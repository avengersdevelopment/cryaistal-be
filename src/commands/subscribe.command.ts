import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const supabase = createClient(config.supabase.url, config.supabase.key);
const MIN_ETH_REQUIRED = "0.1"; // 0.1 ETH minimum

export function setupSubscribeCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("subscribe", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Check if already subscribed
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (!user) {
        ctx.reply("Please use /start first to create your account.");
        return;
      }

      if (user.is_subscribed) {
        ctx.reply(
          "You are already subscribed! Use /performance to check your trading status."
        );
        return;
      }

      // Check ETH balance
      const balance = await walletService.getWalletBalance(
        userId,
        Chain.ETHEREUM
      );
      const ethBalance = ethers.formatEther(balance);

      if (parseFloat(ethBalance) < parseFloat(MIN_ETH_REQUIRED)) {
        const message = `Insufficient ETH balance to start trading.

Required: ${MIN_ETH_REQUIRED} ETH
Current: ${ethBalance} ETH

Please use /deposit to get your wallet address and add more ETH.`;
        ctx.reply(message);
        return;
      }

      // Activate subscription
      await supabase
        .from("users")
        .update({
          is_subscribed: true,
          subscription_date: new Date().toISOString(),
        })
        .eq("telegram_id", userId);

      const message = `🎉 Successfully subscribed to CryAIstal AI Trading!

Your wallet is now connected to our AI trading system. We'll automatically:
• Monitor top-performing traders 24/7
• Copy profitable trades in real-time
• Manage risk and position sizing
• Send you performance updates

Current Balance: ${ethBalance} ETH
Trading Status: Active ✅

Use /performance to track your trading results.
Use /unsubscribe anytime to stop trading.

Happy trading! 🚀`;

      ctx.reply(message);
    } catch (error: any) {
      console.error("Error in subscribe command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
