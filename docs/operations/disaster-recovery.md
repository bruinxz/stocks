# Disaster Recovery — Stocks

服务器从零恢复到 stocks 业务正常运行的完整流程。**预计 60 分钟**。

## 触发场景
- 服务器整机宕机 / 跑路 / 数据中心 incident
- volume 误删 / 数据被破坏
- 想换服务商 / IDC 迁移

## 前置: 你应该有的备份

```
~/Backups/stocks-prod/
├── postgres/最新一份 stock_backtest_*.dump (+ .sha256)
├── redis/   最新一份 redis_*.tgz (+ .sha256)
└── secrets/ 最新一份 backend.env.*.bak
```

如果本地没有, 检查是否在 `~/Backups/stocks-prod-monthly/<最近月>/` 月度归档.

## 一键恢复 (推荐)

```bash
./scripts/ops/disaster-recover.sh \
  --host new-server-ip \
  --user ops \
  --port 22 \
  --identity ~/.ssh/your_key \
  --pg-dump ~/Backups/stocks-prod/postgres/最新文件 \
  --redis-tgz ~/Backups/stocks-prod/redis/最新文件 \
  --env-bak ~/Backups/stocks-prod/secrets/最新文件
```
(脚本待实现 — 短期内手动按下文流程)

## 手动恢复 (SOP)

### Step 1: 新机器基础环境 (5 min)
```bash
# 假设是 Ubuntu 22.04+ 的新机
sudo apt update
sudo apt install -y docker.io docker-compose-plugin postgresql-client git python3-venv nginx
sudo systemctl enable docker
sudo usermod -aG docker $USER
newgrp docker

# 安装 Node.js 18+ 后确认版本
node --version
```

### Step 2: 准备目录 + 用户 (3 min)
```bash
sudo useradd -r -s /bin/bash -m stocks_app
sudo groupadd -f stocks
sudo usermod -aG stocks stocks_app
sudo mkdir -p /opt/stocks/{releases,shared,scripts}
sudo mkdir -p /data/stocks/{postgres,redis}
sudo mkdir -p /backup/stocks/{postgres,redis,secrets}
sudo mkdir -p /var/log/stocks
sudo chown -R stocks_app:stocks /opt/stocks /data/stocks /backup/stocks /var/log/stocks
```

### Step 3: 上传代码 + 备份 (5 min)
```bash
# 本机
RELEASE_TS=$(date +%Y%m%d%H%M%S)-main
ssh new-server "mkdir -p /opt/stocks/releases/${RELEASE_TS}"

rsync -avz --exclude=node_modules --exclude=.git --exclude=backups \
  ~/go/src/github.com/bruinxz/stocks/ \
  new-server:/opt/stocks/releases/${RELEASE_TS}/

# 上传备份
scp ~/Backups/stocks-prod/postgres/最新.dump \
    ~/Backups/stocks-prod/redis/最新.tgz \
    ~/Backups/stocks-prod/secrets/最新.env.bak \
  new-server:/backup/stocks/restore/

# 上服务器
ssh new-server
sudo ln -sfn /opt/stocks/releases/${RELEASE_TS} /opt/stocks/current
sudo cp /backup/stocks/restore/最新.env.bak /opt/stocks/shared/backend.env
sudo chown stocks_app:stocks /opt/stocks/shared/backend.env
sudo chmod 640 /opt/stocks/shared/backend.env
```

### Step 4: 启 Postgres + Redis (5 min)
```bash
cd /opt/stocks/current
# 注意: 只启数据库容器, 不启 backend (灌完数据后再启)
export POSTGRES_PASSWORD='<从密钥备份恢复的 PostgreSQL 管理员密码>'
docker compose -f docker-compose.yml up -d postgres redis
docker compose ps
sleep 15  # 等 health
docker exec stock_postgres pg_isready -U postgres
```

### Step 5: 灌数据 (15-20 min)
```bash
# 校验 dump
cd /backup/stocks/restore
sha256sum -c 最新.dump.sha256 || { echo "DUMP CORRUPT, 用其他日期重来"; exit 1; }

# 创建空库 + 灌入
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" stock_postgres \
  psql -U postgres -c "CREATE DATABASE stock_backtest" 2>/dev/null || true

docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" -i stock_postgres \
  pg_restore -U postgres -d stock_backtest --clean --if-exists --no-owner --no-privileges \
  < /backup/stocks/restore/最新.dump

# 验证 row count (跟你脑子里的近似比, 1.6GB 库通常 1000w+ rows)
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" stock_postgres \
  psql -U postgres -d stock_backtest -c \
  "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10"
```

### Step 6: 恢复 Redis (1 min)
```bash
# 停 Redis，把备份内容写回当前 Compose 的 /data volume，再启动
docker compose -f /opt/stocks/current/docker-compose.yml stop redis
sudo rm -rf /tmp/stocks-redis-restore
sudo mkdir -p /tmp/stocks-redis-restore
sudo tar -xzf /backup/stocks/restore/最新.tgz -C /tmp/stocks-redis-restore
docker run --rm --volumes-from stock_redis \
  -v /tmp/stocks-redis-restore/redis:/restore:ro redis:7-alpine \
  sh -c 'rm -rf /data/* && cp -a /restore/. /data/'
docker compose -f /opt/stocks/current/docker-compose.yml start redis
docker exec stock_redis redis-cli DBSIZE
```

### Step 7: 构建并启动 backend/frontend (10 min)
```bash
cd /opt/stocks/current

# 构建不可变 release 内的产物
sudo -u stocks_app -H bash -lc 'cd /opt/stocks/current/backend && npm ci && npm run build'
sudo -u stocks_app -H bash -lc \
  'cd /opt/stocks/current/frontend && npm ci --legacy-peer-deps && CI=false npm run build'

# 全球市场任务的共享 Python 运行时
sudo -u stocks_app -H python3 -m venv /opt/stocks/shared/venv
sudo -u stocks_app -H /opt/stocks/shared/venv/bin/pip install \
  -r /opt/stocks/current/scripts/ops/requirements-global-markets.txt

# 后端由 systemd 管理，监听 3000
sudo cp scripts/deployment/samples/stocks-backend.service /etc/systemd/system/stocks-backend.service
sudo sed -i 's/^User=.*/User=stocks_app/; s/^Group=.*/Group=stocks/' \
  /etc/systemd/system/stocks-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now stocks-backend.service

# 前端由 Nginx 直接从 current/frontend/build 提供，监听 3001；
# 复制仓库样例后按恢复域名/证书调整 server_name。
sudo cp scripts/deployment/samples/nginx-stocks.conf /etc/nginx/sites-available/stocks
sudo ln -sfn /etc/nginx/sites-available/stocks /etc/nginx/sites-enabled/stocks
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

sleep 10
curl -fsS http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/catdesk
```

### Step 8: 恢复 cron (3 min)
```bash
sudo cp /opt/stocks/current/scripts/ops/pg_backup_daily.sh /opt/stocks/scripts/
sudo cp /opt/stocks/current/scripts/ops/redis_backup_daily.sh /opt/stocks/scripts/
sudo cp /opt/stocks/current/scripts/ops/rotate-releases.sh /opt/stocks/scripts/
sudo chmod +x /opt/stocks/scripts/*.sh

sudo tee /etc/cron.d/stocks-backup > /dev/null <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
25 3 * * * root /opt/stocks/scripts/pg_backup_daily.sh
35 3 * * * root /opt/stocks/scripts/redis_backup_daily.sh
45 3 * * * root /opt/stocks/scripts/rotate-releases.sh
EOF
```

### Step 9: DNS / 反向代理切换 (按需)
- 阿里云 DNS 改 A 记录指向新 IP
- Nginx upstream / Cloudflare origin 切换

### Step 10: 验证业务 (5 min)
- 打开 web UI，确认默认管理员浏览会话建立，并检查 portfolio / signals 数据是否完整
- 跑一次手动 backtest 验证计算正确
- 检查 paper trading 是否能正常下单 (kill-switch 状态需重新确认, 见 `scripts/ops/kill_switch_*.sh`)

## 这次事故复盘 (避免再踩)

**2026-06-14 crp 数据库被 `docker compose up -d --build` 误删, 19 天 cron 静默失败**:
- 教训: `deploy.sh` 不要带 `--build`, 镜像应该手动 build + tag, compose 只用 image
- 教训: cron 失败必须 `exit 1` 让 cron 邮件告警生效 (旧版本静默 `|| true`)
- 教训: 服务端备份要定期手动验证 `pg_restore -l` (脚本已加, 但要看 log)

## 关联文档
- [backup-strategy.md](./backup-strategy.md) — 备份机制 + 保留策略
