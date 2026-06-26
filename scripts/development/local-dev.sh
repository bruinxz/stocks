#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
RUNTIME_DIR="$ROOT_DIR/tmp/local-dev"

SSH_USER="${STOCKS_DEV_SSH_USER:-ops}"
SSH_HOST="${STOCKS_DEV_SSH_HOST:-}"
SSH_PORT="${STOCKS_DEV_SSH_PORT:-14126}"
LOCAL_DB_PORT="${STOCKS_DEV_LOCAL_DB_PORT:-15432}"
REMOTE_DB_HOST="${STOCKS_DEV_REMOTE_DB_HOST:-127.0.0.1}"
REMOTE_DB_PORT="${STOCKS_DEV_REMOTE_DB_PORT:-5432}"
BACKEND_PORT="${STOCKS_DEV_BACKEND_PORT:-3002}"
FRONTEND_PORT="${STOCKS_DEV_FRONTEND_PORT:-3001}"
REDIS_PORT="${STOCKS_DEV_REDIS_PORT:-6379}"

TUNNEL_PID="$RUNTIME_DIR/db-tunnel.pid"
BACKEND_PID="$RUNTIME_DIR/backend.pid"
FRONTEND_PID="$RUNTIME_DIR/frontend.pid"
REDIS_PID="$RUNTIME_DIR/redis.pid"
TUNNEL_LOG="$RUNTIME_DIR/db-tunnel.log"
BACKEND_LOG="$RUNTIME_DIR/backend.log"
FRONTEND_LOG="$RUNTIME_DIR/frontend.log"
REDIS_LOG="$RUNTIME_DIR/redis.log"
REDIS_CONTAINER_NAME="${STOCKS_DEV_REDIS_CONTAINER:-stocks-local-dev-redis}"
CURRENT_MODE="${STOCKS_DEV_MODE:-safe}"
LABEL_SUFFIX="$(printf '%s' "$ROOT_DIR" | cksum | awk '{print $1}')"
LAUNCHD_DOMAIN="gui/$(id -u)"
BACKEND_LABEL="com.local.stocks.$LABEL_SUFFIX.backend"
FRONTEND_LABEL="com.local.stocks.$LABEL_SUFFIX.frontend"
BACKEND_PLIST="$RUNTIME_DIR/backend.plist"
FRONTEND_PLIST="$RUNTIME_DIR/frontend.plist"

mkdir -p "$RUNTIME_DIR"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") start [safe|quant|full|all|backend|frontend|tunnel|redis]
  $(basename "$0") stop [all|backend|frontend|tunnel|redis]
  $(basename "$0") restart [safe|quant|full|all|backend|frontend|tunnel|redis]
  $(basename "$0") status
  $(basename "$0") check
  $(basename "$0") logs [backend|frontend|tunnel|redis]

Defaults:
  start/restart mode: safe
  stop target: all

Modes:
  safe   UI/API/dev DB only. Workers and scheduler are off.
  quant  Enables Bull queue workers for async quant backtests. Scheduler remains off.
  full   Enables queue workers, default task seed, and scheduler. Use intentionally.

Environment overrides:
  STOCKS_DEV_SSH_USER      default: ops
  STOCKS_DEV_SSH_HOST      required: remote SSH host for the dev DB tunnel
  STOCKS_DEV_SSH_PORT      default: 14126
  STOCKS_DEV_LOCAL_DB_PORT default: 15432
  STOCKS_DEV_BACKEND_PORT  default: 3002
  STOCKS_DEV_FRONTEND_PORT default: 3001
  STOCKS_DEV_REDIS_PORT    default: 6379
EOF
}

log() {
  printf '[local-dev] %s\n' "$*"
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

shell_quote() {
  printf '%q' "$1"
}

launchd_available() {
  [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] &&
    command -v launchctl >/dev/null 2>&1 &&
    launchctl print "$LAUNCHD_DOMAIN" >/dev/null 2>&1
}

launchd_loaded() {
  local label="$1"
  launchd_available && launchctl print "$LAUNCHD_DOMAIN/$label" >/dev/null 2>&1
}

launchd_pid() {
  local label="$1"
  launchd_available || return 0
  launchctl print "$LAUNCHD_DOMAIN/$label" 2>/dev/null |
    awk -F'= ' '/pid = / { gsub(/[^0-9]/, "", $2); print $2; exit }' ||
    true
}

is_launchd_service_running() {
  local label="$1"
  local pid_file="$2"
  local pid
  pid="$(launchd_pid "$label")"
  if is_pid_running "$pid"; then
    echo "$pid" > "$pid_file"
    return 0
  fi
  return 1
}

write_env_key() {
  local key="$1"
  local value="${2:-}"
  [ -n "$value" ] || return 0
  printf '    <key>%s</key>\n' "$key"
  printf '    <string>%s</string>\n' "$(xml_escape "$value")"
}

write_launchd_plist() {
  local plist="$1"
  local label="$2"
  local working_dir="$3"
  local log_file="$4"
  local command="$5"
  local service="$6"

  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>$(xml_escape "$command")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$working_dir")</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log_file")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log_file")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
EOF
    write_env_key PATH "$PATH"
    write_env_key NODE_ENV "development"
    write_env_key HEALTH_DETAIL_DB_TIMEOUT_MS "$HEALTH_DETAIL_DB_TIMEOUT_MS"

    if [ "$service" = "backend" ]; then
      write_env_key PORT "$BACKEND_PORT"
      write_env_key DISABLE_SCHEDULER "$DISABLE_SCHEDULER"
      write_env_key DISABLE_DEFAULT_TASK_SEED "$DISABLE_DEFAULT_TASK_SEED"
      write_env_key DISABLE_QUEUE_WORKERS "$DISABLE_QUEUE_WORKERS"
      write_env_key DISABLE_LIVE_TRADING_BACKGROUND "$DISABLE_LIVE_TRADING_BACKGROUND"
      write_env_key SKIP_DB_SYNC "$SKIP_DB_SYNC"
      write_env_key SKIP_LEGACY_SCHEMA_REPAIR "$SKIP_LEGACY_SCHEMA_REPAIR"
      write_env_key SKIP_RECOMMENDATION_RUNTIME_SYNC "$SKIP_RECOMMENDATION_RUNTIME_SYNC"
      write_env_key SKIP_DEFAULT_USER_INIT "$SKIP_DEFAULT_USER_INIT"
    else
      write_env_key BROWSER "none"
      write_env_key CI "false"
      write_env_key PORT "$FRONTEND_PORT"
    fi

    cat <<EOF
  </dict>
</dict>
</plist>
EOF
  } > "$plist"
}

bootout_launchd_service() {
  local label="$1"
  local plist="$2"
  if launchd_loaded "$label"; then
    launchctl bootout "$LAUNCHD_DOMAIN/$label" >/dev/null 2>&1 ||
      launchctl bootout "$LAUNCHD_DOMAIN" "$plist" >/dev/null 2>&1 ||
      true
  fi
}

start_launchd_service() {
  local label="$1"
  local plist="$2"
  local pid_file="$3"
  local service="$4"

  bootout_launchd_service "$label" "$plist"
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist"
  sleep 1
  local pid
  pid="$(launchd_pid "$label")"
  if is_pid_running "$pid"; then
    echo "$pid" > "$pid_file"
    log "$service launchd service started (pid $pid)"
  fi
}

stop_launchd_service() {
  local label="$1"
  local plist="$2"
  local pid_file="$3"
  local service="$4"
  local pid
  pid="$(pid_from_file "$pid_file")"
  if ! is_pid_running "$pid"; then
    pid="$(launchd_pid "$label")"
  fi

  if launchd_loaded "$label"; then
    log "Stopping $service launchd service"
    bootout_launchd_service "$label" "$plist"
  fi

  if is_pid_running "$pid"; then
    kill_tree "$pid"
    sleep 1
    if is_pid_running "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file"
}

is_mode() {
  case "${1:-}" in
    safe|quant|full) return 0 ;;
    *) return 1 ;;
  esac
}

is_target() {
  case "${1:-}" in
    all|backend|frontend|tunnel|redis) return 0 ;;
    *) return 1 ;;
  esac
}

configure_mode() {
  local mode="${1:-safe}"
  case "$mode" in
    safe)
      export DISABLE_SCHEDULER=true
      export DISABLE_DEFAULT_TASK_SEED=true
      export DISABLE_QUEUE_WORKERS=true
      export DISABLE_LIVE_TRADING_BACKGROUND=true
      ;;
    quant)
      export DISABLE_SCHEDULER=true
      export DISABLE_DEFAULT_TASK_SEED=true
      export DISABLE_QUEUE_WORKERS=false
      export DISABLE_LIVE_TRADING_BACKGROUND=true
      ;;
    full)
      export DISABLE_SCHEDULER=false
      export DISABLE_DEFAULT_TASK_SEED=false
      export DISABLE_QUEUE_WORKERS=false
      export DISABLE_LIVE_TRADING_BACKGROUND=false
      ;;
    *)
      log "Unknown mode: $mode"
      usage
      exit 1
      ;;
  esac

  export SKIP_DB_SYNC=true
  export SKIP_LEGACY_SCHEMA_REPAIR=true
  export SKIP_RECOMMENDATION_RUNTIME_SYNC=true
  export SKIP_DEFAULT_USER_INIT=true
  export HEALTH_DETAIL_DB_TIMEOUT_MS="${HEALTH_DETAIL_DB_TIMEOUT_MS:-5000}"
  CURRENT_MODE="$mode"
}

is_pid_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_from_file() {
  local file="$1"
  [ -f "$file" ] && cat "$file" || true
}

is_service_running() {
  local pid_file="$1"
  local pid
  pid="$(pid_from_file "$pid_file")"
  is_pid_running "$pid"
}

remove_stale_pid() {
  local pid_file="$1"
  if [ -f "$pid_file" ] && ! is_service_running "$pid_file"; then
    rm -f "$pid_file"
  fi
}

port_listener_pid() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local timeout="${3:-20}"
  local start
  start="$(date +%s)"
  while true; do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      log "$label is listening on 127.0.0.1:$port"
      return 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      log "$label did not become ready within ${timeout}s"
      return 1
    fi
    sleep 1
  done
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local timeout="${3:-30}"
  local start
  start="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is ready: $url"
      return 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      log "$label did not become ready within ${timeout}s"
      return 1
    fi
    sleep 1
  done
}

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_pid_file() {
  local pid_file="$1"
  local label="$2"
  local pid
  pid="$(pid_from_file "$pid_file")"
  if is_pid_running "$pid"; then
    log "Stopping $label (pid $pid)"
    kill_tree "$pid"
    sleep 1
    if is_pid_running "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    log "$label is not running"
  fi
  rm -f "$pid_file"
}

ensure_backend_env() {
  if [ ! -f "$BACKEND_DIR/.env" ]; then
    log "Missing $BACKEND_DIR/.env"
    log "Create it first; it should point DB_HOST=127.0.0.1 DB_PORT=$LOCAL_DB_PORT DB_NAME=stock_backtest_dev."
    exit 1
  fi
}

env_value() {
  local key="$1"
  node - "$BACKEND_DIR/.env" "$key" <<'NODE'
const fs = require('fs');
const path = require('path');

const envFile = process.argv[2];
const key = process.argv[3];
let dotenv;

try {
  dotenv = require(path.join(path.dirname(envFile), 'node_modules', 'dotenv'));
} catch (_error) {
  dotenv = require('dotenv');
}

const parsed = dotenv.parse(fs.readFileSync(envFile));
process.stdout.write(parsed[key] || '');
NODE
}

assert_backend_env_points_to_dev_db() {
  local db_host db_port db_name db_user
  db_host="$(env_value DB_HOST)"
  db_port="$(env_value DB_PORT)"
  db_name="$(env_value DB_NAME)"
  db_user="$(env_value DB_USER)"

  if [ "$db_host" != "127.0.0.1" ] || [ "$db_port" != "$LOCAL_DB_PORT" ] ||
    [ "$db_name" != "stock_backtest_dev" ] || [ "$db_user" != "stock_dev" ]; then
    log "Refusing to start backend: $BACKEND_DIR/.env is not pointing at the local dev DB tunnel."
    log "Expected DB_HOST=127.0.0.1 DB_PORT=$LOCAL_DB_PORT DB_NAME=stock_backtest_dev DB_USER=stock_dev"
    log "Actual   DB_HOST=$db_host DB_PORT=$db_port DB_NAME=$db_name DB_USER=$db_user"
    exit 1
  fi
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

redis_container_exists() {
  docker_available && docker ps -a --format '{{.Names}}' | grep -Fxq "$REDIS_CONTAINER_NAME"
}

redis_container_running() {
  docker_available && docker ps --format '{{.Names}}' | grep -Fxq "$REDIS_CONTAINER_NAME"
}

start_redis() {
  remove_stale_pid "$REDIS_PID"
  if nc -z 127.0.0.1 "$REDIS_PORT" >/dev/null 2>&1; then
    log "Redis already available on 127.0.0.1:$REDIS_PORT"
    return 0
  fi

  if docker_available; then
    if redis_container_exists; then
      log "Starting existing Docker Redis container: $REDIS_CONTAINER_NAME"
      docker start "$REDIS_CONTAINER_NAME" >> "$REDIS_LOG" 2>&1
    else
      log "Starting Docker Redis container: $REDIS_CONTAINER_NAME"
      : > "$REDIS_LOG"
      docker run -d \
        --name "$REDIS_CONTAINER_NAME" \
        -p "$REDIS_PORT:6379" \
        redis:7-alpine \
        redis-server --appendonly yes >> "$REDIS_LOG" 2>&1
    fi
    wait_for_port "$REDIS_PORT" "Redis" 30
    return 0
  fi

  if command -v redis-server >/dev/null 2>&1; then
    log "Starting local redis-server on 127.0.0.1:$REDIS_PORT"
    mkdir -p "$RUNTIME_DIR/redis-data"
    : > "$REDIS_LOG"
    redis-server \
      --bind 127.0.0.1 \
      --port "$REDIS_PORT" \
      --dir "$RUNTIME_DIR/redis-data" \
      --appendonly yes >> "$REDIS_LOG" 2>&1 &
    echo "$!" > "$REDIS_PID"
    wait_for_port "$REDIS_PORT" "Redis" 30
    return 0
  fi

  log "Redis is not running, and neither Docker nor redis-server is available."
  log "Install/start Redis locally, then rerun this script."
  exit 1
}

start_tunnel() {
  if [ -z "$SSH_HOST" ]; then
    log "STOCKS_DEV_SSH_HOST is required to start the DB tunnel."
    log "Example: STOCKS_DEV_SSH_HOST=<remote-host> $0 start safe"
    exit 1
  fi

  remove_stale_pid "$TUNNEL_PID"
  if is_service_running "$TUNNEL_PID"; then
    log "DB tunnel already running (pid $(cat "$TUNNEL_PID"))"
    return 0
  fi

  local existing_pid
  existing_pid="$(port_listener_pid "$LOCAL_DB_PORT")"
  if [ -n "$existing_pid" ]; then
    log "Port $LOCAL_DB_PORT is already listening (pid $existing_pid); treating DB tunnel as available."
    echo "$existing_pid" > "$TUNNEL_PID"
    return 0
  fi

  log "Starting DB tunnel: 127.0.0.1:$LOCAL_DB_PORT -> $SSH_HOST:$REMOTE_DB_PORT"
  log "SSH may ask for the $SSH_USER password unless you have a key configured."
  : > "$TUNNEL_LOG"
  ssh \
    -f -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o UserKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=no \
    -E "$TUNNEL_LOG" \
    -L "$LOCAL_DB_PORT:$REMOTE_DB_HOST:$REMOTE_DB_PORT" \
    -p "$SSH_PORT" \
    "$SSH_USER@$SSH_HOST"

  wait_for_port "$LOCAL_DB_PORT" "DB tunnel" 15
  existing_pid="$(port_listener_pid "$LOCAL_DB_PORT")"
  if [ -n "$existing_pid" ]; then
    echo "$existing_pid" > "$TUNNEL_PID"
  fi
}

start_backend() {
  ensure_backend_env
  assert_backend_env_points_to_dev_db
  start_redis
  start_tunnel
  remove_stale_pid "$BACKEND_PID"
  if is_launchd_service_running "$BACKEND_LABEL" "$BACKEND_PID"; then
    log "Backend already running (pid $(cat "$BACKEND_PID"))"
    return 0
  fi
  if is_service_running "$BACKEND_PID"; then
    log "Backend already running (pid $(cat "$BACKEND_PID"))"
    return 0
  fi
  if [ -n "$(port_listener_pid "$BACKEND_PORT")" ]; then
    log "Backend port $BACKEND_PORT is already in use."
    exit 1
  fi

  log "Starting backend on http://127.0.0.1:$BACKEND_PORT"
  log "Backend mode: $CURRENT_MODE"
  : > "$BACKEND_LOG"
  if launchd_available; then
    local backend_command
    backend_command="cd $(shell_quote "$BACKEND_DIR") && unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL && exec npm run dev < /dev/null"
    write_launchd_plist "$BACKEND_PLIST" "$BACKEND_LABEL" "$BACKEND_DIR" "$BACKEND_LOG" "$backend_command" "backend"
    start_launchd_service "$BACKEND_LABEL" "$BACKEND_PLIST" "$BACKEND_PID" "backend"
  else
    (
      cd "$BACKEND_DIR"
      unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL
      PORT="$BACKEND_PORT" nohup npm run dev < /dev/null >> "$BACKEND_LOG" 2>&1 &
      echo "$!" > "$BACKEND_PID"
    )
  fi

  wait_for_http "http://127.0.0.1:$BACKEND_PORT/health" "Backend" 40 || {
    log "Backend failed to become healthy. Recent log:"
    tail -n 80 "$BACKEND_LOG" || true
    exit 1
  }
}

start_frontend() {
  remove_stale_pid "$FRONTEND_PID"
  if is_launchd_service_running "$FRONTEND_LABEL" "$FRONTEND_PID"; then
    log "Frontend already running (pid $(cat "$FRONTEND_PID"))"
    return 0
  fi
  if is_service_running "$FRONTEND_PID"; then
    log "Frontend already running (pid $(cat "$FRONTEND_PID"))"
    return 0
  fi
  if [ -n "$(port_listener_pid "$FRONTEND_PORT")" ]; then
    log "Frontend port $FRONTEND_PORT is already in use."
    exit 1
  fi

  log "Starting frontend on http://127.0.0.1:$FRONTEND_PORT"
  : > "$FRONTEND_LOG"
  if launchd_available; then
    local frontend_command
    frontend_command="cd $(shell_quote "$FRONTEND_DIR") && exec npm start < /dev/null"
    write_launchd_plist "$FRONTEND_PLIST" "$FRONTEND_LABEL" "$FRONTEND_DIR" "$FRONTEND_LOG" "$frontend_command" "frontend"
    start_launchd_service "$FRONTEND_LABEL" "$FRONTEND_PLIST" "$FRONTEND_PID" "frontend"
  else
    (
      cd "$FRONTEND_DIR"
      BROWSER=none CI=false PORT="$FRONTEND_PORT" nohup npm start < /dev/null >> "$FRONTEND_LOG" 2>&1 &
      echo "$!" > "$FRONTEND_PID"
    )
  fi

  wait_for_port "$FRONTEND_PORT" "Frontend" 60 || {
    log "Frontend failed to become ready. Recent log:"
    tail -n 80 "$FRONTEND_LOG" || true
    exit 1
  }
}

stop_tunnel() {
  local pid
  pid="$(pid_from_file "$TUNNEL_PID")"
  if is_pid_running "$pid"; then
    local command_name
    command_name="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ' || true)"
    if [ "$command_name" = "ssh" ]; then
      log "Stopping DB tunnel (pid $pid)"
      kill "$pid" 2>/dev/null || true
    else
      log "Not stopping pid $pid on port $LOCAL_DB_PORT because it is '$command_name', not ssh."
    fi
  else
    log "DB tunnel is not running"
  fi
  rm -f "$TUNNEL_PID"
}

stop_redis() {
  local pid
  pid="$(pid_from_file "$REDIS_PID")"
  if is_pid_running "$pid"; then
    log "Stopping local redis-server (pid $pid)"
    kill "$pid" 2>/dev/null || true
    rm -f "$REDIS_PID"
    return 0
  fi
  rm -f "$REDIS_PID"

  if redis_container_running; then
    log "Stopping Docker Redis container: $REDIS_CONTAINER_NAME"
    docker stop "$REDIS_CONTAINER_NAME" >/dev/null
    return 0
  fi

  if nc -z 127.0.0.1 "$REDIS_PORT" >/dev/null 2>&1; then
    log "Redis is available on port $REDIS_PORT, but it was not started by this script; leaving it running."
  else
    log "Redis is not running"
  fi
}

stop_backend() {
  if launchd_loaded "$BACKEND_LABEL"; then
    stop_launchd_service "$BACKEND_LABEL" "$BACKEND_PLIST" "$BACKEND_PID" "backend"
  else
    stop_pid_file "$BACKEND_PID" "backend"
  fi
}

stop_frontend() {
  if launchd_loaded "$FRONTEND_LABEL"; then
    stop_launchd_service "$FRONTEND_LABEL" "$FRONTEND_PLIST" "$FRONTEND_PID" "frontend"
  else
    stop_pid_file "$FRONTEND_PID" "frontend"
  fi
}

start_target() {
  local target="${1:-all}"
  case "$target" in
    all)
      start_redis
      start_tunnel
      start_backend
      start_frontend
      ;;
    tunnel) start_tunnel ;;
    backend) start_backend ;;
    frontend) start_frontend ;;
    redis) start_redis ;;
    *)
      usage
      exit 1
      ;;
  esac
}

stop_target() {
  local target="${1:-all}"
  case "$target" in
    all)
      stop_frontend
      stop_backend
      stop_tunnel
      stop_redis
      ;;
    tunnel) stop_tunnel ;;
    backend) stop_backend ;;
    frontend) stop_frontend ;;
    redis) stop_redis ;;
    *)
      usage
      exit 1
      ;;
  esac
}

status_line() {
  local label="$1"
  local pid_file="$2"
  local port="$3"
  local pid
  pid="$(pid_from_file "$pid_file")"
  if is_pid_running "$pid"; then
    printf '%-10s running  pid=%s  port=%s\n' "$label" "$pid" "$port"
  else
    printf '%-10s stopped  port=%s\n' "$label" "$port"
  fi
}

managed_status_line() {
  local label="$1"
  local pid_file="$2"
  local port="$3"
  local launchd_label="$4"
  local pid
  pid="$(pid_from_file "$pid_file")"
  if ! is_pid_running "$pid"; then
    pid="$(launchd_pid "$launchd_label")"
    if is_pid_running "$pid"; then
      echo "$pid" > "$pid_file"
    fi
  fi

  if is_pid_running "$pid"; then
    printf '%-10s running  pid=%s  port=%s\n' "$label" "$pid" "$port"
  else
    printf '%-10s stopped  port=%s\n' "$label" "$port"
  fi
}

status() {
  remove_stale_pid "$TUNNEL_PID"
  remove_stale_pid "$BACKEND_PID"
  remove_stale_pid "$FRONTEND_PID"
  remove_stale_pid "$REDIS_PID"
  status_line "tunnel" "$TUNNEL_PID" "$LOCAL_DB_PORT"
  if is_service_running "$REDIS_PID"; then
    printf '%-10s running  pid=%s  port=%s\n' "redis" "$(cat "$REDIS_PID")" "$REDIS_PORT"
  elif redis_container_running; then
    printf '%-10s running  container=%s  port=%s\n' "redis" "$REDIS_CONTAINER_NAME" "$REDIS_PORT"
  elif nc -z 127.0.0.1 "$REDIS_PORT" >/dev/null 2>&1; then
    printf '%-10s running  external  port=%s\n' "redis" "$REDIS_PORT"
  else
    printf '%-10s stopped  port=%s\n' "redis" "$REDIS_PORT"
  fi
  managed_status_line "backend" "$BACKEND_PID" "$BACKEND_PORT" "$BACKEND_LABEL"
  managed_status_line "frontend" "$FRONTEND_PID" "$FRONTEND_PORT" "$FRONTEND_LABEL"
  printf 'logs       %s\n' "$RUNTIME_DIR"
}

check() {
  log "Checking DB tunnel"
  nc -zv 127.0.0.1 "$LOCAL_DB_PORT"
  log "Checking Redis"
  nc -zv 127.0.0.1 "$REDIS_PORT"
  log "Checking backend health"
  curl -fsS "http://127.0.0.1:$BACKEND_PORT/health"
  printf '\n'
  log "Checking backend DB-backed stock endpoint"
  curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/stocks?limit=1"
  printf '\n'
}

logs() {
  local target="${1:-backend}"
  case "$target" in
    backend) tail -f "$BACKEND_LOG" ;;
    frontend) tail -f "$FRONTEND_LOG" ;;
    tunnel) tail -f "$TUNNEL_LOG" ;;
    redis)
      if [ -f "$REDIS_LOG" ]; then
        tail -f "$REDIS_LOG"
      elif redis_container_exists; then
        docker logs -f "$REDIS_CONTAINER_NAME"
      else
        log "No Redis log found."
      fi
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

command="${1:-}"
arg="${2:-}"

case "$command" in
  start)
    if [ -z "$arg" ] || is_mode "$arg"; then
      configure_mode "${arg:-safe}"
      start_target all
    elif is_target "$arg"; then
      configure_mode "$CURRENT_MODE"
      start_target "$arg"
    else
      usage
      exit 1
    fi
    ;;
  stop) stop_target "${arg:-all}" ;;
  restart)
    if [ -z "$arg" ] || is_mode "$arg"; then
      stop_target all
      configure_mode "${arg:-safe}"
      start_target all
    elif is_target "$arg"; then
      stop_target "$arg"
      configure_mode "$CURRENT_MODE"
      start_target "$arg"
    else
      usage
      exit 1
    fi
    ;;
  status) status ;;
  check) check ;;
  logs) logs "${2:-backend}" ;;
  -h|--help|help|'') usage ;;
  *)
    usage
    exit 1
    ;;
esac
