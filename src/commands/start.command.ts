import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

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
        ctx.reply(`Welcome back! Use /help to see available commands.`);
        return;
      }

      // Create user record
      await supabase.from("users").insert([
        {
          telegram_id: userId,
          created_at: new Date().toISOString(),
        },
      ]);

      // Create wallets for supported chains
      const chains = Object.values(Chain);
      for (const chain of chains) {
        await walletService.createWallet(userId, chain);
      }

      const message = `
Welcome to the Copy Trading Bot! 🚀

I've created wallets for you on all supported chains:
${chains.map((chain) => `- ${chain.toUpperCase()}`).join("\n")}

Available commands:
/deposit - Get your deposit addresses
/follow <address> - Start following a trader
/unfollow <address> - Stop following a trader
/balance - Check your balances
/traders - List active traders
/help - Show this help message

Please note:
1. Always verify addresses before sending funds
2. Start with small amounts to test
3. Trading involves risk - never invest more than you can afford to lose

Need help? Use /help for command details.
`;

      ctx.reply(message);
    } catch (error: any) {
      console.error("Error in start command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
