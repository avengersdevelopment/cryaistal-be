import { JsonRpcProvider, Contract, ethers } from "ethers";
import { Chain, TraderProfile, Transaction, TrustedTrader } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { WalletService } from "./wallet.service";
import { UniswapService } from "./uniswap.service";

const supabase = createClient(config.supabase.url, config.supabase.key);

const UNISWAP_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

export class TraderService {
  private walletService: WalletService;
  private uniswapService: UniswapService;
  private activeTraders: Map<string, Contract> = new Map();

  constructor() {
    this.walletService = new WalletService();
    this.uniswapService = new UniswapService();
  }

  async startTrackingTrustedTraders() {
    // Get all active trusted traders from database
    const { data: traders, error } = await supabase
      .from("trusted_traders")
      .select("*")
      .eq("is_active", true);

    if (error) {
      console.error("Error fetching trusted traders:", error);
      return;
    }

    if (!traders || traders.length === 0) {
      console.log("No active trusted traders found");
      return;
    }

    // Start tracking each trader
    for (const trader of traders) {
      await this.trackTrader(trader.address, trader.chain as Chain);
      console.log(
        `Started tracking trader: ${trader.name} (${trader.address})`
      );
    }
  }

  async trackTrader(traderAddress: string, chain: Chain) {
    const provider = new JsonRpcProvider(CHAIN_CONFIGS[chain].rpcUrl);
    const factory = new Contract(
      CHAIN_CONFIGS[chain].factory,
      UNISWAP_POOL_ABI,
      provider
    );

    // Store the contract to prevent duplicate listeners
    const key = `${chain}:${traderAddress}`;
    if (this.activeTraders.has(key)) {
      return;
    }
    this.activeTraders.set(key, factory);

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
    // Get trusted trader configuration
    const { data: trustedTrader } = await supabase
      .from("trusted_traders")
      .select("*")
      .eq("address", params.trader)
      .eq("chain", params.chain)
      .eq("is_active", true)
      .single();

    if (!trustedTrader) return;

    // Get subscribed users
    const { data: users } = await supabase
      .from("users")
      .select("telegram_id")
      .eq("is_subscribed", true);

    if (!users || users.length === 0) return;

    // Copy trade for each subscribed user
    for (const user of users) {
      try {
        // Check user's balance first
        const balance = await this.walletService.getWalletBalance(
          user.telegram_id,
          params.chain
        );
        const ethBalance = ethers.formatEther(balance);

        // Skip if user has insufficient balance
        if (parseFloat(ethBalance) < 0.1) {
          console.log(
            `Skipping user ${user.telegram_id} - insufficient balance`
          );
          continue;
        }

        const wallet = await this.walletService.getWallet(
          user.telegram_id,
          params.chain
        );

        let amountToCopy = params.amount0;

        // Apply min/max copy amounts if configured
        if (trustedTrader.min_copy_amount) {
          amountToCopy = Math.max(
            parseFloat(trustedTrader.min_copy_amount),
            parseFloat(amountToCopy)
          ).toString();
        }

        if (trustedTrader.max_copy_amount) {
          amountToCopy = Math.min(
            parseFloat(trustedTrader.max_copy_amount),
            parseFloat(amountToCopy)
          ).toString();
        }

        // Ensure amount doesn't exceed user's balance
        amountToCopy = Math.min(
          parseFloat(amountToCopy),
          parseFloat(ethBalance) * 0.95 // Leave some for gas
        ).toString();

        // Execute the trade
        const tx = await this.uniswapService.swapExactInputSingle(
          wallet,
          params.chain,
          {
            tokenIn: "", // Get from transaction trace
            tokenOut: "", // Get from transaction trace
            fee: 3000,
            amountIn: ethers.parseEther(amountToCopy).toString(),
            amountOutMinimum: "0", // Calculate based on slippage
          }
        );

        // Record the transaction
        await supabase.from("transactions").insert([
          {
            user_id: user.telegram_id,
            trader_id: params.trader,
            chain: params.chain,
            tx_hash: tx.hash,
            amount_in: amountToCopy,
            status: "completed",
          },
        ]);

        // Update trader's stats
        await this.updateTraderStats(trustedTrader.id, true);

        // Notify user of successful trade
        // You would implement notification logic here
      } catch (error: any) {
        console.error(
          `Failed to copy trade for user ${user.telegram_id}:`,
          error
        );
        await supabase.from("transactions").insert([
          {
            user_id: user.telegram_id,
            trader_id: params.trader,
            chain: params.chain,
            tx_hash: params.txHash,
            status: "failed",
            error: error.message,
          },
        ]);

        // Update trader's stats
        await this.updateTraderStats(trustedTrader.id, false);
      }
    }
  }

  private async updateTraderStats(traderId: string, success: boolean) {
    const { data: trader } = await supabase
      .from("trusted_traders")
      .select("total_trades, success_rate")
      .eq("id", traderId)
      .single();

    if (!trader) return;

    const newTotalTrades = trader.total_trades + 1;
    const successfulTrades = success
      ? Math.ceil(trader.success_rate * trader.total_trades) + 1
      : Math.ceil(trader.success_rate * trader.total_trades);
    const newSuccessRate = (successfulTrades / newTotalTrades) * 100;

    await supabase
      .from("trusted_traders")
      .update({
        total_trades: newTotalTrades,
        success_rate: newSuccessRate,
      })
      .eq("id", traderId);
  }

  async getTrustedTraders(): Promise<TrustedTrader[]> {
    const { data, error } = await supabase
      .from("trusted_traders")
      .select("*")
      .eq("is_active", true)
      .order("success_rate", { ascending: false });

    if (error) throw error;
    return data || [];
  }
}
