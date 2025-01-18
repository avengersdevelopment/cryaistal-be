import { JsonRpcProvider, Contract } from "ethers";
import { Chain, TraderProfile, Transaction } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { createClient } from "@supabase/supabase-js";
import { WalletService } from "./wallet.service";
import { UniswapService } from "./uniswap.service";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

const UNISWAP_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

export class TraderService {
  private walletService: WalletService;
  private uniswapService: UniswapService;

  constructor() {
    this.walletService = new WalletService();
    this.uniswapService = new UniswapService();
  }

  async trackTrader(traderAddress: string, chain: Chain) {
    const provider = new JsonRpcProvider(CHAIN_CONFIGS[chain].rpcUrl);
    const factory = new Contract(
      CHAIN_CONFIGS[chain].factory,
      UNISWAP_POOL_ABI,
      provider
    );

    // Listen for swap events
    factory.on(
      "Swap",
      async (
        sender,
        recipient,
        amount0,
        amount1,
        sqrtPrice,
        liquidity,
        tick,
        event
      ) => {
        if (sender.toLowerCase() === traderAddress.toLowerCase()) {
          await this.processTrade({
            trader: traderAddress,
            chain,
            txHash: event.transactionHash,
            amount0: amount0.toString(),
            amount1: amount1.toString(),
          });
        }
      }
    );
  }

  private async processTrade(params: {
    trader: string;
    chain: Chain;
    txHash: string;
    amount0: string;
    amount1: string;
  }) {
    // Get followers of this trader
    const { data: followers } = await supabase
      .from("trader_followers")
      .select("user_id")
      .eq("trader_address", params.trader)
      .eq("chain", params.chain);

    if (!followers) return;

    // Copy trade for each follower
    for (const follower of followers) {
      try {
        const wallet = await this.walletService.getWallet(
          follower.user_id,
          params.chain
        );

        // Here you would implement the logic to copy the trade
        // This is a simplified version - you'd need to add more sophisticated logic
        // to handle token approvals, slippage, etc.
        await this.uniswapService.swapExactInputSingle(wallet, params.chain, {
          tokenIn: "", // You'd need to get these from the original transaction
          tokenOut: "",
          fee: 3000, // Default fee tier
          amountIn: params.amount0,
          amountOutMinimum: "0", // You'd want to calculate this based on slippage
        });

        // Record the transaction
        await supabase.from("transactions").insert([
          {
            user_id: follower.user_id,
            trader_id: params.trader,
            chain: params.chain,
            tx_hash: params.txHash,
            status: "completed",
          },
        ]);
      } catch (error: any) {
        console.error(
          `Failed to copy trade for user ${follower.user_id}:`,
          error
        );
        // Record failed transaction
        await supabase.from("transactions").insert([
          {
            user_id: follower.user_id,
            trader_id: params.trader,
            chain: params.chain,
            tx_hash: params.txHash,
            status: "failed",
            error: error.message,
          },
        ]);
      }
    }
  }

  async getTraderProfile(
    address: string,
    chain: Chain
  ): Promise<TraderProfile> {
    const { data, error } = await supabase
      .from("trader_profiles")
      .select("*")
      .eq("address", address)
      .eq("chain", chain)
      .single();

    if (error) throw error;
    if (!data) throw new Error("Trader not found");

    return {
      address: data.address,
      chain: data.chain,
      isActive: data.is_active,
      followers: data.followers,
      totalVolume: data.total_volume,
      profitLoss: data.profit_loss,
    };
  }
}
