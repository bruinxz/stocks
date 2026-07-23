BEGIN;

-- 因子流水依赖的两张原始事实表。这里只补结构，不执行任何外部抓取，
-- 也不通过 sequelize.sync() 改动其它业务表。
CREATE TABLE IF NOT EXISTS financial_reports (
  report_date DATE NOT NULL,
  stock_code VARCHAR(20) NOT NULL,
  stock_name VARCHAR(100),
  report_type VARCHAR(20),
  net_profit NUMERIC(22, 4),
  net_profit_yoy NUMERIC(14, 4),
  revenue NUMERIC(22, 4),
  revenue_yoy NUMERIC(14, 4),
  roe NUMERIC(12, 4),
  debt_ratio NUMERIC(12, 4),
  source VARCHAR(50) NOT NULL DEFAULT 'akshare',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_reports_pkey PRIMARY KEY (report_date, stock_code)
);

CREATE INDEX IF NOT EXISTS ix_financial_reports_stock_code
  ON financial_reports (stock_code);
CREATE INDEX IF NOT EXISTS ix_financial_reports_report_date
  ON financial_reports (report_date);
CREATE INDEX IF NOT EXISTS ix_financial_reports_report_type
  ON financial_reports (report_type);
CREATE INDEX IF NOT EXISTS ix_financial_reports_stock_date
  ON financial_reports (stock_code, report_date);
CREATE INDEX IF NOT EXISTS ix_financial_reports_stock_type
  ON financial_reports (stock_code, report_type);

CREATE TABLE IF NOT EXISTS analyst_forecasts (
  report_date DATE NOT NULL,
  stock_code VARCHAR(20) NOT NULL,
  analyst_firm VARCHAR(120) NOT NULL,
  stock_name VARCHAR(100),
  target_price NUMERIC(14, 4),
  rating VARCHAR(30),
  forecast_eps_y1 NUMERIC(14, 4),
  forecast_eps_y2 NUMERIC(14, 4),
  forecast_eps_y3 NUMERIC(14, 4),
  forecast_year_y1 SMALLINT,
  forecast_year_y2 SMALLINT,
  forecast_year_y3 SMALLINT,
  analyst_count INTEGER,
  report_title VARCHAR(500),
  industry VARCHAR(120),
  report_pdf_url VARCHAR(500),
  source VARCHAR(50) NOT NULL DEFAULT 'akshare',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT analyst_forecasts_pkey PRIMARY KEY (report_date, stock_code, analyst_firm)
);

CREATE INDEX IF NOT EXISTS ix_analyst_forecasts_report_date
  ON analyst_forecasts (report_date);
CREATE INDEX IF NOT EXISTS ix_analyst_forecasts_stock_code
  ON analyst_forecasts (stock_code);
CREATE INDEX IF NOT EXISTS ix_analyst_forecasts_stock_date
  ON analyst_forecasts (stock_code, report_date);
CREATE INDEX IF NOT EXISTS ix_analyst_forecasts_date_stock
  ON analyst_forecasts (report_date, stock_code);
CREATE INDEX IF NOT EXISTS ix_analyst_forecasts_rating
  ON analyst_forecasts (rating);
CREATE INDEX IF NOT EXISTS ix_analyst_forecasts_forecast_year_y1
  ON analyst_forecasts (forecast_year_y1);

CREATE TABLE IF NOT EXISTS announcement_summaries (
  id SERIAL PRIMARY KEY,
  announce_date DATE NOT NULL,
  stock_code VARCHAR(10) NOT NULL,
  stock_name VARCHAR(50),
  original_title VARCHAR(500) NOT NULL,
  announcement_type VARCHAR(100),
  url VARCHAR(500),
  summary TEXT,
  sentiment VARCHAR(10),
  key_amounts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_type VARCHAR(40),
  priority VARCHAR(20) NOT NULL DEFAULT 'low',
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'completed',
  nlp_engine VARCHAR(50),
  error TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT announcement_summaries_date_code_title_uniq
    UNIQUE (announce_date, stock_code, original_title)
);

CREATE INDEX IF NOT EXISTS ix_announcement_summaries_stock_date
  ON announcement_summaries (stock_code, announce_date);
CREATE INDEX IF NOT EXISTS ix_announcement_summaries_date
  ON announcement_summaries (announce_date);
CREATE INDEX IF NOT EXISTS ix_announcement_summaries_sentiment
  ON announcement_summaries (sentiment);
CREATE INDEX IF NOT EXISTS ix_announcement_summaries_type
  ON announcement_summaries (announcement_type);
CREATE INDEX IF NOT EXISTS idx_announcement_summaries_priority_date
  ON announcement_summaries (priority, announce_date);
CREATE INDEX IF NOT EXISTS idx_announcement_summaries_event_type_date
  ON announcement_summaries (event_type, announce_date);

COMMENT ON TABLE financial_reports IS 'migration:2026-07-24-factor-source-schema';
COMMENT ON TABLE analyst_forecasts IS 'migration:2026-07-24-factor-source-schema';
COMMENT ON TABLE announcement_summaries IS 'migration:2026-07-24-factor-source-schema';

COMMIT;
