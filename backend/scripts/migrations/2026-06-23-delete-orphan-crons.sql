-- Batch BC-9 (2026-06-23): 删除 3 个 PAPER_TRADING_* 孤儿 cron row
-- 真因: 这 3 row (id 15/16/17) 在 2026-06-11 同时被 disabled (与 BC-8 同批),
-- 之后 (Sprint 30 后期? batch AJ 时?) 改注册了新的同 type cron (id 35/36)
-- 用新的 cron expression (每 15min 而非每天 1 次). 但旧 row 没清理.
--
-- 表现: status=FAILED + 11 天没跑 + is_active=false → SchedulerService 启动时
-- 跑 cron registry 检查会报 "non-active row" 干扰诊断.
--
-- 修复: 直接 DELETE 3 个孤儿 row. 不影响生产 (新 cron id 35/36 跑得好好的).
--
-- 涉及:
--   id=15 PAPER_TRADING_AUTO_SYNC cron='40 15 * * 1-5' (旧每天1次)
--   id=16 PAPER_TRADING_AUTO_SYNC cron='42 15 * * 1-5' (旧每天1次, 同 type 重复)
--   id=17 PAPER_TRADING_RISK_CHECK cron='50 15 * * 1-5' (旧每天1次)
--
-- 新替代:
--   id=35 PAPER_TRADING_AUTO_SYNC cron='5,20,35,50 9,10,11,13,14 * * 1-5' (盘中每15min)
--   id=36 PAPER_TRADING_RISK_CHECK cron='15,45 9,10,11,13,14 * * 1-5' (盘中每30min)

DELETE FROM scheduled_tasks WHERE id IN (15, 16, 17);
