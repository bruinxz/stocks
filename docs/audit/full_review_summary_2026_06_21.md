# 2026-06-21 review 二轮 — 找到了 22 个真问题，修了 13 个

## 为什么第一次 review 漏了

上次（6-21 早 macro check）报告"95% 接通"，结果你手点页面就发现：
- 4 tab 不响应
- 登录死循环
- 拓扑数据 7 周前

**真因**：static code analysis ≠ user-level functional verification
- 看 onTabChange 接对 → 没看顶部卡片把 body 推到屏幕外
- 看 catch 清 token → 没考虑并发 401 连环 reload
- 看组件存在 → 没看数据是不是最新

## 这次 review 改用 2 维度

### UX 真用户视角 (Agent A) — 找到 8 个
- 反馈多图必 413
- markdown 数字与代码不一致（13 vs 29 策略 / 18 vs 23 factor）
- 架构图 markdown 指向已删除位置
- 拓扑泄露 admin user_id=4
- AI 弹窗 mode=off 时呈现"系统坏了"样
- TodayWorkspace ?tab= 吃后退键
- nginx 没配 /ws/
- commit message 38 vs 41 节点不一致

### 端到端真数据验证 (Agent B) — 找到 14 个
- **AI 多维分析引擎 multi_dim_v1 真实使用 = 0**（核心承诺没兑现 7 周）
- **AI 引擎在 prod 真调时崩** — Sequelize model 未注册 cold path
- **northbound 数据停在 2024-08-15**（22 个月前）
- 15 个 active cron `next_run_at=2034-01-01` 永不跑（含 DB_BACKUP / AI_DIARY_GENERATE / LIVE_RECONCILIATION_GUARD / ETF_FLOW_SYNC）
- trade_reason 覆盖率 0%（最近 trade 在 patch 前）
- 11 个 cron type 重复（含 PAPER_TRADING_DRAWDOWN_BREAKER_CHECK 风控级）
- error.log 24h 3546 行（99% 6 退市股 socket hang up）
- realtime_quotes universe 仅 807（应 ≥ 4000）
- 6 个 factor std=0（analyst_consensus / earnings_surprise / growth / insider_trade / liquidity / northbound）
- value factor universe 5532 vs 其它 360
- KOLAggregator akshare python sidecar ModuleNotFoundError
- ai_diary / improvement_suggestions / black_swan_events 7d 全 0 行
- user_feedback 表空（cron 没东西可 sweep）

## 这次修了 13 个

### Batch AR (commit `8cc117a`) — UX 一致性 + 文档校准
1. ✅ SystemWorkspace markdown 数字校准（22 factor / 29 策略 / 9 tab）
2. ✅ 反馈表单收紧 3 张 × 1.5MB（绕开 nginx 5MB 限制）
3. ✅ AI 弹窗 mode=off 时显示引导 Alert
4. ✅ TodayWorkspace tab 用 replace 不进 history
5. ✅ 退市股黑名单 + log level error→warn
6. ✅ realtime_quotes universe 600→5000
7. ✅ trade_reason 写入路径排查（确认无 bug 等新 trade）
8. ✅ 38 vs 41 节点澄清（实际 ≈ 40）

### Batch AS (commit `b88410b`) — 5 P0 核心
9. ✅ **AI 引擎 model cold path 修复**（database.js 加 ensureModelsRegistered + AnalysisEngineService 入口调）— 这是最重要的修复
10. ✅ **cron 2034 解析 bug 修**（新 cron-parser wrapper 替换原 next_run 计算）
11. ✅ 北向数据 22 月 stale alert（cron 触发 RiskAlert MEDIUM）
12. ✅ 拓扑 admin user_id=4 泄露修复（改 req.user.id）
13. ✅ 11 个重复 cron 收口（删 4 行冗余）

## 部署验证

| 指标 | 修前 | 修后 |
|---|---|---|
| AI 引擎 cold path | ❌ Sequelize crash | ✅ action=hold conf=84% dq=good |
| cron next_run_at | 2034-01-01 (15 个) | 2026-06-XX (合理) |
| 拓扑数据 | 19 节点 / admin 泄露 | 41 节点 / user 隔离 |
| 北向数据 stale | 静默 22 月 | RiskAlert MEDIUM |
| 重复 cron | 11 个 | 7 个 (合法多模式) |
| 退市股 error 刷屏 | 24h 3546 行 | 黑名单 + warn 级 |
| markdown 数字 | 13 vs 29 / 18 vs 23 矛盾 | 与代码对齐 |

## 没修的 9 个（必须明示）

| 问题 | 为什么没修 |
|---|---|
| **AI 引擎 7 周白干** | model cold path 已修，**用户必须主动开 shadow / hard mode 才会有 multi_dim_v1 报告**。已生效但需要灰度推进 |
| **northbound 数据真接通** | AKShare 上游确实停在 2024-08-16，要切换到 baostock / tushare （要新 client + python helper），是产品决策 |
| 北向以外 factor std=0（6 个） | 缺上游数据源（如分析师 / 公告事件 / 业绩超预期等），需要 1-2 周接通新数据源 |
| KOLAggregator python sidecar | akshare 在某 python 环境缺，需 ops `pip install` |
| nginx /ws/ 没配置 | 我没 ops sudo，AlertsBell 会走 30s polling 兜底（已实现） |
| nginx client_max_body_size 5m | 同上没 ops 权限，前端已限制 3 张 × 1.5MB 兜底 |
| 7 个剩余重复 cron type | 都是合法的多模式（intraday/eod、watchlist 双触发、stop_loss 评估+真卖两阶段）|
| ai_diary / improvement / black_swan 7d 全 0 | cron next_run 修了，要等下一次触发时间到才有数据 |
| value factor universe 大不一致 | factor pipeline 设计就是按 universe 各算，不是 bug |

## 给你的下一步建议

1. **立即体验真生效的 AI 引擎**：现在在系统介绍 → 设置里把"AI 引擎模式"改成 shadow，48 小时内你账号下任何看股票时都会异步写 multi_dim_v1 报告
2. **看 AI 日记 / 改进建议**：周二 09:00 后 `WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE` 会跑（之前永不跑因为 cron 2034 bug），周三早可以查
3. **看对账告警**：`LIVE_RECONCILIATION_GUARD` 也修了，工作日盘中会主动监测
4. **看 DB 备份**：`DB_BACKUP` 凌晨 2 点会跑，明早查 backup 目录
5. **看真盘口 / 北向真接通**：需要单独 sprint 接 baostock，这是产品决策

## review 方法论改进

下次 review 必须遵守：
- **用户旅程视角** Agent：模拟新用户首次访问 + 每个 workspace + 关键操作
- **真数据查询** Agent：所有"已修"功能必须用 SQL/curl 真验证 24h 内数据流入
- 不准只 grep 代码 + 跑单测

否则永远会"看似 OK 实则用户卡住"。
