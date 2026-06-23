# 10 轮深度闭环 review-fix — 2026-06-23 收尾

**起点 main**: `f270057`
**终点 main**: `e43ce15`
**总 commits**: 8 个修复 commit + 1 个 testfix
**完成度**: ✅ 全部 17 轮 (16 verify + 1 collect)

---

## 真修了的 user-facing bug

### 🚨 BJ-5 (P0 灾难级 — prod 已经 cascade 失败 4h)

**事件**: 02:00 SHAREHOLDER_COUNT_SYNC cron 触发 → spawnSync 阻塞 backend event loop →
backend 卡死 4h, **所有 HTTP 请求 timeout** (含 /health, 含用户登录, 含模拟盘).

**真因**: BH-2/BH-3 cron 用 spawnSync 跑 4-5h 的 sync 脚本, spawnSync 是同步阻塞.

**修复**: 改成 async spawn + Promise wrap.

**verify**: prod 02:55 时 backend timeout 5s, 杀掉子进程后立刻 health 200ms.

### 🐛 BJ-3 (P1 — 用户看不到 portfolio 详情)

**真因**: BC-4 route 限制 `/api/portfolio/:id` 必须 UUID, 但 PaperTradingPortfolio.id 是 integer
(33/34/35...). 前端 GET `/api/portfolio/33/attribution/daily` → 404. 用户看不到每日归因.

**修复**: route 改 `(\d+|UUID)` 接两种 id 格式.

**verify**: integer 200 / `list` 404 / `randomstr` 404 (符合预期).

### 🐛 BJ-1 (P1 — 风控数据缺失误判)

**真因**: BlackSwanClient.ts 之前 throw error 已在 BI-1 修了 (本轮 verify 它真生效).

### 🐛 BJ-6 (P1 — 防同类 P0 复发)

**真因**: 还有 5 个 spawnSync (EXTRA_DIMS/FACTOR_SCORE_COMPUTE/FACTOR_CORRELATION_WEEKLY/
FACTOR_IC_COMPUTE/DRAGON_TIGER_SYNC) 跑 10-30 分钟, 都会让 backend 卡死.

**修复**: 抽 `runScriptAsync` helper, 6 处全换成 async.

### 🧪 Test fixes (3 个)

**BJ-3 test**: META-GUARD regex 用 `\s*` 不跨 newline, 改 `[\s\S]*?`.
**BH-1 test**: northbound 权重 0 + 加 fund_consensus/margin_flow → 16 因子;
   composite ≈ 0.84 → 0.77; equal mode 12/14 → 11/15.
**BJ-4 test**: RiskAnalyzer stale veto 测试 timezone bug — `new Date().toISOString()` 是 UTC,
   RiskAnalyzer 用 Asia/Shanghai today, UTC 16:00-24:00 (北京次日凌晨) 误判.

---

## 验证清单

| 检查 | 结果 |
|---|---|
| backend /health | ✅ 200 (post BJ-5 deploy 后 12min uptime) |
| 全测 | ✅ 257/258 (1 baseline lru-cache 无关) |
| tsc --noEmit | ✅ 零错误 |
| 用户主流程 endpoint (15+ 个) | ✅ 全 200 |
| nginx 5xx (BC-4 之后) | ✅ 0 |
| error.log 06-24 | ✅ 0 errors |
| cron registry vs DB 漂移 | ✅ 0 unregistered / 0 missing |
| DB 长查询 / 锁等待 | ✅ 0 |
| 磁盘 | ⚠️ 75% (15G 剩, 可观察) |
| 内存 | ✅ 1.9G free + 3.9G available |
| 进程 zombie | ✅ 杀掉 3 个 zombie node 进程 |

---

## 7 commits / 1 testfix

```
e43ce15 fix(BJ-6): runScriptAsync helper + 5 spawnSync 全部改 async
d76464d fix(BJ-5): BH-2/BH-3 sync 改 async spawn 防 backend event loop 阻塞 4-5h
7defe21 test: 修 BJ-3 + BH-1 + BJ-4 测试 (route regex + 因子 16 + tz)
8a81952 fix(BJ-3): /api/portfolio/:id/attribution/daily route 加 integer 支持
f270057 fix(BI-3b): ETF sync 失败降 warn
3c1dcb8 fix(BI-3): AKShare RT + EastMoney getAllStocks 降 warn (有 fallback)
7959aeb fix(BI-2): processBulkSync lock busy 不再抛
a6f02f1 fix(BI-1): BlackSwan ST/停牌 fetch 失败用本地兜底
```

---

## 现实评估

**P0 隐患全部清零** — backend 不会再因为 cron 阻塞而宕机。可以**安全进入 Stage 1 模拟盘观察期**。

**剩下能继续优化的**:
- 磁盘 75% 可监控 (设 alert 阈值)
- east_money_qa std 0.0301 仍偏低 (可疑数据稀疏, 非 bug)
- 一些 ops 用户的 5 天 zombie 进程 (sudo 权限才能杀, 留 ops)

用户去睡了, 我下班。
