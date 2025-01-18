import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { createClient } from "@supabase/supabase-js";
import { TraderService } from "../services/trader.service";
import { ethers } from "ethers";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

export function setupFollowCommand(bot: Telegraf<Context>) {
  const traderService = new TraderService();

  bot.command("follow", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      const args = ctx.message.text.split(" ");
      if (args.length !== 3) {
        ctx.reply(
          "Usage: /follow <chain> <address>\nExample: /follow ethereum 0x123..."
        );
        return;
      }

      const [_, chainArg, address] = args;
      const chain = chainArg.toLowerCase() as Chain;

      // Validate chain
      if (!Object.values(Chain).includes(chain)) {
        ctx.reply(
          `Invalid chain. Supported chains: ${Object.values(Chain).join(", ")}`
        );
        return;
      }

      // Validate address
      if (!ethers.isAddress(address)) {
        ctx.reply("Invalid Ethereum address format");
        return;
      }

      // Check if already following
      const { data: existing } = await supabase
        .from("trader_followers")
        .select("*")
        .eq("user_id", userId)
        .eq("trader_address", address)
        .eq("chain", chain)
        .single();

      if (existing) {
        ctx.reply("You are already following this trader");
        return;
      }

      // Start tracking the trader
      await traderService.trackTrader(address, chain);

      // Add follower record
      await supabase.from("trader_followers").insert([
        {
          user_id: userId,
          trader_address: address,
          chain,
          followed_at: new Date().toISOString(),
        },
      ]);

      // Get trader profile or create if doesn't exist
      try {
        await traderService.getTraderProfile(address, chain);
      } catch {
        await supabase.from("trader_profiles").insert([
          {
            address,
            chain,
            is_active: true,
            followers: 1,
            total_volume: "0",
            profit_loss: "0",
          },
        ]);
      }

      const message = `
Successfully following trader on ${chain.toUpperCase()}:
\`${address}\`

I'll notify you when this trader makes trades, and automatically copy them to your wallet.
Use /unfollow ${chain} ${address} to stop following this trader.
`;

      ctx.reply(message, { parse_mode: "Markdown" });
    } catch (error: any) {
      console.error("Error in follow command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
