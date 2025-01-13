import { createClient } from '@supabase/supabase-js';
import { config } from '../config/config';
import { UserData } from '../types';

class SupabaseService {
  private client;

  constructor() {
    this.client = createClient(config.supabase.url, config.supabase.key);
  }

  async saveUser(userData: UserData): Promise<void> {
    const { error } = await this.client
      .from('users')
      .upsert([userData], { onConflict: 'telegram_id' });

    if (error) {
      throw new Error(`Error saving user: ${error.message}`);
    }
  }

  async getUserByTelegramId(telegramId: number): Promise<UserData | null> {
    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error) {
      throw new Error(`Error fetching user: ${error.message}`);
    }

    return data;
  }
}

export const supabaseService = new SupabaseService();
