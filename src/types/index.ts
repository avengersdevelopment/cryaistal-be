import { Wallet } from "ethers";

export enum Chain {
  ETHEREUM = "ethereum",
  BASE = "base",
  POLYGON = "polygon",
  ARBITRUM = "arbitrum",
}

export interface UserWallet {
  address: string;
  encryptedPrivateKey: string;
  chain: Chain;
}

export interface TraderProfile {
  address: string;
  chain: Chain;
  isActive: boolean;
  followers: number;
  totalVolume: string;
  profitLoss: string;
}

export interface Transaction {
  hash: string;
  chain: Chain;
  fromToken: string;
  toToken: string;
  amountIn: string;
  amountOut: string;
  timestamp: number;
  userId: string;
  traderId: string;
  status: "pending" | "completed" | "failed";
}

export interface PnLRecord {
  userId: string;
  traderId: string;
  token: string;
  amount: string;
  entryPrice: string;
  currentPrice: string;
  timestamp: number;
}

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  router: string;
  factory: string;
  nativeCurrency: {
    symbol: string;
    decimals: number;
  };
}

export interface UserData {
  telegram_id: string;
  created_at: string;
}
