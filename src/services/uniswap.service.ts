import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  AbiCoder,
  Interface,
  keccak256,
  toBigInt,
  getAddress,
  formatEther,
  formatUnits,
  parseEther,
  getBytes,
  hexlify,
  getBigInt,
  ContractTransactionResponse,
  TransactionReceipt,
} from "ethers";
import { Chain } from "../types";
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

// Constants
const DEFAULT_SLIPPAGE = 0.5; // 0.5%
const MIN_ETH_FOR_GAS = "0.0002"; // Minimum ETH to keep for gas

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
}

interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  gasUsed?: string;
  error?: string;
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
  private readonly WETH = "0x4200000000000000000000000000000000000006";
  private readonly USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  constructor() {
    this.provider = new JsonRpcProvider(config.quicknode.rpc_url, {
      chainId: config.base.chainId,
      name: "base",
    });
  }

  private validateTokenAddress(address: string): string {
    try {
      if (
        address === ZeroAddress ||
        address === "0x0000000000000000000000400000000000000000"
      ) {
        return this.WETH;
      }
      return getAddress(address);
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

      const fee = 3000; // 0.3% fee tier
      const tickSpacing = 60; // Standard tick spacing for 0.3% fee tier
      const hooks = "0x0000000000000000000000000000000000000000"; // Zero address for no hooks

      // Calculate pool ID using keccak256
      const poolId = keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24", "int24", "address"],
          [token0Address, token1Address, fee, tickSpacing, hooks]
        )
      );

      const stateViewContract = new Contract(
        STATE_VIEW,
        STATE_VIEW_ABI,
        this.provider
      );

      const [slot0, liquidity] = await Promise.all([
        stateViewContract.getSlot0(poolId),
        stateViewContract.getLiquidity(poolId),
      ]);

      if (slot0.sqrtPriceX96 === 0n) {
        console.log("Pool not initialized, attempting to initialize...");

        const token0IsETH =
          token0Address.toLowerCase() === this.WETH.toLowerCase();
        const price = token0IsETH ? 1800n : 1n / 1800n;

        const initialSqrtPriceX96 = toBigInt(
          Math.floor(Math.sqrt(Number(price)) * 2 ** 96)
        );

        const poolManagerContract = new Contract(
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

        return {
          poolId,
          token0: token0Address,
          token1: token1Address,
          fee,
          tickSpacing,
          hooks,
          sqrtPriceX96: updatedSlot0.sqrtPriceX96,
          tick: updatedSlot0.tick,
          liquidity: updatedLiquidity,
        };
      }

      return {
        poolId,
        token0: token0Address,
        token1: token1Address,
        fee,
        tickSpacing,
        hooks,
        sqrtPriceX96: slot0.sqrtPriceX96,
        tick: slot0.tick,
        liquidity,
      };
    } catch (error: any) {
      console.error("❌ V4 Pool Error:", error);
      throw new Error(`V4 Pool not found or error: ${error.message}`);
    }
  }

  private async getQuote(params: SwapParams): Promise<string> {
    const quoterContract = new Contract(QUOTER, QUOTER_ABI, this.provider);

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
    wallet: Wallet,
    chain: Chain,
    params: SwapParams
  ): Promise<SwapResult> {
    try {
      const poolInfo = await this.getPoolInfo(params.tokenIn, params.tokenOut);

      if (params.tokenIn.toLowerCase() !== this.WETH.toLowerCase()) {
        const tokenContract = new Contract(
          params.tokenIn,
          [
            "function approve(address spender, uint256 amount) external returns (bool)",
          ],
          wallet
        );

        const tx = await tokenContract.approve(
          UNIVERSAL_ROUTER,
          params.amountIn
        );
        await tx.wait();
      }

      const quotedAmountOut = await this.getQuote(params);

      const slippageTolerance = params.slippage || DEFAULT_SLIPPAGE;
      const minimumAmountOut =
        BigInt(quotedAmountOut) -
        (BigInt(quotedAmountOut) *
          BigInt(Math.floor(slippageTolerance * 100))) /
          BigInt(10000);

      const router = new Contract(
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

      const tx = await router.exactInputSingle(swapParams, {
        value,
        gasPrice: params.gasPrice,
      });

      const receipt = await tx.wait();

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

  decodeSwapInput(data: string): DecodedSwapInput | null {
    try {
      if (!data.startsWith("0x3593564c")) return null;

      const universalRouterInterface = new Interface(UNIVERSAL_ROUTER_ABI);
      const parsed = universalRouterInterface.parseTransaction({ data });
      if (!parsed || !parsed.name.startsWith("execute")) return null;

      const [commands, inputs] = parsed.args;
      if (!commands || !inputs || !Array.isArray(inputs)) return null;

      const commandBytes = getBytes(commands);
      const swapCommandIndex = commandBytes.findIndex((cmd) => cmd === 0x10);
      if (swapCommandIndex === -1) return null;

      const swapInput = inputs[swapCommandIndex];
      if (!swapInput) return null;

      const inputData = getBytes(swapInput);
      return {
        recipient: getAddress(hexlify(inputData.slice(0, 20))),
        tokenIn: getAddress(hexlify(inputData.slice(20, 40))),
        tokenOut: getAddress(hexlify(inputData.slice(40, 60))),
        fee: parseInt(hexlify(inputData.slice(60, 63)).slice(2), 16),
        amountIn: getBigInt(hexlify(inputData.slice(63, 95))),
        amountOutMinimum: getBigInt(hexlify(inputData.slice(95, 127))),
      };
    } catch (error) {
      console.error("Error decoding swap input:", error);
      return null;
    }
  }

  async getTokenPrice(tokenAddress: string): Promise<string> {
    try {
      const poolInfo = await this.getPoolInfo(tokenAddress, this.USDC);
      const sqrtPriceX96 = poolInfo.sqrtPriceX96;
      const price = (Number(sqrtPriceX96) ** 2 / 2 ** 192).toString();
      return price;
    } catch (error) {
      console.error("Error getting token price:", error);
      throw error;
    }
  }
}
