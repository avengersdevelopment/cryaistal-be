import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const supabase = createClient(config.supabase.url, config.supabase.key);

export function setupWithdrawCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("withdraw", async (ctx) => {
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
        .eq("chain", Chain.BASE)
        .single();

      if (!wallet) {
        ctx.reply("No wallet found. Please use /start to create your BASE wallet first.");
        return;
      }

      // Get current balance
      const balance = await walletService.getWalletBalance(userId, Chain.BASE);
      const formattedBalance = ethers.formatEther(balance);

      await ctx.reply(
        `To withdraw ETH from your BASE wallet, reply with:

/withdraw <amount> <address>

Example: /withdraw 0.1 0x123...

Your current balance: ${formattedBalance} ETH
Network: BASE Mainnet

⚠️ Notes:
• Minimum withdrawal: 0.0001 ETH
• Keep some ETH for gas fees
• Double check the address`
      );
    } catch (error) {
      console.error("Error in withdraw command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });

  // Handle withdraw amount and address
  bot.command(/^withdraw (.+)$/, async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      const match = ctx.message.text.match(/^\/withdraw (\d*\.?\d*) (0x[a-fA-F0-9]{40})$/);
      if (!match) {
        ctx.reply(
          "Invalid format. Please use:\n/withdraw <amount> <address>\nExample: /withdraw 0.1 0x123..."
        );
        return;
      }

      const [, amount, toAddress] = match;

      // Validate amount
      const withdrawAmount = parseFloat(amount);
      if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        ctx.reply("Invalid amount. Please enter a positive number.");
        return;
      }

      if (withdrawAmount < 0.0001) {
        ctx.reply("Minimum withdrawal amount is 0.0001 ETH");
        return;
      }

      // Validate address
      if (!ethers.isAddress(toAddress)) {
        ctx.reply("Invalid ETH address. Please check and try again.");
        return;
      }

      // Get current balance
      const balance = await walletService.getWalletBalance(userId, Chain.BASE);
      const currentBalance = parseFloat(ethers.formatEther(balance));

      if (withdrawAmount > currentBalance) {
        ctx.reply(
          `Insufficient balance. Your current balance is ${currentBalance} ETH`
        );
        return;
      }

      // Execute withdrawal
      await ctx.reply("Processing your withdrawal...");

      const tx = await walletService.withdrawETH(
        userId,
        Chain.BASE,
        toAddress,
        amount
      );

      await ctx.reply(
        `✅ Withdrawal successful!

Amount: ${amount} ETH
To: ${toAddress}
Transaction: ${tx.hash}

Network: BASE Mainnet
Explorer: https://basescan.org/tx/${tx.hash}`,
        { parse_mode: "Markdown" }
      );
    } catch (error: any) {
      console.error("Error processing withdrawal:", error);
      ctx.reply(
        `Error processing withdrawal: ${error.message}. Please try again later.`
      );
    }
  });
} 