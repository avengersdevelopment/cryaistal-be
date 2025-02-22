import { ethers } from "ethers";
import { UniswapService } from "./services/uniswap.service";
import { WalletService } from "./services/wallet.service";
import { Chain } from "./types";
import { resolve } from "path";
import { DEPLOYMENTS_ADDRESS } from "./config/constants";

const main = async () => {
  console.log("Deployment", DEPLOYMENTS_ADDRESS);
};

main()
  .then(() => {
    console.log("Done");
  })
  .catch((error) => {
    console.error("Error:", error);
  });
