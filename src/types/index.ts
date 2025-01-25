import { Wallet } from "ethers";

export enum Chain {
  BASE = "base",
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
  name: string;
  chainId: number;
  rpc_url: string;
  explorer_url: string;
  symbol: string;
  decimals: number;
  router: string;
  factory: string;
  universal_router: string;
}

export interface TrustedTrader {
  id: string;
  address: string;
  chain: Chain;
  name: string;
  description?: string;
  min_copy_amount?: string;
  max_copy_amount?: string;
  isActive: boolean;
  total_trades: number;
  success_rate: number;
  created_at?: string;
  updated_at?: string;
}
