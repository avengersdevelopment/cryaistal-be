import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
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

interface TrustedTrader {
  id: string;
  name: string;
  address: string;
  success_rate: number;
  total_trades: number;
  is_active: boolean;
}

export class TraderService {
  private uniswapService: UniswapService;
  private walletService: WalletService;
  private isTracking: boolean = false;
  private lastProcessedNonces: Map<string, number> = new Map();
  private trustedTraderAddresses: Set<string> = new Set();
  private provider: ethers.WebSocketProvider;

  constructor() {
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();
    
    // Gunakan WebSocket provider
    this.provider = new ethers.WebSocketProvider(
      config.quicknode.ws_url,
      {
        chainId: config.base.chainId,
        name: 'base'
      }
    );

    // Handle WebSocket reconnection
    this.setupWebSocketReconnection();
  }

  private setupWebSocketReconnection() {
    const ws = (this.provider.websocket as any);

    ws.on('close', async () => {
      console.log('WebSocket connection closed. Reconnecting...');
      await this.reconnectWebSocket();
    });

    ws.on('error', async (error: any) => {
      console.error('WebSocket error:', error);
      await this.reconnectWebSocket();
    });
  }

  private async reconnectWebSocket() {
    try {
      // Tunggu sebentar sebelum reconnect
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Buat provider baru
      this.provider = new ethers.WebSocketProvider(
        config.quicknode.ws_url,
        {
          chainId: config.base.chainId,
          name: 'base'
        }
      );

      // Setup ulang reconnection handler
      this.setupWebSocketReconnection();

      // Restart tracking jika sedang aktif
      if (this.isTracking) {
        this.isTracking = false;
        await this.startTrackingTrustedTraders();
      }

      console.log('WebSocket successfully reconnected');
    } catch (error) {
      console.error('Error reconnecting WebSocket:', error);
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
        traders.map(t => t.address.toLowerCase())
      );

      console.log('🔄 Mulai tracking trusted traders:', Array.from(this.trustedTraderAddresses));

      // Inisialisasi nonce terakhir untuk setiap trader
      for (const trader of traders) {
        const nonce = await this.provider.getTransactionCount(trader.address);
        this.lastProcessedNonces.set(trader.address.toLowerCase(), nonce);
        console.log(`Inisialisasi nonce untuk ${trader.name}: ${nonce}`);
      }

      // Subscribe ke pending transactions
      this.provider.on('pending', async (txHash) => {
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
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, 'gwei')} gwei
Nonce: ${tx.nonce}
`);

          // Tunggu receipt untuk memastikan transaksi berhasil
          const receipt = await tx.wait();
          if (!receipt) return;

          if (receipt.to?.toLowerCase() === config.base.uniswap.router.toLowerCase()) {
            const trader = traders.find(t => t.address.toLowerCase() === fromAddress);
            if (trader) {
              await this.analyzeTrade(tx, trader);
            }
          }

        } catch (error: any) {
          if (error?.message?.includes('rate limit')) {
            console.log('⚠️ Rate limit hit, transaction will be processed in next block');
          } else {
            console.error('Error processing transaction:', error);
          }
        }
      });

      // Subscribe ke new heads untuk backup
      this.provider.on('block', (blockNumber) => {
        console.log(`📦 New block: ${blockNumber}`);
      });

    } catch (error) {
      console.error('❌ Error starting trader tracking:', error);
      this.isTracking = false;
    }
  }

  // Fungsi helper untuk retry
  private async withRetry<T>(operation: () => Promise<T>, customRetryDelay?: number): Promise<T> {
    let lastError;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        // Tambah delay kecil sebelum setiap request
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
        return await operation();
      } catch (error: any) {
        lastError = error;
        // Check jika error adalah rate limit
        if (error?.code === -32007 || error?.message?.includes('request limit reached')) {
          const delay = customRetryDelay || RETRY_DELAY * Math.pow(2, i); // Exponential backoff
          console.log(`⚠️ Rate limit hit, retry attempt ${i + 1} of ${MAX_RETRIES}, waiting ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async processTransaction(
    txHash: string,
    traders: TrustedTrader[]
  ) {
    try {
      const tx = await this.withRetry(() => this.provider.getTransaction(txHash));
      
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
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, 'gwei')} gwei
Nonce: ${tx.nonce}
`);

      const receipt = await this.withRetry(() => this.provider.getTransactionReceipt(tx.hash));
      if (!receipt) return;

      // Cache receipt
      receiptCache.set(tx.hash, { data: receipt, timestamp: Date.now() });

      if (receipt.to?.toLowerCase() === config.base.uniswap.router.toLowerCase()) {
        const trader = traders.find(t => t.address.toLowerCase() === fromAddress);
        if (trader) {
          await this.analyzeTrade(tx, trader);
        }
      }
    } catch (error) {
      console.error(`Error processing transaction ${txHash}:`, error);
    }
  }

  private async analyzeTrade(tx: ethers.TransactionResponse, trader: TrustedTrader) {
    try {
      console.log(`
📊 Menganalisis trade dari ${trader.name}:
Hash: ${tx.hash}
From: ${tx.from}
To: ${tx.to}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Price: ${ethers.formatUnits(tx.gasPrice || 0, 'gwei')} gwei
Success Rate: ${trader.success_rate}%
Total Trades: ${trader.total_trades}
`);

      // Get subscribed users
      const { data: subscribers } = await supabase
        .from('users')
        .select('*')
        .eq('is_subscribed', true);

      if (!subscribers || subscribers.length === 0) {
        console.log('No active subscribers found');
        return;
      }

      console.log(`Found ${subscribers.length} active subscribers`);

      // Copy trade for each subscriber
      for (const subscriber of subscribers) {
        try {
          console.log(`Processing trade for subscriber ${subscriber.telegram_id}`);
          await this.copyTradeForUser(subscriber.telegram_id, tx, trader);
        } catch (subError) {
          console.error(`Error copying trade for subscriber ${subscriber.telegram_id}:`, subError);
          // Continue with next subscriber
          continue;
        }
      }

    } catch (error) {
      console.error('Error analyzing trade:', error);
      throw error; // Re-throw to be handled by caller
    }
  }

  private async copyTradeForUser(userId: string, tx: ethers.TransactionResponse, trader: TrustedTrader) {
    try {
      console.log(`
🔄 Mencoba copy trade untuk user ${userId}:
Trader: ${trader.name}
Hash Original: ${tx.hash}
Value: ${ethers.formatEther(tx.value)} ETH
`);

      console.log(`Getting wallet for user ${userId}...`);
      const userWallet = await this.walletService.getWallet(userId, Chain.BASE);
      
      if (!userWallet) {
        throw new Error(`Wallet not found for user ${userId}`);
      }

      // Get user's trading amount
      const { data: user } = await supabase
        .from('users')
        .select('trading_amount')
        .eq('telegram_id', userId)
        .single();

      if (!user?.trading_amount) {
        throw new Error(`Trading amount not set for user ${userId}`);
      }

      // Calculate gas estimate
      const gasEstimate = await userWallet.estimateGas({
        to: tx.to,
        data: tx.data,
        value: tx.value
      });

      // Add 20% buffer for gas estimate
      const gasLimit = (gasEstimate * BigInt(120)) / BigInt(100);

      console.log(`Copying trade for user ${userId}...`);
      console.log(`Transaction details:
        To: ${tx.to}
        Value: ${ethers.formatEther(tx.value)} ETH
        Gas Limit: ${gasLimit.toString()}`);

      // Copy the transaction with user's settings
      const tradeTx = await userWallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasLimit
      });

      console.log(`
✅ Trade berhasil dicopy!
User: ${userId}
Trader: ${trader.name}
Hash Original: ${tx.hash}
Hash Copy: ${tradeTx.hash}
Value: ${ethers.formatEther(tx.value)} ETH
Gas Limit: ${gasLimit.toString()}
`);

      // Log the trade
      await this.logTrade(userId, trader.id, tradeTx.hash);

    } catch (error: any) {
      console.error('Error copying trade for user:', error);
      
      // Log failed transaction
      await supabase.from('transactions').insert({
        user_id: userId,
        trader_id: trader.id,
        chain: Chain.BASE,
        tx_hash: tx.hash,
        status: 'failed',
        error: error.message
      });

      throw error; // Re-throw to be handled by caller
    }
  }

  private async logTrade(userId: string, traderId: string, txHash: string) {
    try {
      await supabase.from('transactions').insert({
        user_id: userId,
        trader_id: traderId,
        chain: Chain.BASE,
        tx_hash: txHash,
        status: 'completed'
      });
    } catch (error) {
      console.error('Error logging trade:', error);
    }
  }

  async getTrustedTraders(): Promise<TrustedTrader[]> {
    try {
      const { data: traders, error } = await supabase
        .from('trusted_traders')
        .select('*')
        .eq('is_active', true);

      if (error) throw error;
      return traders || [];
    } catch (error) {
      console.error('Error fetching trusted traders:', error);
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
          await new Promise(resolve => setTimeout(resolve, 200));
          
          const tx = await this.withRetry(() => this.provider.getTransaction(txHash));
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

      console.log(`Processing ${txsToProcess.length} transactions from trusted traders...`);
      const startTime = Date.now();
      
      const results: any[] = [];
      for (let i = 0; i < txsToProcess.length; i += BATCH_SIZE) {
        const batch = txsToProcess.slice(i, i + BATCH_SIZE);
        console.log(`Processing sub-batch ${i/BATCH_SIZE + 1} of ${Math.ceil(txsToProcess.length/BATCH_SIZE)}...`);
        
        try {
          // Proses transaksi satu per satu dengan delay
          for (const txHash of batch) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
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
      console.error('Error in processBatch:', error);
      return [];
    }
  }
}
