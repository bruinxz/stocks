-- Market news is an operational dependency of RSS_NEWS_SYNC and the bullish
-- event detector. Keep this migration idempotent so startup/deployment repair
-- can provision a fresh or partially migrated database without inventing data.

CREATE TABLE IF NOT EXISTS market_news (
  title_hash VARCHAR(64) NOT NULL,
  publish_time TIMESTAMP WITH TIME ZONE NOT NULL,
  publish_date DATE NOT NULL,
  title VARCHAR(512) NOT NULL,
  content TEXT,
  source VARCHAR(40) NOT NULL DEFAULT 'cls',
  category VARCHAR(50),
  url VARCHAR(1000),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (title_hash, publish_time)
);

CREATE INDEX IF NOT EXISTS market_news_publish_time
  ON market_news (publish_time);
CREATE INDEX IF NOT EXISTS market_news_source
  ON market_news (source);
CREATE INDEX IF NOT EXISTS market_news_publish_date
  ON market_news (publish_date);
CREATE INDEX IF NOT EXISTS market_news_publish_date_source
  ON market_news (publish_date, source);

COMMENT ON TABLE market_news IS
  '真实财经新闻事实表；RSS_NEWS_SYNC 写入，利好事件检测与研究页面只读消费。';
