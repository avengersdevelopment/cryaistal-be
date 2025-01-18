import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

export function setupDepositCommand(bot: Telegraf<Context>) {
  bot.command("deposit", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Get user's wallets
      const { data: wallets, error } = await supabase
        .from("user_wallets")
        .select("chain, address")
        .eq("user_id", userId);

      if (error) throw error;
      if (!wallets || wallets.length === 0) {
        ctx.reply(
          "No wallets found. Please use /start to create your wallets."
        );
        return;
      }

      const message = `
Your deposit addresses:

${wallets
  .map(
    (wallet) => `${wallet.chain.toUpperCase()}:
\`${wallet.address}\`
`
  )
  .join("\n")}

Important:
1. Only send tokens on the correct chain
2. Start with a small test amount
3. Transactions are irreversible

Use /balance to check your balances after depositing.
`;

      ctx.reply(message, { parse_mode: "Markdown" });
    } catch (error: any) {
      console.error("Error in deposit command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
