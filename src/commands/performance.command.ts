import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const supabase = createClient(config.supabase.url, config.supabase.key);

export function setupPerformanceCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("performance", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Get user data
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (!user) {
        ctx.reply("Please use /start first to create your account.");
        return;
      }

      // Get user's wallet
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("*")
        .eq("user_id", userId)
        .eq("chain", Chain.BASE)
        .single();

      if (!wallet) {
        ctx.reply("No wallet found. Please use /start to create your BASE wallet first.");
        return;
      }

      // Get current balance
      const balance = await walletService.getWalletBalance(userId, Chain.BASE);
      const currentBalance = ethers.formatEther(balance);

      // Get transaction history
      const { data: transactions } = await supabase
        .from("transactions")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(5);

      let profitLoss = "0.00";
      let totalTrades = 0;
      if (transactions) {
        totalTrades = transactions.length;
        // Calculate P/L (simplified version)
        const pl = transactions.reduce((acc, tx) => {
          const amountIn = parseFloat(tx.amount_in || "0");
          const amountOut = parseFloat(tx.amount_out || "0");
          return acc + (amountOut - amountIn);
        }, 0);
        profitLoss = pl.toFixed(4);
      }

      const message = `📊 CryAIstal Trading Performance

Wallet Balance: ${currentBalance} ETH
Status: ${user.is_subscribed ? "✅ Active" : "❌ Inactive"}
${
  user.subscription_date
    ? `Subscribed Since: ${new Date(
        user.subscription_date
      ).toLocaleDateString()}`
    : ""
}

Performance Metrics:
• Total Trades: ${totalTrades}
• Profit/Loss: ${profitLoss} ETH
• Success Rate: ${
        totalTrades > 0 && transactions
          ? (
              (transactions.filter(
                (tx) =>
                  parseFloat(tx.amount_out || "0") >
                  parseFloat(tx.amount_in || "0")
              ).length /
                totalTrades) *
              100
            ).toFixed(1)
          : 0
      }%

${!user.is_subscribed ? "\nUse /subscribe to start automated trading!" : ""}
${
  transactions && transactions.length > 0
    ? "\nRecent Trades:" +
      transactions
        .slice(0, 3)
        .map(
          (tx) =>
            `\n• ${new Date(tx.created_at).toLocaleTimeString()}: ${
              parseFloat(tx.amount_out || "0") > parseFloat(tx.amount_in || "0")
                ? "📈"
                : "📉"
            } ${tx.amount_in} → ${tx.amount_out} ETH`
        )
        .join("")
    : ""
}`;

      ctx.reply(message);
    } catch (error: any) {
      console.error("Error in performance command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
