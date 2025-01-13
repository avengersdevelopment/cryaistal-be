import { Context, Middleware } from 'telegraf';
import { supabaseService } from '../services/supabase.service';

export const authMiddleware: Middleware<Context> = async (ctx, next) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not identify user.');
  }

  try {
    const user = await supabaseService.getUserByTelegramId(ctx.from.id);
    ctx.state.user = user;
    return next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return ctx.reply('An error occurred while authenticating.');
  }
};
