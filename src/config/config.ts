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
  base: {
    rpc_url: process.env.QUICKNODE_RPC_URL || "https://falling-sly-mountain.base-mainnet.quiknode.pro/idqucknode",
    chainId: 8453,
    uniswap: {
      router: process.env.UNISWAP_V3_ROUTER || "0x2626664c2603336E57B271c5C0b26F421741e481", // BASE Uniswap v3 Router
      factory: process.env.UNISWAP_V3_FACTORY || "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" // BASE Uniswap v3 Factory
    }
  }
};
