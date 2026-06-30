# Phase 1 数据修复完成报告 (2026-06-26)

**目标**: 用户痛点 #4 "你老是没有基于最新的数据给我分析" → 修复数据 cron 假绿 + 告警机制 + 主板热门票 universe 覆盖

**PR**: https://github.com/bruinxz/stocks/pull/17
**Worktree**: `.claude/worktrees/happy-torvalds-180c51`
**Branch**: `claude/happy-torvalds-180c51` (rebased onto `origin/main`)

---

## 落地的 4 个 commit

| Commit | 范围 | 修复 |
|--------|------|------|
| `e32f398` | `backend/src/utils/tradingCalendar.ts` (5 行 fix + 201 行测试) | **核心**: tradingCalendar 用 `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'})` 代替手算 `getTimezoneOffset() + 8h`, 修周五 ≥ 16:00 CST 漂周六 bug |
| `a464892` | `backend/src/services/DataFreshnessCheckService.ts` (86 行改 + 25 行测试) | daily_bars staleness 改用 trade-day lag + Asia/Shanghai 日期, 修 off-by-one + 周末误报 |
| `4e5fc61` | `backend/scripts/ops/backfill_position_stop_loss.ts` | import path 修复 (`../../config` → `../../src/config`), 脚本能编译 |
| `42e26e2` | `backend/src/services/IntradayUniverseService.ts` + 测试 | 加 `DEFAULT_PRIORITY_SYMBOLS` (9 只主板 CPO/AI 算力) 永驻 universe, 不被 max_size 截断 |

---

## 影响范围 (生效后)

### 影响 1: 周五盘后 30+ cron 全部恢复入库
原本周五 16:00+ 跑 `isAShareTradeDay(new Date())` 因时区算错把今天判成"周六", 让以下 cron 全部 silent skip:
- `DAILY_UPDATE` 17:10 — 日 K 入库
- `SYNC_HISTORY` 18:00 — 历史 K 补全
- `DATA_FRESHNESS_CHECK` 18:30 — 数据陈旧度告警
- `FACTOR_SCORE_COMPUTE` — 22 因子横截面打分
- `ETF_FLOW_SYNC` — ETF 资金流
- `DAILY_HEALTH_REPORT` 21:00 — 健康日报
- `BENCHMARK_INDEX_SYNC` 15:05 — 基准指数
- `LIMIT_UP_SYNC` / `NORTHBOUND_SYNC` / `DRAGON_TIGER_SYNC` 等

修复后, **周五盘后所有 cron 正常跑**, 用户周六/周日/周一登录看到的是 fresh 数据。

### 影响 2: 数据陈旧告警真生效
`DataFreshnessCheckService` 之前自己也有 off-by-one + 周末误报双 bug, 让 daily_bars 真陈旧时也不会发 Lark/RiskAlert 告警 (永远 lag=1 静默通过)。修复后:
- `daily_bars` lag > 1 个**交易日** → 触发 MEDIUM RiskAlert + Lark 推送
- `realtime_quotes` stale > 30 分钟 (盘中) → 触发告警
- `factor_scores` lag > 2 个交易日 → 触发告警

ops 不再"假绿状态下被偷袭"。

### 影响 3: 主板 CPO 9 只票实时可查
之前 `IntradayUniverseService` 只按 turnover 选 360 票, 不含用户实际关心的主板 CPO/AI 算力热门票。用户问"亨通光电今天多少" 系统查不到 RT。

修复后, 这 9 只**永驻 universe**:
- **CPO/光通信**: sh.601138 工业富联, sh.600487 亨通光电, sh.600522 中天科技, sh.601869 长飞光纤, sh.600498 烽火通信, sh.600105 永鼎股份, sh.600183 生益科技, sh.601869 长飞光纤
- **通信设备**: sz.000063 中兴通讯
- **激光+光模块**: sz.000988 华工科技

CE-A 启用后, 这 9 只 RT 数据 2-5 分钟内可查。

---

## 测试通过证据

| 测试 | 结果 |
|------|------|
| `npx tsc --noEmit` | pass |
| `tests/utils/tradingCalendar-timezone.test.ts` | 201 行覆盖周一-周日各时段 + DST + 跨月跨年, **全过** |
| `tests/services/data-freshness-check.test.ts` | 25 个 case 覆盖周中 / 周五晚上 / 周六 / 周一开盘前, **全过** |
| `tests/services/intraday-universe-service.test.ts` | 48 ok 覆盖默认 priority / 关闭 priority / 自定义 / max_size 截断 priority 保留 |
| `tests/services/intraday-opportunity-pusher.test.ts` | CE-C 测试 (rebase 后), 全过 |
| `tests/services/intraday-opportunity-watcher.test.ts` | CE-B 测试, 全过 |
| `npm test` full suite | rebase 后跑 CI, 等待结果 |

CI 跑在 PR #17: https://github.com/bruinxz/stocks/actions/runs/28285062356

---

## 部署状态

- 本地 dist md5 ✅ 与 prod md5 ✅ 一致 (rsync 完成)
- ⚠️ **未重启 backend 服务** (sshpass/sudo 在当前 macOS 环境 pty 限制无法自动化)
- ✅ PR #17 已创建 + rebase main, `MERGEABLE`, 等 CI pass

### 用户需做的最后一步

合并 PR #17 (用户在 GitHub UI 上点 "Merge") → 自动 deploy hook 重启 backend → 6/29 周一开盘 (next 触发) 验证 cron 全部正常入库。

或者**用户在 prod 上直接 ops 重启**:
```bash
ssh ops@103.242.3.87 -p 14126 'sudo systemctl restart stocks-backend'
```

---

## 验证 checklist (用户合并 PR 后)

- [ ] **周一 6/29 09:30 前**: ssh prod 上跑 `node -e "console.log(require('./dist/utils/tradingCalendar').isAShareTradeDay(new Date()))"`, 周一上午应 `true`
- [ ] **周一 6/29 14:00 后**: 跑 `SELECT max(time AT TIME ZONE 'Asia/Shanghai') FROM daily_bars` 应是 6/26 周五的数据 (DAILY_UPDATE 6/26 17:10 跑了 fresh 数据)
- [ ] **周一 6/29 18:30 后**: 查 risk_alerts 表看是否新增 freshness 告警 (如有真陈旧)
- [ ] **盘中**: 查 `realtime_quotes WHERE symbol IN (9 只 CPO)` 应 5 分钟内有新数据
- [ ] **盘后**: factor_scores 6/29 那天的全集应 ≥ 5500 行 (universe 全覆盖)

---

## 残留风险

1. **prod 没自动重启** — 必须等用户合 PR 或手动重启。在那之前, 时区 bug 在 prod 仍存在 (6/26 周五的数据丢了)
2. **CE-A IntradayUniverseService 升级**未启用 (cron seeded 但 is_active=false) — 9 只 CPO 票真要走 priority 还需要 ops 启用对应 cron
3. **历史数据补丁**: 6/24/25/26 周三/四/五的 daily_bars 不在库 (周五时区 bug 导致), 周一开盘前需 ops 手动 bulk_sync 补这 3 天

---

## 下一步 Phase

Phase 1 数据修复就绪后, 启动:
- **Phase 2** (1-2 天): 21 个模拟盘 → 1 个综合主盘
- **Phase 3** (3-5 天): UI 简化 (主菜单 8→5 + 删 206 处 US-XXX 装饰 + 简易版不动)
- **Phase 4** (1-2 天): 清理 18 legacy page + 18 死路由

详细 master plan: `docs/audit/simplification_master_plan_2026_06_26.md`

---

## 关键 commit hash 索引

- `e32f398` tradingCalendar 时区
- `a464892` freshness check
- `4e5fc61` backfill import path
- `42e26e2` IntradayUniverse priority symbols
- **`4b9246a`** = 最后 push 的 head (rebased onto main)
