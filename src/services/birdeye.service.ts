import { ethers } from "ethers";
import { config } from "../config/config";
import { Chain } from "../types";
import WebSocket from "ws";

interface BirdEyeResponse<T> {
  data: T;
  success: boolean;
  message?: string;
}

interface BirdEyeTransaction {
  type: string;
  blockUnixTime: number;
  blockHumanTime: string;
  owner: string;
  source: string;
  txHash: string;
  volumeUSD: number;
  network: string;
  base?: {
    symbol: string;
    decimals: number;
    address: string;
    uiAmount: number;
  };
  quote?: {
    symbol: string;
    decimals: number;
    address: string;
    uiAmount: number;
  };
}

export class BirdEyeService {
  private readonly API_KEY: string;
  private readonly BASE_URL = "https://public-api.birdeye.so";
  private readonly WS_URL = "wss://public-api.birdeye.so/socket/base";
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000;

  constructor() {
    this.API_KEY = config.birdeye.api_key;
    console.log('🔑 BirdEye API Key:', this.API_KEY);
    // Verifikasi API key saat inisialisasi
    this.verifyApiKey();
  }

  private async verifyApiKey() {
    try {
      // Coba hit endpoint sederhana untuk verifikasi
      const response = await fetch(`${this.BASE_URL}/public/info`, {
        headers: {
          'X-API-KEY': this.API_KEY,
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`API Key tidak valid: ${response.statusText}`);
      }
      
      console.log('✅ API Key terverifikasi');
    } catch (error) {
      console.error('❌ Error verifikasi API key:', error);
    }
  }

  private async makeRequest<T>(endpoint: string, params: any = {}): Promise<BirdEyeResponse<T>> {
    const url = new URL(`${this.BASE_URL}${endpoint}`);
    Object.keys(params).forEach(key => 
      url.searchParams.append(key, params[key])
    );

    const response = await fetch(url.toString(), {
      headers: {
        'X-API-KEY': this.API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`BirdEye API error: ${response.statusText}`);
    }

    return await response.json() as BirdEyeResponse<T>;
  }

  async monitorWalletTransactions(address: string, callback: (transaction: BirdEyeTransaction) => void): Promise<() => void> {
    this.reconnectAttempts = 0;
    return this.connectWebSocket(address, callback);
  }

  private connectWebSocket(address: string, callback: (transaction: BirdEyeTransaction) => void): () => void {
    // Tutup koneksi yang ada jika ada
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Buat koneksi WebSocket baru dengan query parameter API key
    const wsUrl = `${this.WS_URL}?x-api-key=${this.API_KEY}`;
    console.log('🔗 Connecting to:', wsUrl);
    
    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': 'https://birdeye.so',
        'User-Agent': 'Mozilla/5.0',
        'Sec-WebSocket-Protocol': 'echo-protocol'
      },
      handshakeTimeout: 10000
    });

    this.ws.on('open', () => {
      console.log('🔌 WebSocket terhubung ke BirdEye');
      this.reconnectAttempts = 0;
      
      // Subscribe ke wallet transactions
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const subscribeMessage = {
          type: "SUBSCRIBE_WALLET_TXS",
          data: {
            address: address
          }
        };
        console.log('📤 Mengirim subscribe message:', JSON.stringify(subscribeMessage));
        this.ws.send(JSON.stringify(subscribeMessage));
      }
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === "WALLET_TXS_DATA") {
          console.log(`
📥 TRANSAKSI BARU TERDETEKSI
===========================
Tipe: ${message.data.type}
Waktu: ${message.data.blockHumanTime}
Hash: ${message.data.txHash}
Volume: $${message.data.volumeUSD}
Network: ${message.data.network}
===========================`);
          
          callback(message.data);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.handleReconnect(address, callback);
    });

    this.ws.on('close', () => {
      console.log('WebSocket terputus, mencoba reconnect...');
      this.handleReconnect(address, callback);
    });

    // Return cleanup function
    return () => {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    };
  }

  private handleReconnect(address: string, callback: (transaction: BirdEyeTransaction) => void) {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.log('Maksimum percobaan reconnect tercapai');
      return;
    }

    this.reconnectAttempts++;
    console.log(`Mencoba reconnect (${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`);
    
    setTimeout(() => {
      this.connectWebSocket(address, callback);
    }, this.RECONNECT_DELAY);
  }

  async getTokenPrice(tokenAddress: string): Promise<number> {
    try {
      const endpoint = `/public/price`;
      const params = {
        address: tokenAddress
      };

      const response = await this.makeRequest<{ value: number }>(endpoint, params);
      return response.data.value;
    } catch (error) {
      console.error('Error fetching token price:', error);
      throw error;
    }
  }
} 