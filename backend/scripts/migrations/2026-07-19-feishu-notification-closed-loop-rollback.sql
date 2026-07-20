-- 仅回滚新结构；历史 webhook_fallback_logs 含 secret，不自动重建。
DROP TABLE IF EXISTS notification_incident_states;
DROP TABLE IF EXISTS feishu_notification_outbox;

-- 兼容回滚到旧版 MorningRiskCheckup 模型；历史交付结果不可从旧伪状态恢复。
ALTER TABLE IF EXISTS morning_risk_checkups
  ADD COLUMN IF NOT EXISTS dispatch_status VARCHAR(20) NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_morning_risk_checkups_dispatch_status
  ON morning_risk_checkups (dispatch_status);
