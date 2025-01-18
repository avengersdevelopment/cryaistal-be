import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(config.supabase.url, config.supabase.key);

export function setupStartCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("start", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Check if user already exists
      const { data: existingUser } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (existingUser) {
        // Check if wallet exists
        const { data: wallet } = await supabase
          .from("user_wallets")
          .select("*")
          .eq("user_id", userId)
          .eq("chain", Chain.ETHEREUM)
          .single();

        if (!wallet) {
          // Create wallet if doesn't exist
          await walletService.createWallet(userId, Chain.ETHEREUM);
        }

        const message = `Welcome back to CryAIstal! 🤖

Your AI-powered crypto trading assistant is ready to help.

Current Status: ${
          existingUser.is_subscribed ? "✅ Subscribed" : "❌ Not Subscribed"
        }

Available Commands:
/subscribe - Start automated trading with our AI
/balance - Check your wallet balances
/deposit - Get your deposit address
/position - View active positions and P/L
/performance - View your trading performance
/help - Show detailed information

Need assistance? Just ask me anything!`;

        await ctx.reply(message);
        return;
      }

      // Create new user
      await supabase.from("users").insert([
        {
          telegram_id: userId,
          created_at: new Date().toISOString(),
          is_subscribed: false,
        },
      ]);

      // Create ETH wallet and get private key
      const { wallet: ethWallet, privateKey } =
        await walletService.createWalletWithKey(userId, Chain.ETHEREUM);

      // First message with wallet info
      const welcomeMessage = `Welcome to CryAIstal! 🤖

I'm your AI-powered crypto trading assistant. I use advanced algorithms to identify and copy the most profitable traders in real-time.

✅ Your ETH wallet has been created successfully!
Address: \`${ethWallet.address}\`

⚠️ IMPORTANT: Below is your wallet's private key. Save it securely and NEVER share it with anyone:`;

      await ctx.reply(welcomeMessage, { parse_mode: "Markdown" });

      // Send private key in a separate message for better security
      const privateKeyMessage = `🔐 Private Key:\n\`${privateKey}\`\n\n⚠️ WARNING:\n• Save this key somewhere safe\n• Never share it with anyone\n• We won't show it again\n• You'll need it to recover your wallet`;

      await ctx.reply(privateKeyMessage, { parse_mode: "Markdown" });

      // Final instructions message
      const instructionsMessage = `Here's how to get started:

1. Use /deposit to verify your wallet address
2. Fund your wallet with ETH (min 0.1 ETH recommended)
3. Use /subscribe to activate AI trading

⚠️ Important Notes:
• Start with an amount you're comfortable with
• All trades are automated once subscribed
• Performance updates sent in real-time

Need help? Use /help or just ask me anything!`;

      await ctx.reply(instructionsMessage);
    } catch (error: any) {
      console.error("Error in start command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
