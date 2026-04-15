-- 添加userId列到backtest_results表，并设置默认值为1
ALTER TABLE backtest_results
ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1;

-- 添加外键约束
ALTER TABLE backtest_results
ADD CONSTRAINT fk_backtest_results_user
FOREIGN KEY (user_id) REFERENCES users(id)
ON DELETE CASCADE;