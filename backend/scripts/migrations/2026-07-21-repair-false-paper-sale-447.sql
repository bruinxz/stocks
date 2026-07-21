-- 2026-07-21 production data correction: reverse the false pre-open paper sale
-- of portfolio 65 / sh.600483 / trade 447.
--
-- Root cause: the retired 09:15 intraday risk task evaluated a stale daily bar
-- before the current trading session had a quote. This script is intentionally
-- fingerprinted to the one known bad transaction. Any mismatch aborts the
-- transaction instead of applying a best-effort repair.

BEGIN;

CREATE TABLE IF NOT EXISTS paper_trading_data_corrections (
  id BIGSERIAL PRIMARY KEY,
  correction_key VARCHAR(120) NOT NULL UNIQUE,
  correction_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(120) NOT NULL,
  reason TEXT NOT NULL,
  before_state JSONB NOT NULL,
  after_state JSONB,
  applied_by VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  v_correction_key CONSTANT TEXT := 'paper_sale_447_stale_preopen_quote';
  v_reason CONSTANT TEXT :=
    '09:15 legacy intraday risk task used the prior daily close before a current-session quote existed';
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Shanghai')::date;
  v_quote_price NUMERIC(12, 4);
  v_quote_time TIMESTAMPTZ;
  v_quote_source TEXT;
  v_position_market_value NUMERIC(14, 2);
  v_unrealized_pnl NUMERIC(14, 2);
  v_highest_close NUMERIC(12, 4);
  v_trailing_pct NUMERIC(8, 6);
  v_trailing_stop_price NUMERIC(12, 3);
  v_new_cash NUMERIC(14, 2);
  v_new_position_value NUMERIC(14, 2);
  v_new_total_value NUMERIC(14, 2);
  v_position_id INTEGER;
  v_correction_id BIGINT;
  v_before JSONB;
  v_after JSONB;
  v_paper JSONB;
  v_by_portfolio JSONB;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM paper_trading_data_corrections
    WHERE correction_key = v_correction_key
  ) THEN
    RAISE NOTICE 'Correction % already applied; skipping', v_correction_key;
    RETURN;
  END IF;

  PERFORM 1 FROM paper_trading_portfolios WHERE id = 65 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fingerprint mismatch: portfolio 65 is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM paper_trading_positions
    WHERE portfolio_id = 65 AND symbol = 'sh.600483'
  ) THEN
    RAISE EXCEPTION 'Fingerprint mismatch: sh.600483 position already exists in portfolio 65';
  END IF;

  PERFORM 1
  FROM paper_trading_trades
  WHERE id = 437
    AND portfolio_id = 65
    AND symbol = 'sh.600483'
    AND direction::text = 'BUY'
    AND execute_price = 10.42
    AND quantity = 1100
    AND amount = 11462.00
    AND commission = 5.11
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fingerprint mismatch: entry trade 437 changed or is missing';
  END IF;

  PERFORM 1
  FROM paper_trading_trades
  WHERE id = 447
    AND portfolio_id = 65
    AND symbol = 'sh.600483'
    AND direction::text = 'SELL'
    AND execute_price = 10.69
    AND quantity = 1100
    AND amount = 11757.90
    AND commission = 16.88
    AND realized_pnl = 273.91
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fingerprint mismatch: false exit trade 447 changed or is missing';
  END IF;

  PERFORM 1
  FROM ai_investment_signals
  WHERE id = 959
    AND metadata->'paper_trading'->>'status' = 'closed'
    AND metadata->'paper_trading'->>'sell_trade_id' = '447'
    AND metadata->'paper_trading_by_portfolio'->'65'->>'sell_trade_id' = '447'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fingerprint mismatch: signal 959 no longer points to false exit 447';
  END IF;

  PERFORM 1
  FROM paper_trading_order_intents
  WHERE id = 70977 AND trade_id = 447 AND status = 'executed'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fingerprint mismatch: order intent 70977 changed or is missing';
  END IF;

  PERFORM 1
  FROM recommendation_trade_outcomes
  WHERE id = 221 AND portfolio_id = 65 AND signal_id = 959
    AND trade_status = 'closed' AND exit_trade_id = 447
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fingerprint mismatch: recommendation outcome 221 changed or is missing';
  END IF;

  SELECT current_price, quote_time, source
  INTO v_quote_price, v_quote_time, v_quote_source
  FROM realtime_quotes
  WHERE symbol = 'sh.600483'
    AND trade_date = v_today
    AND current_price > 0
  ORDER BY quote_time DESC
  LIMIT 1;
  IF v_quote_price IS NULL THEN
    RAISE EXCEPTION 'No same-day realtime quote is available for sh.600483 on %', v_today;
  END IF;

  SELECT COALESCE(MAX(b.close), 10.42)
  INTO v_highest_close
  FROM daily_bars b
  JOIN stocks s ON s.id = b.stock_id
  WHERE s.symbol = 'sh.600483'
    AND b.time::date BETWEEN DATE '2026-07-07' AND v_today;

  SELECT COALESCE(
    CASE
      WHEN (u.risk_config->'trailing_stop'->>'pct')::numeric BETWEEN 0 AND 1
        THEN (u.risk_config->'trailing_stop'->>'pct')::numeric
      ELSE NULL
    END,
    0.10
  )
  INTO v_trailing_pct
  FROM users u
  WHERE u.id = 4;

  v_position_market_value := ROUND(v_quote_price * 1100, 2);
  v_unrealized_pnl := ROUND((v_quote_price - 10.42) * 1100, 2);
  v_trailing_stop_price := ROUND(v_highest_close * (1 - v_trailing_pct), 3);

  SELECT jsonb_build_object(
    'portfolio', (SELECT to_jsonb(p) FROM paper_trading_portfolios p WHERE id = 65),
    'position', (SELECT to_jsonb(p) FROM paper_trading_positions p
      WHERE portfolio_id = 65 AND symbol = 'sh.600483'),
    'entry_trade', (SELECT to_jsonb(t) FROM paper_trading_trades t WHERE id = 437),
    'false_exit_trade', (SELECT to_jsonb(t) FROM paper_trading_trades t WHERE id = 447),
    'signal', (SELECT to_jsonb(s) FROM ai_investment_signals s WHERE id = 959),
    'order_intent', (SELECT to_jsonb(i) FROM paper_trading_order_intents i WHERE id = 70977),
    'outcome', (SELECT to_jsonb(o) FROM recommendation_trade_outcomes o WHERE id = 221),
    'outbox', (SELECT to_jsonb(o) FROM feishu_notification_outbox o WHERE id = 6),
    'snapshot', (SELECT to_jsonb(s) FROM paper_trading_snapshots s
      WHERE portfolio_id = 65 AND date = v_today),
    'restoration_quote', jsonb_build_object(
      'price', v_quote_price,
      'quote_time', v_quote_time,
      'source', v_quote_source,
      'trade_date', v_today
    )
  ) INTO v_before;

  INSERT INTO paper_trading_data_corrections (
    correction_key,
    correction_type,
    entity_type,
    entity_id,
    reason,
    before_state,
    applied_by
  ) VALUES (
    v_correction_key,
    'reverse_false_paper_sale',
    'paper_trading_trade',
    '447',
    v_reason,
    v_before,
    'codex_production_repair_2026_07_21'
  ) RETURNING id INTO v_correction_id;

  INSERT INTO paper_trading_positions (
    portfolio_id,
    symbol,
    name,
    quantity,
    avg_cost,
    current_price,
    market_value,
    unrealized_pnl,
    stop_loss_price,
    take_profit_price,
    highest_price,
    trailing_stop_pct,
    trailing_stop_price,
    created_at,
    updated_at
  )
  SELECT
    65,
    'sh.600483',
    '福能股份',
    1100,
    10.42,
    v_quote_price,
    v_position_market_value,
    v_unrealized_pnl,
    9.8990,
    11.4620,
    v_highest_close,
    NULL,
    v_trailing_stop_price,
    t.created_at,
    v_now
  FROM paper_trading_trades t
  WHERE t.id = 437
  RETURNING id INTO v_position_id;

  UPDATE paper_trading_portfolios
  SET current_cash = ROUND(current_cash - 11741.02, 2),
      updated_at = v_now
  WHERE id = 65
  RETURNING current_cash INTO v_new_cash;
  IF v_new_cash < 0 THEN
    RAISE EXCEPTION 'Repair would make portfolio 65 cash negative: %', v_new_cash;
  END IF;

  SELECT ROUND(COALESCE(SUM(market_value), 0), 2)
  INTO v_new_position_value
  FROM paper_trading_positions
  WHERE portfolio_id = 65;
  v_new_total_value := ROUND(v_new_cash + v_new_position_value, 2);

  UPDATE paper_trading_portfolios
  SET total_value = v_new_total_value,
      updated_at = v_now
  WHERE id = 65;

  INSERT INTO paper_trading_snapshots (
    portfolio_id, date, total_value, current_cash, position_value, created_at, updated_at
  ) VALUES (
    65, v_today, v_new_total_value, v_new_cash, v_new_position_value, v_now, v_now
  )
  ON CONFLICT (portfolio_id, date) DO UPDATE
  SET total_value = EXCLUDED.total_value,
      current_cash = EXCLUDED.current_cash,
      position_value = EXCLUDED.position_value,
      updated_at = EXCLUDED.updated_at;

  SELECT metadata->'paper_trading', metadata->'paper_trading_by_portfolio'
  INTO v_paper, v_by_portfolio
  FROM ai_investment_signals
  WHERE id = 959;

  v_paper := (v_paper - ARRAY[
    'adaptive_risk_policy', 'close_source', 'closed_at', 'drawdown_from_peak_pct',
    'exit_amount', 'exit_commission', 'exit_market_environment', 'exit_price',
    'exit_quantity', 'exit_reason', 'exit_reason_label', 'holding_days',
    'max_profit_pct', 'peak_price', 'realized_pnl', 'realized_pnl_pct',
    'sell_trade_id', 'trailing_activation_pct', 'trailing_drawdown_pct',
    'trailing_stop_price'
  ]) || jsonb_build_object('status', 'executed');
  v_paper := jsonb_set(
    v_paper,
    '{execution_reality_decision}',
    COALESCE(
      (SELECT metadata->'execution_reality_decision' FROM ai_investment_signals WHERE id = 959),
      'null'::jsonb
    ),
    true
  );
  v_by_portfolio := jsonb_set(v_by_portfolio, '{65}', v_paper, true);

  UPDATE ai_investment_signals
  SET metadata = jsonb_set(
      jsonb_set(metadata, '{paper_trading}', v_paper, true),
      '{paper_trading_by_portfolio}', v_by_portfolio, true
    ),
    updated_at = v_now
  WHERE id = 959;

  UPDATE paper_trading_order_intents
  SET status = 'reversed',
      trade_id = NULL,
      reason_category = 'data_correction',
      reason_text = '已撤销：09:15 旧风控任务误用前一交易日行情',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'correction_id', v_correction_id,
        'correction_key', v_correction_key,
        'original_trade_id', 447,
        'reversed_at', v_now
      ),
      updated_at = v_now
  WHERE id = 70977;

  DELETE FROM paper_trading_trades WHERE id = 447;

  UPDATE recommendation_trade_outcomes
  SET trade_status = 'open',
      exit_trade_id = NULL,
      exit_date = NULL,
      exit_price = NULL,
      latest_price = v_quote_price,
      exit_amount = NULL,
      total_commission = 5.11,
      realized_pnl = 0,
      realized_pnl_pct = 0,
      unrealized_pnl = v_unrealized_pnl,
      unrealized_pnl_pct = ROUND(((v_quote_price - 10.42) / 10.42) * 100, 4),
      total_pnl = v_unrealized_pnl,
      total_pnl_pct = ROUND(((v_quote_price - 10.42) / 10.42) * 100, 4),
      holding_days = FLOOR(EXTRACT(EPOCH FROM (v_now - (SELECT created_at FROM paper_trading_trades WHERE id = 437))) / 86400),
      exit_reason = NULL,
      exit_reason_label = NULL,
      root_cause = NULL,
      root_cause_label = NULL,
      root_cause_confidence = NULL,
      metadata = (
        (COALESCE(metadata, '{}'::jsonb) - ARRAY['root_cause_diagnostics', 'postmortem'])
        || jsonb_build_object(
          'signal_metadata', (SELECT metadata FROM ai_investment_signals WHERE id = 959),
          'paper_trading', (SELECT metadata->'paper_trading' FROM ai_investment_signals WHERE id = 959),
          'latest_position_id', v_position_id,
          'correction', jsonb_build_object(
            'correction_id', v_correction_id,
            'correction_key', v_correction_key,
            'reopened_at', v_now
          )
        )
      ),
      updated_at = v_now
  WHERE id = 221;

  UPDATE feishu_notification_outbox
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'corrected', true,
      'correction_id', v_correction_id,
      'correction_key', v_correction_key,
      'corrected_at', v_now
    ),
    updated_at = v_now
  WHERE id = 6;

  INSERT INTO feishu_notification_outbox (
    idempotency_key,
    topic_key,
    audience,
    recipient_user_id,
    kind,
    severity,
    title,
    payload,
    status,
    attempts,
    max_attempts,
    next_attempt_at,
    correlation_id,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    'paper-trade:447:correction',
    'paper-trade:65',
    'business',
    NULL,
    'paper_trade_correction',
    'HIGH',
    '🟠 更正 · 福能股份误卖已撤销',
    jsonb_build_object(
      'msg_type', 'interactive',
      'card', jsonb_build_object(
        'config', jsonb_build_object('wide_screen_mode', true),
        'header', jsonb_build_object(
          'template', 'orange',
          'title', jsonb_build_object('tag', 'plain_text', 'content', '🟠 更正 · 福能股份误卖已撤销')
        ),
        'elements', jsonb_build_array(
          jsonb_build_object(
            'tag', 'div',
            'text', jsonb_build_object(
              'tag', 'lark_md',
              'content', '**更正说明**：07-21 09:15 的自主卖出通知无效。旧盘中风控任务在开盘前误用了前一交易日行情。'
            )
          ),
          jsonb_build_object(
            'tag', 'div',
            'fields', jsonb_build_array(
              jsonb_build_object('is_short', true, 'text', jsonb_build_object('tag', 'lark_md', 'content', '**代码**\nsh.600483')),
              jsonb_build_object('is_short', true, 'text', jsonb_build_object('tag', 'lark_md', 'content', '**恢复数量**\n1100 股')),
              jsonb_build_object('is_short', true, 'text', jsonb_build_object('tag', 'lark_md', 'content', '**持仓成本**\n¥10.42')),
              jsonb_build_object('is_short', true, 'text', jsonb_build_object('tag', 'lark_md', 'content', '**原卖出交易**\n已撤销，不计入收益'))
            )
          ),
          jsonb_build_object('tag', 'hr'),
          jsonb_build_object(
            'tag', 'note',
            'elements', jsonb_build_array(
              jsonb_build_object('tag', 'plain_text', 'content', '持仓、现金、收益闭环与当日资产快照均已恢复')
            )
          )
        )
      )
    ),
    'pending',
    0,
    6,
    v_now,
    'paper_trade_id=447;correction=' || v_correction_id,
    jsonb_build_object(
      'portfolio_id', 65,
      'symbol', 'sh.600483',
      'direction', 'SELL',
      'correction_id', v_correction_id,
      'correction_key', v_correction_key
    ),
    v_now,
    v_now
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT jsonb_build_object(
    'portfolio', (SELECT to_jsonb(p) FROM paper_trading_portfolios p WHERE id = 65),
    'position', (SELECT to_jsonb(p) FROM paper_trading_positions p WHERE id = v_position_id),
    'false_exit_trade', (SELECT to_jsonb(t) FROM paper_trading_trades t WHERE id = 447),
    'signal', (SELECT to_jsonb(s) FROM ai_investment_signals s WHERE id = 959),
    'order_intent', (SELECT to_jsonb(i) FROM paper_trading_order_intents i WHERE id = 70977),
    'outcome', (SELECT to_jsonb(o) FROM recommendation_trade_outcomes o WHERE id = 221),
    'original_outbox', (SELECT to_jsonb(o) FROM feishu_notification_outbox o WHERE id = 6),
    'correction_outbox', (SELECT to_jsonb(o) FROM feishu_notification_outbox o
      WHERE idempotency_key = 'paper-trade:447:correction'),
    'snapshot', (SELECT to_jsonb(s) FROM paper_trading_snapshots s
      WHERE portfolio_id = 65 AND date = v_today)
  ) INTO v_after;

  UPDATE paper_trading_data_corrections
  SET after_state = v_after,
      updated_at = v_now
  WHERE id = v_correction_id;
END
$$;

COMMIT;
