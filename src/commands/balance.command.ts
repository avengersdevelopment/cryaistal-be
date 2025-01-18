import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { createClient } from "@supabase/supabase-js";
import { WalletService } from "../services/wallet.service";
import { ethers } from "ethers";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export function setupBalanceCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("balance", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Get user's wallets
      const { data: wallets, error } = await supabase
        .from("user_wallets")
        .select("chain, address")
        .eq("user_id", userId);

      if (error) throw error;
      if (!wallets || wallets.length === 0) {
        ctx.reply(
          "No wallets found. Please use /start to create your wallets."
        );
        return;
      }

      // Get balances for each chain
      const balancePromises = wallets.map(async (wallet) => {
        try {
          const nativeBalance = await walletService.getWalletBalance(
            userId,
            wallet.chain as Chain
          );
          const formattedBalance = ethers.formatEther(nativeBalance);

          // Get token balances from transactions table
          const { data: tokens } = await supabase
            .from("transactions")
            .select("token_address")
            .eq("user_id", userId)
            .eq("chain", wallet.chain);

          let tokenBalances = "";
          if (tokens && tokens.length > 0) {
            const provider = new ethers.JsonRpcProvider(
              process.env[`${wallet.chain.toUpperCase()}_RPC_URL`]
            );

            for (const { token_address } of tokens) {
              if (!token_address) continue;

              const contract = new ethers.Contract(
                token_address,
                ERC20_ABI,
                provider
              );
              const balance = await contract.balanceOf(wallet.address);
              const decimals = await contract.decimals();
              const symbol = await contract.symbol();

              if (balance > BigInt(0)) {
                const formatted = ethers.formatUnits(balance, decimals);
                tokenBalances += `${formatted} ${symbol}\n`;
              }
            }
          }

          return `${wallet.chain.toUpperCase()}:
Native: ${formattedBalance} ${wallet.chain === Chain.POLYGON ? "MATIC" : "ETH"}
${tokenBalances}`;
        } catch (error) {
          console.error(`Error getting balance for ${wallet.chain}:`, error);
          return `${wallet.chain.toUpperCase()}: Error fetching balance`;
        }
      });

      const balances = await Promise.all(balancePromises);

      const message = `
Your Balances:

${balances.join("\n\n")}

Use /deposit to get your deposit addresses.
`;

      ctx.reply(message);
    } catch (error: any) {
      console.error("Error in balance command:", error);
      ctx.reply("Sorry, something went wrong. Please try again later.");
    }
  });
}
