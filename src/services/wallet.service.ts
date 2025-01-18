import { Wallet, JsonRpcProvider } from "ethers";
import * as crypto from "crypto";
import { Chain, UserWallet } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { config } from "../config/config";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const supabase = createClient(config.supabase.url, config.supabase.key);

export class WalletService {
  private readonly encryptionKey: Buffer;

  constructor() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY is required");
    }
    // Create a 32-byte key using SHA256
    this.encryptionKey = crypto.createHash("sha256").update(key).digest();
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
    const provider = new JsonRpcProvider(CHAIN_CONFIGS[chain].rpc_url);
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
    const provider = new JsonRpcProvider(CHAIN_CONFIGS[chain].rpc_url);
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

  async getWallet(userId: string, chain: Chain): Promise<Wallet> {
    const { data, error } = await supabase
      .from("user_wallets")
      .select("*")
      .eq("user_id", userId)
      .eq("chain", chain)
      .single();

    if (error) throw error;
    if (!data) throw new Error("Wallet not found");

    const privateKey = this.decrypt(data.encrypted_private_key);

    // Get RPC URL based on chain
    let rpcUrl = CHAIN_CONFIGS[chain].rpc_url;
    if (chain === Chain.ETHEREUM) {
      const infuraKey = process.env.INFURA_API_KEY;
      if (!infuraKey) {
        throw new Error("INFURA_API_KEY is required for Ethereum network");
      }
      rpcUrl = `https://mainnet.infura.io/v3/${infuraKey}`;
    }

    if (!rpcUrl) {
      throw new Error(`RPC URL not configured for chain ${chain}`);
    }

    // Initialize provider with ENS configuration
    const provider = new JsonRpcProvider(rpcUrl, {
      name: 'mainnet',
      chainId: 1,
      ensAddress: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
    });

    try {
      // Test provider connection
      await provider.getNetwork();
    } catch (error) {
      console.error(`Provider connection error for ${chain}:`, error);
      throw new Error(`Could not connect to ${chain} network`);
    }

    return new Wallet(privateKey, provider);
  }

  async getWalletBalance(userId: string, chain: Chain): Promise<string> {
    try {
      const wallet = await this.getWallet(userId, chain);
      if (!wallet.provider) {
        throw new Error("Provider not connected");
      }
      const balance = await wallet.provider.getBalance(wallet.address);
      return balance.toString();
    } catch (error) {
      console.error(`Error getting balance for ${chain}:`, error);
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
