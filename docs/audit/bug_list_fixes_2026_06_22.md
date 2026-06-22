# Bug list fixes — 2026-06-22 (P0 批)

来源：用户「21 条 bug 清单」P0 批 (高价值低成本)。本轮处理 7 项（修 5 + 核查 1 + 跳过 1），全部已部署到 prod 并验证。

## 总览

| Bug | 标题 | 状态 | Commit |
|-----|------|------|--------|
| 2 | EventIntelligence 5 个列名错 | 修+部署+验证 | `d05a8ac` |
| 3 | KOLAggregator python 兜底 | 修+部署+验证 | `81188c2` |
| 12 | `/api/ai/analyze-stock` success vs status 不一致 | 修+部署 | `2c63d87` |
| 13 | `/api/ai/signals` 过滤无效 | 修+部署+验证 | `5060dc6` |
| 15 | winston 日志串入 stdout | 修+部署 | `0e8779c` |
| 21 | ShadowDoubleRunService 是否真在跑 | 核查（配置缺失） | — |
| 8 | dragon_tiger_boards 表空 | 实际是表存在 + 数据有 28k 行 | — |
| 19 | CLI fusion 不 parse JSON | 跳过（脚本不存在） | — |

Prod 当前 release: `/opt/stocks/releases/20260621153239-main`（symlink `/opt/stocks/current`）。
HEAD commit: `0e8779c`。

---

## Bug 2 — EventIntelligence 5 个列名错（高价值）

**修前症状**（每次 fusion / autoBuyFromSignals 都打 5 条警告）：

```
EventIntelligence isHardBlocked 失败 (sh.600027): column "is_suspended" does not exist
EventIntelligence isInEarningsWindow 失败 (sh.600027): column "id" does not exist
EventIntelligence loadEarningsForecast 失败: column EarningsForecast.symbol does not exist
EventIntelligence loadNorthboundDelta5d 失败: column NorthboundHolding.symbol does not exist
EventIntelligence loadDragonTigerSummary 失败: column "net_buy_amount" does not exist
```

→ 整个 event 维度静默 fail-open 走 `score_multiplier=1, action='allow'`，业绩预告 / 北向 / 龙虎榜 / ST / 停牌全部 0 命中。

**根因**（对比 prod schema）：

| 调用 | 错列 | 真实列 |
|------|------|--------|
| `stocks.is_suspended` | 不存在 | 该字段在 `daily_bars` 表 |
| `earnings_forecasts.id` | 不存在（复合 PK 三键） | 用 `announce_date` |
| `earnings_forecasts.symbol` | 不存在 | `stock_code` (6 位无后缀) |
| `northbound_holdings.symbol` | 不存在 | `stock_code` |
| `dragon_tiger_board.net_buy_amount` | 不存在 | `net_amount` |

另外 `seat_type` 实际是 enum (`public_fund` / `foreign` / `private` / `famous_yz` / `unknown`)，不是中文字符串"机构/游资"。

**修后状态**：

- `loadEarningsForecast` / `isInEarningsWindow` / `loadNorthboundDelta5d` / `loadDragonTigerSummary` → 改用 `stock_code: stripSymbolSuffix(symbol)`；attribute 改 `announce_date`；DragonTiger 用 `net_amount` + 识别 enum seat_type。
- `isHardBlocked` → Stock 表只查 `id, name` 拿 ST flag；停牌从 `daily_bars` 按 `stock_id` order time DESC 取最新 bar 的 `is_suspended`。

**验证命令** (prod, real sequelize)：

```
node -e "...eventIntelligenceLayer.filter({symbol: 'sz.002592'/*ST八菱*/, as_of_date: '2026-06-22'})..."
→ {"action":"veto","mult":0,"events":["st_warning"]}

node -e "...eventIntelligenceLayer.filter({symbol: 'sh.600519', as_of_date: '2026-06-22'})..."
→ {"action":"allow","mult":1,"events":[],"reason":"无事件信号"}  # 0 错误日志
```

测试：32 ok（`tests/services/event-intelligence.test.ts`）。

---

## Bug 3 — KOLAggregator python 兜底 + init 日志（高价值）

**修前症状**（prod logs）：

```
KOLAggregator.fetchNews(601208) failed: Python script failed (exit=1):
  File "akshare_helper.py", line 17, in <module>
    import akshare as ak
ModuleNotFoundError: No module named 'akshare'
```

**根因**：`DefaultKOLAggregatorDataSource` constructor 兜底是 `'python3'`（系统 `/usr/bin/python3` 没装 akshare），任何 CLI / worker 子进程没继承 systemd env 的场景都会失败 fallback `[]`。

**修后**：
1. 兜底改 `/opt/stocks/shared/venv/bin/python`（与 `scripts/sync-extra-dims.ts` 同款）。
2. 加 `logger.info` 输出 init 时实际使用的 python + script + timeout，ops 可 grep 定位。

**验证**（prod 重启后 log）：

```
2026-06-22 15:59:03.810 info: DefaultKOLAggregatorDataSource initialized
(python=/opt/stocks/shared/venv/bin/python, script=.../akshare_helper.py, timeoutMs=60000)
```

---

## Bug 12 — `/api/ai/analyze-stock` success 永远 true（高价值）

**修前症状**：HTTP 200 + `{success: true, data: {status: 'failed', ...}}` 让前端 `aiStockAnalysisService.analyzeSingleStock` 把失败结果当成功 render 半空白页。

**修后**：
- `status ∈ {completed, partial}` → `{success: true, data}`。
- 其余（`failed` / `pending` / `unknown`）→ `{success: false, data, message: 'AI 分析未完成 (status=X): error_text'}`。
- HTTP 仍 200（不破坏 axios interceptor 4xx/5xx 通道）。
- 前端 `aiStockAnalysisService.ts:112` 已有 `if (!response.data?.success) throw` 链路，fix 后真正生效。

---

## Bug 13 — `/api/ai/signals` 过滤无效（高价值）

**修前症状**：`?stock_code=600519` 返 `cnt=0`（因为代码读 `query.symbol`，stock_code 别名被忽略）。

**修后** (`AISignalController.listSignals` + `getSignalStats`)：
- 同时识别 `?symbol=` 和 `?stock_code=` (`rawSymbol = symbol || stock_code`)。
- trim 后判空字符串才传 undefined（避免 `where.symbol=''` 把结果归零）。

**验证**（prod, 直接调 service）：

```
listSignals(symbol='sh.600736') → count=1 first=sh.600736 OK
listSignals(symbol='600736')    → count=1 first=sh.600736 OK (normalizeSymbol)
listSignals(symbol='600736.SH') → count=1 first=sh.600736 OK (normalizeSymbol)
```

---

## Bug 15 — winston Console 串入 stdout（工具链）

**修前症状**：`node eval.js > out.json` 头 168 行混入 winston 彩色 banner（info/debug 全走 stdout），CLI 输出无法直接 jq pipe。

**修后**：
- 引入 `LOG_STDERR_ONLY=true` env switch：
  - 默认（server 模式）：error/warn 走 stderr，其余 stdout — systemd `StandardOutput/StandardError` 行为不变。
  - `LOG_STDERR_ONLY=true`（CLI）：全 level stderr，stdout 留给业务 JSON。
- 用法：`LOG_STDERR_ONLY=true node script.js | jq .data`。
- server 进程不需要改 — 默认行为兼容 `/var/log/stocks/backend.log`。

---

## Bug 21 — ShadowDoubleRunService 是否真在跑（核查）

**结论**：代码存在且接入正确，但所有 3 个 user 的 `users.risk_config->>analysis_engine` 都是 NULL → 默认 mode='off' → `maybeRunShadow` 在 `loadUserConfig` 后立即 `return null`。

**证据**：
- `SELECT COUNT(*), MAX(created_at) FROM ai_stock_analysis_reports WHERE shadow_of_report_id IS NOT NULL` → `0 |` (近 7 天 0 shadow run)。
- `SELECT id, username, risk_config->>'analysis_engine' FROM users` → 3 user 全 NULL。
- prod log grep `shadowDoubleRun|maybeRunShadow|analysis-engine.*shadow` 0 命中（与代码 `if (cfg.mode === 'off') return null;` 短路一致）。
- `[portfolio-construction-SHADOW]` 日志是另一个 Shadow（PortfolioConstruction adapter），并非 analysis-engine。

**调用入口**（确认接入正确）：
- `backend/src/services/AIAdvisorService.ts:1095` — `analyzeSingleStock` 末尾 fire-and-forget。
- `backend/src/api/controllers/RiskController.ts:525,563` — 管理端读 config / 触发预演。

**操作建议**（非代码改动，留给运维 / PM）：
1. 任选一个测试 user，`UPDATE users SET risk_config = jsonb_set(coalesce(risk_config,'{}'::jsonb), '{analysis_engine}', '{"mode":"shadow"}'::jsonb) WHERE id = X;`。
2. 等下一次 `POST /api/ai/analyze-stock` 触发，验 `SELECT COUNT(*) FROM ai_stock_analysis_reports WHERE shadow_of_report_id IS NOT NULL`。
3. 跑稳后切到 `'hard'` 才会写 `AIInvestmentSignal(source_type='analysis_engine')` 真正参与 autoBuyFromSignals。

---

## 跳过的 bug

### Bug 8 — dragon_tiger_boards 表空

实际状态：`dragon_tiger_board` 表存在且有 **28056 行**（latest `2026-06-11`）。问题不是表空，而是 Bug 2 的 `net_buy_amount` 列名错让查询无法返回任何数据 — 已随 Bug 2 一起修。

### Bug 19 — CLI fusion 不 parse JSON

任务清单引用的 `backend/scripts/analyze-stock-cli.ts` / `modeFusion` 函数在本仓库不存在（grep 全仓 0 命中）。跳过，待用户确认正确路径。

---

## quality gates

- TypeScript: `npx tsc --noEmit` 0 errors。
- 关键 service 单测全过：
  - `event-intelligence.test.ts` 32 ok
  - `kol-aggregator-service.test.ts` 381 ok
  - `newsAnalyzerKOL.test.ts` 87 ok
  - `ShadowDoubleRunService.test.ts` 35 ok
- Prod 部署：5 个 src + 5 个 dist 文件已 rsync 到 `/opt/stocks/releases/20260621153239-main`；`systemctl restart stocks-backend.service` 后 `curl /health` 返 HTTP 200。

## commits

```
0e8779c fix(AY-15): winston Console transport 支持 stderr-only 模式
5060dc6 fix(AY-13): /api/ai/signals 兼容 stock_code 别名
2c63d87 fix(AY-12): /api/ai/analyze-stock success 不再永远 true
81188c2 fix(AY-3): KOLAggregator pythonPath 兜底 + init 日志
d05a8ac fix(AY-2): EventIntelligence 5 个列名错对齐 DB schema
```
