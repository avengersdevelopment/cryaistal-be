import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";
import { Chain } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { config } from "../config/config";

// Constants for transaction management
const DEFAULT_SLIPPAGE = 0.5; // 0.5%
const MAX_PRICE_IMPACT = 5; // 5%
const GAS_LIMIT_MULTIPLIER = 1.2;
const MIN_ETH_FOR_GAS = "0.001"; // Minimum ETH to keep for gas
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
    this.provider = new JsonRpcProvider(config.base.rpc_url);
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
    wallet: Wallet,
    chain: Chain,
    params: SwapParams
  ): Promise<SwapResult> {
    try {
      console.log(`Starting swap:
        Token In: ${params.tokenIn}
        Token Out: ${params.tokenOut}
        Amount In: ${params.amountIn}
        Fee: ${params.fee}`);

      if (!wallet.provider) {
        return {
          success: false,
          error: "Wallet provider not connected",
        };
      }

      // Check ETH balance for gas
      const ethBalance = await wallet.provider.getBalance(wallet.address);
      if (ethBalance < ethers.parseEther(MIN_ETH_FOR_GAS)) {
        return {
          success: false,
          error: `Insufficient ETH for gas. Minimum required: ${MIN_ETH_FOR_GAS} ETH`,
        };
      }

      // Get quote for price impact calculation
      const router = this.getRouter(chain, wallet);
      const amountOut = await router.quoteExactInputSingle(
        params.tokenIn,
        params.tokenOut,
        params.fee,
        params.amountIn,
        0
      );

      // Calculate price impact
      const priceImpact = await this.calculatePriceImpact(
        params.tokenIn,
        params.tokenOut,
        params.amountIn,
        amountOut.toString()
      );

      if (priceImpact > MAX_PRICE_IMPACT) {
        return {
          success: false,
          error: `Price impact too high: ${priceImpact.toFixed(2)}%`,
        };
      }

      // Calculate minimum amount out with slippage
      const slippage = params.slippage || DEFAULT_SLIPPAGE;
      const minAmountOut =
        (BigInt(amountOut) * BigInt(1000 - slippage * 10)) / BigInt(1000);

      // Approve token if needed
      if (params.tokenIn !== ethers.ZeroAddress) {
        const approved = await this.checkAndApproveToken(
          wallet,
          params.tokenIn,
          CHAIN_CONFIGS[chain].router,
          params.amountIn
        );
        if (!approved) {
          return {
            success: false,
            error: "Token approval failed",
          };
        }
      }

      // Prepare transaction
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes
      const tx = await router.exactInputSingle(
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee,
          recipient: params.recipient || wallet.address,
          deadline,
          amountIn: params.amountIn,
          amountOutMinimum: minAmountOut.toString(),
          sqrtPriceLimitX96: params.sqrtPriceLimitX96 || 0,
        },
        {
          value: params.tokenIn === ethers.ZeroAddress ? params.amountIn : 0,
          gasLimit:
            ((await router.exactInputSingle.estimateGas(
              {
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                fee: params.fee,
                recipient: params.recipient || wallet.address,
                deadline,
                amountIn: params.amountIn,
                amountOutMinimum: minAmountOut.toString(),
                sqrtPriceLimitX96: params.sqrtPriceLimitX96 || 0,
              },
              {
                value:
                  params.tokenIn === ethers.ZeroAddress ? params.amountIn : 0,
              }
            )) *
              BigInt(Math.floor(GAS_LIMIT_MULTIPLIER * 100))) /
            BigInt(100),
        }
      );

      // Monitor transaction
      this.pendingTransactions.set(tx.hash, 0);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: tx.hash,
        amountIn: params.amountIn,
        amountOut: minAmountOut.toString(),
        gasUsed: receipt.gasUsed.toString(),
        priceImpact,
      };
    } catch (error: any) {
      console.error("Swap failed:", error);
      return {
        success: false,
        error: error.message || "Unknown error occurred",
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
      // Remove 0x prefix and method signature (first 4 bytes)
      const inputData = data.slice(10);

      // Decode parameters according to Uniswap V3 Router format
      const tokenIn = "0x" + inputData.slice(24, 64);
      const tokenOut = "0x" + inputData.slice(88, 128);
      const fee = parseInt(inputData.slice(128, 192), 16);
      const recipient = "0x" + inputData.slice(216, 256);
      const amountIn = BigInt("0x" + inputData.slice(320, 384));
      const amountOutMinimum = BigInt("0x" + inputData.slice(384, 448));

      return {
        tokenIn,
        tokenOut,
        fee,
        amountIn,
        amountOutMinimum,
        recipient,
      };
    } catch (error) {
      console.error("Error decoding swap input:", error);
      return null;
    }
  }
}
