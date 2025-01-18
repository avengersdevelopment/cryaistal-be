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

      const args = ctx.message.text.split(" ");
      const withdrawAmount = args[1];
      const toAddress = args[2];

      if (!withdrawAmount || !toAddress) {
        ctx.reply(`Please provide the amount and destination address.

Format: /withdraw <amount> <address>
Examples:
• /withdraw 0.1 0x123...  (withdraw 0.1 ETH)
• /withdraw all 0x123...  (withdraw entire balance)

⚠️ Make sure to:
• Double check the destination address
• Leave some ETH for gas fees (~0.001 ETH)
• Only send to ETH addresses`);
        return;
      }

      // Validate ETH address
      if (!ethers.isAddress(toAddress)) {
        ctx.reply("Invalid ETH address. Please check and try again.");
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
        ctx.reply("No wallet found. Please use /start first to create your wallet.");
        return;
      }

      // Check if user is subscribed
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (user?.is_subscribed) {
        ctx.reply("⚠️ Please /unsubscribe from trading first before withdrawing.");
        return;
      }

      // Get current balance
      const balance = await walletService.getWalletBalance(userId, Chain.ETHEREUM);
      const ethBalance = ethers.formatEther(balance);

      // Calculate amount to withdraw
      let amountToWithdraw: string;
      if (withdrawAmount.toLowerCase() === 'all') {
        // Leave some ETH for gas
        const gasBuffer = 0.001;
        if (parseFloat(ethBalance) <= gasBuffer) {
          ctx.reply(`Insufficient balance for withdrawal.
Current balance: ${ethBalance} ETH
Minimum required (gas buffer): ${gasBuffer} ETH`);
          return;
        }
        amountToWithdraw = (parseFloat(ethBalance) - gasBuffer).toFixed(6);
      } else {
        if (isNaN(parseFloat(withdrawAmount)) || parseFloat(withdrawAmount) <= 0) {
          ctx.reply("Invalid amount. Please enter a number greater than 0.");
          return;
        }
        amountToWithdraw = withdrawAmount;
      }

      // Check if amount is valid
      if (parseFloat(amountToWithdraw) > parseFloat(ethBalance)) {
        ctx.reply(`Insufficient balance.
Amount requested: ${amountToWithdraw} ETH
Current balance: ${ethBalance} ETH`);
        return;
      }

      // Send confirmation message
      const confirmMessage = `⚠️ Please confirm withdrawal:

Amount: ${amountToWithdraw} ETH
To: ${toAddress}
Gas buffer: ~0.001 ETH
Current balance: ${ethBalance} ETH

Reply with /confirm_withdraw to proceed.`;

      // Store withdrawal info in database
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 5); // 5 minutes expiry

      await supabase.from("pending_withdrawals").upsert([{
        user_id: userId,
        amount: amountToWithdraw,
        to_address: toAddress,
        expires_at: expiresAt.toISOString()
      }]);

      await ctx.reply(confirmMessage);

    } catch (error: any) {
      console.error("Error in withdraw command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });

  // Handle withdrawal confirmation
  bot.command("confirm_withdraw", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Check if there's a pending withdrawal
      const { data: withdrawal } = await supabase
        .from("pending_withdrawals")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (!withdrawal || new Date(withdrawal.expires_at) < new Date()) {
        ctx.reply("No pending withdrawal or confirmation expired. Please start a new withdrawal.");
        return;
      }

      // Execute withdrawal
      await ctx.reply("Processing withdrawal...");
      
      const tx = await walletService.withdrawETH(
        userId,
        Chain.ETHEREUM,
        withdrawal.to_address,
        withdrawal.amount
      );

      const message = `✅ Withdrawal successful!

Amount: ${withdrawal.amount} ETH
To: ${withdrawal.to_address}
Transaction: ${tx.hash}

You can track your transaction here:
https://etherscan.io/tx/${tx.hash}`;

      await ctx.reply(message);

      // Delete pending withdrawal
      await supabase
        .from("pending_withdrawals")
        .delete()
        .eq("user_id", userId);

    } catch (error: any) {
      console.error("Error in confirm_withdraw:", error);
      if (error.message.includes("insufficient funds")) {
        ctx.reply("Insufficient funds. Please make sure you have enough ETH for the amount plus gas fees.");
      } else {
        ctx.reply("Sorry, withdrawal failed. Please try again later.");
      }
    }
  });
} 