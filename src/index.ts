import { Telegraf } from "telegraf";
import * as dotenv from "dotenv";
import { setupStartCommand } from "./commands/start.command";
import { setupDepositCommand } from "./commands/deposit.command";
import { setupFollowCommand } from "./commands/follow.command";
import { setupBalanceCommand } from "./commands/balance.command";

// Load environment variables
dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN || "");

// Setup commands
setupStartCommand(bot);
setupDepositCommand(bot);
setupFollowCommand(bot);
setupBalanceCommand(bot);

// Error handling
bot.catch((err: any) => {
  console.error("Bot error:", err);
});

// Start bot
bot
  .launch()
  .then(() => {
    console.log("Bot started successfully");
  })
  .catch((error) => {
    console.error("Error starting bot:", error);
  });

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
