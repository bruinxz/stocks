#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stocks/current}"
USERNAME="${USERNAME:-stock}"
TRADE_DATE="${TRADE_DATE:-}"
BACKUP_PATH="${BACKUP_PATH:-/tmp/paper_trading_reset_$(date +%Y%m%d%H%M%S).sql}"

cd "$APP_DIR/backend"

if [[ "${SKIP_PAPER_BACKUP:-false}" != "true" ]]; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^stocks-postgres$'; then
    docker exec stocks-postgres pg_dump -U postgres -d stock_backtest \
      -t paper_trading_portfolios \
      -t paper_trading_positions \
      -t paper_trading_trades \
      -t paper_trading_snapshots \
      -t paper_trading_order_intents \
      -t paper_trading_order_intent_outcomes \
      -t paper_trading_canary_review_snapshots \
      -t recommendation_trade_outcomes \
      -t ai_investment_signals \
      > "$BACKUP_PATH"
    echo "paper trading backup: $BACKUP_PATH"
  else
    echo "WARN: docker/stocks-postgres not found, skip paper trading backup" >&2
  fi
fi

args=(dist/scripts/reset-paper-trading-and-run-quant.js --username "$USERNAME")
if [[ -n "$TRADE_DATE" ]]; then
  args+=(--trade-date "$TRADE_DATE")
fi

node "${args[@]}"
