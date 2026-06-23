-- 2026-06-23 风控真演练 (T1-01) — risk_alerts.symbol 长度回滚
-- 注意: 回滚到 VARCHAR(20) 之前 **必须** 把 symbol 超 20 字符的行先删干净,
-- 否则 ALTER 直接报错. SYSTEM:* 全部超 20, 所以默认会失败 — 这是故意的,
-- 表示"该字段实际数据已经依赖 64 长度, 不应回退".

ALTER TABLE risk_alerts
  ALTER COLUMN symbol TYPE VARCHAR(20);
