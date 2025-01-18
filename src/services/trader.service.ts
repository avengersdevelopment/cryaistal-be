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
const BLOCKS_TO_SKIP = 2; // Skip setiap 2 block untuk mengurangi request
const MAX_TX_PER_BLOCK = 50; // Batasi transaksi yang diproses
const CACHE_EXPIRY = 1000 * 60 * 5; // Cache expiry 5 menit

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

  constructor() {
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();
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
      // Get all active traders dan simpan addresses untuk O(1) lookup
      const traders = await this.getTrustedTraders();
      this.trustedTraderAddresses = new Set(
        traders.map(t => t.address.toLowerCase())
      );

      // Setup blockchain listener with retry logic
      let provider;
      let retryCount = 0;
      const maxRetries = 5;

      while (retryCount < maxRetries) {
        try {
          console.log(`Attempting to connect to RPC node (attempt ${retryCount + 1}/${maxRetries})...`);
          provider = new ethers.JsonRpcProvider(config.ethereum.rpc_url);

          // Test connection
          const network = await provider.getNetwork();
          console.log(`Successfully connected to network: ${network.name}`);
          break;
        } catch (error) {
          retryCount++;
          if (retryCount === maxRetries) {
            throw new Error(`Failed to connect to RPC node after ${maxRetries} attempts`);
          }
          console.log(`Connection failed, retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (!provider) {
        throw new Error('Failed to initialize provider');
      }

      // Bersihkan cache secara berkala
      setInterval(() => this.cleanCache(), CACHE_EXPIRY);

      // Listen to new blocks
      provider.on('block', async (blockNumber) => {
        try {
          // Skip blocks untuk rate limiting
          if (blockNumber - this.lastProcessedBlock < BLOCKS_TO_SKIP) {
            return;
          }
          this.lastProcessedBlock = blockNumber;

          console.log(`Processing block ${blockNumber}...`);
          const block = await provider.getBlock(blockNumber, true);
          
          if (!block || !block.transactions || block.transactions.length === 0) {
            return;
          }

          console.log(`Found ${block.transactions.length} transactions in block ${blockNumber}`);

          // Batasi jumlah transaksi dan proses secara parallel
          const transactions = block.transactions.slice(0, MAX_TX_PER_BLOCK);
          await Promise.all(
            transactions.map(async (txHash: string) => {
              try {
                // Check cache first
                const cachedTx = txCache.get(txHash);
                let tx: ethers.TransactionResponse | undefined;

                if (cachedTx) {
                  tx = cachedTx.data;
                } else {
                  tx = await provider.getTransaction(txHash);
                  if (tx) {
                    txCache.set(txHash, { data: tx, timestamp: Date.now() });
                  }
                }

                if (!tx || !this.trustedTraderAddresses.has(tx.from.toLowerCase())) {
                  return;
                }

                console.log(`Found transaction ${tx.hash} from trusted trader`);

                // Check cache for receipt
                const cachedReceipt = receiptCache.get(tx.hash);
                let receipt: ethers.TransactionReceipt | undefined;

                if (cachedReceipt) {
                  receipt = cachedReceipt.data;
                } else {
                  receipt = await provider.getTransactionReceipt(tx.hash);
                  if (receipt) {
                    receiptCache.set(tx.hash, { data: receipt, timestamp: Date.now() });
                  }
                }

                if (!receipt) return;

                // Check if transaction interacts with Uniswap V3 Router
                if (receipt.to?.toLowerCase() === config.uniswap.router.toLowerCase()) {
                  const trader = traders.find(t => t.address.toLowerCase() === tx.from.toLowerCase());
                  if (trader) {
                    console.log(`Processing Uniswap trade from ${trader.name}: ${tx.hash}`);
                    await this.analyzeTrade(tx, trader);
                  }
                }
              } catch (txError) {
                console.error(`Error processing transaction ${txHash}:`, txError);
              }
            })
          );
        } catch (error) {
          console.error('Error processing block:', error);
        }
      });

    } catch (error) {
      console.error('Error starting trader tracking:', error);
      this.isTracking = false;
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
}
