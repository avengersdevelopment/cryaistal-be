import * as dotenv from "dotenv";
import { resolve } from "path";

// Load .env file explicitly from project root
dotenv.config({ path: resolve(__dirname, "../../.env") });

console.log("Loading environment variables...");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY:", process.env.SUPABASE_KEY);

export const config = {
  botToken: process.env.BOT_TOKEN || "",
  supabase: {
    url: process.env.SUPABASE_URL || "",
    key: process.env.SUPABASE_KEY || "",
  },
  ethereum: {
    rpc_url: process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "https://mainnet.infura.io/v3/27c63b1dd92641d6a42dfd87c93d439a"
  },
  uniswap: {
    router: process.env.UNISWAP_V3_ROUTER || "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    factory: process.env.UNISWAP_V3_FACTORY || "0x1F98431c8aD98523631AE4a59f267346ea31F984"
  }
};
