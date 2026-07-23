-- US-099 PR-010 2026-06-20 — 创建 black_swan_events (黑天鹅事件持久化) (up).
--
-- 一行 = 一次黑天鹅事件 (检测瞬间持久化, 用于 ops 仪表 / 复盘 / 触发链路审计).
--
-- 本 story (PR-010) 只新增 schema + migration. 真持久化 (write/read) 由后续:
--   - PR-011 BlackSwanDetector cron (US-100): 30min 巡 5 类信号 → bulkCreate 本表
--   - PR-012 BlackSwanPostmortemReport (US-101): FK 本表
--   - PR-013 BlackSwanPostmortemService (US-102)
--   - PR-014 CounterfactualBaselineCalculator (US-103)
--   - PR-015 EventTimelineReplayer (US-104)
--   - PR-016 ImprovementSuggestor (US-105)
--
-- 与既有 BlackSwanWatchdog (US-053) 边界:
--   - BlackSwanWatchdog = per-user-per-position RiskAlert 写入, 用户级告警, 无全局快照.
--   - 本表          = 事件本身的 global 视角, 一次事件一行, 便于复盘/统计/postmortem 报告 FK.
--
-- 字段语义 (与 backend/src/models/BlackSwanEvent.ts 对齐):
--   - detected_at TIMESTAMPTZ     — 事件检测瞬间 (PR-011 cron 写入时 NOW(); 与 created_at 区分)
--   - event_type VARCHAR(40)      — ST / SUSPENDED / NEWS_KEYWORD / SHAREHOLDER_REDUCTION /
--                                    MARKET_REGIME / OTHER (字符串而非 enum 避免 migration 灾难)
--   - severity VARCHAR(20)        — low / medium / high / critical (与 RiskAlert.level 对齐)
--   - scope VARCHAR(20)           — symbol / sector / market / portfolio
--   - symbol VARCHAR(20)          — scope=symbol 时必填 (e.g. '600519.SH')
--   - signature VARCHAR(255)      — BlackSwanWatchdog.signatureForEvent 输出
--                                    与 (event_type, 上海交易日) 组成业务唯一键
--   - title VARCHAR(200)          — 事件中文标题 (≤ 100 字 cap 由 detector 守)
--   - description TEXT            — 事件描述 (≤ 500 字 cap 由 detector 守)
--   - detail JSONB                — 事件 detail snapshot (per-event_type schema)
--   - scope_detail JSONB          — 影响面附加上下文 (sector/market/portfolio/symbol)
--   - source VARCHAR(20)          — detector_cron / watchdog / manual / external
--   - status VARCHAR(20)          — open / resolved / expired
--   - resolved_at / resolved_reason — lifecycle 标记
--   - metadata JSONB              — 调用 metadata (cron_run_id / linked_risk_alert_ids[] ...)
--
-- 索引:
--   - UNIQUE(event_type, signature, 上海交易日)
--                                 — 同 type 同 signature 同日只一行 (cron 30min 巡多次去重)
--                                   注意: 用固定 Asia/Shanghai 日界线的表达式索引
--                                         而非裸 detected_at
--                                         (后者为 TIMESTAMPTZ, 毫秒级永远不重复, UNIQUE 失效).
--   - (event_type) / (severity) / (scope) / (status) / (symbol) — 多维查询
--   - (detected_at)               — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 detector 的安全态):
--   severity 默认 'medium' (安全态; 减少飞书风暴)
--   scope 默认 'symbol'
--   status 默认 'open'
--   source 默认 'detector_cron'
--   signature/title/description 默认 '' (NOT NULL 让 trivially INSERT 通过)
--   detail/scope_detail/metadata 默认 '{}'::jsonb
--
-- 回滚: 2026-06-20-black-swan-events-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-black-swan-events.sql

BEGIN;

CREATE TABLE IF NOT EXISTS black_swan_events (
  id                  SERIAL PRIMARY KEY,
  detected_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  event_type          VARCHAR(40) NOT NULL,
  severity            VARCHAR(20) NOT NULL DEFAULT 'medium',
  scope               VARCHAR(20) NOT NULL DEFAULT 'symbol',
  symbol              VARCHAR(20),
  signature           VARCHAR(255) NOT NULL DEFAULT '',
  title               VARCHAR(200) NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  detail              JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope_detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source              VARCHAR(20) NOT NULL DEFAULT 'detector_cron',
  status              VARCHAR(20) NOT NULL DEFAULT 'open',
  resolved_at         TIMESTAMP WITH TIME ZONE,
  resolved_reason     VARCHAR(255),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 业务唯一键: (event_type, signature, 上海交易日) — 同 type 同 sig 同日只一行。
-- TIMESTAMPTZ 直接 ::date 依赖 session timezone，不满足 PostgreSQL 表达式索引的
-- IMMUTABLE 约束；先固定到 Asia/Shanghai 再取 date，既可建索引也符合 A 股日界线。
CREATE UNIQUE INDEX IF NOT EXISTS black_swan_events_type_sig_detected_uniq
  ON black_swan_events (
    event_type,
    signature,
    ((detected_at AT TIME ZONE 'Asia/Shanghai')::date)
  );

CREATE INDEX IF NOT EXISTS idx_black_swan_events_event_type
  ON black_swan_events (event_type);

CREATE INDEX IF NOT EXISTS idx_black_swan_events_severity
  ON black_swan_events (severity);

CREATE INDEX IF NOT EXISTS idx_black_swan_events_scope
  ON black_swan_events (scope);

CREATE INDEX IF NOT EXISTS idx_black_swan_events_status
  ON black_swan_events (status);

CREATE INDEX IF NOT EXISTS idx_black_swan_events_symbol
  ON black_swan_events (symbol);

CREATE INDEX IF NOT EXISTS idx_black_swan_events_detected_at
  ON black_swan_events (detected_at);

COMMENT ON TABLE black_swan_events IS
  'US-099 PR-010 黑天鹅事件 — 一次事件一行, global 视角 (与 per-user BlackSwanWatchdog/RiskAlert 互补); PR-011 detector cron / PR-012/013 postmortem 后续接入.';
COMMENT ON COLUMN black_swan_events.detected_at IS '事件检测瞬间 (PR-011 cron 写入时 NOW(); 与 created_at 区分: 后者是 ORM 落库时刻)';
COMMENT ON COLUMN black_swan_events.event_type IS '事件类型: ST / SUSPENDED / NEWS_KEYWORD / SHAREHOLDER_REDUCTION / MARKET_REGIME / OTHER';
COMMENT ON COLUMN black_swan_events.severity IS '严重度: low / medium / high / critical (与 RiskAlert.level 对齐)';
COMMENT ON COLUMN black_swan_events.scope IS '影响面: symbol / sector / market / portfolio';
COMMENT ON COLUMN black_swan_events.symbol IS 'scope=symbol 时必填 (e.g. "600519.SH"); 其它 scope 为 NULL';
COMMENT ON COLUMN black_swan_events.signature IS 'BlackSwanWatchdog.signatureForEvent 输出; 与 (event_type, Asia/Shanghai 交易日) 组成业务唯一键';
COMMENT ON COLUMN black_swan_events.title IS '事件中文标题 (≤ 100 字 cap 由 detector 守)';
COMMENT ON COLUMN black_swan_events.description IS '事件描述详情 (≤ 500 字 cap 由 detector 守)';
COMMENT ON COLUMN black_swan_events.detail IS '事件 detail snapshot (与 BlackSwanWatchdog.BlackSwanTrigger.detail 对齐, per-event_type schema)';
COMMENT ON COLUMN black_swan_events.scope_detail IS '影响面附加上下文 (sector/market/portfolio/symbol per-scope schema)';
COMMENT ON COLUMN black_swan_events.source IS '检测来源: detector_cron / watchdog / manual / external';
COMMENT ON COLUMN black_swan_events.status IS '生命周期: open / resolved / expired';
COMMENT ON COLUMN black_swan_events.resolved_at IS 'status=resolved 时填; 默认 NULL';
COMMENT ON COLUMN black_swan_events.resolved_reason IS 'resolved/expired 时的简短原因 (e.g. "st_removed" / "manual_review_no_impact")';
COMMENT ON COLUMN black_swan_events.metadata IS '调用 metadata (cron_run_id / detector_version / raw_payload_hash / linked_risk_alert_ids[] ...)';

COMMIT;
