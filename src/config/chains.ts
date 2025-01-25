import { Chain, ChainConfig } from "../types";
import { config } from "./config";

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  [Chain.BASE]: {
    name: "Base",
    chainId: config.base.chainId,
    rpc_url: config.base.rpc_url,
    explorer_url: "https://basescan.org",
    symbol: "ETH",
    decimals: 18,
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    universal_router: process.env.UNIVERSAL_ROUTER || "",
  },
};
