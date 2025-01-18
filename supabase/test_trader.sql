-- Insert test trader profile
INSERT INTO trader_profiles (
    address,
    chain,
    is_active,
    followers,
    total_volume,
    profit_loss
) VALUES (
    '0xYOUR_TEST_TRADER_ADDRESS', -- Ganti dengan alamat wallet test trader
    'ethereum',  -- Menggunakan Sepolia testnet
    true,       -- Trader aktif
    0,          -- Mulai dengan 0 follower
    '0',        -- Volume awal 0
    '0'         -- Profit/loss awal 0
); 