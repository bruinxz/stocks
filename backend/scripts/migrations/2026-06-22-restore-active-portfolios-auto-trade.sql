-- AT-2-FIX (2026-06-22 二轮 review) — 补 admin-keep SQL 漏洞 (P1 silent regression).
--
-- 背景: AT-1 主 migration 默认 auto_trade_enabled=false, 防止用户被动失血.
-- admin-keep SQL 只补了 user_id=4 (stock). 但 user_id=2 (lym) 也有 8 个 active
-- portfolio 在 cron 35 `all_portfolios=true` 下被实际跟单 (最近交易 2026-06-18),
-- migration 部署后这 8 个盘全部静默被关掉 — 用户视角看是 prod 之前在跑现在
-- 突然不跑了, 没有任何告警.
--
-- 修法: 补一道更通用的 "有近 30 天真实交易就保持自动跟单" SQL. 比硬编码
-- user_id=4 更稳健 (未来新增 user 时不需要再加 SQL).
--
-- 思路: 任何 paper_trading_portfolios.is_active=true 且 paper_trading_trades 表里
-- 在最近 30 天有 trade 的 portfolio, 视为 "用户在用 + cron 在跟单" → 强制开 auto_trade_enabled.
--
-- 执行 (在 AT-1 主 migration + admin-keep SQL 之后):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-22-restore-active-portfolios-auto-trade.sql

BEGIN;

UPDATE paper_trading_portfolios p
   SET auto_trade_enabled = true
 WHERE p.is_active = true
   AND p.auto_trade_enabled = false
   AND EXISTS (
     SELECT 1 FROM paper_trading_trades t
      WHERE t.portfolio_id = p.id
        AND t.created_at > NOW() - INTERVAL '30 days'
   );

COMMIT;
