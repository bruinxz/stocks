#!/usr/bin/env bash
set -euo pipefail

# Rebuild the market-data -> factor -> quant-backtest -> signal closed loop after
# a server/data reset.  The script is intentionally resumable:
# - market data is selected by "oldest/latest missing first" in task 2;
# - factors/backtests are chunked by symbols that already have enough bars;
# - every step can be re-run safely.
#
# Expected to run on the production server where docker container
# `stocks-postgres` and the web API are available.

BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
USERNAME="${STOCKS_USERNAME:-stock}"
PASSWORD="${STOCKS_PASSWORD:-666}"
TASK_ID="${MARKET_HISTORY_TASK_ID:-2}"
MAX_MARKET_ROUNDS="${MAX_MARKET_ROUNDS:-80}"
TARGET_COVERAGE_PCT="${TARGET_COVERAGE_PCT:-92}"
TARGET_WITH_BARS="${TARGET_WITH_BARS:-5000}"
IDLE_SLEEP_SECONDS="${IDLE_SLEEP_SECONDS:-8}"
ROUND_SLEEP_SECONDS="${ROUND_SLEEP_SECONDS:-3}"
QUEUE_TIMEOUT_SECONDS="${QUEUE_TIMEOUT_SECONDS:-7200}"

RUN_FACTORS_AFTER="${RUN_FACTORS_AFTER:-1}"
RUN_BACKTESTS_AFTER="${RUN_BACKTESTS_AFTER:-1}"
RUN_SIGNALS_AFTER="${RUN_SIGNALS_AFTER:-1}"
RUN_DAILY_PIPELINE_AFTER="${RUN_DAILY_PIPELINE_AFTER:-1}"
WAIT_BACKTESTS_AFTER_QUEUE="${WAIT_BACKTESTS_AFTER_QUEUE:-1}"

FACTOR_CHUNK_SIZE="${FACTOR_CHUNK_SIZE:-800}"
BACKTEST_CHUNK_SIZE="${BACKTEST_CHUNK_SIZE:-500}"
BACKTEST_MIN_BARS="${BACKTEST_MIN_BARS:-75}"
BACKTEST_START_DATE="${BACKTEST_START_DATE:-2026-01-01}"
BACKTEST_END_DATE="${BACKTEST_END_DATE:-$(date +%F)}"
BACKTEST_INITIAL_CAPITAL="${BACKTEST_INITIAL_CAPITAL:-200000}"
BACKTEST_MAX_POSITIONS="${BACKTEST_MAX_POSITIONS:-8}"
BACKTEST_POSITION_PCT="${BACKTEST_POSITION_PCT:-12}"
BACKTEST_MIN_SCORE="${BACKTEST_MIN_SCORE:-55}"
SIGNAL_CANDIDATE_LIMIT="${SIGNAL_CANDIDATE_LIMIT:-1000}"
PIPELINE_CANDIDATE_LIMIT="${PIPELINE_CANDIDATE_LIMIT:-220}"
BACKTEST_WAIT_TIMEOUT_SECONDS="${BACKTEST_WAIT_TIMEOUT_SECONDS:-21600}"
BACKTEST_WAIT_SLEEP_SECONDS="${BACKTEST_WAIT_SLEEP_SECONDS:-30}"

STRATEGY_KEYS="${STRATEGY_KEYS:-ma_trend,macd_trend,rsi_reversion,bollinger_reversion,relative_strength_momentum,breakout_atr,multi_factor_ranking,low_volatility_quality,volume_price_confirmation}"

PG_CONTAINER="${PG_CONTAINER:-stocks-postgres}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-stock_backtest}"

declare -a BACKTEST_TASK_IDS=()

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

need_cmd curl
need_cmd python3
need_cmd docker

api_token=""
api_token_created_at=0
api_token_ttl_seconds="${API_TOKEN_REFRESH_SECONDS:-600}"
api_retry_attempts="${API_RETRY_ATTEMPTS:-6}"
api_retry_sleep_seconds="${API_RETRY_SLEEP_SECONDS:-5}"

login() {
  log "login ${BASE_URL} as ${USERNAME}"
  local attempt response
  for ((attempt=1; attempt<=api_retry_attempts; attempt++)); do
    response="$(
      curl -fsS -X POST "${BASE_URL}/api/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" 2>/tmp/stocks_rebuild_login_error.log || true
    )"
    api_token="$(
      printf '%s' "${response}" |
        python3 -c 'import sys,json; data=sys.stdin.read();
try:
  print(json.loads(data)["data"]["tokens"]["accessToken"])
except Exception:
  print("")'
    )"
    if [[ -n "${api_token}" ]]; then
      api_token_created_at="$(date +%s)"
      return 0
    fi
    log "login attempt ${attempt}/${api_retry_attempts} failed: $(cat /tmp/stocks_rebuild_login_error.log 2>/dev/null || true)"
    sleep "${api_retry_sleep_seconds}"
  done
  [[ -n "${api_token}" ]] || die "empty API token"
}

ensure_login() {
  local now
  now="$(date +%s)"
  if [[ -z "${api_token}" || $((now - api_token_created_at)) -ge "${api_token_ttl_seconds}" ]]; then
    login
  fi
}

api_get() {
  ensure_login
  local attempt
  for ((attempt=1; attempt<=api_retry_attempts; attempt++)); do
    if curl -fsS -H "Authorization: Bearer ${api_token}" "$@"; then
      return 0
    fi
    log "GET attempt ${attempt}/${api_retry_attempts} failed: $*"
    api_token=""
    sleep "${api_retry_sleep_seconds}"
    ensure_login
  done
  return 1
}

api_post_json() {
  local url="$1"
  local payload="$2"
  ensure_login
  local attempt
  for ((attempt=1; attempt<=api_retry_attempts; attempt++)); do
    if curl -fsS -X POST "${url}" \
      -H "Authorization: Bearer ${api_token}" \
      -H 'Content-Type: application/json' \
      -d "${payload}"; then
      return 0
    fi
    log "POST attempt ${attempt}/${api_retry_attempts} failed: ${url}"
    api_token=""
    sleep "${api_retry_sleep_seconds}"
    ensure_login
  done
  return 1
}

psql_at() {
  docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -At -F $'\t' "$@"
}

coverage_tsv() {
  psql_at -c "
with base as (
  select count(*)::numeric as stocks
  from stocks
  where type='stock' and is_listed=true
),
bars as (
  select
    count(distinct b.stock_id)::numeric as with_bars,
    count(*)::numeric as bars,
    min(b.time)::date as first_day,
    max(b.time)::date as last_day
  from daily_bars b
  join stocks s on s.id=b.stock_id
  where s.type='stock' and s.is_listed=true
)
select
  coalesce(base.stocks,0)::int,
  coalesce(bars.with_bars,0)::int,
  coalesce(bars.bars,0)::int,
  round(case when coalesce(base.stocks,0)>0 then coalesce(bars.with_bars,0)*100/base.stocks else 0 end, 2),
  coalesce(bars.first_day::text,''),
  coalesce(bars.last_day::text,'')
from base,bars;
"
}

print_bucket_coverage() {
  psql_at -P pager=off -c "
select
  case
    when s.symbol like 'sh.60%' then 'SH60'
    when s.symbol like 'sz.00%' then 'SZ00'
    when s.symbol like 'sz.30%' then 'SZ30'
    when s.symbol like 'sh.68%' then 'SH68'
    when s.symbol like 'bj.%' then 'BJ'
    else 'OTHER'
  end as bucket,
  count(distinct s.id) as stocks,
  count(distinct b.stock_id) as with_bars,
  count(b.*) as bars,
  min(b.time)::date as first_day,
  max(b.time)::date as last_day
from stocks s
left join daily_bars b on b.stock_id=s.id
where s.type='stock' and s.is_listed=true
group by 1
order by 1;
" >&2 || true
}

queue_counts() {
  api_get "${BASE_URL}/api/market/update-status" |
    python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]["queue"]; print("%s\t%s\t%s\t%s\t%s"%(d.get("waiting",0),d.get("active",0),d.get("delayed",0),d.get("failed",0),d.get("completed",0)))'
}

wait_data_queue_idle() {
  local started
  started="$(date +%s)"
  while true; do
    local counts waiting active delayed failed completed elapsed
    counts="$(queue_counts)"
    IFS=$'\t' read -r waiting active delayed failed completed <<<"${counts}"
    elapsed=$(( $(date +%s) - started ))
    log "data queue waiting=${waiting} active=${active} delayed=${delayed} failed=${failed} completed=${completed} elapsed=${elapsed}s"
    if [[ "${waiting}" == "0" && "${active}" == "0" && "${delayed}" == "0" ]]; then
      break
    fi
    if (( elapsed > QUEUE_TIMEOUT_SECONDS )); then
      die "data queue wait timeout after ${elapsed}s"
    fi
    sleep "${IDLE_SLEEP_SECONDS}"
  done
}

coverage_reached() {
  local line stocks with_bars bars pct first_day last_day
  line="$(coverage_tsv)"
  IFS=$'\t' read -r stocks with_bars bars pct first_day last_day <<<"${line}"
  log "coverage stocks=${stocks} with_bars=${with_bars} bars=${bars} pct=${pct}% range=${first_day:-NA}~${last_day:-NA}"
  python3 - "$with_bars" "$pct" "$TARGET_WITH_BARS" "$TARGET_COVERAGE_PCT" <<'PY'
import sys
with_bars=float(sys.argv[1]); pct=float(sys.argv[2]); target=float(sys.argv[3]); target_pct=float(sys.argv[4])
sys.exit(0 if (with_bars >= target or pct >= target_pct) else 1)
PY
}

trigger_history_round() {
  local response
  response="$(api_post_json "${BASE_URL}/api/tasks/${TASK_ID}/run" '{}')"
  log "trigger history task ${TASK_ID}: ${response}"
}

run_market_loop() {
  log "start market history rebuild loop: max_rounds=${MAX_MARKET_ROUNDS}, target_with_bars=${TARGET_WITH_BARS}, target_pct=${TARGET_COVERAGE_PCT}"
  wait_data_queue_idle
  print_bucket_coverage
  if coverage_reached; then
    log "market coverage already reached"
    return 0
  fi

  local round
  for ((round=1; round<=MAX_MARKET_ROUNDS; round++)); do
    log "market rebuild round ${round}/${MAX_MARKET_ROUNDS}"
    trigger_history_round
    wait_data_queue_idle
    print_bucket_coverage
    if coverage_reached; then
      log "market coverage target reached after round ${round}"
      return 0
    fi
    sleep "${ROUND_SLEEP_SECONDS}"
  done

  log "market loop stopped after max rounds; current coverage:"
  coverage_reached || true
}

symbols_with_enough_bars() {
  local min_bars="$1"
  psql_at -c "
select s.symbol
from stocks s
join daily_bars b on b.stock_id=s.id
where s.type='stock' and s.is_listed=true
group by s.id, s.symbol
having count(*) >= ${min_bars}
order by s.symbol;
"
}

json_array_from_csv() {
  python3 - "$1" <<'PY'
import sys,json
items=[x.strip() for x in sys.argv[1].split(',') if x.strip()]
print(json.dumps(items, ensure_ascii=False))
PY
}

json_array_from_lines() {
  python3 -c '
import sys,json
items=[line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(items, ensure_ascii=False))
'
}

chunk_symbols() {
  local chunk_size="$1"
  python3 -c '
import sys
size=int(sys.argv[1])
buf=[]
for line in sys.stdin:
    s=line.strip()
    if not s:
        continue
    buf.append(s)
    if len(buf) >= size:
        print(",".join(buf))
        buf=[]
if buf:
    print(",".join(buf))
' "${chunk_size}"
}

run_factor_chunks() {
  log "start factor sync chunks size=${FACTOR_CHUNK_SIZE}"
  local total=0 chunk
  while IFS= read -r chunk; do
    [[ -n "${chunk}" ]] || continue
    total=$((total + 1))
    local symbols_json payload response
    symbols_json="$(json_array_from_csv "${chunk}")"
    payload="$(python3 - "${symbols_json}" "${BACKTEST_END_DATE}" "${FACTOR_CHUNK_SIZE}" <<'PY'
import sys,json
symbols=json.loads(sys.argv[1])
payload={
  "scope":"custom",
  "symbols":symbols,
  "limit":int(sys.argv[3]),
  "as_of":sys.argv[2],
  "provider":"auto",
  "prefer_real_provider":True
}
print(json.dumps(payload, ensure_ascii=False))
PY
)"
    response="$(api_post_json "${BASE_URL}/api/market/factors/sync" "${payload}" | python3 -c 'import sys,json; d=json.load(sys.stdin); data=d.get("data",{}); print(json.dumps({"success":d.get("success"),"processed":data.get("processed_stock_count"),"skipped":data.get("skipped_stock_count"),"upserts":data.get("upserts"),"duration_ms":data.get("duration_ms")}, ensure_ascii=False))')"
    log "factor chunk ${total}: ${response}"
    sleep 1
  done < <(symbols_with_enough_bars 30 | chunk_symbols "${FACTOR_CHUNK_SIZE}")
  log "factor sync chunks completed: chunks=${total}"
}

run_backtest_chunks() {
  log "create quant backtest chunks size=${BACKTEST_CHUNK_SIZE}, min_bars=${BACKTEST_MIN_BARS}, range=${BACKTEST_START_DATE}~${BACKTEST_END_DATE}"
  local strategy_json
  strategy_json="$(json_array_from_csv "${STRATEGY_KEYS}")"
  local total=0
  while IFS= read -r chunk; do
    [[ -n "${chunk}" ]] || continue
    total=$((total + 1))
    local symbols_json payload raw_response response task_id
    symbols_json="$(json_array_from_csv "${chunk}")"
    payload="$(python3 - "${symbols_json}" "${strategy_json}" "${total}" <<PY
import sys,json,os
symbols=json.loads(sys.argv[1])
strategies=json.loads(sys.argv[2])
idx=int(sys.argv[3])
payload={
  "task_name": f"重建后全市场量化跑分-分片{idx:02d}",
  "universe": "market",
  "symbols": symbols,
  "strategy_keys": strategies,
  "start_date": os.environ.get("BACKTEST_START_DATE", "${BACKTEST_START_DATE}"),
  "end_date": os.environ.get("BACKTEST_END_DATE", "${BACKTEST_END_DATE}"),
  "candidate_limit": len(symbols),
  "initial_capital": float(os.environ.get("BACKTEST_INITIAL_CAPITAL", "${BACKTEST_INITIAL_CAPITAL}")),
  "max_positions": int(os.environ.get("BACKTEST_MAX_POSITIONS", "${BACKTEST_MAX_POSITIONS}")),
  "position_pct": float(os.environ.get("BACKTEST_POSITION_PCT", "${BACKTEST_POSITION_PCT}")),
  "min_score": float(os.environ.get("BACKTEST_MIN_SCORE", "${BACKTEST_MIN_SCORE}")),
  "rebalance_frequency": "daily",
  "async": True,
  "validation_split": {"enabled": True, "train_pct": 60, "validation_pct": 20}
}
print(json.dumps(payload, ensure_ascii=False))
PY
)"
    raw_response="$(api_post_json "${BASE_URL}/api/quant/backtests" "${payload}")"
    response="$(printf '%s' "${raw_response}" | python3 -c 'import sys,json; d=json.load(sys.stdin); data=d.get("data",{}); task=(data.get("task") or {}).get("task") or (data.get("task") or {}); print(json.dumps({"success":d.get("success"),"queued":data.get("queued"),"queue_job_id":data.get("queue_job_id"),"task_id":task.get("id"),"task_name":task.get("task_name")}, ensure_ascii=False))')"
    task_id="$(printf '%s' "${raw_response}" | python3 -c 'import sys,json; d=json.load(sys.stdin); data=d.get("data",{}); task=(data.get("task") or {}).get("task") or (data.get("task") or {}); print(task.get("id") or "")')"
    if [[ -n "${task_id}" ]]; then
      BACKTEST_TASK_IDS+=("${task_id}")
    fi
    log "backtest chunk ${total}: ${response}"
    sleep 1
  done < <(symbols_with_enough_bars "${BACKTEST_MIN_BARS}" | chunk_symbols "${BACKTEST_CHUNK_SIZE}")
  log "backtest chunks queued: chunks=${total}"
}

wait_backtest_tasks() {
  if [[ "${#BACKTEST_TASK_IDS[@]}" -eq 0 ]]; then
    log "no backtest task ids captured, skip quant-backtest wait"
    return 0
  fi

  local ids_csv
  ids_csv="$(IFS=,; echo "${BACKTEST_TASK_IDS[*]}")"
  log "wait quant backtests: ids=${ids_csv}, timeout=${BACKTEST_WAIT_TIMEOUT_SECONDS}s"

  local started elapsed status_summary active_count failed_count completed_count
  started="$(date +%s)"
  while true; do
    status_summary="$(
      psql_at -c "
select status, count(*)
from quant_backtest_tasks
where id in (${ids_csv})
group by status
order by status;
" | tr '\n' ';'
    )"
    active_count="$(
      psql_at -c "
select count(*)
from quant_backtest_tasks
where id in (${ids_csv}) and status in ('QUEUED','RUNNING');
"
    )"
    failed_count="$(
      psql_at -c "
select count(*)
from quant_backtest_tasks
where id in (${ids_csv}) and status = 'FAILED';
"
    )"
    completed_count="$(
      psql_at -c "
select count(*)
from quant_backtest_tasks
where id in (${ids_csv}) and status = 'COMPLETED';
"
    )"
    elapsed=$(( $(date +%s) - started ))
    log "quant backtests status=${status_summary:-none} completed=${completed_count} failed=${failed_count} active=${active_count} elapsed=${elapsed}s"

    if [[ "${active_count}" == "0" ]]; then
      if [[ "${failed_count}" != "0" ]]; then
        log "quant backtests finished with failures=${failed_count}; continue to signals so successful slices still produce rankings"
      fi
      return 0
    fi
    if (( elapsed > BACKTEST_WAIT_TIMEOUT_SECONDS )); then
      die "quant backtest wait timeout after ${elapsed}s; ids=${ids_csv}"
    fi
    sleep "${BACKTEST_WAIT_SLEEP_SECONDS}"
  done
}

run_signals() {
  log "generate quant signals for ${BACKTEST_END_DATE}"
  local strategy_json payload response
  strategy_json="$(json_array_from_csv "${STRATEGY_KEYS}")"
  payload="$(python3 - "${strategy_json}" <<PY
import sys,json,os
payload={
  "universe":"market",
  "trade_date": os.environ.get("BACKTEST_END_DATE", "${BACKTEST_END_DATE}"),
  "as_of": os.environ.get("BACKTEST_END_DATE", "${BACKTEST_END_DATE}"),
  "candidate_limit": int(os.environ.get("SIGNAL_CANDIDATE_LIMIT", "${SIGNAL_CANDIDATE_LIMIT}")),
  "strategy_keys": json.loads(sys.argv[1]),
  "persist": True,
  "refresh_realtime_quotes": False
}
print(json.dumps(payload, ensure_ascii=False))
PY
)"
  response="$(api_post_json "${BASE_URL}/api/quant/signals/generate" "${payload}" | python3 -c 'import sys,json; d=json.load(sys.stdin); data=d.get("data",{}); print(json.dumps({"success":d.get("success"),"scanned_stocks":data.get("scanned_stocks"),"strategy_count":data.get("strategy_count"),"signal_count":data.get("signal_count"),"by_strategy":data.get("by_strategy")}, ensure_ascii=False))')"
  log "signals: ${response}"
}

run_daily_pipeline() {
  log "run quant daily pipeline smoke, reporting disabled"
  local strategy_json payload response
  strategy_json="$(json_array_from_csv "${STRATEGY_KEYS}")"
  payload="$(python3 - "${strategy_json}" <<PY
import sys,json,os
payload={
  "username":"stock",
  "universe":"market",
  "trade_date": os.environ.get("BACKTEST_END_DATE", "${BACKTEST_END_DATE}"),
  "target_date": os.environ.get("BACKTEST_END_DATE", "${BACKTEST_END_DATE}"),
  "candidate_limit": int(os.environ.get("PIPELINE_CANDIDATE_LIMIT", "${PIPELINE_CANDIDATE_LIMIT}")),
  "top_n": 10,
  "strategy_keys": json.loads(sys.argv[1]),
  "report_to_feishu": False,
  "notify_to_feishu_bot": False,
  "sync_factors_before_scan": False,
  "refresh_realtime_quotes": False,
  "submit_agent_analysis": False,
  "run_paper_trading": False,
  "dry_run": True
}
print(json.dumps(payload, ensure_ascii=False))
PY
)"
  response="$(api_post_json "${BASE_URL}/api/quant/daily-pipeline/run" "${payload}" | python3 -c 'import sys,json; d=json.load(sys.stdin); data=d.get("data",{}); print(json.dumps({"success":d.get("success"),"mode":data.get("mode"),"trade_date":data.get("trade_date"),"scanned_stocks":(data.get("generated") or {}).get("scanned_stocks"),"signal_count":(data.get("generated") or {}).get("signal_count"),"archive_total":(data.get("archive") or {}).get("total"),"selected":(data.get("fusion") or {}).get("selected_count")}, ensure_ascii=False))')"
  log "daily pipeline: ${response}"
}

main() {
  login
  run_market_loop
  if [[ "${RUN_FACTORS_AFTER}" == "1" ]]; then
    run_factor_chunks
  fi
  if [[ "${RUN_BACKTESTS_AFTER}" == "1" ]]; then
    run_backtest_chunks
    if [[ "${WAIT_BACKTESTS_AFTER_QUEUE}" == "1" ]]; then
      wait_backtest_tasks
    fi
  fi
  if [[ "${RUN_SIGNALS_AFTER}" == "1" ]]; then
    run_signals
  fi
  if [[ "${RUN_DAILY_PIPELINE_AFTER}" == "1" ]]; then
    run_daily_pipeline
  fi
  log "closed-loop rebuild workflow submitted/completed"
}

main "$@"
