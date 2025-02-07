import { Telegraf, Context } from "telegraf";
import { Chain, Transaction } from "../types";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";
import { UniswapService } from "./uniswap.service";
import { WalletService } from "./wallet.service";
import Moralis from "moralis";

const supabase = createClient(config.supabase.url, config.supabase.key);

// Constants
const MIN_ETH_FOR_GAS = "0.0000005"; // Lower gas buffer
const POLLING_INTERVAL = 5000; // 5 seconds

interface TrustedTrader {
  id: string;
  name: string;
  address: string;
  success_rate: number;
  total_trades: number;
  is_active: boolean;
}

interface MoralisToken {
  address: string;
  amount: string;
  usdPrice: number;
  usdAmount: number;
  symbol: string;
  logo: string;
  name: string;
  tokenType: string;
}

interface MoralisSwap {
  transactionHash: string;
  transactionIndex: number;
  transactionType: string;
  baseQuotePrice: string;
  entity: string;
  entityLogo: string;
  blockTimestamp: string;
  blockNumber: string;
  subCategory: string;
  walletAddress: string;
  walletAddressLabel: string;
  pairAddress: string;
  pairLabel: string;
  exchangeName: string;
  exchangeAddress: string;
  exchangeLogo: string;
  baseToken: string;
  quoteToken: string;
  bought: MoralisToken;
  sold: MoralisToken;
  totalValueUsd: number;
}

interface MoralisSwapResponse {
  result: MoralisSwap[];
  total?: number;
  page?: number;
  cursor?: string;
}

export class TraderService {
  private provider: ethers.WebSocketProvider;
  private uniswapService: UniswapService;
  private walletService: WalletService;
  private isTracking: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.provider = new ethers.WebSocketProvider(config.quicknode.ws_url);
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();
    this.initializeProvider();
  }

  private async initializeProvider() {
    try {
      await this.provider.getNetwork();
      console.log("WebSocket provider initialized successfully");
      await this.startTrackingTrustedTraders();
    } catch (error) {
      console.error("Failed to initialize WebSocket provider:", error);
      setTimeout(() => this.initializeProvider(), 5000);
    }
  }

  public async getTrustedTraders(): Promise<TrustedTrader[]> {
    try {
      const { data: traders, error } = await supabase
        .from("trusted_traders")
        .select("*")
        .eq("is_active", true);

      if (error) throw error;
      return traders || [];
    } catch (error) {
      console.error("Error fetching trusted traders:", error);
      return [];
    }
  }

  public async startTrackingTrustedTraders() {
    if (this.isTracking) {
      console.log("Already tracking trusted traders");
      return;
    }

    try {
      if (!process.env.MORALIS_API_KEY) {
        throw new Error("MORALIS_API_KEY not found in environment variables");
      }

      // Initialize Moralis
      await Moralis.start({
        apiKey: process.env.MORALIS_API_KEY,
      });

      console.log("Moralis initialized successfully");

      const traders = await this.getTrustedTraders();

      if (!traders || traders.length === 0) {
        console.log("No active trusted traders found");
        return;
      }

      console.log(`Found ${traders.length} active trusted traders`);
      console.log(
        "Trader addresses:",
        traders.map((t) => t.address).join(", ")
      );

      this.isTracking = true;
      this.setupMoralisTracking(traders);
    } catch (error) {
      console.error("Error starting trader tracking:", error);
      this.isTracking = false;
      setTimeout(() => this.startTrackingTrustedTraders(), 5000);
    }
  }

  private setupMoralisTracking(traders: TrustedTrader[]) {
    // Clear existing interval if any
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Set up polling interval to check for new swaps
    this.pollingInterval = setInterval(async () => {
      for (const trader of traders) {
        try {
          const response = await fetch(
            `https://deep-index.moralis.io/api/v2.2/wallets/${trader.address}/swaps?chain=base&limit=10&order=DESC`,
            {
              headers: {
                accept: "application/json",
                "X-API-Key": process.env.MORALIS_API_KEY!,
              },
            }
          );

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const data = (await response.json()) as MoralisSwapResponse;
          console.log("data", data);
          if (!data.result || data.result.length === 0) continue;

          // Process each swap
          for (const swap of data.result) {
            // Skip if already processed
            const { data: existingTx } = await supabase
              .from("transactions")
              .select("*")
              .eq("tx_hash", swap.transactionHash)
              .single();

            if (existingTx) continue;

            // Check if this is a Uniswap swap by verifying the exchange name
            if (
              swap.exchangeName === "Uniswap v3" &&
              swap.exchangeAddress.toLowerCase() ===
                config.base.uniswap.universal_router.toLowerCase()
            ) {
              console.log(`
🔍 DETECTED TRADER UNISWAP SWAP
=====================================
Trader: ${trader.name}
Hash: ${swap.transactionHash}
Type: ${swap.transactionType} (${swap.subCategory})
Pair: ${swap.pairLabel}
Sold: ${swap.sold.amount} ${swap.sold.symbol} ($${swap.sold.usdAmount.toFixed(
                2
              )})
Bought: ${swap.bought.amount} ${
                swap.bought.symbol
              } ($${swap.bought.usdAmount.toFixed(2)})
Total Value: $${swap.totalValueUsd.toFixed(2)}
Time: ${new Date(swap.blockTimestamp).toLocaleString()}
=====================================`);

              // Get transaction details
              const tx = await this.provider.getTransaction(
                swap.transactionHash
              );
              if (!tx) continue;

              // Process the swap
              await this.processTraderSwap(trader, {
                transactionHash: swap.transactionHash,
                tokenIn: {
                  address: swap.sold.address,
                  symbol: swap.sold.symbol,
                  decimals: 18, // We'll need to handle this properly
                  amount: swap.sold.amount.replace("-", ""), // Remove negative sign
                },
                tokenOut: {
                  address: swap.bought.address,
                  symbol: swap.bought.symbol,
                  decimals: 18, // We'll need to handle this properly
                  amount: swap.bought.amount,
                },
                poolFee: 500, // Default to 0.05% for now
              });
            }
          }
        } catch (error) {
          console.error(
            `Error fetching swaps for trader ${trader.name}:`,
            error
          );
        }
      }
    }, POLLING_INTERVAL);

    console.log("Moralis swap tracking started");
  }

  private async processTraderSwap(trader: TrustedTrader, swap: any) {
    try {
      // Get active subscribers
      const { data: subscribers } = await supabase
        .from("users")
        .select("*")
        .eq("is_subscribed", true);

      if (!subscribers || subscribers.length === 0) {
        console.log("No active subscribers found");
        return;
      }

      console.log(`Processing trade for ${subscribers.length} subscribers`);

      // Execute copy trades for each subscriber
      for (const subscriber of subscribers) {
        await this.copyTradeForSubscriber(subscriber, swap, trader);
      }

      // Record the transaction
      await supabase.from("transactions").insert({
        tx_hash: swap.transactionHash,
        trader_id: trader.id,
        chain: "base",
        token_address: swap.tokenIn.address,
        amount_in: swap.tokenInAmount,
        amount_out: swap.tokenOutAmount,
        status: "completed",
      });
    } catch (error) {
      console.error("Error processing trader swap:", error);
    }
  }

  private async copyTradeForSubscriber(
    subscriber: any,
    swap: any,
    trader: TrustedTrader
  ) {
    try {
      console.log(`
🔄 COPYING TRADE FOR SUBSCRIBER
=============================
User ID: ${subscriber.telegram_id}
Max Amount: ${subscriber.trading_amount} ETH
=============================`);

      // Get user's wallet and balance
      const wallet = await this.walletService.getWallet(
        subscriber.telegram_id,
        Chain.BASE
      );

      if (!wallet.provider) {
        throw new Error("Wallet provider not initialized");
      }

      const balance = await wallet.provider.getBalance(wallet.address);
      const balanceEth = ethers.formatEther(balance);

      // Calculate trade amount
      const originalAmountEth = ethers.formatUnits(
        swap.tokenInAmount,
        swap.tokenIn.decimals
      );
      const maxTradeAmountEth = parseFloat(subscriber.trading_amount);
      const tradeAmountEth = Math.min(
        parseFloat(originalAmountEth),
        maxTradeAmountEth
      ).toFixed(8);

      // Check if user has enough balance
      const gasBufferEth = MIN_ETH_FOR_GAS;
      const totalRequiredEth = (
        parseFloat(tradeAmountEth) + parseFloat(gasBufferEth)
      ).toFixed(8);

      console.log(`
💰 BALANCE CHECK
==============
Current Balance: ${balanceEth} ETH
Original Trade: ${originalAmountEth} ETH
Our Trade Amount: ${tradeAmountEth} ETH
Gas Buffer: ${gasBufferEth} ETH
Total Required: ${totalRequiredEth} ETH
==============`);

      if (parseFloat(balanceEth) < parseFloat(totalRequiredEth)) {
        console.log(`❌ Insufficient balance for trade and gas`);
        return;
      }

      // Get gas price
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || undefined;

      // Execute the copy trade
      const result = await this.uniswapService.swapExactInputSingle(
        wallet,
        Chain.BASE,
        {
          tokenIn: swap.tokenIn.address,
          tokenOut: swap.tokenOut.address,
          fee: swap.poolFee || 100,
          amountIn: ethers.parseEther(tradeAmountEth).toString(),
          slippage: 1.0,
          gasPrice,
        }
      );

      if (result.success) {
        console.log(`
✅ COPY TRADE SUCCESSFUL
======================
User: ${subscriber.telegram_id}
Hash: ${result.txHash}
Amount In: ${tradeAmountEth} ETH
Gas Used: ${result.gasUsed}
======================`);

        // Log metrics
        await this.logTradeMetrics(
          subscriber.telegram_id,
          trader.id,
          result.txHash!,
          true,
          result.gasUsed,
          gasPrice?.toString()
        );
      } else {
        console.log(`
❌ COPY TRADE FAILED
==================
User: ${subscriber.telegram_id}
Error: ${result.error}
==================`);

        // Log failed trade
        await this.logTradeMetrics(
          subscriber.telegram_id,
          trader.id,
          swap.transactionHash,
          false,
          undefined,
          undefined,
          undefined
        );
      }
    } catch (error) {
      console.error(
        `Error copying trade for subscriber ${subscriber.telegram_id}:`,
        error
      );
    }
  }

  private async logTradeMetrics(
    userId: string,
    traderId: string,
    txHash: string,
    success: boolean,
    gasUsed?: string,
    gasPrice?: string,
    profitLoss?: string
  ) {
    try {
      // Update transaction record
      await supabase
        .from("transactions")
        .update({
          status: success ? "completed" : "failed",
          gas_used: gasUsed,
          gas_price: gasPrice,
          profit_loss: profitLoss,
        })
        .eq("tx_hash", txHash);

      // Update trader metrics
      const { data: trader } = await supabase
        .from("trusted_traders")
        .select("total_trades, success_rate")
        .eq("id", traderId)
        .single();

      if (trader) {
        const newTotalTrades = trader.total_trades + 1;
        const successfulTrades =
          trader.total_trades * (trader.success_rate / 100) + (success ? 1 : 0);
        const newSuccessRate = (successfulTrades / newTotalTrades) * 100;

        await supabase
          .from("trusted_traders")
          .update({
            total_trades: newTotalTrades,
            success_rate: newSuccessRate,
          })
          .eq("id", traderId);
      }
    } catch (error) {
      console.error("Error logging trade metrics:", error);
    }
  }
}
