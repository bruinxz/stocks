-- Phase 2 rollback — 删除综合策略主盘
--
-- 用于回滚 phase2_create_master_portfolio.sql.
-- 只在新盘 0 持仓 0 trade 时安全 (= 部署当晚立即回滚).

BEGIN;

-- 1. 显示要删的盘 + 它的持仓 / trade 数 (审计)
SELECT
  p.id, p.name, p.user_id, p.is_active,
  (SELECT COUNT(*) FROM paper_trading_positions WHERE portfolio_id = p.id) AS n_positions,
  (SELECT COUNT(*) FROM paper_trading_trades WHERE portfolio_id = p.id) AS n_trades,
  (SELECT COUNT(*) FROM paper_trading_snapshots WHERE portfolio_id = p.id) AS n_snapshots
FROM paper_trading_portfolios p
WHERE p.name = '综合策略主盘';

-- 2. 安全删 (有 trade / position 则拒绝) — 必须先手工清理
DO $$
DECLARE
  v_trade_cnt INTEGER;
  v_pos_cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_trade_cnt FROM paper_trading_trades t
    JOIN paper_trading_portfolios p ON p.id = t.portfolio_id
    WHERE p.name = '综合策略主盘';
  SELECT COUNT(*) INTO v_pos_cnt FROM paper_trading_positions po
    JOIN paper_trading_portfolios p ON p.id = po.portfolio_id
    WHERE p.name = '综合策略主盘';
  IF v_trade_cnt > 0 OR v_pos_cnt > 0 THEN
    RAISE EXCEPTION '综合策略主盘 已有 % 笔 trade + % 持仓, 拒绝物理删 (改用 is_active=false)',
      v_trade_cnt, v_pos_cnt;
  END IF;
END $$;

DELETE FROM paper_trading_portfolios WHERE name = '综合策略主盘';

COMMIT;
