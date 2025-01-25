-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id TEXT UNIQUE NOT NULL,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    is_subscribed BOOLEAN DEFAULT false,
    subscription_date TIMESTAMP WITH TIME ZONE,
    trading_amount TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User wallets table
CREATE TABLE user_wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL REFERENCES users(telegram_id),
    address TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    chain TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, chain)
);

-- Trader profiles table
CREATE TABLE trader_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address TEXT NOT NULL,
    chain TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    followers INTEGER DEFAULT 0,
    total_volume TEXT DEFAULT '0',
    profit_loss TEXT DEFAULT '0',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(address, chain)
);

-- Trader followers table
CREATE TABLE trader_followers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL REFERENCES users(telegram_id),
    trader_address TEXT NOT NULL,
    chain TEXT NOT NULL,
    followed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, trader_address, chain)
);

-- Transactions table
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL REFERENCES users(telegram_id),
    trader_id TEXT,
    chain TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    token_address TEXT,
    amount_in TEXT,
    amount_out TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(chain, tx_hash)
);

-- Trusted traders table
CREATE TABLE trusted_traders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address TEXT NOT NULL,
    chain TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    min_copy_amount TEXT,
    max_copy_amount TEXT,
    is_active BOOLEAN DEFAULT true,
    total_trades INTEGER DEFAULT 0,
    success_rate DECIMAL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(address, chain)
);

-- Update timestamps function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updating timestamps
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_wallets_updated_at
    BEFORE UPDATE ON user_wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trader_profiles_updated_at
    BEFORE UPDATE ON trader_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trusted_traders_updated_at
    BEFORE UPDATE ON trusted_traders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create indexes for better query performance
CREATE INDEX idx_user_wallets_user_id ON user_wallets(user_id);
CREATE INDEX idx_trader_followers_user_id ON trader_followers(user_id);
CREATE INDEX idx_trader_followers_trader_address ON trader_followers(trader_address);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_trader_id ON transactions(trader_id);
CREATE INDEX idx_transactions_chain_status ON transactions(chain, status);

-- Insert trusted traders
INSERT INTO trusted_traders (
    address,
    chain,
    name,
    description,
    min_copy_amount,
    is_active,
    total_trades,
    success_rate
) VALUES 
(
    '0xcbb385321b8be68500493440dbe1a50c8319f6ec',
    'ETHEREUM',
    'Alpha Trader 1',
    'Experienced DeFi trader with focus on mid-cap tokens',
    '0.0001',
    true,
    156,
    85.5
),
(
    '0x7b402C80Bf4779292c2694f5D86e32d9bF9Fb4Db',
    'ETHEREUM',
    'Alpha Trader 2',
    'Specializes in new token launches and early opportunities',
    '0.0001',
    true,
    203,
    82.3
); 