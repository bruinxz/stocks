#!/usr/bin/env bash
#
# scripts/ops/backup-pull.sh — 本地拉取 stocks prod 备份 (只拉最近 3 天).
#
# 设计 (跟 crp backup-pull 同模式, 错开 5 min cron 避免抢香港带宽):
#   - 服务端 /backup/stocks/ 保留最近 7 天 (rotate by pg_backup_daily.sh / redis_backup_daily.sh)
#   - 本地保留最近 3 天 (KEEP_DAYS=3)
#   - 每月 1 号本地额外保留一份永久归档 (~/Backups/stocks-prod-monthly/)
#
# 用法:
#   crontab -e
#   12 4 * * * /Users/bytedance/go/src/github.com/bruinxz/stocks/scripts/ops/backup-pull.sh >> ~/Backups/stocks-prod/.pull.log 2>&1
#
# 本地结构:
#   ~/Backups/stocks-prod/
#     postgres/  daily_*.dump + .sha256
#     redis/     redis_*.tgz + .sha256
#     secrets/   backend.env.*.bak
#   ~/Backups/stocks-prod-monthly/<YYYY-MM>/  月初快照
#
set -euo pipefail

LOCAL_ROOT="${HOME}/Backups/stocks-prod"
LOCAL_PG="${LOCAL_ROOT}/postgres"
LOCAL_REDIS="${LOCAL_ROOT}/redis"
LOCAL_SECRETS="${LOCAL_ROOT}/secrets"
LOCAL_MONTHLY="${HOME}/Backups/stocks-prod-monthly"
REMOTE_HOST="ops@<legacy-prod-host>"
REMOTE_PORT=14126
SSH_KEY="${HOME}/.ssh/crp_prod_ops_103_242_3_87"  # 同一台服务器, 同一个 ops key
KEEP_DAYS=3

# 香港服务器持续传输会被 QoS 限速到 ~30 KB/s, 加 KeepAlive 防卡死
SSH_OPTS=(-i "${SSH_KEY}" -p "${REMOTE_PORT}" -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes)

log() { echo "[$(date -Iseconds)] $*"; }

# Sprint 39: track 拉取失败计数, 最后 fail-fast — 之前每个 rsync 失败仅 WARN 后
# 继续, 导致备份静默缺文件. 现在任何文件拉取失败都计入 PULL_FAILED,
# 脚本最末若 PULL_FAILED > 0 则 exit 1, 让 cron 失败明显可见 (邮件 / 监控可触发).
PULL_FAILED=0
pull_or_fail() {
  local remote_path="$1" local_dir="$2" fname="$3"
  if rsync -avz --partial -e "ssh ${SSH_OPTS[*]}" \
      "${REMOTE_HOST}:${remote_path}" "${local_dir}/"; then
    return 0
  else
    log "  ERROR: pull ${fname} failed (will exit non-zero at end)"
    PULL_FAILED=$((PULL_FAILED + 1))
    return 1
  fi
}

log "=== stocks backup-pull START (keep ${KEEP_DAYS} days local) ==="

if [[ ! -f "${SSH_KEY}" ]]; then
  log "ERROR: SSH key ${SSH_KEY} not found"
  exit 1
fi

mkdir -p "${LOCAL_PG}" "${LOCAL_REDIS}" "${LOCAL_SECRETS}"

# 1. 查询服务端最近 N 天的文件名
log "[1/5] query remote recent ${KEEP_DAYS} days"
REMOTE_PG=$(ssh "${SSH_OPTS[@]}" "${REMOTE_HOST}" \
  "find /backup/stocks/postgres/ -name '*.dump' -mtime -${KEEP_DAYS} ! -name 'latest.dump' -printf '%f\n' | sort | tail -${KEEP_DAYS}" 2>/dev/null || true)
REMOTE_PG_SHA=$(ssh "${SSH_OPTS[@]}" "${REMOTE_HOST}" \
  "find /backup/stocks/postgres/ -name '*.dump.sha256' -mtime -${KEEP_DAYS} ! -name 'latest.*' -printf '%f\n' | sort | tail -${KEEP_DAYS}" 2>/dev/null || true)
REMOTE_REDIS=$(ssh "${SSH_OPTS[@]}" "${REMOTE_HOST}" \
  "find /backup/stocks/redis/ -name 'redis_*.tgz' -mtime -${KEEP_DAYS} -printf '%f\n' | sort | tail -${KEEP_DAYS}" 2>/dev/null || true)
REMOTE_REDIS_SHA=$(ssh "${SSH_OPTS[@]}" "${REMOTE_HOST}" \
  "find /backup/stocks/redis/ -name 'redis_*.tgz.sha256' -mtime -${KEEP_DAYS} -printf '%f\n' | sort | tail -${KEEP_DAYS}" 2>/dev/null || true)
REMOTE_ENV=$(ssh "${SSH_OPTS[@]}" "${REMOTE_HOST}" \
  "find /backup/stocks/secrets/ -name 'backend.env.*.bak' -mtime -${KEEP_DAYS} -printf '%f\n' | sort | tail -${KEEP_DAYS}" 2>/dev/null || true)

log "  pg dumps: $(echo "${REMOTE_PG}" | wc -w | tr -d ' '), redis: $(echo "${REMOTE_REDIS}" | wc -w | tr -d ' '), env: $(echo "${REMOTE_ENV}" | wc -w | tr -d ' ')"

# 2. 拉 PG dump + sha
log "[2/5] pull postgres dumps"
for f in ${REMOTE_PG} ${REMOTE_PG_SHA}; do
  if [[ -f "${LOCAL_PG}/${f}" ]]; then
    continue
  fi
  log "  PULL ${f}"
  pull_or_fail "/backup/stocks/postgres/${f}" "${LOCAL_PG}" "${f}" || true
done

# 3. 拉 redis snapshot + sha
log "[3/5] pull redis snapshots"
for f in ${REMOTE_REDIS} ${REMOTE_REDIS_SHA}; do
  if [[ -f "${LOCAL_REDIS}/${f}" ]]; then
    continue
  fi
  log "  PULL ${f}"
  pull_or_fail "/backup/stocks/redis/${f}" "${LOCAL_REDIS}" "${f}" || true
done

# 4. 拉 backend.env 备份
log "[4/5] pull env backups"
for f in ${REMOTE_ENV}; do
  if [[ -f "${LOCAL_SECRETS}/${f}" ]]; then
    continue
  fi
  log "  PULL ${f}"
  pull_or_fail "/backup/stocks/secrets/${f}" "${LOCAL_SECRETS}" "${f}" || true
done

# 5. 本地清理 KEEP_DAYS 之前的 + 月度归档
log "[5/5] prune local > ${KEEP_DAYS} days"
DEL_PG=$(find "${LOCAL_PG}" -type f \( -name '*.dump' -o -name '*.dump.sha256' \) -mtime +${KEEP_DAYS} -print -delete | wc -l | tr -d ' ')
DEL_REDIS=$(find "${LOCAL_REDIS}" -type f \( -name 'redis_*.tgz' -o -name 'redis_*.tgz.sha256' \) -mtime +${KEEP_DAYS} -print -delete | wc -l | tr -d ' ')
DEL_ENV=$(find "${LOCAL_SECRETS}" -type f -name 'backend.env.*.bak' -mtime +${KEEP_DAYS} -print -delete | wc -l | tr -d ' ')
log "  deleted pg=${DEL_PG}, redis=${DEL_REDIS}, env=${DEL_ENV}"

# 月度归档 (每月 1 号执行) — Sprint 39: 同时复制 .sha256 让归档可独立校验
DAY=$(date +%d)
if [[ "${DAY}" == "01" ]]; then
  YEAR_MONTH=$(date +%Y-%m)
  MONTHLY_DIR="${LOCAL_MONTHLY}/${YEAR_MONTH}"
  mkdir -p "${MONTHLY_DIR}"
  log "  monthly archive → ${MONTHLY_DIR}"
  LATEST_PG=$(ls -t "${LOCAL_PG}/"*.dump 2>/dev/null | head -1 || true)
  LATEST_REDIS=$(ls -t "${LOCAL_REDIS}/"redis_*.tgz 2>/dev/null | head -1 || true)
  LATEST_ENV=$(ls -t "${LOCAL_SECRETS}/"backend.env.*.bak 2>/dev/null | head -1 || true)
  # cp 数据文件 + 对应 .sha256 (Sprint 39 修: 归档要能 sha256sum -c 自检)
  if [[ -n "${LATEST_PG}" ]]; then
    cp "${LATEST_PG}" "${MONTHLY_DIR}/"
    [[ -f "${LATEST_PG}.sha256" ]] && cp "${LATEST_PG}.sha256" "${MONTHLY_DIR}/" \
      || log "  WARN: ${LATEST_PG}.sha256 missing, monthly archive cannot verify checksum"
  fi
  if [[ -n "${LATEST_REDIS}" ]]; then
    cp "${LATEST_REDIS}" "${MONTHLY_DIR}/"
    [[ -f "${LATEST_REDIS}.sha256" ]] && cp "${LATEST_REDIS}.sha256" "${MONTHLY_DIR}/" \
      || log "  WARN: ${LATEST_REDIS}.sha256 missing"
  fi
  # backend.env.*.bak 一般没有 sha256, 直接 cp 数据
  [[ -n "${LATEST_ENV}" ]] && cp "${LATEST_ENV}" "${MONTHLY_DIR}/"
fi

log "=== stocks backup-pull DONE ==="
log "local: $(du -sh "${LOCAL_ROOT}" 2>/dev/null | cut -f1) at ${LOCAL_ROOT}"

# Sprint 39: 任一文件拉取失败 → 整脚本 exit 1, 让 cron 失败明显可见 (不再静默)
if [[ "${PULL_FAILED}" -gt 0 ]]; then
  log "ERROR: ${PULL_FAILED} 个文件拉取失败, exit 1"
  exit 1
fi
