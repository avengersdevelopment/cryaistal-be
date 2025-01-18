import { Telegraf } from "telegraf";
import * as dotenv from "dotenv";
import { setupStartCommand } from "./commands/start.command";
import { setupDepositCommand } from "./commands/deposit.command";
import { setupSubscribeCommand } from "./commands/subscribe.command";
import { setupUnsubscribeCommand } from "./commands/unsubscribe.command";
import { setupBalanceCommand } from "./commands/balance.command";
import { setupPerformanceCommand } from "./commands/performance.command";
import { authMiddleware } from "./middlewares/auth.middleware";
import { setupPositionCommand } from "./commands/position.command";

// Load environment variables
dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN || "");

// Global error handler middleware
bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (error: any) {
    console.error("Bot error:", error);
    ctx.reply("An error occurred while processing your request.");
  }
});

// Setup commands
setupStartCommand(bot);

// Protected commands (require auth)
bot.use(authMiddleware);
setupDepositCommand(bot);
setupSubscribeCommand(bot);
setupUnsubscribeCommand(bot);
setupBalanceCommand(bot);
setupPerformanceCommand(bot);
setupPositionCommand(bot);

// Help command
bot.command("help", (ctx) => {
  const message = `🤖 CryAIstal AI Trading Bot Commands:

/start - Initialize your account
/deposit - Get your wallet address
/subscribe - Start AI trading (min 0.1 ETH)
/unsubscribe - Stop AI trading
/balance - Check wallet balance
/position - View active positions and P/L
/performance - View trading stats
/help - Show this message

Need assistance? Just ask me anything!`;

  ctx.reply(message);
});

// Start bot
bot
  .launch()
  .then(() => {
    console.log("CryAIstal AI Trading Bot started successfully! 🚀");
  })
  .catch((error) => {
    console.error("Error starting bot:", error);
  });

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
