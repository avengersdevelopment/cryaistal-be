import { Chain, ChainConfig } from "../types";

const INFURA_KEY = process.env.INFURA_API_KEY;
const IS_TESTNET = process.env.NODE_ENV === 'testnet';

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  [Chain.ETHEREUM]: {
    chainId: IS_TESTNET ? 11155111 : 1,
    rpcUrl: INFURA_KEY ? `https://${IS_TESTNET ? 'sepolia' : 'mainnet'}.infura.io/v3/${INFURA_KEY}` : "",
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
  [Chain.BASE]: {
    chainId: IS_TESTNET ? 84531 : 8453,
    rpcUrl: IS_TESTNET ? "https://goerli.base.org" : (process.env.BASE_RPC_URL || ""),
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
  [Chain.POLYGON]: {
    chainId: IS_TESTNET ? 80001 : 137,
    rpcUrl: IS_TESTNET ? "https://rpc-mumbai.maticvigil.com" : (process.env.POLYGON_RPC_URL || ""),
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "MATIC",
      decimals: 18,
    },
  },
  [Chain.ARBITRUM]: {
    chainId: IS_TESTNET ? 421613 : 42161,
    rpcUrl: IS_TESTNET ? "https://goerli-rollup.arbitrum.io/rpc" : (process.env.ARBITRUM_RPC_URL || ""),
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || "",
    nativeCurrency: {
      symbol: "ETH",
      decimals: 18,
    },
  },
};
