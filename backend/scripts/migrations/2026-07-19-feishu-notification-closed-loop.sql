-- 2026-07-19: 飞书通知持久化 outbox + cron 事故生命周期。
-- 幂等，可在生产发布前重复执行。

CREATE TABLE IF NOT EXISTS feishu_notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL,
  topic_key VARCHAR(255) NOT NULL,
  audience VARCHAR(32) NOT NULL,
  recipient_user_id INTEGER,
  kind VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'INFO',
  title VARCHAR(500) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  dead_at TIMESTAMPTZ,
  last_error TEXT,
  last_status_code INTEGER,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_feishu_outbox_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_feishu_outbox_audience
    CHECK (audience IN ('ops', 'business', 'live', 'user')),
  CONSTRAINT ck_feishu_outbox_status
    CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'dead', 'suppressed')),
  CONSTRAINT ck_feishu_outbox_attempts
    CHECK (attempts >= 0 AND max_attempts > 0)
);

CREATE INDEX IF NOT EXISTS idx_feishu_outbox_due
  ON feishu_notification_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_feishu_outbox_topic_created
  ON feishu_notification_outbox (topic_key, created_at);
CREATE INDEX IF NOT EXISTS idx_feishu_outbox_correlation
  ON feishu_notification_outbox (correlation_id);

CREATE TABLE IF NOT EXISTS notification_incident_states (
  id BIGSERIAL PRIMARY KEY,
  source_key VARCHAR(255) NOT NULL,
  source_type VARCHAR(64) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'resolved',
  generation INTEGER NOT NULL DEFAULT 0,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  severity VARCHAR(16) NOT NULL DEFAULT 'WARN',
  summary VARCHAR(500) NOT NULL DEFAULT '',
  last_error TEXT,
  opened_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  opened_notification_generation INTEGER NOT NULL DEFAULT 0,
  recovered_notification_generation INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_notification_incident_source UNIQUE (source_key),
  CONSTRAINT ck_notification_incident_status CHECK (status IN ('open', 'resolved')),
  CONSTRAINT ck_notification_incident_counts
    CHECK (generation >= 0 AND occurrence_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_notification_incident_status
  ON notification_incident_states (status, last_seen_at);

-- RiskAlertService 用持久化 owner 标记阻止 model hook 再生产一条重复飞书通知。
ALTER TABLE IF EXISTS risk_alerts
  ADD COLUMN IF NOT EXISTS rule_id VARCHAR(64);
ALTER TABLE IF EXISTS risk_alerts
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 体检业务表不再复制一份永远 pending 的伪交付状态；outbox 是唯一事实源。
ALTER TABLE IF EXISTS morning_risk_checkups
  DROP COLUMN IF EXISTS dispatch_status;

-- 清掉实现已删除或被统一 outbox 替代的历史 active cron。
UPDATE scheduled_tasks
SET is_active = FALSE,
    last_run_status = CASE
      WHEN last_run_status = 'RUNNING' THEN 'SKIPPED'
      ELSE last_run_status
    END,
    updated_at = NOW()
WHERE is_active = TRUE
  AND type IN (
    'SNOWBALL_HOT_KEYWORD_SYNC',
    'WEEKLY_QA_STAT_AGGREGATE',
    'BLACK_SWAN_DETECT',
    'WEBHOOK_FALLBACK_RETRY',
    'PAPER_TRADING_RESTRICTED_SHARE_CHECK',
    'AI_DAILY_SCREENER',
    'AUTO_RECOMMENDATION_LOOP',
    'EARNINGS_FORECAST_WATCH',
    'MARKET_SENTIMENT_INDEX_SYNC',
    'STRATEGY_KILL_SWITCH_CHECK',
    'OVERNIGHT_SIGNAL_SYNC'
  );

-- 删除已失效的通用 report_to_feishu 开关；仅两个仍有业务摘要能力的任务迁移为
-- 语义明确的 notify_business_summary。
UPDATE scheduled_tasks
SET parameters =
  (COALESCE(parameters, '{}'::jsonb) - 'report_to_feishu' - 'reportToFeishu'
    - 'notify_to_feishu_bot' - 'notifyToFeishuBot') ||
  CASE
    WHEN type = 'PAPER_TRADING_AUTO_SYNC' THEN jsonb_build_object(
      'notify_business_summary',
      lower(COALESCE(parameters->>'report_to_feishu', parameters->>'reportToFeishu', 'false'))
        IN ('true','1','yes','on')
      AND lower(COALESCE(parameters->>'notify_to_feishu_bot', parameters->>'notifyToFeishuBot', 'true'))
        NOT IN ('false','0','no','off')
    )
    WHEN type = 'PAPER_TRADING_RISK_CHECK' THEN jsonb_build_object(
      'notify_business_summary',
      lower(COALESCE(parameters->>'report_to_feishu', parameters->>'reportToFeishu', 'false'))
        IN ('true','1','yes','on')
      AND lower(COALESCE(parameters->>'notify_to_feishu_bot', parameters->>'notifyToFeishuBot', 'false'))
        IN ('true','1','yes','on')
    )
    ELSE '{}'::jsonb
  END,
  updated_at = NOW()
WHERE parameters ?| ARRAY[
  'report_to_feishu', 'reportToFeishu', 'notify_to_feishu_bot', 'notifyToFeishuBot'
];

-- 旧 fallback 表包含 webhook secret，不再保留。
DROP TABLE IF EXISTS webhook_fallback_logs;
