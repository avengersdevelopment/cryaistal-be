import { Wallet, JsonRpcProvider } from "ethers";
import * as crypto from "crypto";
import { Chain, UserWallet } from "../types";
import { CHAIN_CONFIGS } from "../config/chains";
import { createClient } from "@supabase/supabase-js";
import { config } from '../config/config';

const supabase = createClient(
  config.supabase.url,
  config.supabase.key
);

export class WalletService {
  private readonly encryptionKey: Buffer;

  constructor() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY is required");
    }
    // Memastikan kunci enkripsi tepat 32 bytes
    this.encryptionKey = crypto.createHash('sha256').update(String(key)).digest();
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      this.encryptionKey,
      iv
    );
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
    const provider = new JsonRpcProvider(CHAIN_CONFIGS[chain].rpcUrl);
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
    const provider = new JsonRpcProvider(CHAIN_CONFIGS[chain].rpcUrl);
    return new Wallet(privateKey, provider);
  }

  async getWalletBalance(userId: string, chain: Chain): Promise<string> {
    const wallet = await this.getWallet(userId, chain);
    if (!wallet.provider) {
      throw new Error("Provider not connected");
    }
    const balance = await wallet.provider.getBalance(wallet.address);
    return balance.toString();
  }
}
