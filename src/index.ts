import { Telegraf } from 'telegraf';
import { config } from './config/config';
import { StartCommand } from './commands/start.command';
import { authMiddleware } from './middlewares/auth.middleware';

const bot = new Telegraf(config.botToken);

// Middleware
// bot.use(authMiddleware);

// Commands
bot.command('start', StartCommand.handle);

// Launch bot
bot.launch()
  .then(() => {
    console.log('Bot is running...');
  })
  .catch((error) => {
    console.error('Error starting bot:', error);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
