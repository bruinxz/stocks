# SECURITY — 凭证管理与轮换指南

## ⚠️ 上一轮安全审计发现 (Batch W, 2026-06-17)

以下凭证已**确认进入 git history**, 必须 **立即轮换** 即使源文件已 git rm:

| 凭证 | 旧值 (已废) | 影响范围 | 优先级 |
|---|---|---|---|
| PG `stock_admin` prod 密码 | `x8Vq$9pL2#mK7@nW1cF5^jY3!bH4*gD` | `103.242.3.87:5432/stock_backtest` | **P0** |
| docker postgres `postgres` 密码 | 同上 (docker-compose.yml:10) | 容器内 PG 默认账户 | **P0** |
| SSH `root@103.242.3.87:14126` | `7tsA0wS62A1e` | prod 服务器 root 登录 | **P0** |
| PG SQL role `postgres` 密码 (run_sql.exp / update_pg_password.exp) | `K8s#Complex!Password_2026` | prod psql 直连 | **P0** |

### 轮换步骤 (按优先级)

1. **prod PG**:
   - ssh 进 prod, `ALTER USER stock_admin WITH PASSWORD '<新密码>'`
   - 更新所有应用 `.env` 的 `DB_PASSWORD` (backend/.env, .env.production)
   - 重启 backend `pm2 restart stock-backend`
   - 确认 `/health/detail` 的 `db: 'ok'`

2. **prod SSH**:
   - 改用 SSH key (生成 ed25519, 加入 ~/.ssh/authorized_keys)
   - `passwd -l root` 锁 root password 登录
   - 更新部署脚本 (deploy_remote_build.sh 等) 走 key auth 不用 sshpass

3. **docker postgres**:
   - .env 加 `POSTGRES_PASSWORD=<新密码>` (gitignored, 已在 .gitignore)
   - `docker-compose down && docker-compose up -d` (会自动应用新密码)

4. **git history 清理 (可选, 推荐)**:
   - 使用 `git filter-repo` 或 BFG 把含有旧密码的 commit 重写
   - `git push --force-with-lease origin main`
   - 注意: 重写 history 会让所有 clone 失效, 团队需重新 clone

## 凭证管理原则

1. **永不提交明文密码 / token / API key 到 git**
   - `.env` 必须在 `.gitignore` 中 (已生效)
   - `docker-compose.yml` 用 `${VAR}` 引用 env, 不内联值
   - shell 脚本里的 `sshpass -p '...'` / `expect '...' { send 'pwd' }` 是高危反模式

2. **轮换周期**
   - prod DB / SSH / SMTP 凭证: 每 90 天
   - JWT_SECRET / LIVE_DEV_JWT_SECRET: 每 180 天 (轮换时所有用户会被踢下线)
   - 飞书 webhook URL: 漏露后立即吊销 + 重建

3. **审计**
   - CI 跑 `scripts/ci/check_weak_secrets.sh` 阻塞含弱密码的 PR
   - `.github/workflows/security-lint.yml` 应 grep `103.242.3.87` 等已知 prod 标识防止误提交
   - 部署脚本里的 `expect` 文件应在 finally 块 `unlink`, 防 /tmp 残留明文

## 数据破坏脚本上锁规范

以下脚本会清空 / 删除 / 重建 prod 数据, 必须双层 guard:

- `scripts/setup_and_db/reset_db.sh` — `ALLOW_RESET_DB=true bash ... --i-know-what-im-doing`
- `scripts/setup_and_db/reset_db_proper.sh` — 同上
- `scripts/setup_and_db/force_sync.js` — `ALLOW_FORCE_SYNC=true node ...`
- `scripts/maintenance/reset_paper_trading_to_stock.js` — `ALLOW_DESTRUCTIVE_RESET=true node ... --i-know-what-im-doing`

新增任何"运行即删 prod 数据"脚本必须沿用同款 guard 范式 + 加入本文档.

## 已废弃 (Batch W git rm) 的高危脚本

- `fix_db.js` — DELETE prod stocks 表无 guard, 已删除
- `backend/fix_db.ts` — TypeScript 复刻, 已删除
- `backend/fix_indices.js` — 索引重建脚本, 已废
- `run_sql.exp` — 含 prod PG 明文密码, 已删除
- `update_pg_password.exp` — 含明文新密码, 已删除
- `setup_firewall.exp` — ufw reset 顺序错 + 含 sshpass, 已删除
- `.vscode/sftp.json` — root 明文密码 + autoDelete 远端文件, 已删除 (本来 gitignored)

如未来需要这些功能, 通过受 guard 保护的脚本重新实现, 不要恢复旧文件.
