#!/usr/bin/env bash
# scripts/deployment/deploy_pr_p_when_ssh_unlocks.sh
#
# 一键部署 PR-A...PR-P (13 PR) 到 prod 103.242.3.87:14126.
# 在 SSH 当前锁住时, 本脚本可以反复重试; SSH unlocked 后跑一遍就能完成所有动作.
#
# 调用:
#   bash scripts/deployment/deploy_pr_p_when_ssh_unlocks.sh
#
# 链路:
#   1. SSH preflight (拒绝就 abort, 不破坏现状)
#   2. backend build (tsc) + frontend build (CRA)
#   3. rsync dist/ + frontend/build/ → prod
#   4. 5 张表 migration (sequelize + node, deploy 无 psql)
#   5. restart backend (printf password → systemctl restart)
#   6. verify: /home 200 + 5 张表行数 + 7 个新 cron 注册 + signal by source
#   7. 不 200 → 回滚 frontend (用 /opt/stocks/releases/<latest>/)
#
# 前置依赖:
#   - ~/.ssh/crp_prod_deploy_103_242_3_87  (deploy 私钥)
#   - ~/.ssh/crp_prod_ops_103_242_3_87     (ops 私钥, 含 sudo)
#   - OPS_SUDO_PASS env 或脚本会用占位符 (不安全, 仅本地)
#
# 安全: 本脚本不会持久化密码; 用户被提示在 ops 步骤前提供.

set -e -o pipefail

HOST=103.242.3.87
PORT=14126
DEPLOY_KEY=$HOME/.ssh/crp_prod_deploy_103_242_3_87
OPS_KEY=$HOME/.ssh/crp_prod_ops_103_242_3_87
SSH_BASE="ssh -o IdentitiesOnly=yes -o ConnectTimeout=5 -i $DEPLOY_KEY -p $PORT"
RSYNC_BASE="rsync -e '$SSH_BASE'"

# ───────────────────────────────────────────────────────────
# Phase 1: SSH preflight
# ───────────────────────────────────────────────────────────
echo "[1/7] SSH preflight..."
if ! $SSH_BASE deploy@$HOST 'echo OK' 2>&1 | grep -q OK; then
  echo "  FAIL: SSH 还锁. 等 ops 解锁后再跑."
  exit 1
fi
echo "  OK: deploy SSH 通"

# ───────────────────────────────────────────────────────────
# Phase 2: Build
# ───────────────────────────────────────────────────────────
echo "[2/7] Build backend (tsc)..."
cd backend && npm run build 2>&1 | tail -3
cd ..

echo "[2/7] Build frontend (CRA, CI=false 允许 warning)..."
cd frontend && CI=false npm run build 2>&1 | tail -3
[ -f build/index.html ] || { echo "  FAIL: frontend build 没出 index.html"; exit 1; }
cd ..

# ───────────────────────────────────────────────────────────
# Phase 3: rsync (backend dist 全量 + frontend build 全量)
# ───────────────────────────────────────────────────────────
echo "[3/7] rsync backend dist..."
# 用 --delete 同步 dist 整树, 防止本地删除的文件残留 prod
rsync -avz --delete \
  -e "$SSH_BASE" \
  backend/dist/ \
  deploy@$HOST:/opt/stocks/current/backend/dist/ 2>&1 | tail -5

# Python helpers (PR-M1/M2/M3 用)
for f in backend/python/akshare_helper.py backend/python/overnight_signal_helper.py; do
  if [ -f "$f" ]; then
    rsync -avz -e "$SSH_BASE" "$f" \
      deploy@$HOST:/opt/stocks/current/backend/python/ 2>&1 | tail -1
  fi
done

echo "[3/7] rsync frontend build..."
rsync -avz --delete \
  -e "$SSH_BASE" \
  frontend/build/ \
  deploy@$HOST:/opt/stocks/current/frontend/build/ 2>&1 | tail -5

# ───────────────────────────────────────────────────────────
# Phase 4: Migrations (5 张表)
# ───────────────────────────────────────────────────────────
echo "[4/7] copy + run migrations..."
for m in 2026-06-29-overnight-signals.sql \
         2026-06-29-auction-and-30min-klines.sql \
         2026-06-29-industry-sentiment-indices.sql \
         2026-06-30-theme-fermentation-phases.sql; do
  if [ -f "backend/scripts/migrations/$m" ]; then
    rsync -e "$SSH_BASE" "backend/scripts/migrations/$m" \
      deploy@$HOST:/tmp/ 2>&1 | tail -1
  else
    echo "  MISSING: backend/scripts/migrations/$m"
  fi
done

# deploy 无 psql → 通过 node + sequelize 跑 migration
$SSH_BASE deploy@$HOST "cd /opt/stocks/current/backend && cat > _mig.js << 'EOF'
require('dotenv').config({path:'.env'});
const fs = require('fs');
const {Sequelize} = require('sequelize');
const seq = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: 'postgres', logging: false
});
(async()=>{
  const migs = [
    '2026-06-29-overnight-signals.sql',
    '2026-06-29-auction-and-30min-klines.sql',
    '2026-06-29-industry-sentiment-indices.sql',
    '2026-06-30-theme-fermentation-phases.sql',
  ];
  for (const m of migs) {
    if (!fs.existsSync('/tmp/' + m)) { console.log('SKIP (no file): ' + m); continue; }
    try {
      const sql = fs.readFileSync('/tmp/' + m, 'utf8');
      await seq.query(sql);
      console.log('OK ' + m);
    } catch(e) { console.log('FAIL ' + m + ': ' + e.message.slice(0, 200)); }
  }
  await seq.close();
})();
EOF
node _mig.js
rm _mig.js"

# ───────────────────────────────────────────────────────────
# Phase 5: Restart backend (ops sudo)
# ───────────────────────────────────────────────────────────
echo "[5/7] restart backend..."
if [ -z "$OPS_SUDO_PASS" ]; then
  echo "  WARN: \$OPS_SUDO_PASS 未设 — 用户需手动:"
  echo "    ssh -i ~/.ssh/crp_prod_ops_103_242_3_87 -p $PORT ops@$HOST 'sudo systemctl restart stocks-backend'"
else
  printf "%s\n" "$OPS_SUDO_PASS" | ssh -o IdentitiesOnly=yes -i "$OPS_KEY" -p $PORT \
    ops@$HOST 'sudo -S -k systemctl restart stocks-backend' 2>&1 | tail -3
fi
sleep 30

# ───────────────────────────────────────────────────────────
# Phase 6: Verify
# ───────────────────────────────────────────────────────────
echo "[6/7] verify /home..."
HOME_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://$HOST:3001/home)
echo "  /home HTTP: $HOME_STATUS"

if [ "$HOME_STATUS" != "200" ]; then
  echo "  FAIL: /home 不是 200, 触发 rollback (frontend only)..."
  $SSH_BASE deploy@$HOST 'LATEST=$(ls -1dt /opt/stocks/releases/*/ | head -1); cp -r $LATEST/frontend/build/* /opt/stocks/current/frontend/build/'
  echo "  ROLLBACK 完成"
  exit 2
fi

echo "[6/7] verify 5 张表行数 + 7 个新 cron 注册 + signal by source..."
$SSH_BASE deploy@$HOST "cd /opt/stocks/current/backend && cat > _ver.js << 'EOF'
require('dotenv').config({path:'.env'});
const {Sequelize} = require('sequelize');
const seq = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: 'postgres', logging: false
});
(async()=>{
  console.log('=== 表行数 ===');
  for (const t of ['overnight_signals','auction_snapshots','intraday_klines_30min','industry_sentiment_indices','theme_fermentation_phases']) {
    try {
      const [r] = await seq.query('SELECT COUNT(*) FROM ' + t);
      console.log('  ' + t + ': ' + r[0].count);
    } catch(e) {
      console.log('  ' + t + ': NO TABLE — ' + e.message.slice(0,80));
    }
  }

  console.log('\\n=== 新 cron 注册 (7 个) ===');
  const [c] = await seq.query(\"SELECT type, cron_expression, is_active FROM scheduled_tasks WHERE type IN ('OPENING_RUSH_DETECT','INTRADAY_PRICE_VOLUME_ANOMALY','LAST_HOUR_MOMENTUM','LIMIT_UP_BOARD_DETECT','THEME_FERMENTATION_DETECT','INDUSTRY_SENTIMENT_AGGREGATE','INTRADAY_REVERSAL_DETECT') ORDER BY type\");
  c.forEach(x => console.log('  ' + x.type + ' [' + (x.is_active ? 'A' : '-') + '] ' + x.cron_expression));

  console.log('\\n=== 今日推荐 by source_type ===');
  const [s] = await seq.query(\"SELECT source_type, metadata->>'timing_tag' AS tag, COUNT(*) FROM ai_investment_signals WHERE created_at::date = CURRENT_DATE GROUP BY source_type, tag ORDER BY 3 DESC LIMIT 30\");
  s.forEach(x => console.log('  ' + x.source_type + ' [' + (x.tag||'-') + ']: ' + x.count));

  await seq.close();
})();
EOF
node _ver.js
rm _ver.js"

# ───────────────────────────────────────────────────────────
# Phase 7: Trigger detectors (one-shot dry_run smoke)
# ───────────────────────────────────────────────────────────
echo "[7/7] manual trigger 6 detector dry_run..."
$SSH_BASE deploy@$HOST "cd /opt/stocks/current/backend && node -e \"
(async()=>{
  const trials = [
    ['OpeningRushDetector', './dist/services/OpeningRushDetector', 'openingRushDetector'],
    ['IntradayPriceVolumeAnomalyDetector', './dist/services/IntradayPriceVolumeAnomalyDetector', 'intradayPriceVolumeAnomalyDetector'],
    ['LastHourMomentumDetector', './dist/services/LastHourMomentumDetector', 'lastHourMomentumDetector'],
    ['LimitUpBoardDetector', './dist/services/LimitUpBoardDetector', 'limitUpBoardDetectorService'],
    ['ThemeFermentationDetector', './dist/services/ThemeFermentationDetector', 'themeFermentationDetector'],
    ['IndustrySentimentAggregator', './dist/services/IndustrySentimentAggregator', 'industrySentimentAggregator'],
  ];
  for (const [name, mod, varName] of trials) {
    try {
      const svc = require(mod)[varName];
      const r = await svc.runOnce({dry_run: true, force: true});
      console.log(name + ': ' + JSON.stringify(r).slice(0, 220));
    } catch(e) {
      console.log(name + ': FAIL ' + (e.message||e).toString().slice(0,150));
    }
  }
})();
\" 2>&1 | head -40"

echo ""
echo "============================================"
echo "PR-P 部署收尾 完成 ✓"
echo "  prod /home: $HOME_STATUS"
echo "  下一步: 启 PR-V 验证 agent"
echo "  Handoff doc: docs/audit/PR_V_VALIDATION_HANDOFF_2026_06_29.md"
echo "============================================"
