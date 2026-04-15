-- 快速修复股票代码格式：添加点号
-- 仅针对不带点号且格式为两个小写字母后跟数字的代码

BEGIN;

-- 检查冲突：转换后的代码是否已存在
SELECT COUNT(*) as conflict_count
FROM stocks s1
JOIN stocks s2 ON s1.id != s2.id
WHERE s1.symbol NOT LIKE '%.%'
  AND s2.symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
  AND s1.symbol ~ '^[a-z]{2}[0-9]+$';

-- 如果冲突数为0，执行更新
UPDATE stocks
SET symbol = LEFT(symbol, 2) || '.' || SUBSTRING(symbol FROM 3)
WHERE symbol NOT LIKE '%.%'
  AND symbol ~ '^[a-z]{2}[0-9]+$';

-- 验证更新
SELECT
  COUNT(*) as total,
  COUNT(CASE WHEN symbol LIKE '%.%' THEN 1 END) as with_dot,
  COUNT(CASE WHEN symbol NOT LIKE '%.%' THEN 1 END) as without_dot
FROM stocks;

COMMIT;