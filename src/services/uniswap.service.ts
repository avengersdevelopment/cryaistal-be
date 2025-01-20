import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";
import { Chain } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { config } from "../config/config";

// Constants for transaction management
const DEFAULT_SLIPPAGE = 0.5; // 0.5%
const MAX_PRICE_IMPACT = 5; // 5%
const GAS_LIMIT_MULTIPLIER = 1.2;
const MIN_ETH_FOR_GAS = "0.0002"; // Minimum ETH to keep for gas
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

// Extended ABI to support all swap types and approvals
const UNISWAP_V3_ABI = [
  // Router functions
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)",
  "function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum)) external payable returns (uint256 amountIn)",
  // Quoter functions
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
  "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut)",
  // Events
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

// Universal Router ABI
const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable external",
  "function execute(bytes commands, bytes[] inputs) payable external"
];

// ERC20 ABI for token interactions
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  amountOutMinimum?: string;
  recipient?: string;
  deadline?: number;
  sqrtPriceLimitX96?: string;
  slippage?: number;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  gasUsed?: string;
  error?: string;
  priceImpact?: number;
}

interface DecodedSwapInput {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  recipient: string;
}

export class UniswapService {
  private provider: JsonRpcProvider;
  private lastRequestTime: number = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // 100ms between requests
  private pendingTransactions: Map<string, number> = new Map(); // txHash -> retry count

  constructor() {
    this.provider = new JsonRpcProvider(config.base.rpc_url, {
      chainId: config.base.chainId,
      name: 'base'
    });
    this.monitorPendingTransactions();
  }

  private async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private async rateLimitedRequest<T>(request: () => Promise<T>): Promise<T> {
    await this.rateLimit();
    return request();
  }

  private getRouter(chain: Chain, signer: Wallet) {
    return new Contract(CHAIN_CONFIGS[chain].router, UNISWAP_V3_ABI, signer);
  }

  private async checkAndApproveToken(
    wallet: Wallet,
    tokenAddress: string,
    spenderAddress: string,
    amount: string
  ): Promise<boolean> {
    try {
      const tokenContract = new Contract(tokenAddress, ERC20_ABI, wallet);
      const currentAllowance = await tokenContract.allowance(
        wallet.address,
        spenderAddress
      );

      if (currentAllowance < amount) {
        console.log(`Approving token ${tokenAddress} for amount ${amount}`);
        const tx = await tokenContract.approve(spenderAddress, amount);
        await tx.wait();
        console.log(`Token approval successful: ${tx.hash}`);
        return true;
      }

      return true;
    } catch (error) {
      console.error("Error in token approval:", error);
      return false;
    }
  }

  private async getTokenDecimals(tokenAddress: string): Promise<number> {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, this.provider);
    return await tokenContract.decimals();
  }

  private async calculatePriceImpact(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    amountOut: string
  ): Promise<number> {
    try {
      // Get token prices from a price oracle or pool
      const priceIn = await this.getTokenPrice(tokenIn);
      const priceOut = await this.getTokenPrice(tokenOut);

      const valueIn = parseFloat(amountIn) * parseFloat(priceIn);
      const valueOut = parseFloat(amountOut) * parseFloat(priceOut);

      return ((valueIn - valueOut) / valueIn) * 100;
    } catch (error) {
      console.error("Error calculating price impact:", error);
      return 0;
    }
  }

  private async monitorPendingTransactions() {
    setInterval(async () => {
      for (const [txHash, retryCount] of this.pendingTransactions.entries()) {
        try {
          const receipt = await this.provider.getTransactionReceipt(txHash);

          if (receipt) {
            this.pendingTransactions.delete(txHash);
            console.log(`Transaction ${txHash} confirmed:`, {
              status: receipt.status ? "success" : "failed",
              gasUsed: receipt.gasUsed.toString(),
              blockNumber: receipt.blockNumber,
            });
          } else if (retryCount >= MAX_RETRIES) {
            this.pendingTransactions.delete(txHash);
            console.error(
              `Transaction ${txHash} failed after ${MAX_RETRIES} retries`
            );
          } else {
            this.pendingTransactions.set(txHash, retryCount + 1);
          }
        } catch (error) {
          console.error(`Error monitoring transaction ${txHash}:`, error);
        }
      }
    }, RETRY_DELAY);
  }

  async swapExactInputSingle(
    wallet: ethers.Wallet,
    chain: Chain,
    params: SwapParams
  ): Promise<SwapResult> {
    try {
      if (!wallet.provider) {
        throw new Error("Wallet provider not connected");
      }

      // Check ETH balance first
      const balance = await wallet.provider.getBalance(wallet.address);
      const amountInWei = BigInt(params.amountIn);
      const minRequiredWei = amountInWei + ethers.parseEther("0.0002"); // Turunkan gas buffer ke 0.0002

      console.log(`
💰 DETAILED BALANCE CHECK
=======================
Current Balance: ${ethers.formatEther(balance)} ETH
Swap Amount: ${ethers.formatEther(amountInWei)} ETH
Required (with buffer): ${ethers.formatEther(minRequiredWei)} ETH
Available for Gas: ${ethers.formatEther(balance - amountInWei)} ETH
=======================`);

      if (balance < minRequiredWei) {
        throw new Error(`Insufficient balance. You need at least ${ethers.formatEther(minRequiredWei)} ETH (including gas buffer)`);
      }

      // Get router contract with optimized ABI
      const routerContract = new ethers.Contract(
        config.base.uniswap.router,
        [
          'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
          'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
        ],
        wallet
      );

      // Get token details
      const WETH = "0x4200000000000000000000000000000000000006";
      const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
      const tokenIn = params.tokenIn === ethers.ZeroAddress ? WETH : params.tokenIn;
      const tokenOut = params.tokenOut || USDC; // Default to USDC if not specified
      const fee = params.fee || 3000; // Default to 0.3% if not specified

      // Validate token addresses
      if (!ethers.isAddress(tokenIn) || !ethers.isAddress(tokenOut)) {
        throw new Error('Invalid token address');
      }

      // Validate fee
      const validFees = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
      if (!validFees.includes(fee)) {
        throw new Error(`Invalid fee. Must be one of: ${validFees.map(f => f/10000)}%`);
      }

      // Get quote with more details
      console.log(`\n💭 Getting quote for swap...`);
      console.log(`Token In: ${tokenIn === WETH ? "ETH/WETH" : tokenIn}`);
      console.log(`Token Out: ${tokenOut}`);
      console.log(`Fee: ${fee / 10000}%`);
      
      // Get quote amount
      const [quoteAmount, , , estimatedGas] = await routerContract.quoteExactInputSingle.staticCall(
        tokenIn,
        tokenOut,
        fee,
        amountInWei,
        0
      );

      // Increase slippage to 2% for small trades
      const slippagePercent = amountInWei < ethers.parseEther("0.001") ? BigInt(2) : BigInt(1);
      const minAmountOut = quoteAmount - (quoteAmount * slippagePercent / BigInt(100));

      // Try to get token decimals for better formatting
      let outDecimals = 18; // default to 18
      try {
        const tokenContract = new ethers.Contract(
          tokenOut,
          ['function decimals() view returns (uint8)'],
          wallet
        );
        outDecimals = await tokenContract.decimals();
      } catch (error) {
        console.log('Could not get token decimals, using default 18');
      }

      // Get latest gas price with optimization
      const feeData = await wallet.provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || BigInt(0);
      
      // Optimize gas price - use 90% of current gas price for small trades
      const gasPrice = amountInWei < ethers.parseEther("0.001") 
        ? (baseGasPrice * BigInt(90) / BigInt(100))
        : baseGasPrice;

      // Use lower gas limit for small trades
      const gasLimit = amountInWei < ethers.parseEther("0.001")
        ? estimatedGas + (estimatedGas * BigInt(30) / BigInt(100))  // 30% buffer for small trades
        : estimatedGas + (estimatedGas * BigInt(50) / BigInt(100)); // 50% buffer for larger trades

      console.log(`
⛽ OPTIMIZED GAS SETTINGS
=======================
Base Gas Price: ${ethers.formatUnits(baseGasPrice, 'gwei')} gwei
Optimized Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei
Estimated Gas: ${estimatedGas}
Gas Limit: ${gasLimit}
Total Gas Cost: ${ethers.formatEther(gasLimit * gasPrice)} ETH
=======================`);

      // Execute swap with optimized parameters
      console.log(`\n🔄 Executing swap with optimized parameters...`);
      
      const tx = await routerContract.exactInputSingle(
        {
          tokenIn,
          tokenOut,
          fee,
          recipient: wallet.address,
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
          amountIn: amountInWei,
          amountOutMinimum: minAmountOut,
          sqrtPriceLimitX96: 0
        },
        {
          value: params.tokenIn === ethers.ZeroAddress ? amountInWei : 0,
          gasLimit,
          gasPrice,
          maxFeePerGas: undefined, // Disable EIP-1559 for more predictable gas costs
          maxPriorityFeePerGas: undefined
        }
      );

      console.log(`\n📝 Transaction sent: ${tx.hash}`);

      // Wait for confirmation with timeout
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction confirmation timeout')), 60000)
        )
      ]) as ethers.TransactionReceipt;

      if (!receipt || !receipt.status) {
        throw new Error('Transaction failed');
      }

      console.log(`
✅ SWAP SUCCESSFUL
================
Hash: ${receipt.hash}
Block: ${receipt.blockNumber}
Gas Used: ${receipt.gasUsed}
Effective Gas Price: ${ethers.formatUnits(receipt.gasPrice || 0, 'gwei')} gwei
Total Cost: ${ethers.formatEther(BigInt(receipt.gasPrice || 0) * BigInt(receipt.gasUsed))} ETH
================`);

      return {
        success: true,
        txHash: receipt.hash,
        amountIn: amountInWei.toString(),
        amountOut: quoteAmount.toString(),
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error: any) {
      console.error('Swap failed:', error);
      
      let errorMessage = 'Unknown error';
      
      if (error.code === 'CALL_EXCEPTION') {
        if (error.info?.error?.message) {
          errorMessage = `Transaction would fail: ${error.info.error.message}`;
        } else if (error.reason) {
          errorMessage = `Transaction would fail: ${error.reason}`;
        } else {
          errorMessage = 'Transaction would fail: Please check pool liquidity and gas settings';
        }
      } else if (error.code === 'INSUFFICIENT_FUNDS') {
        errorMessage = 'Insufficient ETH for transaction';
      } else if (error.code === 'UNPREDICTABLE_GAS_LIMIT') {
        errorMessage = 'Could not estimate gas: The swap might fail';
      } else if (error.message) {
        errorMessage = error.message;
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async swapExactInput(
    wallet: Wallet,
    chain: Chain,
    params: {
      path: string;
      amountIn: string;
      amountOutMinimum: string;
    }
  ) {
    const router = this.getRouter(chain, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    return this.rateLimitedRequest(async () => {
      const tx = await router.exactInput({
        path: params.path,
        recipient: wallet.address,
        deadline,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
      });

      return await tx.wait();
    });
  }

  async getTokenPrice(tokenAddress: string): Promise<string> {
    return this.rateLimitedRequest(async () => {
      try {
        const poolAddress = await this.getPoolAddress(tokenAddress);
        const poolContract = new ethers.Contract(
          poolAddress,
          [
            "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
          ],
          this.provider
        );

        const { sqrtPriceX96 } = await poolContract.slot0();
        const price = (Number(sqrtPriceX96) ** 2 / 2 ** 192).toString();
        return price;
      } catch (error) {
        console.error("Error getting token price:", error);
        throw error;
      }
    });
  }

  private async getPoolAddress(tokenAddress: string): Promise<string> {
    return this.rateLimitedRequest(async () => {
      const factoryAddress = config.base.uniswap.factory;
      const factoryContract = new ethers.Contract(
        factoryAddress,
        [
          "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
        ],
        this.provider
      );

      const WETH = "0x4200000000000000000000000000000000000006"; // WETH di BASE
      return await factoryContract.getPool(tokenAddress, WETH, 3000);
    });
  }

  decodeSwapInput(data: string): DecodedSwapInput | null {
    try {
      console.log(`
🔍 DECODING TRANSACTION DATA
=========================
Data: ${data.slice(0, 66)}...
Length: ${data.length}
=========================`);

      // Check if this is Universal Router or SwapRouter
      const isUniversalRouter = data.startsWith('0x3593564c'); // execute function selector
      
      console.log(`Router Type: ${isUniversalRouter ? 'Universal Router' : 'Swap Router'}`);
      
      if (isUniversalRouter) {
        return this.decodeUniversalRouterInput(data);
      }

      // Decode for SwapRouter02
      const iface = new ethers.Interface(UNISWAP_V3_ABI);
      const parsed = iface.parseTransaction({ data });

      if (!parsed) {
        console.log('❌ Could not parse transaction data');
        return null;
      }

      console.log(`Function Name: ${parsed.name}`);

      // Handle different function types
      if (parsed.name === 'exactInputSingle') {
        const params = parsed.args[0];
        if (!params) {
          console.log('❌ No parameters found in transaction');
          return null;
        }

        console.log(`
📝 EXACT INPUT SINGLE PARAMS
=========================
Token In: ${params.tokenIn}
Token Out: ${params.tokenOut}
Fee: ${params.fee}
Amount In: ${ethers.formatEther(params.amountIn)} ETH
=========================`);

        return {
          tokenIn: ethers.getAddress(params.tokenIn),
          tokenOut: ethers.getAddress(params.tokenOut),
          fee: params.fee,
          amountIn: params.amountIn,
          amountOutMinimum: params.amountOutMinimum,
          recipient: params.recipient
        };
      } 
      else if (parsed.name === 'exactInput') {
        // Handle multi-hop swaps
        const params = parsed.args[0];
        if (!params || !params.path) {
          console.log('❌ No path found in multi-hop swap');
          return null;
        }

        try {
          // Decode path for multi-hop
          const path = params.path;
          const pathData = ethers.getBytes(path);
          
          console.log(`
📝 EXACT INPUT (MULTI-HOP) PATH
============================
Path Data: ${ethers.hexlify(pathData)}
Length: ${pathData.length}
============================`);
          
          // Get first and last token from path
          const tokenIn = ethers.getAddress(ethers.hexlify(pathData.slice(0, 20)));
          const fee = parseInt(ethers.hexlify(pathData.slice(20, 23)).slice(2), 16);
          const tokenOut = ethers.getAddress(ethers.hexlify(pathData.slice(-20)));

          return {
            tokenIn,
            tokenOut,
            fee,
            amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum,
            recipient: params.recipient
          };
        } catch (error) {
          console.error('❌ Error decoding multi-hop path:', error);
          return null;
        }
      }

      console.log(`❌ Unsupported function: ${parsed.name}`);
      return null;

    } catch (error) {
      console.error('Error decoding swap input:', error);
      return null;
    }
  }

  private decodeUniversalRouterInput(data: string): DecodedSwapInput | null {
    try {
      console.log('\n🔍 Decoding Universal Router input...');
      
      const iface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
      const parsed = iface.parseTransaction({ data });

      if (!parsed || parsed.name !== 'execute') {
        console.log('❌ Not an execute function call');
        return null;
      }

      const commands = parsed.args[0];
      const inputs = parsed.args[1];

      if (!commands || !inputs || !Array.isArray(inputs)) {
        console.log('❌ Invalid commands or inputs');
        return null;
      }

      // Find swap command index
      let swapCommandIndex = -1;
      const commandBytes = ethers.getBytes(commands);
      
      for (let i = 0; i < commandBytes.length; i++) {
        // Check for any type of swap command
        if ([0x00, 0x01, 0x02, 0x03].includes(commandBytes[i])) {
          swapCommandIndex = i;
          break;
        }
      }

      if (swapCommandIndex === -1) {
        console.log('❌ No swap command found');
        return null;
      }
      
      // Parse swap input data
      const swapInput = inputs[swapCommandIndex];
      
      if (!swapInput) {
        console.log('❌ No swap input found');
        return null;
      }

      try {
        // Decode path from input
        const pathData = ethers.getBytes(swapInput);
        
        // Extract addresses and fee
        const tokenIn = ethers.getAddress(ethers.hexlify(pathData.slice(0, 20)));
        const fee = parseInt(ethers.hexlify(pathData.slice(20, 23)).slice(2), 16);
        const tokenOut = ethers.getAddress(ethers.hexlify(pathData.slice(-20)));
        
        // Amount is after path data
        const amountInData = pathData.slice(43, 75); // Take 32 bytes for amount
        const amountIn = ethers.getBigInt(ethers.hexlify(amountInData));

        console.log(`
✅ Decoded swap details:
Token In: ${tokenIn}
Token Out: ${tokenOut}
Fee: ${fee}
Amount In: ${amountIn.toString()} wei
        `);

        return {
          tokenIn,
          tokenOut,
          fee,
          amountIn,
          amountOutMinimum: BigInt(0),
          recipient: ethers.ZeroAddress
        };
      } catch (error) {
        console.error('❌ Error parsing swap data:', error);
        return null;
      }
    } catch (error) {
      console.error('❌ Error decoding Universal Router input:', error);
      return null;
    }
  }
}
