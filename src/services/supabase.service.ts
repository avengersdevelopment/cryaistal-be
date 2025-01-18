import { createClient } from "@supabase/supabase-js";
import { Chain } from "../types";

interface User {
  telegram_id: string;
  created_at?: string;
  updated_at?: string;
}

class SupabaseService {
  private client;

  constructor() {
    this.client = createClient(
      process.env.SUPABASE_URL || "",
      process.env.SUPABASE_KEY || ""
    );
  }

  async saveUser(user: User): Promise<void> {
    const { error } = await this.client
      .from("users")
      .upsert([user], { onConflict: "telegram_id" });

    if (error) {
      throw new Error(`Error saving user: ${error.message}`);
    }
  }

  async getUserByTelegramId(telegramId: string): Promise<User | null> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    if (error) {
      throw new Error(`Error fetching user: ${error.message}`);
    }

    return data;
  }

  async getWalletsByUserId(userId: string) {
    const { data, error } = await this.client
      .from("user_wallets")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      throw new Error(`Error fetching wallets: ${error.message}`);
    }

    return data;
  }

  async getWalletByChain(userId: string, chain: Chain) {
    const { data, error } = await this.client
      .from("user_wallets")
      .select("*")
      .eq("user_id", userId)
      .eq("chain", chain)
      .single();

    if (error) {
      throw new Error(`Error fetching wallet: ${error.message}`);
    }

    return data;
  }

  async getTraderFollowers(traderAddress: string, chain: Chain) {
    const { data, error } = await this.client
      .from("trader_followers")
      .select("user_id")
      .eq("trader_address", traderAddress)
      .eq("chain", chain);

    if (error) {
      throw new Error(`Error fetching followers: ${error.message}`);
    }

    return data;
  }

  async saveTransaction(transaction: {
    user_id: string;
    trader_id?: string;
    chain: Chain;
    tx_hash: string;
    token_address?: string;
    amount_in?: string;
    amount_out?: string;
    status: "pending" | "completed" | "failed";
    error?: string;
  }) {
    const { error } = await this.client
      .from("transactions")
      .insert([transaction]);

    if (error) {
      throw new Error(`Error saving transaction: ${error.message}`);
    }
  }
}

export const supabaseService = new SupabaseService();
