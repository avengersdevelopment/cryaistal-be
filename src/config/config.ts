import * as dotenv from "dotenv";
import { resolve } from "path";

// Load .env file explicitly from project root
dotenv.config({ path: resolve(__dirname, "../../.env") });

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    key: process.env.SUPABASE_KEY || "",
  },
  base: {
    rpc: {
      http: process.env.BASE_RPC_HTTP || "",
      ws: process.env.BASE_RPC_WS || "",
    },
    uniswap: {
      router: process.env.UNISWAP_ROUTER || "",
      universal_router: process.env.UNISWAP_UNIVERSAL_ROUTER || "",
      factory: process.env.UNISWAP_FACTORY || "",
      quoter: process.env.UNISWAP_QUOTER || "",
    },
  },
  quicknode: {
    rpc_url: process.env.QUICKNODE_RPC_URL || "",
    ws_url: process.env.QUICKNODE_WS_URL || ""
  },
  birdeye: {
    api_key: process.env.BIRDEYE_API_KEY || "",
  }
};
