import { Chain, ChainConfig } from "../types";

const INFURA_KEY = process.env.INFURA_API_KEY;

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  [Chain.ETHEREUM]: {
    name: 'Ethereum',
    chainId: 1,
    rpc_url: INFURA_KEY ? `https://mainnet.infura.io/v3/${INFURA_KEY}` : "",
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
    symbol: 'MATIC',
    decimals: 18,
    router: process.env.UNISWAP_V3_ROUTER || "",
    factory: process.env.UNISWAP_V3_FACTORY || ""
  }
};
