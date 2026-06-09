#!/usr/bin/env bash
# Remote-build deployment for stocks-{lym,main,xz}.
#
# Unlike the legacy local-build flow (deploy_release_package.js), this script
# does NOT compile anything locally. It only:
#   1. Confirms the target branch is pushed to GitHub
#   2. SSH'es to deploy@103.242.3.87 to clone+build+release+activate remotely
#   3. SSH'es to ops@103.242.3.87 to restart systemd + run health gate
#
# Usage:
#   bash scripts/deployment/deploy_remote_build.sh <target> [branch]
#     target: lym | main | xz   (required)
#     branch: git branch/tag/sha (default: current local branch)
#
# Required env:
#   DEPLOY_PASSWORD  password for deploy@103.242.3.87:14126
#   OPS_PASSWORD     password for ops@103.242.3.87:14126
#
# Optional env:
#   SKIP_HEALTH_GATE=true   skip the post-deploy health gate
#   SKIP_DB_BACKUP=true     skip db backup for target=main (default: backup)
#   GIT_REPO_URL            override repo URL (default: https://github.com/bruinxz/stocks.git)

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + env
# ---------------------------------------------------------------------------
TARGET="${1:-}"
BRANCH="${2:-}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <lym|main|xz> [branch]" >&2
  exit 1
fi

case "$TARGET" in
  lym|main|xz) ;;
  *) echo "Invalid target: $TARGET (must be lym|main|xz)" >&2; exit 1 ;;
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
[[ -z "$DEPLOY_PASSWORD" ]] && { echo "DEPLOY_PASSWORD required" >&2; exit 1; }
[[ -z "$OPS_PASSWORD" ]] && { echo "OPS_PASSWORD required" >&2; exit 1; }

SSH_HOST="103.242.3.87"
SSH_PORT="14126"
GIT_REPO_URL="${GIT_REPO_URL:-https://github.com/bruinxz/stocks.git}"

# Target → /opt/stocks{,-lym,-xz} + service name
case "$TARGET" in
  main) ROOT="/opt/stocks"; SERVICE="stocks-backend.service" ;;
  lym)  ROOT="/opt/stocks-lym"; SERVICE="stocks-backend-lym.service" ;;
  xz)   ROOT="/opt/stocks-xz";  SERVICE="stocks-backend-xz.service"  ;;
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
echo "▶ [1/8] Confirm branch '$BRANCH' is reachable on GitHub from server..."
ssh_deploy "git ls-remote --heads '$GIT_REPO_URL' '$BRANCH' | grep -q '$BRANCH'" \
  || { echo "ERROR: branch '$BRANCH' not found on remote $GIT_REPO_URL" >&2; exit 1; }
echo "  ✓ branch reachable"

# ---------------------------------------------------------------------------
# DB backup before main (US-071's backup-db.sh)
# ---------------------------------------------------------------------------
if [[ "$TARGET" == "main" && "${SKIP_DB_BACKUP:-false}" != "true" ]]; then
  echo ""
  echo "▶ [2/8] Backing up production DB before main deploy..."
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
      docker exec stocks_postgres pg_dump -U postgres stock_backtest | gzip > \$OUT
    fi
    ls -lh \$BACKUP_DIR | tail -3
  '" || { echo "ERROR: DB backup failed; aborting deploy" >&2; exit 1; }
  echo "  ✓ DB backed up"
else
  echo ""
  echo "▶ [2/8] Skipping DB backup (target=$TARGET or SKIP_DB_BACKUP=true)"
fi

# ---------------------------------------------------------------------------
# Remote clone + build + release
# ---------------------------------------------------------------------------
echo ""
echo "▶ [3/8] Remote clone + checkout..."
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
echo "▶ [4/8] Remote install + build..."
ssh_deploy "bash -s" <<EOF
set -euo pipefail
WORK='$WORK'
cd "\$WORK"

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
echo "▶ react-scripts build (frontend)..."
CI=false NODE_OPTIONS=--max-old-space-size=4096 ./node_modules/.bin/react-scripts build 2>&1 | tail -20
EOF

echo ""
echo "▶ [5/8] Create release dir + activate symlink..."
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
# Restart systemd
# ---------------------------------------------------------------------------
echo ""
echo "▶ [6/8] Restart $SERVICE (sudo via ops)..."
ssh_ops "echo '$OPS_PASSWORD' | sudo -S systemctl restart $SERVICE" 2>&1 | tail -5
sleep 3
ssh_ops "echo '$OPS_PASSWORD' | sudo -S systemctl is-active $SERVICE" || \
  { echo "ERROR: service failed to start" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Sync Sequelize schema (creates missing tables for new models)
# Disabled by default; enable with SYNC_SCHEMA=true (typically when deploying
# a release that introduces new models).
# ---------------------------------------------------------------------------
if [[ "${SYNC_SCHEMA:-false}" == "true" ]]; then
  echo ""
  echo "▶ [7/8] Sync Sequelize schema (creating any missing tables)..."
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
  echo "▶ [7/8] Skipping schema sync (set SYNC_SCHEMA=true to enable)"
fi

# ---------------------------------------------------------------------------
# Health gate
# ---------------------------------------------------------------------------
if [[ "${SKIP_HEALTH_GATE:-false}" != "true" ]]; then
  echo ""
  echo "▶ [8/8] Run health gate..."
  ssh_deploy "
    if [ -f $CURRENT/scripts/deployment/release_health_gate.js ]; then
      cd $CURRENT && node scripts/deployment/release_health_gate.js 2>&1 | tail -30
    else
      echo '  no health gate script; doing minimal health check'
      case '$TARGET' in
        main) PORT=3000 ;;
        lym)  PORT=3010 ;;
        xz)   PORT=3020 ;;
      esac
      curl -fsS http://127.0.0.1:\$PORT/health
    fi
  "
else
  echo ""
  echo "▶ [8/8] Skipped health gate (SKIP_HEALTH_GATE=true)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Deployment to $TARGET complete"
echo "  Release: $RELEASE_DIR"
case "$TARGET" in
  main) echo "  → http://$SSH_HOST:3001/" ;;
  lym)  echo "  → http://$SSH_HOST:3011/" ;;
  xz)   echo "  → http://$SSH_HOST:3021/" ;;
esac
echo "═══════════════════════════════════════════════════════════════"
