import { Telegraf, Context } from "telegraf";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(config.supabase.url, config.supabase.key);

export function setupUnsubscribeCommand(bot: Telegraf<Context>) {
  bot.command("unsubscribe", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Check subscription status
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (!user) {
        ctx.reply("Please use /start first to create your account.");
        return;
      }

      if (!user.is_subscribed) {
        ctx.reply("You are not currently subscribed to our trading service.");
        return;
      }

      // Deactivate subscription
      await supabase
        .from("users")
        .update({
          is_subscribed: false,
          subscription_date: null,
        })
        .eq("telegram_id", userId);

      const message = `✅ Successfully unsubscribed from CryAIstal AI Trading.

Your wallet will no longer participate in automated trading.
All current positions remain unchanged.

You can reactivate trading anytime using /subscribe.

Thank you for using CryAIstal! 🙏`;

      ctx.reply(message);
    } catch (error: any) {
      console.error("Error in unsubscribe command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
