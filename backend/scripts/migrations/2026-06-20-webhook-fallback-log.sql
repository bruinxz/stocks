-- US-095 OPS-006 2026-06-20 — 创建 webhook_fallback_log (飞书 webhook fail-open 兜底表) (up).
--
-- 一行 = 飞书 webhook POST 一次失败 (504/超时/SSRF guard 拒绝/任何 Error) 的兜底
-- snapshot. 主流程已 fail-OPEN (FeishuBotWebhookService 各 send 方法返
-- {success:false,message} 不抛), 本表是"为了不丢消息"的第二道防线:
--   - PRD AC: feishuNotifier 失败时不阻塞主流程；写 fallback_log 表 + 5min retry
--   - WEBHOOK_FALLBACK_RETRY cron 每 5min 扫 status='pending' 行重投递, 成功标
--     status='sent', 失败 attempts +=1, attempts >= MAX_ATTEMPTS → status='dead'.
--
-- 主入口模块: backend/src/services/webhookFailOpen.ts
--   - wrapFeishuWebhookFailOpen(args, sender) — 失败时 INSERT 一行 status='pending'
--   - retryPendingFallbacks(opts) — cron 调; 扫 pending 行 + 透传 sender 重试
--
-- 字段语义:
--   - channel        — feishu | feishu_ops (与 RiskAlertService channel 同源)
--   - scenario       — sendRecommendationSummary / sendDailyDigestCard /
--                       sendRiskAlertCard / sendCriticalAnnouncement / etc
--                       (caller 自报, 便于按场景 dashboard 分组)
--   - webhook_url    — POST 目标 (脱敏: 已存全 URL, 让 retry 不依赖 env 重读;
--                       OPS 处理 leakage 时按 row 删. 与 RiskAlertService
--                       feishu_webhook_url 同样 in-DB 透明存储约定)
--   - payload        — JSONB; 原始 send 参数 + sender 名 + caller hint
--   - last_error     — 最近一次失败原因 (HTTP 504 / timeout / SSRF guard rejected)
--   - last_status_code — HTTP code (用于 ops 区分 4xx 客户端错 vs 5xx 服务端临时)
--   - attempts       — 已重试次数 (含首次失败本身; 1 = 仅原始失败 + 0 retry)
--   - max_attempts   — 上限 (默认 5; cron 调时透传 caller 覆盖)
--   - status         — pending | sent | dead (sent/dead 不再 retry)
--   - next_retry_at  — 下次重试时间; 指数 backoff (5min / 10min / 20min / 40min / 80min)
--   - last_attempt_at — 最近一次 retry 时间戳 (cron 写)
--   - sent_at        — 成功投递时间戳 (cron 写; 与 status='sent' 配对)
--   - dead_at        — 进入 dead 时间戳 (cron 写; 与 status='dead' 配对)
--   - metadata       — caller_module / cron_run_id / etc
--
-- 索引:
--   - (status, next_retry_at) — cron 扫 pending 列 + 时间过滤 (最频繁查询)
--   - (channel) — ops 看板按通道分组
--   - (created_at) — 时间序列 sweep
--
-- 默认值 (fail-safe):
--   status 默认 'pending' (cron 扫得到); attempts 默认 1 (首次失败已计)
--   max_attempts 默认 5 (与 webhookFailOpen.ts DEFAULT_MAX_ATTEMPTS 同步)
--   next_retry_at 默认 NOW() + 5min (与 webhookFailOpen.ts DEFAULT_FIRST_BACKOFF_MS 同步)
--   payload / metadata 默认 '{}'::jsonb
--
-- 回滚: 2026-06-20-webhook-fallback-log-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-webhook-fallback-log.sql

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_fallback_log (
  id                  SERIAL PRIMARY KEY,
  channel             VARCHAR(40) NOT NULL,
  scenario            VARCHAR(80) NOT NULL,
  webhook_url         TEXT NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error          TEXT NOT NULL DEFAULT '',
  last_status_code    INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 1,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  next_retry_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  last_attempt_at     TIMESTAMP WITH TIME ZONE,
  sent_at             TIMESTAMP WITH TIME ZONE,
  dead_at             TIMESTAMP WITH TIME ZONE,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_fallback_log_status_next_retry
  ON webhook_fallback_log (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_webhook_fallback_log_channel
  ON webhook_fallback_log (channel);

CREATE INDEX IF NOT EXISTS idx_webhook_fallback_log_created_at
  ON webhook_fallback_log (created_at);

COMMENT ON TABLE webhook_fallback_log IS
  'US-095 OPS-006 飞书 webhook fail-open 兜底; 单失败 = 一行; WEBHOOK_FALLBACK_RETRY cron 5min 扫 pending 重投递.';
COMMENT ON COLUMN webhook_fallback_log.channel IS '通道: feishu / feishu_ops (与 RiskAlertService channel 同源)';
COMMENT ON COLUMN webhook_fallback_log.scenario IS 'caller 自报场景 (sendRecommendationSummary / sendDailyDigestCard / 等)';
COMMENT ON COLUMN webhook_fallback_log.webhook_url IS 'POST 目标 URL (in-DB; retry 不依赖 env 重读)';
COMMENT ON COLUMN webhook_fallback_log.payload IS '原始 send 参数 + sender 名 + caller hint';
COMMENT ON COLUMN webhook_fallback_log.last_error IS '最近一次失败原因 (HTTP 504 / timeout / SSRF guard rejected)';
COMMENT ON COLUMN webhook_fallback_log.last_status_code IS 'HTTP code (区分 4xx vs 5xx)';
COMMENT ON COLUMN webhook_fallback_log.attempts IS '已尝试次数 (含首次失败本身; 1 = 仅原始失败)';
COMMENT ON COLUMN webhook_fallback_log.max_attempts IS '上限 (默认 5; cron 透传 caller 覆盖)';
COMMENT ON COLUMN webhook_fallback_log.status IS '生命周期: pending / sent / dead';
COMMENT ON COLUMN webhook_fallback_log.next_retry_at IS '下次 retry 时间; 指数 backoff';
COMMENT ON COLUMN webhook_fallback_log.last_attempt_at IS '最近一次 retry 时间戳';
COMMENT ON COLUMN webhook_fallback_log.sent_at IS '成功投递时间戳 (与 status=sent 配对)';
COMMENT ON COLUMN webhook_fallback_log.dead_at IS '进入 dead 时间戳 (与 status=dead 配对)';
COMMENT ON COLUMN webhook_fallback_log.metadata IS '调用 metadata (caller_module / cron_run_id / etc)';

COMMIT;
