import { ethers } from "ethers";
import { UniswapService } from "./services/uniswap.service";
import { WalletService } from "./services/wallet.service";
import { Chain } from "./types";
import { resolve } from "path";

const main = async () => {
  const uniswapService = new UniswapService();
  const walletService = new WalletService();

  // const wallet = await walletService.getWallet("6817160117", Chain.BASE);
  // console.log("Wallet:", wallet);

  // const result = await uniswapService.swapExactInputSingle(wallet, Chain.BASE, {
  //   tokenIn: "0x0000000000000000000000400000000000000000",
  //   tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  //   fee: 3000, // Default to 0.3% fee if not specified
  //   amountIn: ethers.parseEther("0.00001").toString(),
  //   slippage: 1.0,
  //   gasPrice: BigInt(6136399),
  // });

  // console.log("Swap Result:", result);

  console.log("Waiting for 3 seconds...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const poolInfo = await uniswapService.getPoolInfo(
    "0x0000000000000000000000400000000000000000",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a"
  );
  console.log("Pool Info:", poolInfo);

  // console.log("Waiting for 3 seconds...");
  // await new Promise((resolve) => setTimeout(resolve, 3000));

  // const quote = await uniswapService.getQuote({
  //   amountIn: ethers.parseEther("0.00004").toString(),
  //   fee: 3000,
  //   tokenIn: "0x4200000000000000000000000000000000000006",
  //   tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // });

  // console.log("Quote:", quote);
};

main()
  .then(() => {
    console.log("Done");
  })
  .catch((error) => {
    console.error("Error:", error);
  });
