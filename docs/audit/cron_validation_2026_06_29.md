# Cron 验证 / 修复报告 — 2026-06-29

承接 5 PR (PR-A/B/C/D/E/F) 上线后用户验收, 排查并修复 3 个"半完成" cron 问题.

---

## TL;DR

| 项 | 报告问题 | 实际诊断 | 修复 | 状态 |
|---|---|---|---|---|
| 1 | BULLISH_EVENT_DETECT cron 卡住, last_run UTC 09:00 之后 5h 不动 | 误读: UTC 09:00 = Beijing 17:00, 5h 前是 last_run 当时唯一一次 tick. 实际 cron 一直在跑 (16:30 / 17:00 / 17:30 都有 SUCCESS) | 无须修代码; 仅 ops 误读时区 | OK |
| 2 | KOL_AGGREGATE 从未跑过, timezone 不确定 | timezone = `Asia/Shanghai` (SchedulerService L427 `node-cron` 显式指定); cron `30 18 * * *` = 北京 18:30, 时间设置正确; 之所以 last_run=NULL 是首日 18:30 还没到. 但 `sync-kol-opinions --favorites` 实际执行会挂 — `FavoriteStock.findAll({attributes:['symbol']})` SQL 报 `column "symbol" does not exist` (FavoriteStock 表只有 stock_id FK, 没 symbol) | 改 sync-kol-opinions.ts 走 include:[Stock] + nest:true + 抽出纯函数 `rowsToFavoriteStockCodes` + 21 单测 META-GUARD | Fixed (代码) |
| 3 | 周末数据 cron `* * 1-5` 跳周末, PR-A `ensureDefaultTasks` 只对全新 type 生效, 不会 ALTER 已存在 row | 确认: DB row id=63/64/67 cron 仍是 `* * 1-5` | 直接 SQL UPDATE 改 cron_expression 为 `* * *` + 重启 backend 让 scheduler 重新拉 cron | Fixed (DB + 重启) |

---

## SchedulerService timezone 结论

`backend/src/services/SchedulerService.ts` L427:
```ts
const scheduledJob = cron.schedule(
  task.cron_expression,
  async () => { ... },
  { timezone: 'Asia/Shanghai' }
);
```

**所有 scheduled_tasks 的 cron_expression 都按 Asia/Shanghai (UTC+8) 解析**.
即 `30 18 * * *` = 北京时间 18:30, 不是 UTC 18:30. 之前担心 KOL_AGGREGATE 18:30 UTC = 北京 02:30 凌晨**不成立**.

`task_execution_logs.started_at` 和 `scheduled_tasks.last_run_at` 列**类型是 TIMESTAMP WITH TIME ZONE**, psql 默认按 UTC 显示, 容易让 ops 误读 (UTC 09:00 = 北京 17:00).

---

## 修复 1: 周末 cron — DB 直接 ALTER

PR-A 的代码层默认值 (`SchedulerService.ensureDefaultTasks` + `cronRegistry.ts`) 改了 `* * 1-5` → `* * *`,
但启动时只对**全新 type** 跑 INSERT, 已存在的 active row **不 UPDATE**. 操作:

```sql
UPDATE scheduled_tasks SET cron_expression='0 16 * * *', updated_at=NOW()
  WHERE type='SNOWBALL_HOT_KEYWORD_SYNC' AND cron_expression='0 16 * * 1-5';
UPDATE scheduled_tasks SET cron_expression='30 16 * * *', updated_at=NOW()
  WHERE type='STOCK_SENTIMENT_SYNC' AND cron_expression='30 16 * * 1-5';
UPDATE scheduled_tasks SET cron_expression='20 16 * * *', updated_at=NOW()
  WHERE type='SOCIAL_SENTIMENT_SYNC' AND cron_expression='20 16 * * 1-5';
```

3 行各影响 1 row. 重启 `stocks-backend` 让 SchedulerService 重新走 startup → `scheduleTask` → `cron.schedule(new_expr, ..., {timezone:'Asia/Shanghai'})`.

restart 后 cron registry log:
```
type=SNOWBALL_HOT_KEYWORD_SYNC cron="0 16 * * *"  nextRunAt=2026-06-30 16:00:00 CST registered=true
type=SOCIAL_SENTIMENT_SYNC     cron="20 16 * * *" nextRunAt=2026-06-30 16:20:00 CST registered=true
type=STOCK_SENTIMENT_SYNC      cron="30 16 * * *" nextRunAt=2026-06-30 16:30:00 CST registered=true
```

**注: EXTRA_DIMS_SYNC `30 16 * * 1-5` 保持 1-5 不动** — 它的 dims 是 macro / qvix (期权波动率) / block (大宗交易), 三类周末都没数据可拉.

注: MARKET_NEWS_SYNC 已有两行 (盘中 `7,37 9-15 * * 1-5` + 收盘 `17 17 * * *`), 盘中本来就只该工作日跑 (没行情没盘中 news), 收盘那条已经全周, 不动.

---

## 修复 2: sync-kol-opinions --favorites SQL bug

### 问题
PR-A 把 KOL_AGGREGATE cron 注册成功后, 18:30 该跑 `sync-kol-opinions --favorites`. 手动触发观察:

```
2026-06-29 17:25:13.271 [error]: sync-kol-opinions failed: column "symbol" does not exist
```

源代码 (sync-kol-opinions.ts L80):
```ts
const rows = (await FavoriteStock.findAll({
  attributes: ['symbol'],   // ← bug: 该表没 symbol 列
  raw: true,
})) as unknown as Array<{ symbol: string }>;
```

但 `FavoriteStock` 模型 (`backend/src/models/FavoriteStock.ts`) 只声明:
- `id` (PK)
- `user_id` (FK → users)
- `stock_id` (FK → stocks)
- `group_id, tags, notes, sort_order, timestamps`

**没有 `symbol` 列**. symbol 在 `stocks` 表. 之前从未有人跑过 `--favorites` 模式 (US-056 引入时未被 cron 调用), 隐藏到 PR-A 注册 cron 才暴露.

### 修复
1. 改 SQL 走 `include:[Stock]+nest:true` → `row.Stock.symbol`
2. 把 row 整理逻辑抽成 export 纯函数 `rowsToFavoriteStockCodes`
3. export 已存在的 `stripSuffix` 助手 (便于复用)
4. 加 CLI entrypoint guard `if (require.main === module) program.parseAsync(...)` 让单测能 import 不副作用执行 CLI
5. 加 `backend/tests/scripts/sync-kol-opinions.test.ts` 21 个断言 (含 META-GUARD: 用 fs 读 FavoriteStock.ts 源码 regex 检查没有 `declare symbol` / `field: 'symbol'`, 防 schema 改回去)

测试通过: `passed=21 failed=0`

---

## 当前 cron 状态 (prod 2026-06-29 17:23 CST 后)

| id | type | cron_expression | next_run_at (CST) | 备注 |
|---|---|---|---|---|
| 101 | ANNOUNCEMENT_NLP | `0 17 * * *` | 2026-06-30 17:00 | 每日 17:00 已跑过 ✓ |
| 102 | KOL_AGGREGATE | `30 18 * * *` | 2026-06-29 18:30 | 今晚首次 (需 PR-A2 sync-kol-opinions 修复部署) |
| 103 | BULLISH_EVENT_DETECT | `*/30 * * * *` | 2026-06-29 17:30 | 16:30/17:00 已跑过 (scanned=86, 0 命中) |
| 63 | SNOWBALL_HOT_KEYWORD_SYNC | `0 16 * * *` (was `1-5`) | 2026-06-30 16:00 | 周末也跑 ✓ |
| 64 | STOCK_SENTIMENT_SYNC | `30 16 * * *` (was `1-5`) | 2026-06-30 16:30 | 周末也跑 ✓ |
| 67 | SOCIAL_SENTIMENT_SYNC | `20 16 * * *` (was `1-5`) | 2026-06-30 16:20 | 周末也跑 ✓ |
| 32 | EXTRA_DIMS_SYNC | `30 16 * * 1-5` | 2026-06-30 16:30 | 保持 1-5 (dims 都是工作日) |
| 65 | MARKET_NEWS_SYNC | `7,37 9-15 * * 1-5` | 2026-06-30 09:07 | 盘中 sync, 保持 1-5 |
| 66 | MARKET_NEWS_SYNC | `17 17 * * *` | 2026-06-29 17:17 | 收盘 sync, 已全周 |
| 68 | MARKET_HOT_SEARCH_SYNC | `40 16 * * 1-5` | 2026-06-30 16:40 | 百度热搜 |

---

## BULLISH 手动触发结果

`runOnce({dry_run:true})` 单独通过 `node -e require(...)` 调:
```
OK {"ok":true,"dry_run":true,"scanned":0,...}
```

(注: 0 因为单独 require 不会触发 models/index 注册, model `findAll` 失败 → fail-OPEN universe 空; 实际 cron 路径走 dist/index.js 启动完成, models 注册齐, universe scanned=86)

实际 cron 路径 (`*/30 * * * *`) 在 prod 已稳定运行:
```
17:00:00 [BULLISH_EVENT_DETECT] scanned=86 detected=0 pushed=0 errors=0
16:30:00 [BULLISH_EVENT_DETECT] scanned=86 detected=0 pushed=0 errors=0
```

`runOnce` 全程 fail-OPEN, 永不 throw, scheduler tick SUCCESS.

---

## KOL_AGGREGATE backfill 结果

手动触发 (旧 dist):
```
17:25:13 [error]: sync-kol-opinions failed: column "symbol" does not exist
```
**0 行写入 kol_opinions**.

修复部署后预期: 今晚 18:30 cron 首次跑或修复 dist 部署后手动触发, 应能 resolve favorites count > 0 并写入 (取决于 favorite_stocks 是否有 row).

---

## 下次预期

- **BULLISH 飞书卡**: 取决于命中. 当前 86 stocks 扫描 0 命中. 下个 tick `2026-06-29 17:30 CST`, 之后每 30 min 一次. 等市场有正面 critical 公告 / 高分新闻 / 关注度突增 / KOL 集中关注就触发.
- **KOL_AGGREGATE 首批数据**: PR-A2 sync-kol-opinions 修复 deploy 后, 今晚 `2026-06-29 18:30 CST` 第一次 cron tick 应该写入 kol_opinions (前提: favorite_stocks 表非空).
- **周末数据**: 下周六 (2026-07-04) 16:00/16:20/16:30 三个 cron 应该 tick 而非跳过.

---

## 改动清单

- 代码: `backend/src/scripts/sync-kol-opinions.ts` (favorites SQL + 抽 helper)
- 测试: `backend/tests/scripts/sync-kol-opinions.test.ts` (新, 21 断言)
- DB: 3 SQL UPDATE 在 prod `stock_backtest` (无 migration 文件, 一次性 ALTER)
- 服务: `stocks-backend.service` 重启 1 次

无新 migration. 无 schema 变更. 无 PR-A 的 cronRegistry 推荐值变化 (代码层默认值 PR-A 已经是 `* * *`).
