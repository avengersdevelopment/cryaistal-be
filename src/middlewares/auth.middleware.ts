import { Context } from "telegraf";
import { supabaseService } from "../services/supabase.service";

export async function authMiddleware(ctx: Context, next: () => Promise<void>) {
  try {
    if (!ctx.from) {
      ctx.reply("Could not identify user.");
      return;
    }

    const user = await supabaseService.getUserByTelegramId(
      ctx.from.id.toString()
    );
    if (!user) {
      ctx.reply("Please use /start to register first.");
      return;
    }

    await next();
  } catch (error: any) {
    console.error("Auth middleware error:", error);
    ctx.reply("An error occurred while processing your request.");
  }
}
