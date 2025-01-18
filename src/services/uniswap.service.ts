import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { Chain } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { ethers } from "ethers";
import { config } from "../config/config";

const UNISWAP_V3_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)",
];

export class UniswapService {
  private provider: ethers.JsonRpcProvider;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.ethereum.rpc_url);
  }

  private getRouter(chain: Chain, wallet: Wallet) {
    if (!wallet.provider) {
      throw new Error("Provider not connected");
    }
    return new Contract(CHAIN_CONFIGS[chain].router, UNISWAP_V3_ABI, wallet);
  }

  async swapExactInputSingle(
    wallet: Wallet,
    chain: Chain,
    params: {
      tokenIn: string;
      tokenOut: string;
      fee: number;
      amountIn: string;
      amountOutMinimum: string;
      sqrtPriceLimitX96?: string;
    }
  ) {
    const router = this.getRouter(chain, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    const tx = await router.exactInputSingle({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.fee,
      recipient: wallet.address,
      deadline,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96: params.sqrtPriceLimitX96 || 0,
    });

    return await tx.wait();
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

    const tx = await router.exactInput({
      path: params.path,
      recipient: wallet.address,
      deadline,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
    });

    return await tx.wait();
  }

  async getTokenPrice(tokenAddress: string): Promise<string> {
    try {
      // Using Uniswap V3 Factory to get the ETH/Token pool
      const poolAddress = await this.getPoolAddress(tokenAddress);
      const poolContract = new ethers.Contract(
        poolAddress,
        [
          "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
        ],
        this.provider
      );

      const { sqrtPriceX96 } = await poolContract.slot0();
      const price = (Number(sqrtPriceX96) ** 2 / (2 ** 192)).toString();
      return price;
    } catch (error) {
      console.error("Error getting token price:", error);
      throw error;
    }
  }

  private async getPoolAddress(tokenAddress: string): Promise<string> {
    const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory
    const factoryContract = new ethers.Contract(
      factoryAddress,
      [
        "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
      ],
      this.provider
    );

    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    return await factoryContract.getPool(tokenAddress, WETH, 3000); // Using 0.3% fee tier
  }
}
