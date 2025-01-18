import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { Chain } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";

const UNISWAP_V3_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)",
];

export class UniswapService {
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
}
