-- 批9 补漏: 退役空跑的 '推荐信号模拟盘跟单' cron (PAPER_TRADING_AUTO_SYNC)
--
-- 定性 (2026-07-03 计划闭环复核):
--   该 cron 带 refresh_recommendations=true + source_type='quant_recommendation'.
--   批5 已删除 QuantRecommendationService — 全系统再无任何服务产出 quant_recommendation
--   信号, 故 refreshRecommendations 分支恒归档 0 条候选, autoBuyFromSignals 亦查不到
--   新信号, 该 cron 每交易日 15:40 纯空跑. 与批9 清理的 5 个批5 下线 cron 同型
--   (service 删了/seed 没删), 属遗漏的第 6 个 "下线做一半".
--   Core 70% 已由 ETFRotationService (source_type=etf_factor_rotation, action=TARGET_WEIGHT)
--   接管, 落信号供 V3 展示 + 用户拍板 (出口 A). paper 自动执行属计划出口 B (后期).
-- 幂等: 按 name+type 精确匹配, 仅置 inactive (保留行以备审计, 与批5 下线迁移一致风格).

UPDATE scheduled_tasks
SET is_active = false, updated_at = NOW()
WHERE name = '推荐信号模拟盘跟单'
  AND type = 'PAPER_TRADING_AUTO_SYNC'
  AND is_active = true;
