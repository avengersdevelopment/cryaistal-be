import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
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

      // Get user's subscription status
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (!user) {
        ctx.reply("User not found. Please use /start first.");
        return;
      }

      if (!user.is_subscribed) {
        ctx.reply("You are not currently subscribed to AI trading.");
        return;
      }

      // Update subscription status
      const { error } = await supabase
        .from("users")
        .update({ is_subscribed: false })
        .eq("telegram_id", userId);

      if (error) throw error;

      // Check if there are any remaining subscribers
      const { data: activeSubscribers } = await supabase
        .from("users")
        .select("telegram_id")
        .eq("is_subscribed", true);

      const subscriberCount = activeSubscribers?.length || 0;
      console.log(`
📊 UNSUBSCRIBE EVENT
===================
User: ${userId}
Remaining Subscribers: ${subscriberCount}
Time: ${new Date().toLocaleTimeString()}
===================`);

      await ctx.reply(
        `✅ Successfully unsubscribed from AI trading.

You can now withdraw your funds using /withdraw command.
To start trading again, use /subscribe.

Network: BASE Mainnet`
      );
    } catch (error) {
      console.error("Error in unsubscribe command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
