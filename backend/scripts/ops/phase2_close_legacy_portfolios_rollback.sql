-- Phase 2 rollback — 把 20 个旧盘恢复 is_active=true (auto_trade 不动, 避免误下单)
--
-- 用途: 如果发现新的"综合策略主盘"配置有问题, 想暂回到老多盘并行.
-- 仅恢复 is_active, 不打开 auto_trade — 用户需要手工再开自动跟单.

BEGIN;

UPDATE paper_trading_portfolios
SET is_active = true,
    updated_at = NOW()
WHERE id IN (25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,61,62,63,64);

SELECT id, name, is_active, auto_trade_enabled
FROM paper_trading_portfolios
WHERE id IN (25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,61,62,63,64)
ORDER BY id;

COMMIT;
