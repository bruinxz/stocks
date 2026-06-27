-- Phase 2 — 关闭 20 个旧盘 (16 active + 4 僵尸 Agent 空盘)
--
-- 不删 row, 只 is_active=false + auto_trade_enabled=false 保留历史 trades / snapshots / positions.
-- 旧盘的持仓不平 — 用户可通过 admin "已归档" 入口看到历史持仓 + trade 记录.
--
-- 关闭范围 (DA-0 表 1.1):
--   16 active 实跑盘: 25..40
--    4 Agent 空盘:    61, 62, 63, 64
--    (#24 系统观测盘 已 is_active=false, 不动)
--    (新建的 '综合策略主盘' 受 WHERE name != '综合策略主盘' 排除保护)
--
-- 使用 (生产):
--   走 sequelize 节点脚本 (ops 账号无 psql):
--   node backend/dist/scripts/ops/phase2_run_consolidation.js --apply

BEGIN;

-- 1. 列出关闭前的活跃盘 (审计 trail)
SELECT id, name, user_id, initial_capital, total_value, is_active, auto_trade_enabled
FROM paper_trading_portfolios
WHERE is_active = true
ORDER BY id;

-- 2. 关闭所有非综合主盘的 active 盘
UPDATE paper_trading_portfolios
SET is_active = false,
    auto_trade_enabled = false,
    updated_at = NOW()
WHERE is_active = true
  AND name != '综合策略主盘';

-- 3. 显示关闭结果 — 应仅剩 综合策略主盘 是 active
SELECT 'remaining_active' AS kind, COUNT(*) AS n
FROM paper_trading_portfolios WHERE is_active = true
UNION ALL
SELECT 'closed_in_this_txn', COUNT(*)
FROM paper_trading_portfolios
WHERE is_active = false
  AND updated_at > NOW() - INTERVAL '1 minute';

-- 4. 综合主盘留存的 sanity check (= 1)
SELECT id, name FROM paper_trading_portfolios
WHERE is_active = true ORDER BY id;

COMMIT;
