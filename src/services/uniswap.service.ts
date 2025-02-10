import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";
import { Chain } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { config } from "../config/config";
import QUOTER_ABI from "../config/abis/quoter.json";
import UNIVERSAL_ROUTER_ABI from "../config/abis/universalrouter.json";
import POOL_MANAGER_ABI from "../config/abis/uniswapv4poolmanager.json";
import STATE_VIEW_ABI from "../config/abis/stateview.json";
import {
  POOL_MANAGER,
  QUOTER,
  UNIVERSAL_ROUTER,
  STATE_VIEW,
} from "../config/constants";
import { Pool } from "@uniswap/v4-sdk";
import { Token } from "@uniswap/sdk-core";

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
  private readonly WETH = "0x4200000000000000000000000000000000000006";
  private readonly USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  constructor() {
    this.provider = new JsonRpcProvider(config.quicknode.rpc_url, {
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
        console.log(`
💫 APPROVING TOKEN
================
Token: ${tokenAddress}
Amount: ${amount}
Spender: ${spenderAddress}
================`);

        const tx = await tokenContract.approve(spenderAddress, amount);
        const receipt = await tx.wait();

        console.log(`
✅ TOKEN APPROVAL SUCCESSFUL
=========================
Transaction: ${receipt.hash}
=========================`);
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

  private validateTokenAddress(address: string): string {
    try {
      if (
        address === ethers.ZeroAddress ||
        address === "0x0000000000000000000000400000000000000000"
      ) {
        return this.WETH;
      }
      return ethers.getAddress(address);
    } catch (error) {
      throw new Error(`Invalid token address: ${address}`);
    }
  }

  private async getPoolInfo(tokenIn: string, tokenOut: string) {
    try {
      const normalizedTokenIn = this.validateTokenAddress(tokenIn);
      const normalizedTokenOut = this.validateTokenAddress(tokenOut);

      const [token0Address, token1Address] = [
        normalizedTokenIn,
        normalizedTokenOut,
      ].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

      console.log(`
🔍 V4 POOL LOOKUP
===============
Token In: ${normalizedTokenIn}
Token Out: ${normalizedTokenOut}
===============`);

      const token0 = new Token(
        config.base.chainId,
        token0Address,
        token0Address.toLowerCase() === this.WETH.toLowerCase() ? 18 : 6,
        token0Address.toLowerCase() === this.WETH.toLowerCase()
          ? "WETH"
          : "USDC"
      );
      const token1 = new Token(
        config.base.chainId,
        token1Address,
        token1Address.toLowerCase() === this.WETH.toLowerCase() ? 18 : 6,
        token1Address.toLowerCase() === this.WETH.toLowerCase()
          ? "WETH"
          : "USDC"
      );

      const fee = 3000; // 0.3% fee tier
      const tickSpacing = 60; // Standard tick spacing for 0.3% fee tier
      const hooks = ethers.ZeroAddress;

      const poolId = Pool.getPoolId(token0, token1, fee, tickSpacing, hooks);

      const stateViewContract = new ethers.Contract(
        STATE_VIEW,
        STATE_VIEW_ABI,
        this.provider
      );

      const [slot0, liquidity] = await Promise.all([
        stateViewContract.getSlot0(poolId),
        stateViewContract.getLiquidity(poolId),
      ]);

      let pool = new Pool(
        token0,
        token1,
        fee,
        tickSpacing,
        hooks,
        slot0.sqrtPriceX96,
        liquidity,
        slot0.tick
      );

      if (slot0.sqrtPriceX96 === 0n) {
        console.log("Pool not initialized, attempting to initialize...");

        const token0IsETH =
          token0Address.toLowerCase() === this.WETH.toLowerCase();
        const price = token0IsETH ? 1800n : 1n / 1800n;

        const initialSqrtPriceX96 = ethers.toBigInt(
          Math.floor(Math.sqrt(Number(price)) * 2 ** 96)
        );

        const poolManagerContract = new ethers.Contract(
          POOL_MANAGER,
          POOL_MANAGER_ABI,
          this.provider
        );

        const tx = await poolManagerContract.initialize(
          {
            currency0: token0Address,
            currency1: token1Address,
            fee,
            tickSpacing,
            hooks,
          },
          initialSqrtPriceX96
        );
        await tx.wait();

        const [updatedSlot0, updatedLiquidity] = await Promise.all([
          stateViewContract.getSlot0(poolId),
          stateViewContract.getLiquidity(poolId),
        ]);

        pool = new Pool(
          token0,
          token1,
          fee,
          tickSpacing,
          hooks,
          updatedSlot0.sqrtPriceX96,
          updatedLiquidity,
          updatedSlot0.tick
        );
      }

      return {
        poolId,
        token0: token0Address,
        token1: token1Address,
        fee,
        tickSpacing,
        hooks,
        sqrtPriceX96: pool.sqrtRatioX96,
        tick: pool.tickCurrent,
        liquidity: pool.liquidity,
        token0Price: pool.token0Price,
        token1Price: pool.token1Price,
      };
    } catch (error: any) {
      console.error("❌ V4 Pool Error:", error);
      throw new Error(`V4 Pool not found or error: ${error.message}`);
    }
  }

  private async getQuote(params: SwapParams): Promise<string> {
    const quoterContract = new ethers.Contract(
      QUOTER,
      QUOTER_ABI,
      this.provider
    );

    try {
      const quotedAmountOut =
        await quoterContract.quoteExactInputSingle.staticCall({
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee,
          amountIn: params.amountIn,
          sqrtPriceLimitX96: 0,
        });

      return quotedAmountOut[0].toString();
    } catch (error) {
      console.error("Error getting quote:", error);
      throw error;
    }
  }

  async swapExactInputSingle(
    wallet: ethers.Wallet,
    chain: Chain,
    params: SwapParams
  ): Promise<SwapResult> {
    try {
      await this.rateLimit();

      const poolInfo = await this.getPoolInfo(params.tokenIn, params.tokenOut);

      if (params.tokenIn.toLowerCase() !== this.WETH.toLowerCase()) {
        const approved = await this.checkAndApproveToken(
          wallet,
          params.tokenIn,
          UNIVERSAL_ROUTER,
          params.amountIn
        );
        if (!approved) {
          throw new Error("Token approval failed");
        }
      }

      const quotedAmountOut = await this.getQuote(params);

      const slippageTolerance = params.slippage || DEFAULT_SLIPPAGE;
      const minimumAmountOut =
        BigInt(quotedAmountOut) -
        (BigInt(quotedAmountOut) *
          BigInt(Math.floor(slippageTolerance * 100))) /
          BigInt(10000);

      const router = new ethers.Contract(
        UNIVERSAL_ROUTER,
        UNIVERSAL_ROUTER_ABI,
        wallet
      );

      const swapParams = {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: poolInfo.fee,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        amountIn: params.amountIn,
        amountOutMinimum: minimumAmountOut.toString(),
        sqrtPriceLimitX96: 0,
      };

      const value =
        params.tokenIn.toLowerCase() === this.WETH.toLowerCase()
          ? params.amountIn
          : "0";

      console.log(`
🔄 EXECUTING SWAP
===============
Token In: ${params.tokenIn === this.WETH ? "ETH/WETH" : params.tokenIn}
Token Out: ${params.tokenOut}
Amount In: ${ethers.formatEther(params.amountIn)} ETH
Min Out: ${ethers.formatUnits(minimumAmountOut, 6)} USDC
Gas Price: ${
        params.gasPrice ? ethers.formatUnits(params.gasPrice, "gwei") : "auto"
      } gwei
===============`);

      const tx = await router.exactInputSingle(swapParams, {
        value,
        gasPrice: params.gasPrice,
      });

      console.log(`
⏳ SWAP TRANSACTION SENT
=====================
Hash: ${tx.hash}
=====================`);

      const receipt = await tx.wait();

      console.log(`
✅ SWAP SUCCESSFUL
===============
Hash: ${receipt.hash}
Gas Used: ${receipt.gasUsed}
Block: ${receipt.blockNumber}
===============`);

      return {
        success: true,
        txHash: receipt.hash,
        amountIn: params.amountIn,
        amountOut: quotedAmountOut,
        gasUsed: receipt.gasUsed?.toString(),
      };
    } catch (error: any) {
      console.error("Swap failed:", error);
      return {
        success: false,
        error: error?.shortMessage || error?.message || "Swap failed",
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
      // Check if this is Universal Router transaction
      if (data.startsWith("0x3593564c")) {
        // execute function selector
        return this.decodeUniversalRouterInput(data);
      }
      return null;
    } catch (error) {
      console.error("Error decoding swap input:", error);
      return null;
    }
  }

  private decodeUniversalRouterInput(data: string): DecodedSwapInput | null {
    try {
      console.log(`
🔍 DECODING V4 TRANSACTION
========================
Data: ${data.slice(0, 66)}...
Length: ${data.length}
========================`);

      const universalRouterInterface = new ethers.Interface(
        UNIVERSAL_ROUTER_ABI
      );
      const parsed = universalRouterInterface.parseTransaction({ data });

      if (!parsed || !parsed.name.startsWith("execute")) {
        console.log("❌ Not a V4 execute function call");
        return null;
      }

      const [commands, inputs] = parsed.args;

      if (!commands || !inputs || !Array.isArray(inputs)) {
        console.log("❌ Invalid V4 commands or inputs");
        return null;
      }

      // V4 Command types based on Uniswap v4 docs
      const V4_COMMANDS = {
        PERMIT2_PERMIT: 0x04,
        WRAP_ETH: 0x06,
        UNWRAP_WETH: 0x07,
        V4_SWAP_EXACT_IN: 0x10,
        V4_SWAP_EXACT_OUT: 0x11,
      };

      console.log(`
📦 V4 ROUTER EXECUTION
===================
Commands: 0x${commands.toString("hex")}
Inputs: ${inputs.length}
===================`);

      // Find V4 swap command
      const commandBytes = ethers.getBytes(commands);
      let swapCommandIndex = -1;
      let isExactIn = true;

      for (let i = 0; i < commandBytes.length; i++) {
        const cmd = commandBytes[i];
        if (cmd === V4_COMMANDS.V4_SWAP_EXACT_IN) {
          swapCommandIndex = i;
          isExactIn = true;
          break;
        } else if (cmd === V4_COMMANDS.V4_SWAP_EXACT_OUT) {
          swapCommandIndex = i;
          isExactIn = false;
          break;
        }
      }

      if (swapCommandIndex === -1) {
        console.log("❌ No V4 swap command found");
        return null;
      }

      const swapInput = inputs[swapCommandIndex];
      if (!swapInput) {
        console.log("❌ No V4 swap input found");
        return null;
      }

      // V4 swap input format (based on v4 protocol)
      const inputData = ethers.getBytes(swapInput);

      // Decode based on V4 protocol format
      const recipient = ethers.getAddress(
        ethers.hexlify(inputData.slice(0, 20))
      );
      const tokenIn = ethers.getAddress(
        ethers.hexlify(inputData.slice(20, 40))
      );
      const tokenOut = ethers.getAddress(
        ethers.hexlify(inputData.slice(40, 60))
      );
      const fee = parseInt(
        ethers.hexlify(inputData.slice(60, 63)).slice(2),
        16
      );
      const amountIn = ethers.getBigInt(
        ethers.hexlify(inputData.slice(63, 95))
      );
      const amountOutMinimum = ethers.getBigInt(
        ethers.hexlify(inputData.slice(95, 127))
      );

      console.log(`
✅ V4 SWAP DECODED
===============
Type: ${isExactIn ? "EXACT_INPUT" : "EXACT_OUTPUT"}
Recipient: ${recipient}
Token In: ${tokenIn}
Token Out: ${tokenOut}
Fee: ${fee}
Amount In: ${ethers.formatEther(amountIn)} ETH
Min Out: ${ethers.formatUnits(amountOutMinimum, 6)} USDC
===============`);

      return {
        tokenIn,
        tokenOut,
        fee,
        amountIn,
        amountOutMinimum,
        recipient,
      };
    } catch (error) {
      console.error("❌ Error decoding V4 input:", error);
      return null;
    }
  }
}
