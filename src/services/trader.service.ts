import { Telegraf, Context } from "telegraf";
import { Chain, Transaction } from "../types";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";
import { UniswapService } from "./uniswap.service";
import { WalletService } from "./wallet.service";

const supabase = createClient(config.supabase.url, config.supabase.key);

// Interface untuk cache entries
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Cache untuk menyimpan data transaksi
const txCache = new Map<string, CacheEntry<ethers.TransactionResponse>>();
const receiptCache = new Map<string, CacheEntry<ethers.TransactionReceipt>>();

// Rate limiting dan optimasi
const BLOCKS_TO_SKIP = 0; // Tidak skip block
const MAX_TX_PER_BLOCK = 100; // Tingkatkan batas transaksi
const BATCH_SIZE = 10; // Ukuran batch yang optimal
const BATCH_DELAY = 500; // 500ms delay antar batch
const CACHE_EXPIRY = 1000 * 60 * 5; // 5 menit cache
const MAX_RETRIES = 5; // Tingkatkan retry limit
const RETRY_DELAY = 1000; // 1 detik delay retry
const REQUEST_DELAY = 100; // 100ms delay antar request

// Constants for trade management
const MIN_TRADE_AMOUNT = "0.0001"; // Minimum trade size in ETH
const MAX_TRADE_AMOUNT = "1"; // Maximum trade size in ETH
const MIN_BALANCE_BUFFER = "0.002"; // Keep 0.002 ETH for gas
const MAX_PENDING_TRADES = 5; // Maximum number of pending trades per user

interface TrustedTrader {
  id: string;
  name: string;
  address: string;
  success_rate: number;
  total_trades: number;
  is_active: boolean;
}

interface TradeMetrics {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalGasUsed: string;
  averageGasPrice: string;
  totalProfitLoss: string;
}

export class TraderService {
  private uniswapService: UniswapService;
  private walletService: WalletService;
  private isTracking: boolean = false;
  private lastProcessedNonces: Map<string, number> = new Map();
  private trustedTraderAddresses: Set<string> = new Set();
  private provider: ethers.WebSocketProvider;
  private pendingTrades: Map<string, number> = new Map(); // userId -> pending trade count

  constructor() {
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();

    // Gunakan WebSocket provider
    this.provider = new ethers.WebSocketProvider(config.quicknode.ws_url, {
      chainId: config.base.chainId,
      name: "base",
    });

    // Handle WebSocket reconnection
    this.setupWebSocketReconnection();
  }

  private setupWebSocketReconnection() {
    const ws = this.provider.websocket as any;

    ws.on("close", async () => {
      console.log("WebSocket connection closed. Reconnecting...");
      await this.reconnectWebSocket();
    });

    ws.on("error", async (error: any) => {
      console.error("WebSocket error:", error);
      await this.reconnectWebSocket();
    });
  }

  private async reconnectWebSocket() {
    try {
      // Tunggu sebentar sebelum reconnect
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Buat provider baru
      this.provider = new ethers.WebSocketProvider(config.quicknode.ws_url, {
        chainId: config.base.chainId,
        name: "base",
      });

      // Setup ulang reconnection handler
      this.setupWebSocketReconnection();

      // Restart tracking jika sedang aktif
      if (this.isTracking) {
        this.isTracking = false;
        await this.startTrackingTrustedTraders();
      }

      console.log("WebSocket successfully reconnected");
    } catch (error) {
      console.error("Error reconnecting WebSocket:", error);
      // Coba reconnect lagi setelah delay
      setTimeout(() => this.reconnectWebSocket(), 10000);
    }
  }

  // Fungsi untuk membersihkan cache yang expired
  private cleanCache() {
    const now = Date.now();
    for (const [key, value] of txCache.entries()) {
      if (now - value.timestamp > CACHE_EXPIRY) {
        txCache.delete(key);
      }
    }
    for (const [key, value] of receiptCache.entries()) {
      if (now - value.timestamp > CACHE_EXPIRY) {
        receiptCache.delete(key);
      }
    }
  }

  async startTrackingTrustedTraders() {
    if (this.isTracking) return;
    this.isTracking = true;

    try {
      const traders = await this.getTrustedTraders();
      this.trustedTraderAddresses = new Set(
        traders.map((t) => t.address.toLowerCase())
      );

      console.log(
        "🔄 Mulai tracking trusted traders:",
        Array.from(this.trustedTraderAddresses)
      );

      // Inisialisasi nonce terakhir untuk setiap trader
      for (const trader of traders) {
        const nonce = await this.provider.getTransactionCount(trader.address);
        this.lastProcessedNonces.set(trader.address.toLowerCase(), nonce);
        console.log(`Inisialisasi nonce untuk ${trader.name}: ${nonce}`);
      }

      // Subscribe ke pending transactions
      this.provider.on("pending", async (txHash) => {
        try {
          const tx = await this.provider.getTransaction(txHash);
          if (!tx) return;

          const fromAddress = tx.from.toLowerCase();
          if (!this.trustedTraderAddresses.has(fromAddress)) return;

          // Cek apakah ini transaksi baru berdasarkan nonce
          const lastNonce = this.lastProcessedNonces.get(fromAddress) || 0;
          if (tx.nonce <= lastNonce) return;

          // Update nonce terakhir
          this.lastProcessedNonces.set(fromAddress, tx.nonce);

          console.log(`🔍 Transaksi baru ditemukan dari trusted trader:
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, "gwei")} gwei
Nonce: ${tx.nonce}
`);

          // Tunggu receipt untuk memastikan transaksi berhasil
          const receipt = await tx.wait();
          if (!receipt) return;

          if (
            receipt.to?.toLowerCase() ===
            config.base.uniswap.router.toLowerCase()
          ) {
            const trader = traders.find(
              (t) => t.address.toLowerCase() === fromAddress
            );
            if (trader) {
              await this.analyzeTrade(tx, trader);
            }
          }
        } catch (error: any) {
          if (error?.message?.includes("rate limit")) {
            console.log(
              "⚠️ Rate limit hit, transaction will be processed in next block"
            );
          } else {
            console.error("Error processing transaction:", error);
          }
        }
      });

      // Subscribe ke new heads untuk backup
      this.provider.on("block", (blockNumber) => {
        console.log(`📦 New block: ${blockNumber}`);
      });
    } catch (error) {
      console.error("❌ Error starting trader tracking:", error);
      this.isTracking = false;
    }
  }

  // Fungsi helper untuk retry
  private async withRetry<T>(
    operation: () => Promise<T>,
    customRetryDelay?: number
  ): Promise<T> {
    let lastError;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        // Tambah delay kecil sebelum setiap request
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY));
        return await operation();
      } catch (error: any) {
        lastError = error;
        // Check jika error adalah rate limit
        if (
          error?.code === -32007 ||
          error?.message?.includes("request limit reached")
        ) {
          const delay = customRetryDelay || RETRY_DELAY * Math.pow(2, i); // Exponential backoff
          console.log(
            `⚠️ Rate limit hit, retry attempt ${
              i + 1
            } of ${MAX_RETRIES}, waiting ${delay}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async processTransaction(txHash: string, traders: TrustedTrader[]) {
    try {
      const tx = await this.withRetry(() =>
        this.provider.getTransaction(txHash)
      );

      if (!tx) return;

      // Cek dulu apakah transaksi dari trusted trader sebelum memproses lebih lanjut
      const fromAddress = tx.from.toLowerCase();
      if (!this.trustedTraderAddresses.has(fromAddress)) {
        return;
      }

      // Cache transaksi jika dari trusted trader
      txCache.set(txHash, { data: tx, timestamp: Date.now() });

      console.log(`🔍 Transaksi ditemukan dari trusted trader:
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, "gwei")} gwei
Nonce: ${tx.nonce}
`);

      const receipt = await this.withRetry(() =>
        this.provider.getTransactionReceipt(tx.hash)
      );
      if (!receipt) return;

      // Cache receipt
      receiptCache.set(tx.hash, { data: receipt, timestamp: Date.now() });

      if (
        receipt.to?.toLowerCase() === config.base.uniswap.router.toLowerCase()
      ) {
        const trader = traders.find(
          (t) => t.address.toLowerCase() === fromAddress
        );
        if (trader) {
          await this.analyzeTrade(tx, trader);
        }
      }
    } catch (error) {
      console.error(`Error processing transaction ${txHash}:`, error);
    }
  }

  private async validateTradeSize(
    userId: string,
    tradeAmount: string,
    chain: Chain
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      // Check minimum trade size
      if (
        ethers.parseEther(tradeAmount) < ethers.parseEther(MIN_TRADE_AMOUNT)
      ) {
        return {
          valid: false,
          error: `Trade amount too small. Minimum: ${MIN_TRADE_AMOUNT} ETH`,
        };
      }

      // Check maximum trade size
      if (
        ethers.parseEther(tradeAmount) > ethers.parseEther(MAX_TRADE_AMOUNT)
      ) {
        return {
          valid: false,
          error: `Trade amount too large. Maximum: ${MAX_TRADE_AMOUNT} ETH`,
        };
      }

      // Check user's balance
      const balance = await this.walletService.getWalletBalance(userId, chain);
      const requiredBalance =
        ethers.parseEther(tradeAmount) + ethers.parseEther(MIN_BALANCE_BUFFER);

      if (BigInt(balance) < requiredBalance) {
        return {
          valid: false,
          error: `Insufficient balance. Required: ${ethers.formatEther(
            requiredBalance
          )} ETH (including gas buffer)`,
        };
      }

      // Check pending trades limit
      const pendingTradeCount = this.pendingTrades.get(userId) || 0;
      if (pendingTradeCount >= MAX_PENDING_TRADES) {
        return {
          valid: false,
          error: `Too many pending trades. Maximum: ${MAX_PENDING_TRADES}`,
        };
      }

      return { valid: true };
    } catch (error) {
      console.error("Error validating trade size:", error);
      return {
        valid: false,
        error: "Error validating trade size",
      };
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

      // Update user metrics
      const { data: metrics } = await supabase
        .from("user_metrics")
        .select("*")
        .eq("user_id", userId)
        .single();

      const updatedMetrics: TradeMetrics = {
        totalTrades: (metrics?.totalTrades || 0) + 1,
        successfulTrades: (metrics?.successfulTrades || 0) + (success ? 1 : 0),
        failedTrades: (metrics?.failedTrades || 0) + (success ? 0 : 1),
        totalGasUsed: (
          BigInt(metrics?.totalGasUsed || 0) + BigInt(gasUsed || 0)
        ).toString(),
        averageGasPrice: metrics?.averageGasPrice || "0",
        totalProfitLoss: (
          BigInt(metrics?.totalProfitLoss || 0) + BigInt(profitLoss || 0)
        ).toString(),
      };

      await supabase.from("user_metrics").upsert({
        user_id: userId,
        ...updatedMetrics,
      });
    } catch (error) {
      console.error("Error logging trade metrics:", error);
    }
  }

  private async analyzeTrade(
    tx: ethers.TransactionResponse,
    trader: TrustedTrader
  ) {
    try {
      console.log(`
📊 Analyzing trade from ${trader.name}:
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, "gwei")} gwei
Success Rate: ${trader.success_rate}%
Total Trades: ${trader.total_trades}
`);

      // Get subscribed users
      const { data: subscribers } = await supabase
        .from("users")
        .select("*")
        .eq("is_subscribed", true);

      if (!subscribers || subscribers.length === 0) {
        console.log("No active subscribers found");
        return;
      }

      console.log(`Found ${subscribers.length} active subscribers`);

      // Process trade for each subscriber
      for (const subscriber of subscribers) {
        try {
          // Validate trade size and user's balance
          const tradeAmount = ethers.formatEther(tx.value);
          const validation = await this.validateTradeSize(
            subscriber.telegram_id,
            tradeAmount,
            Chain.BASE
          );

          if (!validation.valid) {
            console.log(
              `Skipping trade for user ${subscriber.telegram_id}: ${validation.error}`
            );
            continue;
          }

          // Increment pending trades counter
          this.pendingTrades.set(
            subscriber.telegram_id,
            (this.pendingTrades.get(subscriber.telegram_id) || 0) + 1
          );

          // Copy the trade
          const result = await this.copyTradeForUser(
            subscriber.telegram_id,
            tx,
            trader
          );

          // Decrement pending trades counter
          this.pendingTrades.set(
            subscriber.telegram_id,
            (this.pendingTrades.get(subscriber.telegram_id) || 1) - 1
          );

          // Log metrics
          if (result.receipt) {
            await this.logTradeMetrics(
              subscriber.telegram_id,
              trader.id,
              result.receipt.hash,
              result.success,
              result.receipt.gasUsed?.toString(),
              tx.gasPrice?.toString(),
              result.profitLoss
            );
          }
        } catch (error) {
          console.error(
            `Error processing trade for subscriber ${subscriber.telegram_id}:`,
            error
          );
          continue;
        }
      }
    } catch (error) {
      console.error("Error analyzing trade:", error);
      throw error;
    }
  }

  private async copyTradeForUser(
    userId: string,
    tx: ethers.TransactionResponse,
    trader: TrustedTrader
  ): Promise<{
    success: boolean;
    receipt?: ethers.TransactionReceipt;
    profitLoss?: string;
  }> {
    try {
      console.log(`
🔄 Copying trade for user ${userId}:
Trader: ${trader.name}
Hash Original: ${tx.hash}
Value: ${ethers.formatEther(tx.value)} ETH
`);

      const userWallet = await this.walletService.getWallet(userId, Chain.BASE);

      if (!userWallet || !userWallet.provider) {
        throw new Error(`Wallet not found for user ${userId}`);
      }

      // Get user's trading amount
      const { data: user } = await supabase
        .from("users")
        .select("trading_amount")
        .eq("telegram_id", userId)
        .single();

      if (!user?.trading_amount) {
        throw new Error(`Trading amount not set for user ${userId}`);
      }

      // Decode transaction input to understand the trade
      const decodedInput = this.uniswapService.decodeSwapInput(tx.data || "");
      if (!decodedInput) {
        throw new Error("Could not decode transaction input");
      }

      // Scale the trade amount based on user's settings
      const scaledAmount = this.scaleTradeAmount(
        decodedInput.amountIn.toString(),
        user.trading_amount
      );

      // Execute the swap
      const swapResult = await this.uniswapService.swapExactInputSingle(
        userWallet,
        Chain.BASE,
        {
          tokenIn: decodedInput.tokenIn,
          tokenOut: decodedInput.tokenOut,
          fee: decodedInput.fee,
          amountIn: scaledAmount,
          slippage: 1.0, // 1% slippage tolerance
        }
      );

      if (!swapResult.success) {
        throw new Error(swapResult.error || "Swap failed");
      }

      const receipt = await userWallet.provider.getTransactionReceipt(
        swapResult.txHash || ""
      );
      if (!receipt) {
        throw new Error("Failed to get transaction receipt");
      }

      return {
        success: true,
        receipt,
        profitLoss: this.calculateProfitLoss(
          scaledAmount,
          swapResult.amountOut || "0"
        ),
      };
    } catch (error) {
      console.error("Error copying trade:", error);
      return { success: false };
    }
  }

  private scaleTradeAmount(
    originalAmount: string,
    userTradingAmount: string
  ): string {
    try {
      const original = BigInt(originalAmount);
      const userAmount = ethers.parseEther(userTradingAmount);

      // Scale down if original is larger than user's amount
      if (original > userAmount) {
        return userAmount.toString();
      }

      return original.toString();
    } catch (error) {
      console.error("Error scaling trade amount:", error);
      return originalAmount;
    }
  }

  private calculateProfitLoss(amountIn: string, amountOut: string): string {
    try {
      const input = BigInt(amountIn);
      const output = BigInt(amountOut);
      return (output - input).toString();
    } catch (error) {
      console.error("Error calculating profit/loss:", error);
      return "0";
    }
  }

  async getTrustedTraders(): Promise<TrustedTrader[]> {
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

  // Process transactions in batches with improved rate limiting
  private async processBatch(transactions: string[], traders: TrustedTrader[]) {
    try {
      // Batasi jumlah transaksi yang diproses
      const limitedTxs = transactions.slice(0, MAX_TX_PER_BLOCK);

      // Filter transaksi yang perlu diproses dengan delay
      const txsToProcess: string[] = [];

      for (const txHash of limitedTxs) {
        try {
          // Tambah delay antara setiap request
          await new Promise((resolve) => setTimeout(resolve, 200));

          const tx = await this.withRetry(() =>
            this.provider.getTransaction(txHash)
          );
          if (tx && this.trustedTraderAddresses.has(tx.from.toLowerCase())) {
            txsToProcess.push(txHash);
          }
        } catch (error) {
          console.error(`Error checking transaction ${txHash}:`, error);
          continue;
        }
      }

      if (txsToProcess.length === 0) {
        return [];
      }

      console.log(
        `Processing ${txsToProcess.length} transactions from trusted traders...`
      );
      const startTime = Date.now();

      const results: any[] = [];
      for (let i = 0; i < txsToProcess.length; i += BATCH_SIZE) {
        const batch = txsToProcess.slice(i, i + BATCH_SIZE);
        console.log(
          `Processing sub-batch ${i / BATCH_SIZE + 1} of ${Math.ceil(
            txsToProcess.length / BATCH_SIZE
          )}...`
        );

        try {
          // Proses transaksi satu per satu dengan delay
          for (const txHash of batch) {
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
            await this.processTransaction(txHash, traders);
          }
        } catch (error) {
          console.error(`Error processing batch at index ${i}:`, error);
          continue;
        }
      }

      const duration = Date.now() - startTime;
      console.log(`Batch processing completed in ${duration}ms`);

      return results;
    } catch (error) {
      console.error("Error in processBatch:", error);
      return [];
    }
  }
}
