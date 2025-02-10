import { Telegraf, Context } from "telegraf";
import { Chain, Transaction } from "../types";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";
import { UniswapService } from "./uniswap.service";
import { WalletService } from "./wallet.service";
import { POOL_MANAGER } from "../config/constants";
import POOL_MANAGER_ABI from "../config/abis/uniswapv4poolmanager.json";

const supabase = createClient(config.supabase.url, config.supabase.key);

// Constants
const MIN_ETH_FOR_GAS = "0.0000005"; // Lower gas buffer
const MIN_BALANCE_BUFFER = "0.0000005"; // Lower safety buffer

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
  private provider!: ethers.WebSocketProvider;
  private trustedTraderAddresses: Set<string> = new Set();
  private processedTxCache: Set<string> = new Set();
  private isMonitoring: boolean = false;

  constructor() {
    this.uniswapService = new UniswapService();
    this.walletService = new WalletService();
    this.initializeProvider();
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

      // Setup reconnection logic
      const ws = this.provider.websocket as WebSocket;
      ws.addEventListener("close", () => {
        console.log("🔄 WebSocket disconnected, attempting to reconnect...");
        setTimeout(() => this.initializeProvider(), 5000);
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

    // Create interface for V4 Pool Manager
    const poolManagerInterface = new ethers.Interface(POOL_MANAGER_ABI);

    // Get swap event
    const swapEvent = poolManagerInterface.getEvent("Swap");
    if (!swapEvent) {
      console.error("❌ Swap event not found in ABI");
      return;
    }

    // Monitor Uniswap V4 Pool Manager Swap events
    const poolSwapFilter = {
      address: POOL_MANAGER,
      topics: [swapEvent.topicHash],
    };

    this.provider.on(poolSwapFilter, async (log) => {
      try {
        if (this.processedTxCache.has(log.transactionHash)) return;

        const tx = await this.provider.getTransaction(log.transactionHash);
        if (!tx || !this.trustedTraderAddresses.has(tx.from.toLowerCase()))
          return;

        // Decode the swap event using V4 Pool Manager ABI
        const event = poolManagerInterface.parseLog({
          topics: log.topics,
          data: log.data,
        });

        if (!event || !event.args) {
          console.log("❌ Failed to decode V4 swap event");
          return;
        }

        const [
          poolId,
          sender,
          amount0,
          amount1,
          sqrtPriceX96,
          liquidity,
          tick,
          fee,
        ] = event.args;

        // Convert amounts to readable format
        const amount0Str = ethers.formatUnits(
          amount0 < 0n ? -amount0 : amount0,
          18
        );
        const amount1Str = ethers.formatUnits(
          amount1 < 0n ? -amount1 : amount1,
          6
        );

        console.log(`
🔄 V4 POOL SWAP DETECTED
====================
Hash: ${log.transactionHash}
Pool ID: ${poolId}
Trader: ${sender}
Amount ETH: ${amount0Str} ${amount0 < 0n ? "OUT" : "IN"}
Amount USDC: ${amount1Str} ${amount1 < 0n ? "OUT" : "IN"}
Fee: ${fee}
Price: ${sqrtPriceX96}
Liquidity: ${liquidity}
Tick: ${tick}
====================`);

        await this.processTraderTransaction(tx);
      } catch (error) {
        console.error("Error processing V4 swap event:", error);
      }
    });

    this.isMonitoring = true;

    console.log(`
🎯 V4 POOL MONITORING ACTIVE
========================
Pool Manager: ${POOL_MANAGER}
Subscribers: ${subscribers.length}
Trusted Traders: ${this.trustedTraderAddresses.size}
========================`);
  }

  private async processTraderTransaction(tx: ethers.TransactionResponse) {
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

      this.processedTxCache.add(tx.hash);

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
Trading Amount: ${subscriber.trading_amount} ETH
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

      // Use the subscriber's configured trading amount
      const tradeAmountEth = subscriber.trading_amount;

      // Calculate required amounts
      const gasBufferEth = MIN_ETH_FOR_GAS;
      const totalRequiredEth = (
        parseFloat(tradeAmountEth) + parseFloat(gasBufferEth)
      ).toFixed(8);

      console.log(`
💰 BALANCE CHECK
==============
Current Balance: ${balanceEth} ETH
Trading Amount: ${tradeAmountEth} ETH
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

      console.log(`
🔄 SWAP DETAILS
=============
Token In: ${tokenIn}
Token Out: ${tokenOut}
Fee: ${decodedSwap.fee}
=============`);

      // Execute the copy trade
      const result = await this.uniswapService.swapExactInputSingle(
        wallet,
        Chain.BASE,
        {
          tokenIn,
          tokenOut,
          fee: decodedSwap.fee || 3000, // Default to 0.3% fee if not specified
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

        // await this.logTradeMetrics(
        //   subscriber.telegram_id,
        //   tx.from,
        //   result.txHash!,
        //   true,
        //   result.gasUsed,
        //   gasPrice?.toString(),
        //   result.amountOut
        // );
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

  private async getActiveSubscribers() {
    const { data: subscribers } = await supabase
      .from("users")
      .select("*")
      .eq("is_subscribed", true);

    return subscribers || [];
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

  private stopMonitoring() {
    this.provider.removeAllListeners();
    this.isMonitoring = false;
    this.processedTxCache.clear();
    console.log("✅ Monitoring stopped successfully");
  }

  async startTrackingTrustedTraders() {
    if (this.isMonitoring) {
      console.log("Already monitoring traders");
      return;
    }

    try {
      // Get active subscribers first
      const subscribers = await this.getActiveSubscribers();
      if (subscribers.length === 0) {
        console.log("No active subscribers, not starting monitoring");
        return;
      }

      // Get trusted traders
      const traders = await this.getTrustedTraders();
      this.trustedTraderAddresses = new Set(
        traders.map((t) => t.address.toLowerCase())
      );

      if (this.trustedTraderAddresses.size === 0) {
        console.log("❌ No active trusted traders found");
        return;
      }

      console.log(`
🚀 STARTING TRADER TRACKING
=========================
Active Subscribers: ${subscribers.length}
Trusted Traders: ${this.trustedTraderAddresses.size}
=========================`);

      // Initialize provider if needed
      if (!this.provider) {
        await this.initializeProvider();
      }

      // Start monitoring
      await this.setupMonitoring();

      console.log(`
✅ TRACKING SYSTEM ACTIVE
=======================
Status: Monitoring
Traders: ${Array.from(this.trustedTraderAddresses).join("\n")}
=======================`);
    } catch (error) {
      console.error("❌ Error starting trader tracking:", error);
      this.isMonitoring = false;
      // Retry after 5 seconds
      setTimeout(() => this.startTrackingTrustedTraders(), 5000);
    }
  }
}
