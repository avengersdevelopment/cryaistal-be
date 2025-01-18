import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(config.supabase.url, config.supabase.key);

export function setupDepositCommand(bot: Telegraf<Context>) {
  bot.command("deposit", async (ctx) => {
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

      const message = `📥 Your BASE Deposit Address:

\`${wallet.address}\`

⚠️ Important:
1. Only send ETH on BASE network
2. Do not send from exchanges
3. Minimum deposit: 0.0001 ETH

Use /balance to check your balance after deposit.`;

      await ctx.reply(message, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Error in deposit command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
