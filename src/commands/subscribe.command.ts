import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { TraderService } from "../services/trader.service";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const supabase = createClient(config.supabase.url, config.supabase.key);
const MIN_ETH_REQUIRED = "0.0001"; // Minimum lowered to 0.0001 ETH
const ALLOWED_PERCENTAGES = [10, 25, 50, 100];

export function setupSubscribeCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();
  const traderService = new TraderService();

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
        const message = `You are already subscribed! 🎯

Trading Status: Active ✅
Use /performance to check your trading results.
Use /unsubscribe to stop automated trading.`;

        ctx.reply(message);
        return;
      }

      // Check ETH balance first
      const balance = await walletService.getWalletBalance(
        userId,
        Chain.ETHEREUM
      );
      const ethBalance = ethers.formatEther(balance);

      // Always check minimum balance first
      if (parseFloat(ethBalance) < parseFloat(MIN_ETH_REQUIRED)) {
        const message = `Insufficient ETH balance to start trading.

Required minimum: ${MIN_ETH_REQUIRED} ETH
Current balance: ${ethBalance} ETH

Please use /deposit to get your wallet address and add more ETH.`;
        ctx.reply(message);
        return;
      }

      const args = ctx.message.text.split(" ");
      const tradingInput = args[1];

      if (!tradingInput) {
        // Calculate amounts for each percentage
        const percentageAmounts = ALLOWED_PERCENTAGES.map(percent => {
          const amount = (parseFloat(ethBalance) * (percent / 100)).toFixed(4);
          return { percent, amount };
        });

        await ctx.reply(`Please select the percentage of your balance to use for trading, or enter a custom amount:

Your balance: ${ethBalance} ETH

Format for custom amount:
/subscribe <eth_amount>
Example: /subscribe 0.05`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "10%", callback_data: "subscribe_10" },
                { text: "25%", callback_data: "subscribe_25" },
                { text: "50%", callback_data: "subscribe_50" },
                { text: "100%", callback_data: "subscribe_100" }
              ]
            ]
          }
        });
        return;
      }

      let tradingAmount: string;
      let percentageUsed: number | null = null;
      
      // Check if input is percentage
      if (tradingInput.endsWith('%')) {
        const percentage = parseFloat(tradingInput.slice(0, -1));
        
        if (!ALLOWED_PERCENTAGES.includes(percentage)) {
          ctx.reply(`Invalid percentage. Please select from the available options: ${ALLOWED_PERCENTAGES.join('%,  ')}%`);
          return;
        }

        tradingAmount = (parseFloat(ethBalance) * (percentage / 100)).toFixed(8);
        percentageUsed = percentage;

        // Check if percentage amount meets minimum requirement
        if (parseFloat(tradingAmount) < parseFloat(MIN_ETH_REQUIRED)) {
          const message = `Insufficient ETH balance to start trading.

Required minimum: ${MIN_ETH_REQUIRED} ETH
Current balance: ${ethBalance} ETH

Please use /deposit to get your wallet address and add more ETH.`;
          ctx.reply(message);
          return;
        }
      } else {
        // Handle fixed amount input
        if (isNaN(parseFloat(tradingInput)) || parseFloat(tradingInput) <= 0) {
          ctx.reply("Invalid ETH amount. Please enter a number greater than 0.");
          return;
        }
        tradingAmount = tradingInput;
        percentageUsed = (parseFloat(tradingAmount) / parseFloat(ethBalance)) * 100;
      }

      if (parseFloat(tradingAmount) > parseFloat(ethBalance)) {
        const message = `Insufficient ETH balance to start trading.

Required minimum: ${MIN_ETH_REQUIRED} ETH
Current balance: ${ethBalance} ETH

Please use /deposit to get your wallet address and add more ETH.`;
        ctx.reply(message);
        return;
      }

      // Get trusted traders info
      const trustedTraders = await traderService.getTrustedTraders();

      if (trustedTraders.length === 0) {
        ctx.reply(
          "No active traders available at the moment. Please try again later."
        );
        return;
      }

      // Activate subscription
      const { error: updateError } = await supabase
        .from("users")
        .update({
          is_subscribed: true,
          subscription_date: new Date().toISOString(),
          trading_amount: tradingAmount
        })
        .eq("telegram_id", userId);

      if (updateError) {
        console.error("Error updating subscription status:", updateError);
        throw updateError;
      }

      console.log(`Successfully updated subscription for user ${userId}`);

      // Double check subscription status
      const { data: updatedUser } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      console.log("Updated user data:", updatedUser);

      const tradersInfo = trustedTraders
        .map(
          (t) => `• ${t.name}
  Success Rate: ${t.success_rate.toFixed(1)}%
  Total Trades: ${t.total_trades}`
        )
        .join("\n\n");

      const message = `🎉 Successfully subscribed to CryAIstal AI Trading!

Your wallet is now connected to our AI trading system. 
Trading amount: ${tradingAmount} ETH (${percentageUsed.toFixed(1)}% of your balance)

We will automatically copy trades from our trusted traders:

${tradersInfo}

Current Balance: ${ethBalance} ETH
Trading Status: Active ✅

We will automatically:
• Monitor traders 24/7
• Copy profitable trades in real-time
• Manage risk and position sizing
• Send performance updates

Use /performance to track your trading results.
Use /unsubscribe anytime to stop trading.

Happy trading! 🚀`;

      await ctx.reply(message);

      // Start tracking traders if not already tracking
      await traderService.startTrackingTrustedTraders();
    } catch (error: any) {
      console.error("Error in subscribe command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });

  // Handle callback queries for percentage selections
  bot.action(/subscribe_(\d+)/, async (ctx) => {
    try {
      const percentage = ctx.match[1];
      await ctx.answerCbQuery(); // Acknowledge the button press
      
      // Execute subscribe command with selected percentage
      await ctx.reply(`/subscribe ${percentage}%`);
    } catch (error) {
      console.error("Error handling subscription callback:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
