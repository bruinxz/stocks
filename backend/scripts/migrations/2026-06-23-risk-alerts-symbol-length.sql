-- 2026-06-23 风控真演练 (T1-01) — risk_alerts.symbol 长度修复
--
-- 背景: risk_alerts.symbol 之前是 VARCHAR(20), 但 codebase 用 'SYSTEM:*' 模式
-- 表示系统级 sentinel (按 UI / Grafana 分组):
--   SYSTEM:RISK_GUARD_UNAVAILABLE       (29 字符)
--   SYSTEM:DRAWDOWN_LEVEL_1/2/3         (23 字符)
--   SYSTEM:MARKET_REGIME_DEATH_CROSS    (32 字符)
--   SYSTEM:MARKET_REGIME_HALT_BUY       (29 字符)
--   SYSTEM:SCHEDULED_TASK_DRY_RUN_AUDIT (35 字符)
--   SYSTEM:WIZARD_VIOLATION             (23 字符)
--   SYSTEM:PRE_TRADE_COMPLIANCE         (27 字符)
-- 几乎全部超 20, 导致 RiskAlert.create 抛 'value too long for type
-- character varying(20)'. 而 handleRiskGuardUnavailable / 各 guard 都在
-- try/catch 里 logger.warn 吞错 — 半年 fail-CLOSED HIGH alert 在 prod 一条
-- 都没落库.
--
-- Risk drill 2026-06-23 scenario B 才把这个查出来:
--   [risk-guard-fail-closed] RiskAlert.create RISK_GUARD_UNAVAILABLE failed
--   (caller=automation.preTradeGuards guard=drawdown_breaker):
--   value too long for type character varying(20)
--
-- 修复: 拓宽到 64 (与 rule_id 同长度, 给未来 sentinel 留余量).
-- 同时 RiskAlert model 已经把 DataType.STRING(20) → STRING(64) 同步.

ALTER TABLE risk_alerts
  ALTER COLUMN symbol TYPE VARCHAR(64);

COMMENT ON COLUMN risk_alerts.symbol IS
  '触发告警的股票代码 (T1-01 2026-06-23: 20→64 防 SYSTEM:* 长 sentinel 截断)';
