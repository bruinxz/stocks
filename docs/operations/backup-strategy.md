# Backup & Disaster Recovery — Stocks

## RTO/RPO 目标

| 指标 | 目标 | 含义 |
|---|---|---|
| RPO (数据丢失窗口) | **≤ 24h** | 取决于每日 03:25/03:35 备份 |
| RTO (恢复时间) | **≤ 60 min** | 30min 部署 + 20min 灌库 + 10min 验证 |

## 备份范围

| 优先级 | 内容 | 服务端大小 | 必备 |
|---|---|---|---|
| **P0** | `stock_backtest` DB pg_dump (`-Fc` 压缩格式) | ~35 MB | ✅ |
| **P0** | `/opt/stocks/shared/backend.env` (39 行, DB 密码 + AI key + 券商 token) | 1.5 KB | ✅ |
| **P1** | Redis dump (paper trading 仓位 + kill-switch 状态) | ~3 MB | ✅ |
| **P1** | sha256 校验文件 | 64 B each | ✅ |
| **P3** | `/opt/stocks/releases/` 老 release (代码 git 已有) | 11 GB | ❌ |
| **P3** | Docker images (timescaledb + redis, 可现拉) | GB 级 | ❌ |

**全量 vs 增量**: 全量。每份 pg_dump 35 MB (TimescaleDB hypertable 压缩极好), 7 份 = 250 MB, 存储成本忽略。
rsync 本地拉取 **事实增量** (skip 已存在文件), 不需要 WAL archiving 复杂运维。

## node_modules 共享 (R71 改造)

之前 `deploy_main_release.sh` bug: 每份 release 独立装 1.3GB node_modules → 4 份就 5.2GB
浪费. 现在改成 `/opt/stocks/shared/node_modules/{backend,frontend}` 单份共享:

- deploy 时比对 `package-lock.json` sha256, 不变直接 symlink, 节省 npm ci 时间
- 变了才 npm ci 一次到 shared, 写入新 hash
- 老 release symlink 自动指向最新 shared (回滚需注意 lock 兼容性)
- 单 release 大小从 1.4GB → 88MB, 7 份保留时占盘从 11GB → 700MB
- 详见 [scripts/ops/deploy_main_release.sh](../../scripts/ops/deploy_main_release.sh) + [migrate-node-modules-to-shared.sh](../../scripts/ops/migrate-node-modules-to-shared.sh)

## 服务端备份机制

### Cron (root, `/etc/cron.d/stocks-backup`)
```cron
25 3 * * * root /opt/stocks/scripts/pg_backup_daily.sh
35 3 * * * root /opt/stocks/scripts/redis_backup_daily.sh
45 3 * * * root /opt/stocks/scripts/rotate-releases.sh
```

### 输出目录
```
/backup/stocks/
├── postgres/
│   ├── stock_backtest_YYYYMMDDHHMMSS.dump (+ .sha256)
│   ├── latest.dump → 最新一份 (symlink)
│   └── latest.dump.sha256
├── redis/
│   ├── redis_YYYYMMDDHHMMSS.tgz (+ .sha256)
│   └── latest.tgz
└── secrets/
    ├── backend.env.YYYYMMDDHHMMSS.bak
    └── latest.env.bak
```

### 保留策略
- 服务端: 最近 **7 天** (mtime +7 -delete), `latest.*` symlink 永久保留
- 本地: 最近 **3 天** (rsync 拉 + KEEP_DAYS=3 清理)
- 月度: 每月 1 号本地额外保留一份到 `~/Backups/stocks-prod-monthly/<YYYY-MM>/`

### 失败告警
- 脚本 `set -euo pipefail` + 关键失败 `exit 1` → cron 邮件告警生效
- log: `/var/log/stocks/{pg,redis}_backup_daily.log` (人工巡检)

## 本地备份机制

### Cron (本机 macOS, 错开 crp 5 min 避免抢香港带宽)
```cron
12 4 * * * /Users/bytedance/go/src/github.com/bruinxz/stocks/scripts/ops/backup-pull.sh >> ~/Backups/stocks-prod/.pull.log 2>&1
```

### 实际拉取耗时
香港服务器 → 本机, 持续传输 ~30 KB/s, **3 dump (~120 MB) + 3 redis + 3 env ≈ 1-2 小时**, 凌晨跑无人值守 OK.

## 监控点

| 项 | 怎么查 | 异常处理 |
|---|---|---|
| 服务端最新 dump 时间 | `ssh ops@... stat /backup/stocks/postgres/latest.dump` | > 30h 没更新 → 立即检查 cron log |
| 本地最新 dump 时间 | `stat ~/Backups/stocks-prod/postgres/*.dump` | > 48h 没更新 → 检查本地 cron |
| sha256 校验 | `cd ~/Backups/stocks-prod/postgres && sha256sum -c *.sha256` | 任一 FAIL → 重新拉 |
| 磁盘 | `ssh ops@... df -h /` | > 80% → 检查 rotate-releases 是否生效 |

## 关键文件清单 (灾难恢复需要)

| 文件 | 来源 | 用途 |
|---|---|---|
| 最新 `*.dump` | 本地 `~/Backups/stocks-prod/postgres/latest 或最新` | pg_restore 灌库 |
| 最新 `*.dump.sha256` | 同上 | 校验完整性 |
| 最新 `redis_*.tgz` | 本地 `~/Backups/stocks-prod/redis/` | 恢复 paper trading 状态 |
| 最新 `backend.env.*.bak` | 本地 `~/Backups/stocks-prod/secrets/` | 恢复 DB 密码 / AI key / 券商 token |
| `deployment/docker-compose.yml` | git repo | 启服务 |
| `scripts/setup_and_db/*.sql` | git repo | DB schema (备用, dump 已有) |

## 关联文档
- [disaster-recovery.md](./disaster-recovery.md) — 灾难恢复 SOP (一步步)
