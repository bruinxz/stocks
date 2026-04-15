-- 添加entry_date和exit_date列到trades表
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS entry_date TIMESTAMP,
ADD COLUMN IF NOT EXISTS exit_date TIMESTAMP;

-- 如果有trade_date列，将其数据复制到entry_date，然后删除trade_date列（可选）
-- ALTER TABLE trades DROP COLUMN IF EXISTS trade_date;