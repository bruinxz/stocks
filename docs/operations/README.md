# Operations

运维相关文档. 任何"服务器/部署/备份/恢复"问题先翻这里.

| 文档 | 用途 |
|---|---|
| [backup-strategy.md](./backup-strategy.md) | 备份范围 + 服务端/本地 cron + 保留策略 + 监控点 |
| [disaster-recovery.md](./disaster-recovery.md) | 服务器从零恢复完整 SOP (~60 min RTO) |

## 关键脚本

| 脚本 | 部署位置 | Cron |
|---|---|---|
| [scripts/ops/pg_backup_daily.sh](../../scripts/ops/pg_backup_daily.sh) | `/opt/stocks/scripts/` (服务端) | 每天 03:25 |
| [scripts/ops/redis_backup_daily.sh](../../scripts/ops/redis_backup_daily.sh) | `/opt/stocks/scripts/` (服务端) | 每天 03:35 |
| [scripts/ops/rotate-releases.sh](../../scripts/ops/rotate-releases.sh) | `/opt/stocks/scripts/` (服务端) | 每天 03:45 |
| [scripts/ops/backup-pull.sh](../../scripts/ops/backup-pull.sh) | 本地 (macOS/Linux) | 本机 04:12 |

## 常用命令

```bash
# 查最新一份服务端备份
ssh ops@<legacy-prod-host> 'stat /backup/stocks/postgres/latest.dump | head -5'

# 校验本地备份完整性
cd ~/Backups/stocks-prod/postgres && sha256sum -c *.sha256

# 手动跑一次本地拉取 (前台显示进度)
bash /Users/bytedance/go/src/github.com/bruinxz/stocks/scripts/ops/backup-pull.sh

# 看服务端 cron 是否在跑
ssh ops@<legacy-prod-host> 'tail -20 /var/log/stocks/pg_backup_daily.log'
```

## 关联
- crp (`college-recommendation-platform`) 的同款运维文档在 `crp 项目的 docs/operations/`
- 两个项目共用同一台香港服务器 (`<legacy-prod-host>`)
- crp cron 04:07 / stocks cron 04:12 错开避免抢香港跨境带宽
