-- 回滚: 无法真正回滚 (原 seed 无 dispatch 实现, 重建只会继续抛 Unsupported task type).
-- 如确需恢复该行仅供审计, 手动 INSERT; 但强烈不建议 —— 该能力计划已判删除.
-- (此文件为占位, 保持 migration 双文件规范.)
SELECT 'OVERNIGHT_SIGNAL_SYNC zombie deletion has no meaningful rollback' AS note;
