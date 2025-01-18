import { Chain, ChainConfig } from "../types";

const INFURA_KEY = process.env.INFURA_API_KEY;

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  [Chain.ETHEREUM]: {
    chainId: 1,
    rpcUrl: INFURA_KEY ? `https://mainnet.infura.io/v3/${INFURA_KEY}` : "",
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
  [Chain.BASE]: {
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || "",
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
  [Chain.POLYGON]: {
    chainId: 137,
    rpcUrl: process.env.POLYGON_RPC_URL || "",
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "MATIC",
      decimals: 18,
    },
  },
  [Chain.ARBITRUM]: {
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || "",
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
};
