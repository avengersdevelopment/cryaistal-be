import { Telegraf, Context } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config/config";
import { ethers } from "ethers";
import { UniswapService } from "../services/uniswap.service";
import { WalletService } from "../services/wallet.service";
import { Chain } from "../types";

const supabase = createClient(config.supabase.url, config.supabase.key);

interface Position {
  token_address: string;
  token_symbol: string;
  amount: string;
  entry_price: string;
  current_price: string;
  unrealized_pnl: string;
  pnl_percentage: string;
  last_updated: Date;
}

export function setupPositionCommand(bot: Telegraf<Context>) {
  const uniswapService = new UniswapService();
  const walletService = new WalletService();

  bot.command("position", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Check if user is subscribed
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (!user || !user.is_subscribed) {
        ctx.reply("You need to be subscribed to view positions. Use /subscribe to start trading.");
        return;
      }

      // Get user's active positions
      const { data: positions } = await supabase
        .from("positions")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (!positions || positions.length === 0) {
        ctx.reply(`No active positions found.

Trading Amount: ${user.trading_amount} ETH
Available Balance: ${await getFormattedBalance(userId, walletService)} ETH`);
        return;
      }

      // Calculate current prices and P/L for each position
      const updatedPositions: Position[] = await Promise.all(
        positions.map(async (pos) => {
          const currentPrice = await uniswapService.getTokenPrice(pos.token_address);
          const unrealizedPnl = calculateUnrealizedPnl(
            pos.amount,
            pos.entry_price,
            currentPrice
          );
          const pnlPercentage = calculatePnlPercentage(
            pos.entry_price,
            currentPrice
          );

          return {
            token_address: pos.token_address,
            token_symbol: pos.token_symbol,
            amount: ethers.formatEther(pos.amount),
            entry_price: pos.entry_price,
            current_price: currentPrice,
            unrealized_pnl: unrealizedPnl,
            pnl_percentage: pnlPercentage,
            last_updated: new Date()
          };
        })
      );

      // Calculate total P/L
      const totalPnl = updatedPositions.reduce(
        (sum, pos) => sum + parseFloat(pos.unrealized_pnl),
        0
      );

      // Format message
      const positionsInfo = updatedPositions
        .map(
          (pos) => `🔹 ${pos.token_symbol}
Amount: ${pos.amount}
Entry Price: $${formatPrice(pos.entry_price)}
Current Price: $${formatPrice(pos.current_price)}
Unrealized P/L: ${formatPnl(pos.unrealized_pnl)} (${formatPercentage(pos.pnl_percentage)})`
        )
        .join("\n\n");

      const message = `📊 Your Active Positions

${positionsInfo}

📈 Summary
Total Unrealized P/L: ${formatPnl(totalPnl.toString())}
Trading Amount: ${user.trading_amount} ETH
Available Balance: ${await getFormattedBalance(userId, walletService)} ETH

Last Updated: ${new Date().toLocaleString()}

Use /performance to see your trading history
Use /unsubscribe to stop copy trading`;

      await ctx.reply(message);

    } catch (error) {
      console.error("Error in position command:", error);
      ctx.reply("Sorry, something went wrong while fetching your positions.");
    }
  });
}

// Helper functions
function calculateUnrealizedPnl(
  amount: string,
  entryPrice: string,
  currentPrice: string
): string {
  const amountNum = parseFloat(amount);
  const entryNum = parseFloat(entryPrice);
  const currentNum = parseFloat(currentPrice);
  return ((currentNum - entryNum) * amountNum).toString();
}

function calculatePnlPercentage(
  entryPrice: string,
  currentPrice: string
): string {
  const entryNum = parseFloat(entryPrice);
  const currentNum = parseFloat(currentPrice);
  return (((currentNum - entryNum) / entryNum) * 100).toString();
}

function formatPrice(price: string): string {
  return parseFloat(price).toFixed(4);
}

function formatPnl(pnl: string): string {
  const pnlNum = parseFloat(pnl);
  const sign = pnlNum >= 0 ? "+" : "";
  return `${sign}$${Math.abs(pnlNum).toFixed(2)}`;
}

function formatPercentage(percentage: string): string {
  const num = parseFloat(percentage);
  const sign = num >= 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}

async function getFormattedBalance(
  userId: string,
  walletService: WalletService
): Promise<string> {
  const balance = await walletService.getWalletBalance(userId, Chain.ETHEREUM);
  return ethers.formatEther(balance);
} 