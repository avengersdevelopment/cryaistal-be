import { Telegraf } from "telegraf";
import * as dotenv from "dotenv";
import { setupStartCommand } from "./commands/start.command";
import { setupDepositCommand } from "./commands/deposit.command";
import { setupSubscribeCommand } from "./commands/subscribe.command";
import { setupUnsubscribeCommand } from "./commands/unsubscribe.command";
import { setupBalanceCommand } from "./commands/balance.command";
import { setupPerformanceCommand } from "./commands/performance.command";
import { authMiddleware } from "./middlewares/auth.middleware";
import { CHAIN_CONFIGS } from "./config/chains";
import { Chain } from "./types";

// Load environment variables
dotenv.config();

const IS_TESTNET = process.env.NODE_ENV === 'testnet';

// Log network information
console.log("\n🌐 Network Configuration:");
console.log(`Environment: ${IS_TESTNET ? '🧪 TESTNET' : '🚀 MAINNET'}`);
console.log("\nChain Details:");
Object.entries(CHAIN_CONFIGS).forEach(([chain, config]) => {
  console.log(`${chain}:`);
  console.log(`  Chain ID: ${config.chainId}`);
  console.log(`  Network: ${IS_TESTNET ? 
    chain === Chain.ETHEREUM ? 'Sepolia' :
    chain === Chain.BASE ? 'Base Goerli' :
    chain === Chain.POLYGON ? 'Mumbai' :
    'Arbitrum Goerli'
    : 
    chain === Chain.ETHEREUM ? 'Mainnet' :
    chain === Chain.BASE ? 'Base' :
    chain === Chain.POLYGON ? 'Polygon' :
    'Arbitrum One'
  }`);
});
console.log("\n");

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

// Help command
bot.command("help", (ctx) => {
  const message = `🤖 CryAIstal AI Trading Bot Commands:

/start - Initialize your account
/deposit - Get your wallet address
/subscribe - Start AI trading (min 0.1 ETH)
/unsubscribe - Stop AI trading
/balance - Check wallet balance
/performance - View trading stats
/help - Show this message

Network: ${IS_TESTNET ? '🧪 TESTNET' : '🚀 MAINNET'}
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
