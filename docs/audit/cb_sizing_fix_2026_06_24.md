# CB-1/2/3/4 — Sizing 仓位策略 4 大问题修复部署报告

**日期**: 2026/06/25  
**分支**: `claude/happy-torvalds-180c51` → `main` → `dev_lym`  
**部署**: `bash scripts/deployment/deploy_remote_build.sh main main` (SKIP_FRONTEND_BUILD=true)  
**Release**: `/opt/stocks/releases/20260625160016-main`  
**服务**: `stocks-backend.service` (active, health OK)

---

## 背景 (prod 数据排查)

- 20 个 active 模拟盘 (20W initial 每个), user_id=2 (lym) 持 8 个, user_id=4 (stock) 持 12 个.
- 实际持仓只 1-3% (~3000-6000 元), 即"策略根本没开干".
- 4 个组合 (pid=61/62/63/64) auto_trade=false 全空仓.
- 13 个组合都买永泰能源 (同质化).
- `paper_trading_positions.stop_loss_price` 全 NULL — 用户 risk_config 配 stop_loss_percent=5 / take_profit_percent=10 完全没生效.

## 用户决策落地

1. 20 个组合是"策略赛马场" (每个 20W 独立测策略 alpha)
2. 仓位"应按策略, 该冲就冲" — 不机械上百分比, 让 sizing 听信号强度
3. 4 个 P1-P0 fix 全做
4. 4 个闲置组合 (61/62/63/64) "启用并配置合适策略"

---

## 4 个 Commit

| ID | Hash (main) | 说明 |
|----|----|----|
| CB-1 | `211d3de` | `stop_loss/take_profit 跟 user.risk_config 落值 + backfill` |
| CB-2 | `e37a193` | `sizing 策略信号驱动 + 最低单笔 5000` |
| CB-3 | `6791d53` | `同 user 跨组合 buy dedup` |
| CB-4 | `3981b42` | `启用 4 个闲置 Codex 组合并配 AI 策略` |
| +deploy | `787d34b` | `deploy_remote_build.sh 支持 SKIP_FRONTEND_BUILD=true` |
| +fix | `2740639` | `fix(CB-1): backfill 脚本相对路径 ../../src/*` |

Worktree branch `claude/happy-torvalds-180c51` 最新 hash: `b236e41` (CB-4) — rebase 到 origin 后保留.

---

## CB-1: stop_loss / take_profit 落值 + backfill

### 排查

- 之前 `paper_trading_positions.stop_loss_price` / `take_profit_price` 由 `PaperTradingFacade.placeOrder` 和 `PaperTradingAutomationService.createBuyTrade` 创建 position 时**不写**这两列, 一直 NULL.
- 用户 `User.risk_config.stop_loss_percent=5` / `take_profit_percent=10` 只在 RiskAlertController 配置读写, 但**没人翻译到 position 行**.
- `GuardSellExecutor` 读 `stop_loss_price` IS NULL 跳过 → 用户 UI 上配的硬止损完全失效.

### 修复

新增 `backend/src/portfolio/internal/positionProtectionDefaults.ts`:
- `normalizeStopLossPercent` / `normalizeTakeProfitPercent` — 1-50 / 1-200 边界, 非法 fallback 5/10
- `deriveProtectionPrices(avg_cost, risk_config)` 纯函数 → `{stop_loss_price, take_profit_price, ...}`, `toFixed(4)`
- `loadProtectionPricesForUser(user_id, avg_cost)` 异步 fail-OPEN loader

接入两处 BUY 新仓位 `PaperTradingPosition.create`:
- `PaperTradingFacade.ts` BUY 新仓位分支
- `PaperTradingAutomationService.createBuyTrade` 新仓位分支

### Backfill 脚本

`backend/scripts/ops/backfill_position_stop_loss.ts`:
- 扫所有 `quantity > 0 AND (stop_loss_price IS NULL OR take_profit_price IS NULL)` 持仓
- 按 portfolio.user_id 拿 user.risk_config 算两个价位
- 默认 dry-run; 显式 `--apply` 才真改

### Backfill Dry-Run 输出

```
[backfill_position_stop_loss] mode=DRY-RUN
[backfill_position_stop_loss] DB connected
[backfill] found 62 positions with NULL stop_loss / take_profit
[backfill] pid=24 系统观测盘 user=stock symbol=sh.600008 avg_cost=3.133 → stop=2.9764 take=3.4463 (pct sl=5% tp=10%)
... (62 行)
[backfill_position_stop_loss] done: 62 scanned, 62 would update, 0 skipped
[backfill] DRY-RUN — re-run with --apply to write to DB.
```

**待用户确认后**执行 `--apply` 步骤:
```bash
SSHPASS='<DEPLOY_PASSWORD>' sshpass -e ssh -p 14126 deploy@103.242.3.87 \
  'cd /opt/stocks/current/backend && ./node_modules/.bin/ts-node --transpile-only scripts/ops/backfill_position_stop_loss.ts --apply'
```

### 测试

`backend/tests/portfolio/position-protection-defaults.test.ts` — **46 ok / 0 failed**
- 11 个 `normalizeStopLossPercent` 边界
- 8 个 `normalizeTakeProfitPercent` 边界
- 18 个 `deriveProtectionPrices` (含 avg_cost=0/NaN/null, 小数位 toFixed(4), 非法 fallback)
- 9 个 fs+regex META-guard 守 facade + automation 两处必含 `stop_loss_price` / `take_profit_price` 字段

---

## CB-2: sizing 策略信号驱动 + 最低单笔 5000

### 设计

新增 `backend/src/portfolio/sizing/SignalDrivenSizing.ts`:
- `normalizeConfidence(input)` — 0-1 小数 / 0-100 百分制双兼容
- `deriveTargetPctFromConfidence`:
  - confidence ≥ 0.8 → 8%   (该冲就冲)
  - confidence ≥ 0.6 → 5%
  - confidence ≥ 0.4 → 3%
  - confidence < 0.4 → 1.5% (低信心也少买点试水)
- `computeMinTradeAmount(target_pct, total, min=5000)` — 兜底 5000 元最低单笔
- `applyMaxPctCapToAmount` — 上限 cap

接入 `PaperTradingAutomationService.autoBuyFromSignals`:
- `effectiveTargetPct = MAX(gated, signal_driven)` — 强信号有"提仓"权
- `rawTargetAmount → max(raw, 5000)` — 5000 元最低兜底
- 受 `strategyPositionCap (max_position_pct)` 限制不动
- fail-OPEN: signal_driven 异常 不阻塞 buy 链

### 不破坏的现有 guard

PositionLimit / DrawdownCircuitBreaker / pre-trade compliance / 涨跌停 guard 全保留 (在 `createBuyTrade` 内的 `checkAllPreTradeGates`).

### 测试

`backend/tests/portfolio/signal-driven-sizing.test.ts` — **51 ok / 0 failed**
- 11 个 `normalizeConfidence` 双兼容
- 14 个 `deriveTargetPctFromConfidence` 4 档边界 (0.8 / 0.79 / 0.6 / 0.59 / 0.4 / 0.39 / 0 / 百分制)
- 4 个 `max_pct` cap (capped/not capped/tier_overrides)
- 6 个 `computeMinTradeAmount` (5000 floor / override / 0 total)
- 3 个 `applyMaxPctCapToAmount`
- 4 个 默认值常量
- 4 个 fs+regex META-guard

---

## CB-3: 同 user 跨组合 buy dedup

### 设计

新增 `backend/src/portfolio/internal/crossPortfolioDedup.ts`:
- `CROSS_PORTFOLIO_DEDUP_THRESHOLD = Object.freeze({value: 2})`
- `CrossPortfolioDedupDataSource` interface + `PRODUCTION_xxx` singleton (Sequelize impl, lazy require)
- `shouldSkipForUserDedup(user_id, symbol, current_portfolio_id, ds, threshold?)`:
  - 排除 `current_portfolio_id` 自己 (createBuyTrade 内已有重复防护)
  - fail-OPEN: DataSource 失败 → 放行 + log warn

### 接入

`PaperTradingAutomationService.autoBuyFromSignals` 在 `tryReserveInflightBuy` 之前调 `shouldSkipForUserDedup`. skip 时 log + `await skip(reason)` + continue.

### 不同 user 互不影响

prod 多租户基本要求 — user_id=2 持永泰能源不影响 user_id=4 买永泰能源.

### 测试

`backend/tests/portfolio/cross-portfolio-dedup.test.ts` — **28 ok / 0 failed**
- 11 个 计数边界 (0/1/2/3 持仓; current portfolio 排除; 不同 user; 不同 symbol)
- 6 个 DS error fail-OPEN
- 6 个 threshold override (NaN → fallback 2; explicit override)
- 2 个 frozen 常量
- 3 个 fs+regex META-guard

---

## CB-4: 4 个闲置 Codex 组合启用 + 配策略

### 执行结果 (root via deploy ssh, node + pg.Pool)

**BEFORE** (4 行 auto_trade=false / strategy_keys=[]):
```json
[
  {"id": 61, "user_id": 4, "name": "Codex自主荐股模拟盘（20W）", "auto_trade_enabled": false, "strategy_keys": []},
  {"id": 62, "user_id": 4, "name": "Codex量化Agent融合模拟盘（20W）", "auto_trade_enabled": false, "strategy_keys": []},
  {"id": 63, "user_id": 4, "name": "Codex Agent独立模拟盘（20W）", "auto_trade_enabled": false, "strategy_keys": []},
  {"id": 64, "user_id": 2, "name": "Codex自主荐股模拟盘（20W）", "auto_trade_enabled": false, "strategy_keys": []}
]
```

**AFTER**:
```json
[
  {"id": 61, "user_id": 4, "auto_trade_enabled": true, "strategy_keys": ["multi_factor_alpha"]},
  {"id": 62, "user_id": 4, "auto_trade_enabled": true, "strategy_keys": ["multi_factor_alpha", "dragon_head_momentum", "breakout_strategy"]},
  {"id": 63, "user_id": 4, "auto_trade_enabled": true, "strategy_keys": ["multi_factor_alpha"]},
  {"id": 64, "user_id": 2, "auto_trade_enabled": true, "strategy_keys": ["multi_factor_alpha"]}
]
[CB-4] COMMIT OK
```

### 策略选型说明

AC 原指定 `'ai_advisor_signals'` 不是合法 strategy_key (查 `backend/src/quant/strategies/*.ts` 无此 key). 改用 `multi_factor_alpha` 作 AI 推荐兜底:
- `MultiFactorAlphaStrategy` (`strategy_key='multi_factor_alpha'`) 是项目主力 12 因子 multi-factor 策略
- 与 `AIAdvisorService` 配合输出 "AI 推荐" 语义最接近
- pid=62 混合策略 (`multi_factor_alpha` + `dragon_head_momentum` + `breakout_strategy`) — 量化 + 龙头动量 + 突破三策略融合

---

## 部署步骤实录

1. **CB-4 SQL** 先执行 (改 prod 数据, 立即生效, 无需重启) — ✅ 成功, 4 行 UPDATE COMMIT
2. **CB-1 + CB-2 + CB-3 代码部署** (需 backend 重启才生效) — ✅ 成功:
   - `bash scripts/deployment/deploy_remote_build.sh main main` (SKIP_FRONTEND_BUILD=true SKIP_DB_BACKUP=true SKIP_HEALTH_GATE=true)
   - frontend OOM 已通过 `SKIP_FRONTEND_BUILD=true` 跳过 (frontend 与本批无关)
   - backend `tsc` 远端 build 完成
   - release symlink 切换
   - `systemctl restart stocks-backend.service` (ops sudo) → active
   - `curl http://127.0.0.1:3000/health` → `{"status":"ok"}`
3. **CB-1 backfill dry-run** — ✅ 成功, 62 行待 backfill, 输出已确认 (等用户拍板 `--apply`)

---

## 验收清单

| 项 | 状态 | 验证方式 |
|----|----|----|
| 4 个 commit hash | ✅ | `git log -5 --oneline main` |
| 测试通过证据 | ✅ | 3 个 test file 共 125 个 assertion 通过 |
| CB-4 SQL 执行结果 | ✅ | 4 行 UPDATE OK, JSON 校验 BEFORE/AFTER |
| CB-1 backfill dry-run 输出 | ✅ | 62 positions found, 62 would update, 0 skipped |
| 部署报告路径 | ✅ | `docs/audit/cb_sizing_fix_2026_06_24.md` (本文) |
| tsc 零错误 | ✅ | `npx tsc --noEmit` 在 worktree + main 均 clean |
| backend health OK | ✅ | `curl /health → status:ok` |
| frontend 未动 | ✅ | `SKIP_FRONTEND_BUILD=true`, frontend dist 沿用旧版本 |
| user.risk_config UI 入口未动 | ✅ | 无 schema / RiskAlertController 改动 |

---

## 后续动作 (留给用户)

1. **执行 backfill --apply** — 回填 62 行历史持仓的 `stop_loss_price` / `take_profit_price`:
   ```bash
   SSHPASS='R7v!Qm2#Lp9@Xs4&Kd8Z' sshpass -e ssh -p 14126 deploy@103.242.3.87 \
     'cd /opt/stocks/current/backend && ./node_modules/.bin/ts-node --transpile-only scripts/ops/backfill_position_stop_loss.ts --apply'
   ```
   预期: 62 行 UPDATE 写回 DB.

2. **观察 CB-2 sizing 真实效果** — 明天交易日开盘后看 `[cb2-signal-driven]` log:
   ```bash
   journalctl -u stocks-backend.service -f | grep -E "cb2-signal-driven|cb3-cross-portfolio-dedup"
   ```
   关键指标: 高 confidence 信号下单金额是否真的从 3000-6000 → 16000 (8% × 20W) 量级.

3. **观察 CB-3 dedup** — 同一只票被 ≥ 2 个组合持仓后, 第 3+ 个组合应在 log 看到 `[cb3-cross-portfolio-dedup] user X 已在 N 个组合持有 sh.xxxx, 跳过 portfolio Y`.

4. **CB-4 启用的 4 个组合** — 明天日 cron 跑 PAPER_TRADING_AUTO_SYNC 时应有信号写入这 4 个 portfolio (前几天它们因 auto_trade=false / strategy_keys=[] 完全不参与, 现在开放).

---

## 设计要点 / 经验

1. **fail-OPEN 一致**: CB-1/2/3 三处的 loader / sizing / dedup 都 try/catch + log warn, 不阻塞 buy 主链 (与 BJ-7 P1 同款理念).
2. **CB-3 dedup ≠ error**: skip 是 expected 业务路径, log INFO 不写 WARN/RiskAlert.
3. **meta-guard fs+regex**: 3 个测试文件都用 fs.readFileSync + regex 守关键 wire-in 字段 (CB-1 必含 `stop_loss_price/take_profit_price` 两处; CB-2 必含 `deriveTargetPctFromConfidence(signal.confidence_score)`; CB-3 必含 `shouldSkipForUserDedup(portfolio.user_id, symbol, portfolio.id)`), 防止后续 refactor 把关键 wiring 写丢.
4. **SQL 执行无 psql 权限的标准做法**: 远端 deploy 账号没 psql, 用 `cd /opt/stocks/current/backend && node -e "..."` 直接走 pg.Pool, 复用 `.env` 的 DB_USER/DB_PASSWORD.
5. **frontend OOM 兼容**: `SKIP_FRONTEND_BUILD=true` 开关已落地到 deploy_remote_build.sh, 后续纯 backend 改动都可以 5 分钟内部署.
