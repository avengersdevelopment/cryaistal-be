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
const BLOCKS_TO_SKIP = 2; // Skip 2 blok untuk mengurangi request
const MAX_TX_PER_BLOCK = 50; // Kurangi batas transaksi
const BATCH_SIZE = 15; // Kurangi ukuran batch
const BATCH_DELAY = 250; // Tingkatkan delay antar batch
const CACHE_EXPIRY = 1000 * 60 * 5; // 5 menit cache
const MAX_RETRIES = 3; // Maksimal retry saat rate limit
const RETRY_DELAY = 1000; // Delay 1 detik sebelum retry

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
  private lastProcessedBlock: number = 0;
  private trustedTraderAddresses: Set<string> = new Set();
  private provider: ethers.JsonRpcProvider;

  constructor() {
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();
    // Menggunakan HTTP Provider dengan optimasi untuk Quicknode Premium di jaringan BASE
    this.provider = new ethers.JsonRpcProvider(config.base.rpc_url, {
      chainId: config.base.chainId,
      name: 'base',
      ensAddress: undefined
    });
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

      // Bersihkan cache secara berkala
      setInterval(() => this.cleanCache(), CACHE_EXPIRY / 2);

      // Listen to new blocks dengan polling yang dioptimalkan
      this.provider.on('block', async (blockNumber) => {
        try {
          if (blockNumber - this.lastProcessedBlock < BLOCKS_TO_SKIP) {
            return;
          }
          this.lastProcessedBlock = blockNumber;

          const block = await this.provider.getBlock(blockNumber, true);
          
          if (!block?.transactions?.length) return;

          // Process transactions in batches
          const transactions = block.transactions.slice(0, MAX_TX_PER_BLOCK);
          await this.processBatch(transactions, traders);

        } catch (error) {
          console.error('Error processing block:', error);
        }
      });

    } catch (error) {
      console.error('Error starting trader tracking:', error);
      this.isTracking = false;
    }
  }

  // Fungsi helper untuk retry
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        // Check jika error adalah rate limit
        if (error?.code === -32007 || error?.message?.includes('request limit reached')) {
          console.log(`Rate limit hit, retry attempt ${i + 1} of ${MAX_RETRIES}`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1))); // Exponential backoff
          continue;
        }
        throw error; // Throw langsung jika bukan rate limit error
      }
    }
    throw lastError;
  }

  private async processTransaction(
    txHash: string,
    traders: TrustedTrader[]
  ) {
    try {
      const cachedTx = txCache.get(txHash);
      let tx: ethers.TransactionResponse | null = null;

      if (cachedTx && Date.now() - cachedTx.timestamp < CACHE_EXPIRY) {
        tx = cachedTx.data;
      } else {
        tx = await this.withRetry(() => this.provider.getTransaction(txHash));
        if (tx) {
          txCache.set(txHash, { data: tx, timestamp: Date.now() });
        }
      }

      if (!tx || !this.trustedTraderAddresses.has(tx.from.toLowerCase())) {
        return;
      }

      const cachedReceipt = receiptCache.get(tx.hash);
      let receipt: ethers.TransactionReceipt | null = null;

      if (cachedReceipt && Date.now() - cachedReceipt.timestamp < CACHE_EXPIRY) {
        receipt = cachedReceipt.data;
      } else {
        receipt = await this.withRetry(() => this.provider.getTransactionReceipt(tx.hash));
        if (receipt) {
          receiptCache.set(tx.hash, { data: receipt, timestamp: Date.now() });
        }
      }

      if (!receipt) return;

      if (receipt.to?.toLowerCase() === config.base.uniswap.router.toLowerCase()) {
        const trader = traders.find(t => t.address.toLowerCase() === tx.from.toLowerCase());
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
      console.log(`Analyzing trade ${tx.hash} from trader ${trader.name}...`);

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
      console.log(`Getting wallet for user ${userId}...`);
      const userWallet = await this.walletService.getWallet(userId, Chain.ETHEREUM);
      
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

      console.log(`Trade copied successfully. Transaction hash: ${tradeTx.hash}`);

      // Log the trade
      await this.logTrade(userId, trader.id, tradeTx.hash);

    } catch (error: any) {
      console.error('Error copying trade for user:', error);
      
      // Log failed transaction
      await supabase.from('transactions').insert({
        user_id: userId,
        trader_id: trader.id,
        chain: Chain.ETHEREUM,
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
        chain: Chain.ETHEREUM,
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
    console.log(`Processing batch of ${transactions.length} transactions...`);
    const startTime = Date.now();
    
    const results = [];
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      console.log(`Processing sub-batch ${i/BATCH_SIZE + 1} of ${Math.ceil(transactions.length/BATCH_SIZE)}...`);
      
      try {
        const batchResults = await Promise.all(
          batch.map(txHash => this.processTransaction(txHash, traders))
        );
        results.push(...batchResults);
        
        // Tambah delay yang lebih lama setelah setiap batch
        if (i + BATCH_SIZE < transactions.length) {
          const randomDelay = BATCH_DELAY + Math.floor(Math.random() * 100); // Add random jitter
          await new Promise(resolve => setTimeout(resolve, randomDelay));
        }
      } catch (error) {
        console.error(`Error processing batch at index ${i}:`, error);
        // Continue dengan batch berikutnya
        continue;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`Batch processing completed in ${duration}ms`);
    
    return results;
  }
}
