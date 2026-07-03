-- 批10: 删除僵尸 cron 'OVERNIGHT_SIGNAL_SYNC'
--
-- 定性: 该 type 在 REFACTOR_PLAN.md:65 已被列入批2 删除清单 (日内/竞价类,
--   OvernightSignalSyncService), 模型也在 :182 列删. 但 2026-06-29 PR-M1 又把
--   seed 加回 ensureDefaultTasks (is_active=true, 每15min 触发), 却从未补
--   cronRegistry 注册项, 也无 _executeTaskLogic dispatch 分支 → 每次触发命中
--   SchedulerService line 5755 `throw Unsupported task type: OVERNIGHT_SIGNAL_SYNC`.
--   属"只 seed、能力未实现"的僵尸, 且计划已判该能力删除. 彻底移除.
-- 幂等: 按 type 精确匹配删除 (非置 inactive — 该 type 无任何合法实现, 无审计保留价值).

DELETE FROM scheduled_tasks WHERE type = 'OVERNIGHT_SIGNAL_SYNC';
