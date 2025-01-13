import { Context } from 'telegraf';
import { HashService } from '../services/hash.service';
import { supabaseService } from '../services/supabase.service';

export class StartCommand {
  static async handle(ctx: Context) {
    if (!ctx.from?.id) {
      return ctx.reply('Could not identify user.');
    }

    try {
      const existingUser = await supabaseService.getUserByTelegramId(ctx.from.id);

      if (existingUser) {
        return ctx.reply(`Welcome back! Your hash is: ${existingUser.hash}`);
      }

      const hash = HashService.generateHash();
      await supabaseService.saveUser({
        telegramId: ctx.from.id,
        hash,
        createdAt: new Date(),
      });

      return ctx.reply(`Welcome! Your new hash is: ${hash}`);
    } catch (error) {
      console.error('Start command error:', error);
      return ctx.reply('An error occurred while processing your request.');
    }
  }
}
