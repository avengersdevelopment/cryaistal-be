import * as dotenv from "dotenv";
import { WETH9 } from "@uniswap/sdk-core";
import { Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "../../.env") });

const mode = process.env.NETWORK_MODE as "mainnet" | "testnet";

interface DeploymentConfig {
  POOL_MANAGER: Address;
  POSITION_MANAGER: Address;
  QUOTER: Address;
  STATE_VIEW: Address;
  UNIVERSAL_ROUTER: Address;
  CHAIN_ID: number;
  NAME: string;
  RPC_URL: string;
  WS_URL: string;
  WETH: Address | string;
}

const baseMainnet: DeploymentConfig = {
  POOL_MANAGER: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  POSITION_MANAGER: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
  QUOTER: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // Still use the old Quoter (V2)
  STATE_VIEW: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  UNIVERSAL_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481", // Still use the old Universal Router (V3)S
  CHAIN_ID: base.id,
  NAME: base.name,
  RPC_URL: process.env.BASE_RPC_URL || "",
  WS_URL: process.env.BASE_WS_URL || "",
  WETH: WETH9[base.id].address,
};

const baseTestnet: DeploymentConfig = {
  POOL_MANAGER: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
  POSITION_MANAGER: "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80",
  QUOTER: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",
  STATE_VIEW: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
  UNIVERSAL_ROUTER: "0x492e6456d9528771018deb9e87ef7750ef184104",
  CHAIN_ID: baseSepolia.id,
  NAME: baseSepolia.name,
  RPC_URL: process.env.BASE_RPC_URL || "",
  WS_URL: process.env.BASE_WS_URL || "",
  WETH: WETH9[baseSepolia.id].address,
};

export const DEPLOYMENTS_ADDRESS: DeploymentConfig =
  mode === "mainnet" ? baseMainnet : baseTestnet;
