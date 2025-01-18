import { Telegraf, Context } from "telegraf";
import { Chain } from "../types";
import { WalletService } from "../services/wallet.service";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

export function setupStartCommand(bot: Telegraf<Context>) {
  const walletService = new WalletService();

  bot.command("start", async (ctx) => {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) {
        ctx.reply("Error: Could not identify user");
        return;
      }

      // Check if user already exists
      const { data: existingUser } = await supabase
        .from("users")
        .select("*")
        .eq("telegram_id", userId)
        .single();

      if (existingUser) {
        // Ambil wallet yang sudah ada
        const chains = Object.values(Chain);
        const wallets = await Promise.all(
          chains.map(async (chain) => {
            const wallet = await walletService.getWallet(userId, chain);
            return `${chain.toUpperCase()}: \`${wallet.address}\``;
          })
        );

        const message = `
🏦 *Wallet Anda:*

${wallets.join('\n')}

Gunakan /deposit untuk melihat QR code deposit
Gunakan /balance untuk cek saldo
`;
        ctx.replyWithMarkdown(message);
        return;
      }

      // Buat user baru
      await supabase.from("users").insert([
        {
          telegram_id: userId,
          created_at: new Date().toISOString(),
        },
      ]);

      // Generate wallet untuk semua chain yang didukung
      const chains = Object.values(Chain);
      const generatedWallets = await Promise.all(
        chains.map(async (chain) => {
          const wallet = await walletService.createWallet(userId, chain);
          return `${chain.toUpperCase()}: \`${wallet.address}\``;
        })
      );

      const message = `
🎉 *Selamat Datang di Copy Trading Bot!*

✨ Wallet Anda telah berhasil digenerate:

${generatedWallets.join('\n')}

*Perintah yang tersedia:*
📥 /deposit - Lihat QR code deposit
💰 /balance - Cek saldo
👥 /follow <address> - Ikuti trader
❌ /unfollow <address> - Berhenti mengikuti
📊 /traders - Lihat daftar trader
ℹ️ /help - Bantuan

*Catatan Penting:*
• Selalu verifikasi alamat sebelum deposit
• Mulai dengan jumlah kecil untuk testing
• Trading memiliki risiko - trade dengan bijak
`;

      ctx.replyWithMarkdown(message);
    } catch (error: any) {
      console.error("Error in start command:", error);
      ctx.reply("Maaf, terjadi kesalahan. Silakan coba lagi nanti.");
    }
  });
}
