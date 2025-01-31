import { Telegraf, Context } from "telegraf";
import { Chain, Transaction } from "../types";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";
import { UniswapService } from "./uniswap.service";
import { WalletService } from "./wallet.service";

const supabase = createClient(config.supabase.url, config.supabase.key);

// Constants
const RATE_LIMIT = 50; // Quicknode limit 125, kita set 50 untuk safety
const REQUEST_WINDOW = 1000; // 1 detik window
const BLOCK_BATCH_SIZE = 5; // Proses 5 block sekaligus
const BLOCK_PROCESS_INTERVAL = 2000; // 2 detik interval antar batch
const REQUEST_QUEUE_SIZE = 100;
const BATCH_SIZE = 1; // Hanya proses 1 tx per batch
const BATCH_INTERVAL = 2000; // Naikkan ke 2 detik
const CACHE_CLEANUP_INTERVAL = 1800000;
const REQUEST_TIMEOUT = 5000;
const REQUEST_DELAY = 1000; // Naikkan ke 1 detik
const MAX_RETRIES = 3;
const MAX_TX_PER_BLOCK = 50;
const MIN_TRADE_AMOUNT = "0.0001";
const MAX_TRADE_AMOUNT = "1";
const MIN_ETH_FOR_GAS = "0.0000005"; // Lower gas buffer
const MIN_BALANCE_BUFFER = "0.0000005"; // Lower safety buffer
const MAX_PENDING_TRADES = 5;
const BATCH_DELAY = 200;
const MAX_QUEUE_SIZE = 50; // Batasi ukuran queue
const UNIVERSAL_ROUTER_V2 = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

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

interface QueuedTrade {
  userId: string;
  tx: ethers.TransactionResponse;
  trader: TrustedTrader;
  attempts: number;
  lastAttempt: number;
}

interface MonitoringState {
  isActive: boolean;
  subscriberCount: number;
  lastCheck: number;
}

interface RequestQueue {
  timestamp: number;
  count: number;
}

export class TraderService {
  private uniswapService: UniswapService;
  private walletService: WalletService;
  private isTracking: boolean = false;
  private lastProcessedNonces: Map<string, number> = new Map();
  private trustedTraderAddresses: Set<string> = new Set();
  private provider!: ethers.WebSocketProvider; // Use definite assignment assertion
  private pendingTrades: Map<string, number> = new Map(); // userId -> pending trade count
  private txQueue: Array<{ hash: string; blockNumber: number }> = [];
  private isProcessingQueue = false;
  private requestCount = 0;
  private lastResetTime = Date.now();
  private tradeQueue: QueuedTrade[] = [];
  private readonly QUEUE_PROCESS_INTERVAL = 1000; // 1 detik
  private readonly MAX_GAS_PRICE = ethers.parseUnits("100", "gwei"); // 100 gwei
  private queueInterval: NodeJS.Timeout | null = null;
  private readonly PENDING_TX_BATCH_SIZE = 5; // Batasi jumlah transaksi pending yang diproses
  private readonly PENDING_TX_INTERVAL = 2000; // Naikkan ke 2 detik
  private pendingTxQueue: string[] = [];
  private isProcessingPendingTx = false;
  private readonly SWAP_ROUTER: string;
  private readonly UNIVERSAL_ROUTER: string;
  private txCache: Map<string, CacheEntry<ethers.TransactionResponse>>;
  private receiptCache: Map<string, CacheEntry<ethers.TransactionReceipt>>;
  private processedTxCache: Map<string, boolean>;
  private readonly rateLimit: number = RATE_LIMIT;
  private monitoringState: MonitoringState;
  private swapTopics: string[];
  private requestQueue: RequestQueue[] = [];
  private lastProcessedBlock: number = 0;
  private processingBlocks: boolean = false;

  constructor() {
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();

    this.txCache = new Map();
    this.receiptCache = new Map();
    this.processedTxCache = new Map();
    this.pendingTxQueue = [];
    this.isProcessingQueue = false;
    this.requestCount = 0;
    this.lastResetTime = Date.now();
    this.trustedTraderAddresses = new Set();
    this.SWAP_ROUTER = config.base.uniswap.router.toLowerCase();
    this.UNIVERSAL_ROUTER = config.base.uniswap.universal_router.toLowerCase();

    this.monitoringState = {
      isActive: false,
      subscriberCount: 0,
      lastCheck: 0,
    };

    // Pre-compute event topics
    this.swapTopics = [
      ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
      ethers.id("ExactInputSingle(address,uint256,uint256,uint160)"),
    ];

    this.initializeProvider();
    this.startQueueProcessor();
    setInterval(() => this.cleanCache(), CACHE_CLEANUP_INTERVAL);
    setInterval(() => this.checkSubscribers(), 60000); // Check subscribers every minute
  }

  private async initializeProvider() {
    try {
      this.provider = new ethers.WebSocketProvider(config.quicknode.ws_url, {
        chainId: config.base.chainId,
        name: "base",
      });

      console.log(`
🔌 WEBSOCKET INITIALIZED
=======================
Chain: Base
Time: ${new Date().toLocaleTimeString()}
=======================`);

      // Setup reconnection logic menggunakan websocket internal
      const ws = this.provider.websocket as WebSocket;
      ws.addEventListener("close", () => {
        console.log("🔄 WebSocket terputus, mencoba reconnect...");
        setTimeout(() => this.initializeProvider(), 5000);
      });

      // Monitor network events
      this.provider.on("network", (newNetwork, oldNetwork) => {
        if (oldNetwork) {
          console.log("🔄 Network changed, reinitializing connection...");
          setTimeout(() => this.initializeProvider(), 1000);
        }
      });

      await this.setupMonitoring();
    } catch (error) {
      console.error("Provider initialization failed:", error);
      setTimeout(() => this.initializeProvider(), 5000);
    }
  }

  private async setupMonitoring() {
    // Only setup if we have active subscribers
    const subscribers = await this.getActiveSubscribers();
    if (subscribers.length === 0) {
      console.log(`
💤 MONITORING STOPPED
===================
Reason: No active subscribers
Time: ${new Date().toLocaleTimeString()}
===================`);

      // Stop all monitoring
      this.stopMonitoring();
      return;
    }

    // Get trusted traders
    const traders = await this.getTrustedTraders();
    this.trustedTraderAddresses = new Set(
      traders.map((t) => t.address.toLowerCase())
    );

    if (this.trustedTraderAddresses.size === 0) {
      console.log("⚠️ No trusted traders configured");
      return;
    }

    // Remove existing listeners
    this.provider.removeAllListeners();

    // Monitor Uniswap V3 Pool Swap events
    const poolSwapFilter = {
      address: "0xd0b53D9277642d899DF5C87A3966A349A798F224", // WETH/USDC Pool
      topics: [
        ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
      ],
    };

    this.provider.on(poolSwapFilter, async (log) => {
      try {
        if (this.processedTxCache.has(log.transactionHash)) return;

        const tx = await this.provider.getTransaction(log.transactionHash);
        if (!tx || !this.trustedTraderAddresses.has(tx.from.toLowerCase()))
          return;

        // Decode the swap event
        const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
          ["int256", "int256", "uint160", "uint128", "int24"],
          ethers.dataSlice(log.data, 0)
        );

        const [amount0, amount1, sqrtPriceX96, liquidity, tick] = decodedData;

        console.log(`
🔄 POOL SWAP DETECTED
====================
Hash: ${log.transactionHash}
Trader: ${tx.from}
Amount0: ${amount0.toString()}
Amount1: ${amount1.toString()}
Tick: ${tick.toString()}
====================`);

        await this.processTraderTransaction(tx);
      } catch (error) {
        if (error instanceof Error && error.message.includes("rate limit")) {
          console.log(
            "⏳ Rate limit on swap event, will catch in block monitoring"
          );
        }
      }
    });

    this.monitoringState.isActive = true;
    this.monitoringState.subscriberCount = subscribers.length;
    this.monitoringState.lastCheck = Date.now();

    console.log(`
🎯 POOL MONITORING ACTIVE
========================
Pool: WETH/USDC
Address: 0xd0b53D9277642d899DF5C87A3966A349A798F224
Subscribers: ${subscribers.length}
Trusted Traders: ${this.trustedTraderAddresses.size}
========================`);

    // Keep block monitoring as backup
    this.startBlockMonitoring();
  }

  private async processTraderTransaction(tx: ethers.TransactionResponse) {
    // Skip if already processed
    if (this.processedTxCache.has(tx.hash)) return;

    try {
      console.log(`
🔍 PROCESSING TRANSACTION
=======================
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Data Length: ${tx.data.length}
=======================`);

      // Decode swap data
      const decodedSwap = await this.uniswapService.decodeSwapInput(tx.data);

      if (!decodedSwap) {
        console.log("❌ Failed to decode swap data");
        return;
      }

      console.log(`
✅ DECODED SWAP DATA
==================
Token In: ${decodedSwap.tokenIn}
Token Out: ${decodedSwap.tokenOut}
Fee: ${decodedSwap.fee}
Amount In: ${decodedSwap.amountIn.toString()} wei
==================`);

      // Cache the transaction
      this.txCache.set(tx.hash, { data: tx, timestamp: Date.now() });
      this.processedTxCache.set(tx.hash, true);

      // Get active subscribers
      const subscribers = await this.getActiveSubscribers();

      // Process for each subscriber
      for (const subscriber of subscribers) {
        try {
          await this.copyTradeForSubscriber(subscriber, tx, decodedSwap);
        } catch (error) {
          console.error(
            `Error copying trade for subscriber ${subscriber.telegram_id}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error("Error processing trader transaction:", error);
    }
  }

  private async copyTradeForSubscriber(
    subscriber: any,
    tx: ethers.TransactionResponse,
    decodedSwap: any
  ) {
    try {
      console.log(`
🔄 COPYING TRADE FOR SUBSCRIBER
=============================
User ID: ${subscriber.telegram_id}
Max Amount: ${subscriber.trading_amount} ETH
=============================`);

      // Get user's wallet and balance first
      const wallet = await this.walletService.getWallet(
        subscriber.telegram_id,
        Chain.BASE
      );

      if (!wallet.provider) {
        throw new Error("Wallet provider not initialized");
      }

      const balance = await wallet.provider.getBalance(wallet.address);
      const balanceEth = ethers.formatEther(balance);

      // Get original transaction value
      const originalAmountWei = decodedSwap.amountIn;
      const originalAmountEth = ethers.formatEther(originalAmountWei);

      // Calculate proportional trade amount (use the same proportion as original trade)
      const maxTradeAmountEth = parseFloat(subscriber.trading_amount);
      const tradeAmountEth = Math.min(
        parseFloat(originalAmountEth),
        maxTradeAmountEth
      ).toFixed(8);

      // Calculate required amounts
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

      // Get latest gas price
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || undefined;

      // Define common token addresses
      const WETH = "0x4200000000000000000000000000000000000006";
      const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

      // Get token addresses from decoded swap
      const tokenIn =
        decodedSwap.tokenIn === ethers.ZeroAddress ? WETH : decodedSwap.tokenIn;
      const tokenOut =
        decodedSwap.tokenOut === ethers.ZeroAddress
          ? USDC
          : decodedSwap.tokenOut;

      // Execute the copy trade with scaled amount
      const result = await this.uniswapService.swapExactInputSingle(
        wallet,
        Chain.BASE,
        {
          tokenIn,
          tokenOut,
          fee: decodedSwap.fee || 100, // Use decoded fee or default to 0.01%
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
      } else {
        console.log(`
❌ COPY TRADE FAILED
==================
User: ${subscriber.telegram_id}
Error: ${result.error}
==================`);
      }
    } catch (error) {
      console.error(
        `Error copying trade for subscriber ${subscriber.telegram_id}:`,
        error
      );
    }
  }

  private async checkSubscribers() {
    try {
      const subscribers = await this.getActiveSubscribers();

      // Jika tidak ada subscribers dan monitoring masih aktif
      if (subscribers.length === 0 && this.monitoringState.isActive) {
        console.log(`
🛑 STOPPING MONITORING
====================
Reason: No active subscribers
Previous State: Active
Action: Stopping all processes
Time: ${new Date().toLocaleTimeString()}
====================`);

        // Stop semua proses monitoring
        this.stopMonitoring();
        return;
      }

      // Jika ada subscribers baru dan monitoring tidak aktif
      if (subscribers.length > 0 && !this.monitoringState.isActive) {
        console.log(`
🚀 STARTING MONITORING
===================
Reason: New subscribers detected
Count: ${subscribers.length}
Time: ${new Date().toLocaleTimeString()}
===================`);

        // Start monitoring
        await this.setupMonitoring();
      }

      // Update subscriber count
      this.monitoringState.subscriberCount = subscribers.length;
      this.monitoringState.lastCheck = Date.now();
    } catch (error) {
      console.error("Error checking subscribers:", error);
    }
  }

  private async getActiveSubscribers() {
    const { data: subscribers } = await supabase
      .from("users")
      .select("*")
      .eq("is_subscribed", true);

    return subscribers || [];
  }

  private async cleanCache(): Promise<void> {
    const now = Date.now();

    // Bersihkan tx cache
    for (const [key, value] of this.txCache.entries()) {
      if (now - value.timestamp > 60000) {
        this.txCache.delete(key);
      }
    }

    // Bersihkan receipt cache
    for (const [key, value] of this.receiptCache.entries()) {
      if (now - value.timestamp > 60000) {
        this.receiptCache.delete(key);
      }
    }

    // Reset processed tx cache
    this.processedTxCache.clear();

    console.log("🧹 Cache dibersihkan");
  }

  private async processQueue() {
    if (this.isProcessingQueue || this.txQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.txQueue.length > 0) {
      // Reset rate limit counter setiap detik
      const now = Date.now();
      if (now - this.lastResetTime >= 1000) {
        this.requestCount = 0;
        this.lastResetTime = now;
      }

      // Cek rate limit
      if (this.requestCount >= this.rateLimit) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const tx = this.txQueue.shift();
      if (!tx) continue;

      try {
        this.requestCount++;
        const txResponse = await this.provider.getTransaction(tx.hash);
        if (!txResponse) continue;

        // Cek apakah dari trusted trader
        if (this.trustedTraderAddresses.has(txResponse.from.toLowerCase())) {
          console.log(`
📝 Transaksi dari trusted trader terdeteksi:
Block: ${tx.blockNumber}
Hash: ${txResponse.hash}
From: ${txResponse.from}
To: ${txResponse.to}
Value: ${ethers.formatEther(txResponse.value)} ETH
          `);

          // Coba decode sebagai transaksi Uniswap
          try {
            const decodedInput = this.uniswapService.decodeSwapInput(
              txResponse.data || ""
            );
            if (decodedInput) {
              console.log("✅ Transaksi swap Uniswap terdeteksi!");
              console.log(
                "📊 Decoded input:",
                JSON.stringify(decodedInput, null, 2)
              );

              const trader = (await this.getTrustedTraders()).find(
                (t) => t.address.toLowerCase() === txResponse.from.toLowerCase()
              );

              if (trader) {
                console.log("🔄 Memulai copy trade...");
                await this.analyzeTrade(txResponse, trader);
              }
            }
          } catch (error) {
            // Bukan transaksi Uniswap, lanjutkan
            continue;
          }
        }
      } catch (error: any) {
        if (error?.error?.code === -32007) {
          // Rate limit hit, tunggu 1 detik
          await new Promise((resolve) => setTimeout(resolve, 1000));
          // Masukkan kembali transaksi ke queue
          this.txQueue.unshift(tx);
        } else {
          console.error("Error processing transaction:", error);
        }
      }
    }

    this.isProcessingQueue = false;
  }

  async startTrackingTrustedTraders() {
    if (this.isTracking) return;
    this.isTracking = true;

    try {
      const traders = await this.getTrustedTraders();
      this.trustedTraderAddresses = new Set(
        traders.map((t) => t.address.toLowerCase())
      );

      if (this.trustedTraderAddresses.size === 0) {
        console.log("❌ Tidak ada trusted trader yang aktif");
        return;
      }

      console.log(
        "🔄 Mulai tracking trusted traders:",
        Array.from(this.trustedTraderAddresses)
      );

      // Subscribe ke block baru
      this.provider.on("block", async (blockNumber) => {
        try {
          // Ambil block dengan detail transaksi
          const block = await this.provider.getBlock(blockNumber);
          if (!block || !block.transactions) return;

          // Tambahkan transaksi ke queue
          for (const txHash of block.transactions) {
            this.txQueue.push({ hash: txHash, blockNumber });
          }

          // Mulai proses queue jika belum berjalan
          if (!this.isProcessingQueue) {
            this.processQueue();
          }
        } catch (error) {
          console.error("Error processing block:", error);
        }
      });

      console.log("✅ Sistem tracking berhasil dimulai");
    } catch (error) {
      console.error("❌ Error starting trader tracking:", error);
      this.isTracking = false;
      setTimeout(() => this.startTrackingTrustedTraders(), 5000);
    }
  }

  // Fungsi helper untuk retry yang lebih sederhana
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        // Tambah delay sederhana
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY));
        return await operation();
      } catch (error: any) {
        lastError = error;
        console.error(`Retry attempt ${i + 1} failed:`, error);
        // Tunggu sebentar sebelum retry
        await new Promise((resolve) =>
          setTimeout(resolve, REQUEST_DELAY * (i + 1))
        );
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
      this.txCache.set(txHash, { data: tx, timestamp: Date.now() });

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
      this.receiptCache.set(tx.hash, { data: receipt, timestamp: Date.now() });

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
      // Convert all amounts to BigInt
      const minTradeAmountWei = ethers.parseEther(MIN_TRADE_AMOUNT);
      const tradeAmountWei = ethers.parseEther(tradeAmount);
      const gasBufferWei = ethers.parseEther(MIN_ETH_FOR_GAS);
      const safetyBufferWei = ethers.parseEther(MIN_BALANCE_BUFFER);

      // Check minimum trade size (comparing BigInts)
      if (tradeAmountWei < minTradeAmountWei) {
        return {
          valid: false,
          error: `Trade amount too small. Minimum: ${MIN_TRADE_AMOUNT} ETH`,
        };
      }

      // Get user's balance (already in BigInt)
      const balanceWei = await this.walletService.getWalletBalance(
        userId,
        chain
      );

      // Calculate total required (all values are BigInt)
      const requiredBalanceWei =
        tradeAmountWei + gasBufferWei + safetyBufferWei;

      console.log(`
💰 BALANCE VALIDATION
===================
Current: ${ethers.formatEther(balanceWei)} ETH
Required:
- Trade: ${tradeAmount} ETH
- Gas: ${MIN_ETH_FOR_GAS} ETH
- Buffer: ${MIN_BALANCE_BUFFER} ETH
Total: ${ethers.formatEther(requiredBalanceWei)} ETH
===================`);

      // Compare BigInt values (both are already BigInt)
      if (BigInt(balanceWei) < BigInt(requiredBalanceWei)) {
        return {
          valid: false,
          error: `Insufficient balance. Required: ${ethers.formatEther(
            requiredBalanceWei
          )} ETH (including gas & buffer)`,
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
📊 ANALYZING TRADE
=================
Trader: ${trader.name}
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, "gwei")} gwei
=================`);

      // Get subscribed users
      const { data: subscribers } = await supabase
        .from("users")
        .select("*")
        .eq("is_subscribed", true);

      if (!subscribers || subscribers.length === 0) {
        console.log("❌ No active subscribers found");
        return;
      }

      console.log(`
👥 FOUND ${subscribers.length} ACTIVE SUBSCRIBERS
=============================================`);

      // Queue trades for each subscriber
      for (const subscriber of subscribers) {
        // Skip if queue terlalu penuh
        if (this.tradeQueue.length >= MAX_QUEUE_SIZE) {
          console.log("⚠️ Trade queue full, skipping new trades");
          continue;
        }

        console.log(`
🔄 Processing Subscriber: ${subscriber.telegram_id}
------------------------------------------------`);

        // Validate trade size
        const validation = await this.validateTradeSize(
          subscriber.telegram_id,
          subscriber.trading_amount,
          Chain.BASE
        );

        if (!validation.valid) {
          console.log(`❌ Trade skipped: ${validation.error}`);
          continue;
        }

        // Add to queue
        this.tradeQueue.push({
          userId: subscriber.telegram_id,
          tx,
          trader,
          attempts: 0,
          lastAttempt: 0,
        });

        console.log(
          `✅ Trade queued successfully for user ${subscriber.telegram_id}`
        );
      }

      if (this.tradeQueue.length > 0) {
        console.log(`
🎯 TRADE QUEUE STATUS
===================
Total Trades: ${this.tradeQueue.length}
Processing: ${this.isProcessingQueue ? "Yes ⚡" : "No ⏸️"}
===================`);

        // Start processing queue if not already running
        if (!this.isProcessingQueue) {
          this.processTradeQueue();
        }
      }
    } catch (error) {
      console.error("❌ Error analyzing trade:", error);
      throw error;
    }
  }

  private startQueueProcessor() {
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
    }

    this.queueInterval = setInterval(() => {
      this.processTradeQueue();
    }, this.QUEUE_PROCESS_INTERVAL);
  }

  private async processTradeQueue() {
    if (this.isProcessingQueue || this.tradeQueue.length === 0) return;

    this.isProcessingQueue = true;
    console.log(`Processing trade queue. Size: ${this.tradeQueue.length}`);

    try {
      const currentGasPrice = await this.provider.getFeeData();

      // Skip jika gas price terlalu tinggi
      if (
        currentGasPrice.gasPrice &&
        currentGasPrice.gasPrice > this.MAX_GAS_PRICE
      ) {
        console.log("Gas price too high, waiting for better conditions...");
        this.isProcessingQueue = false;
        return;
      }

      const trade = this.tradeQueue[0];

      // Skip jika trade terlalu lama dalam queue
      if (Date.now() - trade.lastAttempt < 10000) {
        // 10 detik cooldown
        this.isProcessingQueue = false;
        return;
      }

      try {
        const result = await this.executeCopyTrade(trade);
        if (result.success) {
          this.tradeQueue.shift(); // Hapus dari queue jika berhasil
          console.log(`Successfully executed trade for user ${trade.userId}`);
        } else {
          trade.attempts++;
          trade.lastAttempt = Date.now();

          if (trade.attempts >= MAX_RETRIES) {
            console.log(
              `Failed to execute trade after ${MAX_RETRIES} attempts for user ${trade.userId}`
            );
            this.tradeQueue.shift();
          } else {
            // Pindahkan ke belakang queue untuk retry nanti
            this.tradeQueue.push(this.tradeQueue.shift()!);
          }
        }
      } catch (error) {
        console.error("Error executing trade:", error);
        trade.attempts++;
        trade.lastAttempt = Date.now();
      }
    } catch (error) {
      console.error("Error processing trade queue:", error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async executeCopyTrade(queuedTrade: QueuedTrade) {
    try {
      const { userId, tx, trader } = queuedTrade;

      // Get user's wallet and trading amount
      const userWallet = await this.walletService.getWallet(userId, Chain.BASE);
      const { data: user } = await supabase
        .from("users")
        .select("trading_amount")
        .eq("telegram_id", userId)
        .single();

      if (!userWallet || !user?.trading_amount) {
        throw new Error("Invalid user configuration");
      }

      // Decode dan validasi trade
      const decodedInput = this.uniswapService.decodeSwapInput(tx.data || "");
      if (!decodedInput) {
        throw new Error("Could not decode transaction input");
      }

      // Validasi trade size dan balance
      const validation = await this.validateTradeSize(
        userId,
        user.trading_amount,
        Chain.BASE
      );
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      // Optimasi gas price
      const feeData = await this.provider.getFeeData();
      const optimizedGasPrice = this.optimizeGasPrice(
        feeData.gasPrice || BigInt(0)
      );

      // Execute swap dengan gas yang dioptimasi
      const swapResult = await this.uniswapService.swapExactInputSingle(
        userWallet,
        Chain.BASE,
        {
          tokenIn: decodedInput.tokenIn,
          tokenOut: decodedInput.tokenOut,
          fee: decodedInput.fee,
          amountIn: this.scaleTradeAmount(
            decodedInput.amountIn.toString(),
            user.trading_amount
          ),
          slippage: 1.0,
          gasPrice: optimizedGasPrice,
        }
      );

      if (!swapResult.success) {
        throw new Error(swapResult.error);
      }

      // Log metrics
      await this.logTradeMetrics(
        userId,
        trader.id,
        swapResult.txHash!,
        true,
        swapResult.gasUsed,
        optimizedGasPrice.toString(),
        swapResult.amountOut
      );

      return { success: true };
    } catch (error) {
      console.error("Error executing copy trade:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private optimizeGasPrice(currentGasPrice: bigint): bigint {
    // Add 10% to current gas price for faster confirmation
    return (currentGasPrice * BigInt(110)) / BigInt(100);
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

  private async processPendingTransactions() {
    if (this.isProcessingPendingTx) return;
    this.isProcessingPendingTx = true;

    try {
      while (this.pendingTxQueue.length > 0) {
        // Ambil batch transaksi
        const batch = this.pendingTxQueue.splice(0, this.PENDING_TX_BATCH_SIZE);

        // Proses batch dengan delay
        for (const txHash of batch) {
          try {
            // Cek rate limit
            if (this.requestCount >= this.rateLimit) {
              console.log("⚠️ Rate limit reached, waiting...");
              await new Promise((resolve) => setTimeout(resolve, 1000));
              this.requestCount = 0;
            }

            this.requestCount++;
            const tx = await this.provider.getTransaction(txHash);

            if (!tx || !tx.to) continue;

            const toAddress = tx.to.toLowerCase();
            // Hanya proses transaksi ke Uniswap router
            if (
              toAddress === config.base.uniswap.router.toLowerCase() ||
              toAddress === config.base.uniswap.universal_router.toLowerCase()
            ) {
              // Cek dari trusted trader
              if (this.trustedTraderAddresses.has(tx.from.toLowerCase())) {
                console.log(`
📡 INCOMING TRANSACTION DETECTED
==============================
Router: ${
                  toAddress === config.base.uniswap.router.toLowerCase()
                    ? "SwapRouter02 📦"
                    : "UniversalRouter 🌐"
                }
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, "gwei")} gwei
==============================`);

                // Proses transaksi trusted trader
                await this.handleTrustedTraderTransaction(tx);
              }
            }
          } catch (error: any) {
            if (error?.error?.code === -32007) {
              console.log("⚠️ Rate limit hit, pausing...");
              await new Promise((resolve) => setTimeout(resolve, 1000));
              this.requestCount = 0;
              // Kembalikan txHash ke queue
              this.pendingTxQueue.unshift(txHash);
            } else {
              console.error("Error processing transaction:", error);
            }
          }

          // Delay antara setiap transaksi dalam batch
          await new Promise((resolve) =>
            setTimeout(resolve, this.PENDING_TX_INTERVAL)
          );
        }
      }
    } finally {
      this.isProcessingPendingTx = false;

      // Jika masih ada transaksi di queue, proses lagi
      if (this.pendingTxQueue.length > 0) {
        setTimeout(
          () => this.processPendingTransactions(),
          this.PENDING_TX_INTERVAL
        );
      }
    }
  }

  private async handleTrustedTraderTransaction(tx: ethers.TransactionResponse) {
    try {
      // Decode input untuk memastikan ini swap
      const decodedInput = await this.uniswapService.decodeSwapInput(
        tx.data || ""
      );
      if (!decodedInput) return;

      console.log(`
🔍 SWAP DETAILS
==============
Token In: ${
        decodedInput.tokenIn === "0x4200000000000000000000000000000000000006"
          ? "ETH 💎"
          : decodedInput.tokenIn
      }
Token Out: ${
        decodedInput.tokenOut === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          ? "USDC 💵"
          : decodedInput.tokenOut
      }
Amount In: ${ethers.formatEther(decodedInput.amountIn)} ETH
==============`);

      // Tunggu konfirmasi dengan timeout
      console.log(`\n⏳ Waiting for transaction confirmation...`);

      const receipt = (await Promise.race([
        tx.wait(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Transaction confirmation timeout")),
            60000
          )
        ),
      ])) as ethers.TransactionReceipt;

      if (receipt && "status" in receipt && receipt.status === 1) {
        const trader = (await this.getTrustedTraders()).find(
          (t) => t.address.toLowerCase() === tx.from.toLowerCase()
        );

        if (trader) {
          await this.analyzeTrade(tx, trader);
        }
      }
    } catch (error) {
      console.error("Error handling trusted trader transaction:", error);
    }
  }

  private async processPendingTxQueue(): Promise<void> {
    if (this.isProcessingQueue || this.pendingTxQueue.length === 0) return;

    this.isProcessingQueue = true;
    console.log(`📦 Memproses queue (${this.pendingTxQueue.length} transaksi)`);

    try {
      while (this.pendingTxQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const txHash = this.pendingTxQueue.shift();
        if (!txHash) continue;

        try {
          if (this.processedTxCache.has(txHash)) {
            console.log(`⏭️ Skip ${txHash.slice(0, 10)}... (sudah diproses)`);
            continue;
          }

          const cachedTx = this.txCache.get(txHash);
          let tx: ethers.TransactionResponse | null = null;

          if (cachedTx && Date.now() - cachedTx.timestamp < 60000) {
            tx = cachedTx.data;
            console.log(
              `📂 Menggunakan data dari cache untuk ${txHash.slice(0, 10)}...`
            );
          } else {
            if (this.requestCount >= this.rateLimit) {
              console.log("⚠️ Rate limit tercapai, menunggu 2 detik...");
              await new Promise((resolve) => setTimeout(resolve, 2000));
              this.requestCount = 0;
            }

            console.log(`🔄 Fetching tx ${txHash.slice(0, 10)}...`);
            this.requestCount++;

            try {
              // Fetch with timeout
              tx = await Promise.race([
                this.provider.getTransaction(txHash),
                new Promise<null>((_, reject) => {
                  setTimeout(() => reject(new Error("Request timeout")), 5000);
                }),
              ]);

              if (tx) {
                console.log(
                  `✅ TX ${txHash.slice(0, 10)}... berhasil di-fetch`
                );
                this.txCache.set(txHash, { data: tx, timestamp: Date.now() });
              }
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === "Request timeout"
              ) {
                console.log(`⏱️ Timeout untuk ${txHash.slice(0, 10)}...`);
                if (this.pendingTxQueue.length < MAX_QUEUE_SIZE) {
                  this.pendingTxQueue.push(txHash);
                }
              }
              continue;
            }
          }

          if (!tx) continue;

          this.processedTxCache.set(txHash, true);

          // Cek apakah transaksi ke Uniswap router
          if (
            tx.to &&
            (tx.to.toLowerCase() === this.SWAP_ROUTER ||
              tx.to.toLowerCase() === this.UNIVERSAL_ROUTER)
          ) {
            console.log(`
🔍 TRANSAKSI TERDETEKSI
=======================
📝 Hash: ${tx.hash}
👤 From: ${tx.from}
💰 Value: ${ethers.formatEther(tx.value)} ETH
⛽ Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, "gwei")} Gwei
            `);

            // Cek apakah dari trusted trader
            if (this.trustedTraderAddresses.has(tx.from.toLowerCase())) {
              console.log(`✨ Transaksi dari Trusted Trader terdeteksi!`);

              // Tunggu 2 detik sebelum memproses transaksi trusted trader
              await new Promise((resolve) => setTimeout(resolve, 2000));
              await this.processTransaction(
                txHash,
                await this.getTrustedTraders()
              );
            }
          }
        } catch (error: unknown) {
          if (error instanceof Error) {
            console.error(
              `❌ Error memproses ${txHash.slice(0, 10)}...`,
              error.message
            );
          }
        }

        // Tunggu 2 detik sebelum memproses transaksi berikutnya
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      this.isProcessingQueue = false;
      console.log("✅ Queue processing selesai");
    }
  }

  private async handlePendingTransactions(txHash: string): Promise<void> {
    if (this.processedTxCache.has(txHash)) return;

    this.pendingTxQueue.push(txHash);
    console.log(
      `📥 Transaksi ${txHash.slice(0, 10)}... masuk queue (Size: ${
        this.pendingTxQueue.length
      })`
    );

    await this.processPendingTxQueue();
  }

  private async throttleRequest(): Promise<void> {
    // Bersihkan queue yang lebih lama dari 1 detik
    const now = Date.now();
    this.requestQueue = this.requestQueue.filter(
      (req) => now - req.timestamp < REQUEST_WINDOW
    );

    // Hitung total request dalam 1 detik terakhir
    const totalRequests = this.requestQueue.reduce(
      (sum, req) => sum + req.count,
      0
    );

    if (totalRequests >= RATE_LIMIT) {
      // Tunggu sampai window berikutnya
      const oldestRequest = this.requestQueue[0];
      const waitTime = REQUEST_WINDOW - (now - oldestRequest.timestamp);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.throttleRequest();
    }

    // Tambah request ke queue
    this.requestQueue.push({ timestamp: now, count: 1 });
  }

  private async processBlockRange(startBlock: number, endBlock: number) {
    try {
      for (
        let blockNumber = startBlock;
        blockNumber <= endBlock;
        blockNumber++
      ) {
        await this.throttleRequest();

        try {
          const block = await this.provider.getBlock(blockNumber, true);
          if (!block || !block.transactions) continue;

          // Filter transaksi yang relevan
          const relevantTxs = block.transactions.filter((tx) => {
            if (typeof tx === "string") return false;

            const transaction = tx as ethers.TransactionResponse;
            return (
              this.trustedTraderAddresses.has(transaction.from.toLowerCase()) &&
              (transaction.to?.toLowerCase() === this.SWAP_ROUTER ||
                transaction.to?.toLowerCase() === this.UNIVERSAL_ROUTER)
            );
          });

          // Proses transaksi yang relevan
          for (const tx of relevantTxs) {
            if (typeof tx !== "string") {
              await this.processTraderTransaction(
                tx as ethers.TransactionResponse
              );
            }
          }
        } catch (error: any) {
          if (error?.error?.code === -32007) {
            // Rate limit hit, tunggu dan retry
            console.log("⏳ Rate limit hit, waiting...");
            await new Promise((resolve) => setTimeout(resolve, 2000));
            blockNumber--; // Retry block ini
            continue;
          }
          console.error(`Error processing block ${blockNumber}:`, error);
        }
      }

      this.lastProcessedBlock = endBlock;
    } catch (error) {
      console.error("Error in block range processing:", error);
    }
  }

  private async startBlockMonitoring() {
    if (this.processingBlocks) return;
    this.processingBlocks = true;

    try {
      while (this.processingBlocks) {
        // Check flag in loop condition
        // Check subscribers setiap 10 block
        if (this.lastProcessedBlock % 10 === 0) {
          const subscribers = await this.getActiveSubscribers();
          if (subscribers.length === 0) {
            console.log("💤 No active subscribers, stopping block monitoring");
            this.processingBlocks = false;
            break;
          }
        }

        const currentBlock = await this.provider.getBlockNumber();

        // Skip jika sudah up to date
        if (this.lastProcessedBlock >= currentBlock) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Tentukan range untuk batch berikutnya
        const startBlock = this.lastProcessedBlock + 1;
        const endBlock = Math.min(
          startBlock + BLOCK_BATCH_SIZE - 1,
          currentBlock
        );

        await this.processBlockRange(startBlock, endBlock);

        // Tunggu interval sebelum batch berikutnya
        await new Promise((resolve) =>
          setTimeout(resolve, BLOCK_PROCESS_INTERVAL)
        );
      }
    } catch (error) {
      console.error("Error in block monitoring:", error);
      this.processingBlocks = false;
      // Restart monitoring hanya jika masih ada subscribers
      const subscribers = await this.getActiveSubscribers();
      if (subscribers.length > 0) {
        setTimeout(() => this.startBlockMonitoring(), 5000);
      }
    }
  }

  private stopMonitoring() {
    try {
      // Stop block monitoring
      this.processingBlocks = false;

      // Remove all event listeners
      this.provider.removeAllListeners();

      // Reset state
      this.monitoringState.isActive = false;
      this.monitoringState.subscriberCount = 0;
      this.lastProcessedBlock = 0;

      // Clear all queues
      this.requestQueue = [];
      this.pendingTxQueue = [];
      this.tradeQueue = [];
      this.txQueue = [];

      // Clear caches
      this.txCache.clear();
      this.receiptCache.clear();
      this.processedTxCache.clear();

      console.log(`
✅ MONITORING STOPPED SUCCESSFULLY
==============================
Time: ${new Date().toLocaleTimeString()}
Status:
- WebSocket: Disconnected
- Block Monitoring: Stopped
- Event Listeners: Removed
- Queues: Cleared
- Caches: Cleared
==============================`);
    } catch (error) {
      console.error("Error stopping monitoring:", error);
    }
  }
}
