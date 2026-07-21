#!/usr/bin/env bash
# Remote-build deployment for stocks main (Sprint 37: lym/xz sandbox 已关停).
#
# Unlike the legacy local-build flow (deploy_release_package.js), this script
# does NOT compile anything locally. It only:
#   1. Confirms the target branch is pushed to GitHub
#   2. SSH'es to deploy@$SSH_HOST to clone+build+release+activate remotely
#   3. SSH'es to ops@$SSH_HOST to restart systemd + run health gate
#
# Usage:
#   bash scripts/deployment/deploy_remote_build.sh main [branch]
#     target: main   (required; Sprint 37 后仅 main, lym/xz sandbox 已关停)
#     branch: git branch/tag/sha (default: current local branch)
#
# Required env:
#   SSH_HOST         production hostname or IP (never commit the real value)
#   DEPLOY_PASSWORD  password for deploy@$SSH_HOST:$SSH_PORT
#   OPS_PASSWORD     password for ops@$SSH_HOST:$SSH_PORT
#
# Optional env:
#   SKIP_HEALTH_GATE=true   skip the post-deploy health gate
#   SKIP_DB_BACKUP=true     skip db backup for target=main (default: backup)
#   GIT_REPO_URL            override repo URL (default: https://github.com/bruinxz/stocks.git)
#   RELEASE_RUN_SMOKE       run authenticated read-only smoke checks (default: true)
#   RELEASE_SMOKE_USERNAME  smoke account (default: stocks)
#   RELEASE_SMOKE_PASSWORD  required when RELEASE_RUN_SMOKE is enabled

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + env
# ---------------------------------------------------------------------------
TARGET="${1:-}"
BRANCH="${2:-}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 main [branch]" >&2
  echo "  (Sprint 37: lym/xz sandbox 已关停, 仅 main 可用)" >&2
  exit 1
fi

case "$TARGET" in
  main) ;;
  *) echo "Invalid target: $TARGET (lym/xz sandbox 已关停, 仅支持 main)" >&2; exit 1 ;;
esac

# Resolve branch from current local if not given
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git -C "$(dirname "$0")/../.." rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
fi
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  echo "Cannot infer branch from current repo; pass branch as 2nd arg" >&2
  exit 1
fi

DEPLOY_PASSWORD="${DEPLOY_PASSWORD:-}"
OPS_PASSWORD="${OPS_PASSWORD:-}"
SSH_HOST="${SSH_HOST:-${DEPLOY_HOST:-}}"
SSH_PORT="${SSH_PORT:-14126}"
[[ -z "$SSH_HOST" ]] && { echo "SSH_HOST (or DEPLOY_HOST) required" >&2; exit 1; }
[[ -z "$DEPLOY_PASSWORD" ]] && { echo "DEPLOY_PASSWORD required" >&2; exit 1; }
[[ -z "$OPS_PASSWORD" ]] && { echo "OPS_PASSWORD required" >&2; exit 1; }

GIT_REPO_URL="${GIT_REPO_URL:-https://github.com/bruinxz/stocks.git}"
RELEASE_RUN_SMOKE="${RELEASE_RUN_SMOKE:-true}"
RELEASE_SMOKE_USERNAME="${RELEASE_SMOKE_USERNAME:-stocks}"
RELEASE_SMOKE_PASSWORD="${RELEASE_SMOKE_PASSWORD:-}"

if [[ "${SKIP_HEALTH_GATE:-false}" != "true" ]]; then
  case "${RELEASE_RUN_SMOKE,,}" in
    0|false|no|n|off) ;;
    *)
      [[ -n "$RELEASE_SMOKE_PASSWORD" ]] || {
        echo "RELEASE_SMOKE_PASSWORD is required when RELEASE_RUN_SMOKE is enabled" >&2
        exit 1
      }
      ;;
  esac
fi

# Target → /opt/stocks + service name (Sprint 37: 仅 main)
case "$TARGET" in
  main) ROOT="/opt/stocks"; SERVICE="stocks-backend.service" ;;
esac

TS="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="$ROOT/releases/${TS}-${TARGET}"
SHARED="$ROOT/shared"
CURRENT="$ROOT/current"
WORK="/tmp/stocks_remote_build_${TARGET}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Remote-build deployment"
echo "  Target:   $TARGET ($ROOT)"
echo "  Branch:   $BRANCH"
echo "  Service:  $SERVICE"
echo "  Release:  $RELEASE_DIR"
echo "═══════════════════════════════════════════════════════════════"

# ---------------------------------------------------------------------------
# SSH wrappers
# ---------------------------------------------------------------------------
ssh_deploy() {
  SSHPASS="$DEPLOY_PASSWORD" sshpass -e ssh -p "$SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ServerAliveInterval=30 \
    "deploy@$SSH_HOST" "$@"
}

ssh_ops() {
  SSHPASS="$OPS_PASSWORD" sshpass -e ssh -p "$SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ServerAliveInterval=30 \
    "ops@$SSH_HOST" "$@"
}

# Confirm branch reachable on remote git (deploy account)
echo ""
echo "▶ [1/9] Confirm branch '$BRANCH' is reachable on GitHub from server..."
ssh_deploy "git ls-remote --heads '$GIT_REPO_URL' '$BRANCH' | grep -q '$BRANCH'" \
  || { echo "ERROR: branch '$BRANCH' not found on remote $GIT_REPO_URL" >&2; exit 1; }
echo "  ✓ branch reachable"

# ---------------------------------------------------------------------------
# DB backup before main (US-071's backup-db.sh)
# ---------------------------------------------------------------------------
if [[ "$TARGET" == "main" && "${SKIP_DB_BACKUP:-false}" != "true" ]]; then
  echo ""
  echo "▶ [2/9] Backing up production DB before main deploy..."
  ssh_ops "bash -c '
    set -e
    BACKUP_DIR=/var/backups/stocks
    sudo mkdir -p \$BACKUP_DIR
    sudo chown ops:ops \$BACKUP_DIR
    OUT=\$BACKUP_DIR/predeploy-\$(date +%Y%m%d%H%M%S).sql.gz
    echo \"backing up to \$OUT...\"
    if [ -x $CURRENT/scripts/backup-db.sh ]; then
      bash $CURRENT/scripts/backup-db.sh
    else
      echo \"  (no backup-db.sh in current release; doing inline pg_dump)\"
      docker exec stocks-postgres pg_dump -U postgres stock_backtest | gzip > \$OUT
    fi
    ls -lh \$BACKUP_DIR | tail -3
  '" || { echo "ERROR: DB backup failed; aborting deploy" >&2; exit 1; }
  echo "  ✓ DB backed up"
else
  echo ""
  echo "▶ [2/9] Skipping DB backup (target=$TARGET or SKIP_DB_BACKUP=true)"
fi

# ---------------------------------------------------------------------------
# Remote clone + build + release
# ---------------------------------------------------------------------------
echo ""
echo "▶ [3/9] Remote clone + checkout..."
ssh_deploy "bash -s" <<EOF
set -euo pipefail
WORK='$WORK'
BRANCH='$BRANCH'
REPO='$GIT_REPO_URL'

# Reuse the dir across deploys; fetch+checkout instead of re-clone
if [ -d "\$WORK/.git" ]; then
  cd "\$WORK"
  git fetch --depth=1 origin "\$BRANCH"
  git reset --hard FETCH_HEAD
else
  rm -rf "\$WORK"
  git clone --depth=1 --branch "\$BRANCH" "\$REPO" "\$WORK"
fi
cd "\$WORK"
echo "  HEAD: \$(git rev-parse --short HEAD) \$(git log -1 --pretty='%s' | head -c 60)"
EOF

echo ""
echo "▶ [4/9] Remote install + build..."
ssh_deploy "bash -s" <<EOF
set -euo pipefail
WORK='$WORK'
cd "\$WORK"

# The 09:00 global-market job parses JPX's official PDF. Install its small
# dependency into the shared backend interpreter so it survives release
# rotation and is available to the stocks_app service user.
GLOBAL_MARKET_REQUIREMENTS="\$WORK/scripts/ops/requirements-global-markets.txt"
PYTHON_RUNTIME=\$(grep '^PYTHON_PATH=' '$SHARED/backend.env' 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')
if [ -f "\$GLOBAL_MARKET_REQUIREMENTS" ]; then
  if [ -z "\$PYTHON_RUNTIME" ] || [ ! -x "\$PYTHON_RUNTIME" ]; then
    echo "ERROR: configured PYTHON_PATH is required for global-market dependencies" >&2
    exit 1
  fi
  echo "▶ pip install (global-market runtime)..."
  "\$PYTHON_RUNTIME" -m pip install --disable-pip-version-check --no-input \
    -r "\$GLOBAL_MARKET_REQUIREMENTS" 2>&1 | tail -10
fi

# TradingAgents is a first-class local runtime. Keep its Python environment in
# shared/ so release rotation only replaces source, not the dependency layer.
AI_REQUIREMENTS="\$WORK/ai/tradingagents-app/requirements.txt"
AI_VENV="$SHARED/tradingagents-venv"
if [ ! -x "\$AI_VENV/bin/python" ]; then
  echo "▶ create TradingAgents venv..."
  python3 -m venv "\$AI_VENV"
fi
echo "▶ pip install (TradingAgents runtime)..."
"\$AI_VENV/bin/python" -m pip install --disable-pip-version-check --no-input \
  -r "\$AI_REQUIREMENTS" 2>&1 | tail -20
mkdir -p "$SHARED/tradingagents/results" "$SHARED/tradingagents/storage" "$SHARED/tradingagents/data-cache"

# Reuse old node_modules if exists (huge time saver)
OLD_BACKEND_NM='$CURRENT/backend/node_modules'
OLD_FRONTEND_NM='$CURRENT/frontend/node_modules'
if [ -d "\$OLD_BACKEND_NM" ] && [ ! -e "\$WORK/backend/node_modules" ]; then
  echo "  reusing backend/node_modules from current release"
  cp -a "\$OLD_BACKEND_NM" "\$WORK/backend/node_modules"
fi
if [ -d "\$OLD_FRONTEND_NM" ] && [ ! -e "\$WORK/frontend/node_modules" ]; then
  echo "  reusing frontend/node_modules from current release"
  cp -a "\$OLD_FRONTEND_NM" "\$WORK/frontend/node_modules"
fi

# Reconcile with package-lock.json (fast if unchanged, installs new deps if added)
cd "\$WORK/backend"
echo "▶ npm install (backend)..."
npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -10
echo "▶ tsc build (backend)..."
./node_modules/.bin/tsc -p tsconfig.json --pretty false 2>&1 | tail -20

cd "\$WORK/frontend"
echo "▶ npm install (frontend)..."
npm install --no-audit --no-fund --prefer-offline --legacy-peer-deps 2>&1 | tail -10
if [ "${SKIP_FRONTEND_BUILD:-false}" = "true" ]; then
  echo "▶ react-scripts build (frontend) — SKIPPED (SKIP_FRONTEND_BUILD=true)"
else
  echo "▶ react-scripts build (frontend)..."
  CI=false NODE_OPTIONS=--max-old-space-size=4096 ./node_modules/.bin/react-scripts build 2>&1 | tail -20
fi
EOF

echo ""
echo "▶ [5/9] Create release dir + activate symlink..."
ssh_deploy "bash -s" <<EOF
set -euo pipefail
WORK='$WORK'
REL='$RELEASE_DIR'
SHARED='$SHARED'
CURRENT='$CURRENT'
ROOT='$ROOT'
TARGET='$TARGET'

mkdir -p "\$REL"

# Move build artifacts + source into release (rsync excludes node_modules)
rsync -a --delete \\
  --exclude='.git' \\
  --exclude='backend/node_modules' \\
  --exclude='frontend/node_modules' \\
  --exclude='backend/logs' \\
  --exclude='backend/uploads' \\
  --exclude='.artifacts' \\
  "\$WORK/" "\$REL/"

# Copy node_modules into release dir (NOT symlink — systemd PrivateTmp=true
# isolates /tmp from the service user, so symlinks pointing into /tmp/stocks_remote_build_*
# become invisible to the running process and dotenv/etc fail to load).
if [ -d "\$WORK/backend/node_modules" ]; then
  cp -a "\$WORK/backend/node_modules" "\$REL/backend/node_modules"
fi
if [ -d "\$WORK/frontend/node_modules" ]; then
  cp -a "\$WORK/frontend/node_modules" "\$REL/frontend/node_modules"
fi

# Wire in shared env files
if [ -f "\$SHARED/backend.env" ]; then
  cp "\$SHARED/backend.env" "\$REL/backend/.env"
fi
if [ -f "\$SHARED/frontend.env.production" ]; then
  cp "\$SHARED/frontend.env.production" "\$REL/frontend/.env.production"
fi

# Keep symlink for log/upload dirs (shared across releases)
if [ -d "\$SHARED/logs" ]; then
  rm -rf "\$REL/backend/logs"
  ln -sfn "\$SHARED/logs" "\$REL/backend/logs"
fi
if [ -d "\$SHARED/uploads" ]; then
  rm -rf "\$REL/backend/uploads"
  ln -sfn "\$SHARED/uploads" "\$REL/backend/uploads"
fi

# Activate
ln -sfn "\$REL" "\$CURRENT"
echo "  → \$(readlink -f \$CURRENT)"

# Cleanup old releases (keep last 3 with node_modules — anything older only keeps source)
# Without this, each deploy adds ~1.3GB and the 58GB disk fills up fast.
RELEASES_DIR="\$ROOT/releases"
KEEP_COUNT=3
echo "  cleaning old releases (keeping latest \$KEEP_COUNT)..."
ls -1dt "\$RELEASES_DIR"/*-\$TARGET 2>/dev/null | tail -n +\$((KEEP_COUNT + 1)) | while read old; do
  if [ -d "\$old" ] && [ "\$old" != "\$(readlink -f \$CURRENT)" ]; then
    # Just strip node_modules from old releases — keep code for rollback debug
    if [ -d "\$old/backend/node_modules" ] || [ -d "\$old/frontend/node_modules" ]; then
      du -sh "\$old" 2>/dev/null | awk '{print "    pruning node_modules: "\$2" ("\$1")"}'
      rm -rf "\$old/backend/node_modules" "\$old/frontend/node_modules"
    fi
  fi
done
EOF

# ---------------------------------------------------------------------------
# Required auth migration (idempotent marker/shape probe; before restart)
# ---------------------------------------------------------------------------
echo ""
echo "▶ [6/9] Apply and verify auth refresh-session migration..."
ssh_deploy "bash -s" <<EOF
set -euo pipefail
CURRENT='$CURRENT'
cd "\$CURRENT/backend"
test -f .env
APPLY_AUTH_REFRESH_SESSION_MIGRATION=1 NODE_ENV=production \
  node dist/scripts/apply-auth-refresh-session-migration.js
EOF

echo "▶ [6/9] Deduplicate realtime quotes and enforce their natural key..."
ssh_deploy "bash -s" <<EOF
set -euo pipefail
CURRENT='$CURRENT'
cd "\$CURRENT/backend"
test -f .env
APPLY_REALTIME_QUOTE_DEDUP_MIGRATION=1 NODE_ENV=production \
  node dist/scripts/apply-realtime-quote-dedup-migration.js
EOF

# ---------------------------------------------------------------------------
# Restart systemd
# ---------------------------------------------------------------------------
echo ""
echo "▶ [7/9] Install/restart local TradingAgents and $SERVICE (sudo via ops)..."
ssh_ops "echo '$OPS_PASSWORD' | sudo -S install -m 0644 '$CURRENT/scripts/deployment/samples/stocks-tradingagents.service' /etc/systemd/system/stocks-tradingagents.service && echo '$OPS_PASSWORD' | sudo -S chown -R stocks_app:stocks '$SHARED/tradingagents' && echo '$OPS_PASSWORD' | sudo -S systemctl daemon-reload && echo '$OPS_PASSWORD' | sudo -S systemctl enable stocks-tradingagents.service && echo '$OPS_PASSWORD' | sudo -S systemctl restart stocks-tradingagents.service && echo '$OPS_PASSWORD' | sudo -S systemctl restart $SERVICE" 2>&1 | tail -10
sleep 3
if ! ssh_ops "echo '$OPS_PASSWORD' | sudo -S systemctl is-active stocks-tradingagents.service $SERVICE"; then
  if [[ "${SKIP_HEALTH_GATE:-false}" == "true" ]]; then
    echo "ERROR: service failed to start and health gate is disabled" >&2
    exit 1
  fi
  echo "WARN: service is not active yet; release health gate will diagnose and roll back if needed" >&2
fi

# ---------------------------------------------------------------------------
# Sync Sequelize schema (creates missing tables for new models)
# Disabled by default; enable with SYNC_SCHEMA=true (typically when deploying
# a release that introduces new models).
# ---------------------------------------------------------------------------
if [[ "${SYNC_SCHEMA:-false}" == "true" ]]; then
  echo ""
  echo "▶ [8/9] Sync Sequelize schema (creating any missing tables)..."
  ssh_deploy "bash -s" <<EOF
set -euo pipefail
CURRENT='$CURRENT'

cat > /tmp/sync-schema-${TARGET}.js <<'NODEEOF'
require('dotenv').config({ path: process.env.STOCKS_BACKEND_ENV });
const path = require('path');
const cwd = process.env.STOCKS_BACKEND_CWD;
process.chdir(cwd);
require(path.join(cwd, 'dist/models/index.js'));
const { sequelize } = require(path.join(cwd, 'dist/config/database.js'));
(async () => {
  try {
    await sequelize.authenticate();
    console.log('▶ Running sequelize.sync({alter:true})...');
    await sequelize.sync({ alter: true });
    console.log('✅ Schema sync complete');
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Schema sync failed:', err.message);
    process.exit(1);
  }
})();
NODEEOF

NODE_PATH=\$CURRENT/backend/node_modules \\
STOCKS_BACKEND_ENV=\$CURRENT/backend/.env \\
STOCKS_BACKEND_CWD=\$CURRENT/backend \\
/usr/bin/node /tmp/sync-schema-${TARGET}.js 2>&1 | tail -30
EOF
else
  echo ""
  echo "▶ [8/9] Skipping schema sync (set SYNC_SCHEMA=true to enable)"
fi

# ---------------------------------------------------------------------------
# Health gate
# ---------------------------------------------------------------------------
if [[ "${SKIP_HEALTH_GATE:-false}" != "true" ]]; then
  echo ""
  echo "▶ [9/9] Run health gate..."
  printf -v RELEASE_RUN_SMOKE_Q '%q' "$RELEASE_RUN_SMOKE"
  printf -v RELEASE_SMOKE_USERNAME_Q '%q' "$RELEASE_SMOKE_USERNAME"
  printf -v RELEASE_SMOKE_PASSWORD_Q '%q' "$RELEASE_SMOKE_PASSWORD"
  # The gate restarts services and may roll back the current symlink, so it
  # must run through the privileged ops channel. Feeding sudo on stdin keeps
  # OPS_PASSWORD out of the remote command line and logs.
  printf '%s\n' "$OPS_PASSWORD" | ssh_ops "sudo -S env \
    RELEASE_RUN_SMOKE=$RELEASE_RUN_SMOKE_Q \
    RELEASE_SMOKE_USERNAME=$RELEASE_SMOKE_USERNAME_Q \
    RELEASE_SMOKE_PASSWORD=$RELEASE_SMOKE_PASSWORD_Q \
    bash -lc '
    if [ -f $CURRENT/scripts/deployment/release_health_gate.js ]; then
      cd $CURRENT && node scripts/deployment/release_health_gate.js 2>&1 | tail -30
    else
      echo '  no health gate script; doing minimal health check'
      case '$TARGET' in
        main) PORT=3000 ;;
      esac
      curl -fsS http://127.0.0.1:\$PORT/health
    fi
  '"
else
  echo ""
  echo "▶ [9/9] Skipped health gate (SKIP_HEALTH_GATE=true)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Deployment to $TARGET complete"
echo "  Release: $RELEASE_DIR"
case "$TARGET" in
  main) echo "  → http://$SSH_HOST:3001/" ;;
esac
echo "═══════════════════════════════════════════════════════════════"
