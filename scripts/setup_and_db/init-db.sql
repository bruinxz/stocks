-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create stocks table
CREATE TABLE IF NOT EXISTS stocks (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL,
    name VARCHAR(100) NOT NULL,
    market VARCHAR(10),
    industry VARCHAR(100),
    listing_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol)
);

-- Create daily_bars table (time-series)
CREATE TABLE IF NOT EXISTS daily_bars (
    time TIMESTAMP NOT NULL,
    stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    open DECIMAL(12, 4) NOT NULL,
    high DECIMAL(12, 4) NOT NULL,
    low DECIMAL(12, 4) NOT NULL,
    close DECIMAL(12, 4) NOT NULL,
    volume BIGINT NOT NULL,
    turnover DECIMAL(20, 4),
    adj_close DECIMAL(12, 4),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (time, stock_id)
);

-- Convert daily_bars to hypertable
SELECT create_hypertable('daily_bars', 'time', if_not_exists => TRUE);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_daily_bars_stock_id ON daily_bars(stock_id);
CREATE INDEX IF NOT EXISTS idx_daily_bars_time_desc ON daily_bars(time DESC);

-- Create backtest_results table
CREATE TABLE IF NOT EXISTS backtest_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    strategy_config JSONB NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    initial_capital DECIMAL(20, 4) NOT NULL,
    final_capital DECIMAL(20, 4) NOT NULL,
    total_return DECIMAL(10, 4) NOT NULL,
    annualized_return DECIMAL(10, 4),
    sharpe_ratio DECIMAL(10, 4),
    max_drawdown DECIMAL(10, 4),
    win_rate DECIMAL(10, 4),
    total_trades INTEGER NOT NULL,
    profit_trades INTEGER NOT NULL,
    loss_trades INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'completed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create trades table
CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backtest_id UUID NOT NULL REFERENCES backtest_results(id) ON DELETE CASCADE,
    trade_date TIMESTAMP NOT NULL,
    stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL, -- 'long' or 'short'
    entry_price DECIMAL(12, 4) NOT NULL,
    exit_price DECIMAL(12, 4) NOT NULL,
    quantity INTEGER NOT NULL,
    pnl DECIMAL(12, 4) NOT NULL,
    pnl_percent DECIMAL(10, 4) NOT NULL,
    holding_days INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_backtest_results_created_at ON backtest_results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_backtest_id ON trades(backtest_id);
CREATE INDEX IF NOT EXISTS idx_trades_trade_date ON trades(trade_date);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_stocks_updated_at BEFORE UPDATE ON stocks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_backtest_results_updated_at BEFORE UPDATE ON backtest_results
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();