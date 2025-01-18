import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env file explicitly from project root
dotenv.config({ path: resolve(__dirname, '../../.env') });

console.log('Loading environment variables...');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY);

export const config = {
  botToken: process.env.BOT_TOKEN!,
  supabase: {
    url: process.env.SUPABASE_URL!,
    key: process.env.SUPABASE_KEY!,
  },
};
