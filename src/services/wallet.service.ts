import { Wallet, JsonRpcProvider, WebSocketProvider, ethers } from "ethers";
import * as crypto from "crypto";
import { Chain, UserWallet } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(config.supabase.url, config.supabase.key);

export class WalletService {
  private readonly encryptionKey: Buffer;
  private providers: Map<Chain, ethers.Provider> = new Map();
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;

  constructor() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY is required");
    }
    this.encryptionKey = crypto.createHash("sha256").update(key).digest();
    this.initializeProviders();
  }

  private async initializeProviders() {
    try {
      // Initialize HTTP provider with proper configuration
      const httpProvider = new JsonRpcProvider(config.quicknode.rpc_url, {
        chainId: config.base.chainId,
        name: "base",
      });

      // Test the connection
      await httpProvider.getBlockNumber();

      // Set the HTTP provider
      this.providers.set(Chain.BASE, httpProvider);

      console.log(`
🔌 PROVIDER INITIALIZED
======================
Chain: Base
Provider: HTTP
Status: Connected
Block: ${await httpProvider.getBlockNumber()}
======================`);
    } catch (error) {
      console.error("Error initializing provider:", error);
      throw error;
    }
  }

  private async getProvider(chain: Chain): Promise<ethers.Provider> {
    let provider = this.providers.get(chain);
    let retries = 0;

    while (!provider && retries < this.MAX_RETRIES) {
      try {
        await this.initializeProviders();
        provider = this.providers.get(chain);
        if (provider) {
          // Test the connection
          await provider.getBlockNumber();
          break;
        }
      } catch (error) {
        console.error(
          `Provider initialization attempt ${retries + 1} failed:`,
          error
        );
        retries++;
        if (retries < this.MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY));
        }
      }
    }

    if (!provider) {
      throw new Error(
        `Failed to initialize provider for chain ${chain} after ${this.MAX_RETRIES} attempts`
      );
    }

    return provider;
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", this.encryptionKey, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return `${iv.toString("hex")}:${encrypted}`;
  }

  private decrypt(text: string): string {
    const [ivHex, encryptedHex] = text.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      this.encryptionKey,
      iv
    );
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  async createWallet(userId: string, chain: Chain): Promise<UserWallet> {
    const chainConfig = CHAIN_CONFIGS[chain];
    const provider = new JsonRpcProvider(chainConfig.rpc_url, {
      chainId: chainConfig.chainId,
      name: chainConfig.name.toLowerCase(),
    });
    const wallet = Wallet.createRandom().connect(provider);

    const userWallet: UserWallet = {
      address: wallet.address,
      encryptedPrivateKey: this.encrypt(wallet.privateKey),
      chain,
    };

    const { error } = await supabase.from("user_wallets").insert([
      {
        user_id: userId,
        address: userWallet.address,
        encrypted_private_key: userWallet.encryptedPrivateKey,
        chain: userWallet.chain,
      },
    ]);

    if (error) throw error;
    return userWallet;
  }

  async createWalletWithKey(
    userId: string,
    chain: Chain
  ): Promise<{ wallet: UserWallet; privateKey: string }> {
    const provider = await this.getProvider(chain);
    const randomWallet = Wallet.createRandom();
    const wallet = randomWallet.connect(provider);

    const userWallet: UserWallet = {
      address: wallet.address,
      encryptedPrivateKey: this.encrypt(wallet.privateKey),
      chain,
    };

    const { error } = await supabase.from("user_wallets").insert([
      {
        user_id: userId,
        address: userWallet.address,
        encrypted_private_key: userWallet.encryptedPrivateKey,
        chain: userWallet.chain,
      },
    ]);

    if (error) throw error;
    return { wallet: userWallet, privateKey: wallet.privateKey };
  }

  async getWallet(userId: string, chain: Chain): Promise<ethers.Wallet> {
    try {
      const { data: wallet, error } = await supabase
        .from("user_wallets")
        .select("encrypted_private_key")
        .eq("user_id", userId)
        .eq("chain", chain)
        .single();

      if (error || !wallet?.encrypted_private_key) {
        throw new Error(
          `Wallet not found for user ${userId} on chain ${chain}`
        );
      }

      const provider = await this.getProvider(chain);
      const privateKey = this.decrypt(wallet.encrypted_private_key);

      return new ethers.Wallet(privateKey, provider);
    } catch (error) {
      console.error("Error getting wallet:", error);
      throw error;
    }
  }

  async getWalletBalance(userId: string, chain: Chain): Promise<bigint> {
    try {
      const wallet = await this.getWallet(userId, chain);
      return await wallet.provider!.getBalance(wallet.address);
    } catch (error) {
      console.error("Error getting wallet balance:", error);
      throw error;
    }
  }

  async withdrawETH(
    userId: string,
    chain: Chain,
    toAddress: string,
    amount: string
  ) {
    try {
      // Get user's wallet
      const wallet = await this.getWallet(userId, chain);

      // Convert amount to wei
      const amountWei = ethers.parseEther(amount);

      // Create transaction
      const tx = await wallet.sendTransaction({
        to: toAddress,
        value: amountWei,
      });

      return tx;
    } catch (error) {
      console.error("Error withdrawing ETH:", error);
      throw error;
    }
  }
}
