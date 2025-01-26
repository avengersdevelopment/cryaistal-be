import { BirdEyeService } from "./services/birdeye.service";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config/config";

const supabase = createClient(config.supabase.url, config.supabase.key);

async function testBirdEyeMonitoring() {
  const birdEyeService = new BirdEyeService();
  
  // Ambil daftar trusted trader yang aktif dari database
  const { data: traders, error } = await supabase
    .from("trusted_traders")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("Error mengambil data trader:", error);
    return;
  }

  if (!traders || traders.length === 0) {
    console.log("Tidak ada trusted trader yang aktif");
    return;
  }

  console.log(`
🚀 MEMULAI MONITORING BIRDEYE
===========================
Total Trader: ${traders.length}
===========================`);

  // Monitor setiap trader
  const cleanupFunctions = await Promise.all(
    traders.map(async (trader) => {
      console.log(`
📡 MONITORING TRADER
==================
Nama: ${trader.name}
Alamat: ${trader.address}
Chain: ${trader.chain}
Success Rate: ${trader.success_rate}%
==================`);

      return birdEyeService.monitorWalletTransactions(
        trader.address,
        (transaction) => {
          console.log(`
🔍 DETAIL TRANSAKSI
=================
Trader: ${trader.name}
Type: ${transaction.type}
Time: ${transaction.blockHumanTime}
Network: ${transaction.network}
Volume: $${transaction.volumeUSD}
Base Token: ${transaction.base?.symbol || 'N/A'} (${transaction.base?.uiAmount || 0})
Quote Token: ${transaction.quote?.symbol || 'N/A'} (${transaction.quote?.uiAmount || 0})
=================`);
        }
      );
    })
  );

  // Cleanup saat program dihentikan
  process.on('SIGINT', () => {
    console.log('Menghentikan monitoring...');
    cleanupFunctions.forEach(cleanup => cleanup());
    process.exit();
  });
}

// Jalankan test
testBirdEyeMonitoring().catch(console.error); 