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
        // Check if user has BASE wallet
        const { data: wallet } = await supabase
          .from("user_wallets")
          .select("*")
          .eq("user_id", userId)
          .eq("chain", Chain.BASE)
          .single();

        if (wallet) {
          const message = `Welcome back! 🎉

Your BASE wallet is already set up:
\`${wallet.address}\`

What would you like to do?
/deposit - Get your deposit address
/balance - Check your balance
/subscribe - Start AI trading
/help - See all commands`;

          await ctx.reply(message, { parse_mode: "Markdown" });
          return;
        }
      }

      // Create new user if not exists
      if (!existingUser) {
        const { error: userError } = await supabase.from("users").insert([
          {
            telegram_id: userId,
            username: ctx.from.username || "",
            first_name: ctx.from.first_name || "",
            last_name: ctx.from.last_name || "",
            is_subscribed: false,
          },
        ]);

        if (userError) throw userError;
      }

      // Create BASE wallet
      const { wallet, privateKey } = await walletService.createWalletWithKey(
        userId,
        Chain.BASE
      );

      const message = `🎉 Welcome to CryAIstal AI Trading Bot!

Your BASE wallet has been created:
\`${wallet.address}\`

⚠️ IMPORTANT: Save your private key securely!
\`${privateKey}\`

Next steps:
1. Send ETH to your wallet using /deposit
2. Check balance with /balance
3. Start trading with /subscribe (min 0.0001 ETH)

Need help? Use /help to see all commands.

Network: BASE Mainnet`;

      await ctx.reply(message, { parse_mode: "Markdown" });
    } catch (error: any) {
      console.error("Error in start command:", error);
      ctx.reply(
        "Sorry, something went wrong while setting up your account. Please try again."
      );
    }
  });
}
