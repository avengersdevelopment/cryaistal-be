import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const supabase = createClient(config.supabase.url, config.supabase.key);

export function setupBalanceCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("balance", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Get user's wallet
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("*")
        .eq("user_id", userId)
        .eq("chain", Chain.ETHEREUM)
        .single();

      if (!wallet) {
        ctx.reply("No wallet found. Please use /start to create your wallet.");
        return;
      }

      try {
        const balance = await walletService.getWalletBalance(
          userId,
          Chain.ETHEREUM
        );
        const formattedBalance = ethers.formatEther(balance);

        const message = `💰 Your Wallet Balance:

Address: \`${wallet.address}\`
Balance: ${formattedBalance} ETH

Need more ETH? Use /deposit to get your deposit address.
Want to start trading? Use /subscribe (min 0.0001 ETH required).`;

        await ctx.reply(message, { parse_mode: "Markdown" });
      } catch (error: any) {
        console.error("Error fetching balance:", error);
        await ctx.reply(
          `Error fetching balance: ${error.message}. Please try again later.`
        );
      }
    } catch (error: any) {
      console.error("Error in balance command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
