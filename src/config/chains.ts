import { Chain, ChainConfig } from "../types";
import { config } from "./config";

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  [Chain.ETHEREUM]: {
    name: 'Ethereum',
    chainId: 1,
    rpc_url: process.env.ETH_RPC_URL || "",
    explorer_url: 'https://etherscan.io',
    symbol: 'ETH',
    decimals: 18,
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || ""
  },
  [Chain.POLYGON]: {
    name: 'Polygon',
    chainId: 137,
    rpc_url: process.env.POLYGON_RPC_URL || "",
    explorer_url: 'https://polygonscan.com',
    symbol: 'ETH',
    decimals: 18,
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || ""
  },
  [Chain.BASE]: {
    name: 'Base',
    chainId: config.base.chainId,
    rpc_url: config.base.rpc_url,
    explorer_url: 'https://basescan.org',
    symbol: 'ETH',
    decimals: 18,
    router: config.base.uniswap.router,
    factory: config.base.uniswap.factory
  }
};
