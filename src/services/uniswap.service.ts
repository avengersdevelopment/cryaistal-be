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

// Universal Router ABI for swaps
const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable returns ()",
  "function WETH9() external view returns (address)",
];

// ERC20 ABI for token interactions
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

// QuoterV2 ABI
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint264 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
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
  private readonly UNIVERSAL_ROUTER =
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
  private readonly QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
  private readonly WETH = "0x4200000000000000000000000000000000000006";

  constructor() {
    this.provider = new JsonRpcProvider(config.base.rpc_url, {
      chainId: config.base.chainId,
      name: "base",
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
    params: {
      tokenIn: string;
      tokenOut: string;
      fee: number;
      amountIn: string;
      slippage: number;
      gasPrice?: bigint;
    }
  ) {
    try {
      console.log(`
💭 Getting quote for swap...
Token In: ${params.tokenIn === this.WETH ? "ETH/WETH" : params.tokenIn}
Token Out: ${params.tokenOut}
Fee: ${params.fee / 10000}%`);

      const isEthIn = params.tokenIn.toLowerCase() === this.WETH.toLowerCase();

      // Get quote first to calculate minimum output
      const quoter = new ethers.Contract(this.QUOTER_V2, QUOTER_V2_ABI, wallet);
      const [quoteAmount] = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        fee: params.fee,
        sqrtPriceLimitX96: 0,
      });

      // Calculate minimum output with slippage
      const minOut =
        quoteAmount -
        (quoteAmount * BigInt(Math.floor(params.slippage * 100))) /
          BigInt(10000);

      // Create router contract
      const router = new ethers.Contract(
        this.UNIVERSAL_ROUTER,
        UNIVERSAL_ROUTER_ABI,
        wallet
      );

      // Command types
      const COMMAND_TYPE = {
        V3_SWAP_EXACT_IN: "00",
        WRAP_ETH: "0b",
        UNWRAP_WETH: "0c",
      };

      // Encode V3 swap parameters
      const swapParams = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "address",
          "address",
          "uint24",
          "address",
          "uint256",
          "uint256",
          "uint160",
        ],
        [
          params.tokenIn,
          params.tokenOut,
          params.fee,
          wallet.address,
          params.amountIn,
          minOut,
          0, // sqrtPriceLimitX96
        ]
      );

      // Prepare commands and inputs
      let commands = COMMAND_TYPE.V3_SWAP_EXACT_IN;
      if (isEthIn) {
        commands = COMMAND_TYPE.WRAP_ETH + commands;
      }

      const inputs = [swapParams];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

      // Prepare transaction
      const txData = {
        value: isEthIn ? params.amountIn : "0",
        gasPrice: params.gasPrice,
      };

      console.log(`
🔄 Executing swap...
Commands: ${commands}
Value: ${ethers.formatEther(txData.value)} ETH
Gas Price: ${
        txData.gasPrice ? ethers.formatUnits(txData.gasPrice, "gwei") : "auto"
      } gwei
Min Output: ${ethers.formatUnits(minOut, 6)} USDC`);

      // Execute swap
      const tx = await router.execute(
        "0x" + commands,
        inputs,
        deadline,
        txData
      );

      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed?.toString(),
        amountOut: minOut.toString(),
      };
    } catch (error: any) {
      console.log("Swap failed:", error);
      return {
        success: false,
        error:
          error?.shortMessage ||
          error?.message ||
          "Transaction would fail: execution reverted",
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
      const isUniversalRouter = data.startsWith("0x3593564c"); // execute function selector

      console.log(
        `Router Type: ${isUniversalRouter ? "Universal Router" : "Swap Router"}`
      );

      if (isUniversalRouter) {
        return this.decodeUniversalRouterInput(data);
      }

      // Decode for SwapRouter02
      const iface = new ethers.Interface(UNISWAP_V3_ABI);
      const parsed = iface.parseTransaction({ data });

      if (!parsed) {
        console.log("❌ Could not parse transaction data");
        return null;
      }

      console.log(`Function Name: ${parsed.name}`);

      // Handle different function types
      if (parsed.name === "exactInputSingle") {
        const params = parsed.args[0];
        if (!params) {
          console.log("❌ No parameters found in transaction");
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
          recipient: params.recipient,
        };
      } else if (parsed.name === "exactInput") {
        // Handle multi-hop swaps
        const params = parsed.args[0];
        if (!params || !params.path) {
          console.log("❌ No path found in multi-hop swap");
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
          const tokenIn = ethers.getAddress(
            ethers.hexlify(pathData.slice(0, 20))
          );
          const fee = parseInt(
            ethers.hexlify(pathData.slice(20, 23)).slice(2),
            16
          );
          const tokenOut = ethers.getAddress(
            ethers.hexlify(pathData.slice(-20))
          );

          return {
            tokenIn,
            tokenOut,
            fee,
            amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum,
            recipient: params.recipient,
          };
        } catch (error) {
          console.error("❌ Error decoding multi-hop path:", error);
          return null;
        }
      }

      console.log(`❌ Unsupported function: ${parsed.name}`);
      return null;
    } catch (error) {
      console.error("Error decoding swap input:", error);
      return null;
    }
  }

  private decodeUniversalRouterInput(data: string): DecodedSwapInput | null {
    try {
      console.log("\n🔍 Decoding Universal Router input...");

      const iface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
      const parsed = iface.parseTransaction({ data });

      if (!parsed || parsed.name !== "execute") {
        console.log("❌ Not an execute function call");
        return null;
      }

      const commands = parsed.args[0];
      const inputs = parsed.args[1];

      if (!commands || !inputs || !Array.isArray(inputs)) {
        console.log("❌ Invalid commands or inputs");
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
        console.log("❌ No swap command found");
        return null;
      }

      // Parse swap input data
      const swapInput = inputs[swapCommandIndex];

      if (!swapInput) {
        console.log("❌ No swap input found");
        return null;
      }

      try {
        // Decode path from input
        const pathData = ethers.getBytes(swapInput);

        // Extract addresses and fee
        const tokenIn = ethers.getAddress(
          ethers.hexlify(pathData.slice(0, 20))
        );
        const fee = parseInt(
          ethers.hexlify(pathData.slice(20, 23)).slice(2),
          16
        );
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
          recipient: ethers.ZeroAddress,
        };
      } catch (error) {
        console.error("❌ Error parsing swap data:", error);
        return null;
      }
    } catch (error) {
      console.error("❌ Error decoding Universal Router input:", error);
      return null;
    }
  }
}
