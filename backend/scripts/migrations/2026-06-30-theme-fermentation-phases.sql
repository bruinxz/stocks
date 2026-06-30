-- PR-O5 2026-06-30 — 创建 theme_fermentation_phases (题材发酵 5 阶段日度分类) (up).
--
-- 一行 = (trade_date, industry) 二元组, 来自 ThemeFermentationDetector 每日 16:30 (工作日)
-- 跑一次 — 消费 PR-M3 industry_sentiment_indices (16:00 写完) + 昨日同表数据, 给每个板块
-- 打 5 阶段 (germinate / launch / outbreak / climax / recession) 标签 + 检测主线切换.
--
-- 字段语义 (与 backend/src/models/ThemeFermentationPhase.ts 严格对齐):
--   - trade_date           交易日 (DATEONLY)
--   - industry             申万一级 (e.g. '半导体' '电力') ≤ 100 字符
--   - phase                'germinate' | 'launch' | 'outbreak' | 'climax' | 'recession'
--   - lim_up_count         当日涨停只数 (透传)
--   - consecutive_max      当日最高连板数 (透传)
--   - lim_up_failure_rate  炸板率 [0,1] (透传, 可 NULL)
--   - composite_heat       composite_score 透传 (大约 [-5, +5], 可 NULL)
--   - momentum_30d_z       30 日动量 z-score (透传, NULL = 数据不足)
--   - phase_changed_from   昨日相位 (NULL = 第一日或昨日无数据; 与今日相同也写以便审计)
--   - is_mainline          当日热点主线 = composite_score 当日 top-3 且 phase ∈ {launch, outbreak, climax}
--   - top_codes            涨停代表股 JSONB string[]
--   - raw_payload          调试 + mainline_switch_event 透传 JSONB
--
-- 索引:
--   - PRIMARY KEY (trade_date, industry)
--   - (trade_date, phase)               per-date 按阶段筛选 (查"今日 launch 板块"等)
--   - (industry, trade_date DESC)       per-industry 时序回查 (查"半导体最近 7 日相位演化")
--   - (trade_date, is_mainline)         per-date 取主线 (查"今日主线板块")
--
-- 回滚: 2026-06-30-theme-fermentation-phases-rollback.sql
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-30-theme-fermentation-phases.sql

BEGIN;

CREATE TABLE IF NOT EXISTS theme_fermentation_phases (
  trade_date           DATE NOT NULL,
  industry             VARCHAR(100) NOT NULL,
  phase                VARCHAR(20) NOT NULL,
  lim_up_count         INTEGER NOT NULL DEFAULT 0,
  consecutive_max      INTEGER NOT NULL DEFAULT 0,
  lim_up_failure_rate  NUMERIC(8, 4),
  composite_heat       NUMERIC(10, 4),
  momentum_30d_z       NUMERIC(10, 4),
  phase_changed_from   VARCHAR(20),
  is_mainline          BOOLEAN NOT NULL DEFAULT false,
  top_codes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_date, industry)
);

CREATE INDEX IF NOT EXISTS idx_tfp_date_phase
  ON theme_fermentation_phases (trade_date, phase);

CREATE INDEX IF NOT EXISTS idx_tfp_industry_date
  ON theme_fermentation_phases (industry, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_tfp_date_mainline
  ON theme_fermentation_phases (trade_date, is_mainline);

COMMENT ON TABLE theme_fermentation_phases IS
  'PR-O5 题材发酵 5 阶段日度分类 — 由 ThemeFermentationDetector 每日 16:30 (工作日) 跑出, 消费 PR-M3 industry_sentiment_indices + 昨日数据, 给推荐 service 消费做"启动/爆发推次龙头, 高潮 reduce, 退潮换主线"决策.';
COMMENT ON COLUMN theme_fermentation_phases.trade_date IS '交易日 (YYYY-MM-DD)';
COMMENT ON COLUMN theme_fermentation_phases.industry IS '申万一级行业名';
COMMENT ON COLUMN theme_fermentation_phases.phase IS '5 阶段: germinate / launch / outbreak / climax / recession';
COMMENT ON COLUMN theme_fermentation_phases.lim_up_count IS '当日涨停只数';
COMMENT ON COLUMN theme_fermentation_phases.consecutive_max IS '当日最高连板数';
COMMENT ON COLUMN theme_fermentation_phases.lim_up_failure_rate IS '炸板率 [0,1]';
COMMENT ON COLUMN theme_fermentation_phases.composite_heat IS 'composite_score 透传 (大约 [-5, +5])';
COMMENT ON COLUMN theme_fermentation_phases.momentum_30d_z IS '30 日动量 z-score (透传); NULL = 数据不足';
COMMENT ON COLUMN theme_fermentation_phases.phase_changed_from IS '昨日相位; NULL = 第一日 / 昨日无数据';
COMMENT ON COLUMN theme_fermentation_phases.is_mainline IS '是否当日热点主线 (composite top-3 + phase ∈ {launch, outbreak, climax})';
COMMENT ON COLUMN theme_fermentation_phases.top_codes IS '涨停代表股 JSONB string[]';
COMMENT ON COLUMN theme_fermentation_phases.raw_payload IS '调试 / 审计透传 JSONB';

COMMIT;
