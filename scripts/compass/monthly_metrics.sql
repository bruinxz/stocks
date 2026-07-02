-- =====================================================================
-- 战略镜子 · 月度客观指标 SQL (§8 monthly_metrics)
-- ---------------------------------------------------------------------
-- 用途: 每月第一个周末填战略镜子 (docs/compass/YYYY-MM.md) 前,
--       跑本脚本取 6 题所需的客观数据 (层 1 现状 / 层 2 评估).
--       AI 只填客观数据, 主观归因 (层 3) 与决定 (层 4) 必须人手写 (§8.1).
--
-- 口径:
--   - 核心 (Core)   = recommendation_trade_outcomes.source_type='etf_factor_rotation'
--   - 卫星 (Sat)    = source_type='theme_event'
--   - 现金 (Cash)   = source_type='cash_management'
--   - alpha         = excess_return_pct (相对基准 CSI300 的超额, RecommendationTradeOutcome 已算)
--   - 月度归属      = exit_date 落在目标自然月 (已平仓口径), 未平仓单独统计浮盈亏
--
-- 使用:
--   psql "$DB_URL" -v month="'2026-07'" -f scripts/compass/monthly_metrics.sql
--   (缺省 :month 用当前自然月)
-- =====================================================================

-- 目标月 (YYYY-MM). 未传 -v month=... 时默认取当前自然月 (shell date).
\if :{?month}
\else
  \set month `date +%Y-%m | sed "s/.*/'&'/"`
\endif

\echo '================ 战略镜子月度指标 · 目标月:' :month '================'

-- ---------------------------------------------------------------------
-- Q1 / Q3 / Q4: 各桶月度已平仓表现 (笔数 / 胜率 / 平均盈亏 / 总 PnL / 平均 alpha)
-- ---------------------------------------------------------------------
\echo '--- [Q1/Q3/Q4] 各桶月度已平仓表现 (exit_date 落在目标月) ---'
SELECT
  CASE source_type
    WHEN 'etf_factor_rotation' THEN 'core_核心'
    WHEN 'theme_event'         THEN 'satellite_卫星'
    WHEN 'cash_management'     THEN 'cash_现金'
    ELSE source_type
  END                                                    AS bucket,
  COUNT(*)                                               AS n_closed,
  ROUND(100.0 * SUM((realized_pnl > 0)::int) / NULLIF(COUNT(*),0), 1) AS win_pct,
  ROUND(AVG(realized_pnl_pct)::numeric, 3)               AS avg_pnl_pct,
  ROUND(AVG(realized_pnl_pct) FILTER (WHERE realized_pnl > 0)::numeric, 3) AS avg_win_pct,
  ROUND(AVG(realized_pnl_pct) FILTER (WHERE realized_pnl <= 0)::numeric, 3) AS avg_loss_pct,
  ROUND(SUM(realized_pnl)::numeric, 2)                   AS total_realized_pnl,
  ROUND(AVG(excess_return_pct)::numeric, 3)             AS avg_alpha_pct
FROM recommendation_trade_outcomes
WHERE trade_status = 'closed'
  AND to_char(exit_date, 'YYYY-MM') = :month
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q1 / Q3: 各桶当前持仓 (未平仓) 浮盈亏
-- ---------------------------------------------------------------------
\echo '--- [Q1/Q3] 各桶当前持仓浮盈亏 (未平仓) ---'
SELECT
  CASE source_type
    WHEN 'etf_factor_rotation' THEN 'core_核心'
    WHEN 'theme_event'         THEN 'satellite_卫星'
    WHEN 'cash_management'     THEN 'cash_现金'
    ELSE source_type
  END                                                    AS bucket,
  COUNT(*)                                               AS n_open,
  ROUND(SUM(unrealized_pnl)::numeric, 2)                AS total_unrealized_pnl,
  ROUND(AVG(unrealized_pnl_pct)::numeric, 3)            AS avg_unrealized_pnl_pct
FROM recommendation_trade_outcomes
WHERE trade_status IN ('open', 'executed', 'closing')
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q3 硬边界: 卫星 60 天滚动窗口累计亏损 (占组合%) — §4.2 / §8.3 冻结阈值 5%
-- ---------------------------------------------------------------------
\echo '--- [Q3] 卫星 60 天滚动累计亏损 (已实现+未平仓浮亏, 占组合%) 冻结阈值 5% ---'
WITH pf AS (
  SELECT id, GREATEST(total_value, initial_capital) AS base
  FROM paper_trading_portfolios WHERE is_active = true
),
realized60 AS (
  SELECT o.portfolio_id, COALESCE(SUM(o.realized_pnl),0) AS realized
  FROM recommendation_trade_outcomes o
  WHERE o.source_type = 'theme_event' AND o.trade_status = 'closed'
    AND o.exit_date > (CURRENT_DATE - INTERVAL '60 days')
  GROUP BY o.portfolio_id
),
unreal AS (
  SELECT o.portfolio_id, COALESCE(SUM(LEAST(o.unrealized_pnl,0)),0) AS unrealized_loss
  FROM recommendation_trade_outcomes o
  WHERE o.source_type = 'theme_event' AND o.trade_status IN ('open','executed','closing')
  GROUP BY o.portfolio_id
)
SELECT
  pf.id                                                  AS portfolio_id,
  ROUND(COALESCE(r.realized,0)::numeric, 2)             AS realized_60d,
  ROUND(COALESCE(u.unrealized_loss,0)::numeric, 2)      AS unrealized_loss_now,
  ROUND((-(COALESCE(r.realized,0)+COALESCE(u.unrealized_loss,0)) / NULLIF(pf.base,0) * 100)::numeric, 2) AS rolling_loss_pct,
  CASE WHEN (-(COALESCE(r.realized,0)+COALESCE(u.unrealized_loss,0)) / NULLIF(pf.base,0) * 100) > 5
       THEN 'FREEZE_触发冻结' ELSE 'ok' END              AS freeze_flag
FROM pf
LEFT JOIN realized60 r ON r.portfolio_id = pf.id
LEFT JOIN unreal u ON u.portfolio_id = pf.id
ORDER BY pf.id;

-- ---------------------------------------------------------------------
-- Q3 硬边界: 卫星连续月度 alpha (§4.2 / §8.3 连续 3 月 alpha<0 永久停)
-- ---------------------------------------------------------------------
\echo '--- [Q3] 卫星最近 6 个自然月月度 alpha (连续 3 月<0 => 永久停) ---'
SELECT
  to_char(exit_date, 'YYYY-MM')                          AS month,
  COUNT(*)                                               AS n_closed,
  ROUND(SUM(excess_return_pct)::numeric, 3)             AS month_alpha_sum,
  CASE WHEN SUM(excess_return_pct) < 0 THEN 'neg' ELSE 'pos_or_zero' END AS alpha_sign
FROM recommendation_trade_outcomes
WHERE source_type = 'theme_event' AND trade_status = 'closed'
  AND exit_date > (CURRENT_DATE - INTERVAL '6 months')
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q2: 核心因子稳定性 — 核心月度胜率 & alpha 逐月 (看是否漂移)
-- ---------------------------------------------------------------------
\echo '--- [Q2] 核心 (ETF 因子) 最近 6 月逐月胜率/alpha (看稳定性) ---'
SELECT
  to_char(exit_date, 'YYYY-MM')                          AS month,
  COUNT(*)                                               AS n_closed,
  ROUND(100.0 * SUM((realized_pnl > 0)::int) / NULLIF(COUNT(*),0), 1) AS win_pct,
  ROUND(AVG(excess_return_pct)::numeric, 3)             AS avg_alpha_pct
FROM recommendation_trade_outcomes
WHERE source_type = 'etf_factor_rotation' AND trade_status = 'closed'
  AND exit_date > (CURRENT_DATE - INTERVAL '6 months')
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q4: 核心 vs 卫星 Sharpe 对比 (月度已平仓 PnL% 的均值/标准差近似)
--     注: 严格 Sharpe 需日频净值曲线, 此处用月内已平仓单 PnL% 分布作近似诊断.
-- ---------------------------------------------------------------------
\echo '--- [Q4] 核心 vs 卫星 已平仓单 PnL% 分布 (近似 Sharpe = mean/std) ---'
SELECT
  CASE source_type
    WHEN 'etf_factor_rotation' THEN 'core_核心'
    WHEN 'theme_event'         THEN 'satellite_卫星'
    ELSE source_type
  END                                                    AS bucket,
  COUNT(*)                                               AS n_closed,
  ROUND(AVG(realized_pnl_pct)::numeric, 3)              AS mean_pnl_pct,
  ROUND(STDDEV_SAMP(realized_pnl_pct)::numeric, 3)      AS std_pnl_pct,
  ROUND((AVG(realized_pnl_pct) / NULLIF(STDDEV_SAMP(realized_pnl_pct),0))::numeric, 3) AS sharpe_like
FROM recommendation_trade_outcomes
WHERE source_type IN ('etf_factor_rotation','theme_event')
  AND trade_status = 'closed'
  AND exit_date > (CURRENT_DATE - INTERVAL '3 months')
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------
-- 组合总览: 各 active 组合当前净值 / 现金 / 收益
-- ---------------------------------------------------------------------
\echo '--- [总览] active 组合净值/现金 ---'
SELECT
  id AS portfolio_id, name,
  ROUND(initial_capital::numeric,2) AS initial_capital,
  ROUND(current_cash::numeric,2)    AS current_cash,
  ROUND(total_value::numeric,2)     AS total_value,
  ROUND(((total_value - initial_capital) / NULLIF(initial_capital,0) * 100)::numeric, 2) AS total_return_pct
FROM paper_trading_portfolios
WHERE is_active = true
ORDER BY id;

\echo '================ 指标输出完毕. 层3归因/层4决定请人手填 docs/compass/YYYY-MM.md ================'
