-- AT-1 2026-06-22 — 部署后 ops 步骤: 把 user_id=4 (admin) 现有 active portfolio
-- 的 auto_trade_enabled 恢复 true (保持线上 auto_sync 行为不被默认 false 关闭).
--
-- 主 migration 默认所有 portfolio auto_trade_enabled=false, 防止"用户没看到字段就被悄悄自动跟单".
-- 但 user_id=4 admin 是 prod 一直在用的 auto-sync 主账号, 不能因为升级被静默暂停.
--
-- 执行 (部署主 migration 之后立刻跑):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-22-admin-keep-auto-trade.sql

BEGIN;

UPDATE paper_trading_portfolios
   SET auto_trade_enabled = true
 WHERE user_id = 4
   AND is_active = true;

COMMIT;
