# 54 — 行业集中度（Industry Concentration）

> 单股 10% 不爆仓 ≠ 单行业 50% 不爆仓——行业系统性事件（限电、双减、集采）能让 10 只票同时跌停。本 guard 在 post-trade 监控行业占比 + 提供一键再平衡 endpoint。

---

## A. 操盘手心智

行业集中度才是真正的"系统性单点失败"——你以为 10 只新能源是分散，结果集采政策出来 10 只一起 -8%。

控制方法两层：

1. **pre-trade 硬卡（30%）**：US-047 PositionLimitGuard 单行业 max_pct=30%，新单累计超过 → 拒（已生效）
2. **post-trade 软告警（35%）**：US-052 本 guard 在 EOD 评估，持仓涨成超 35% → 写 MEDIUM RiskAlert + 提供一键再平衡

5% buffer（30% → 35%）是 by design：让 normal 价格波动不立即触发告警，否则用户调整完次日又触发。

---

## B. 系统设计

### B.1 双闸门关系（互补）

| | US-047 pre-trade | US-052 post-trade |
|---|---|---|
| **时机** | placeOrder BUY 前 | EOD cron |
| **阈值** | 30% 严格 `>` | 35% 严格 `>` |
| **触发** | 拒单 | RiskAlert MEDIUM + 提供 rebalance |
| **目的** | 防新单恶化 | 防 holding 漂移 |

### B.2 行业计算口径

```
industry_pct(I) = Σ_{p in I} p.market_value / Σ_all p.market_value
```

**cash 不计入分母**——理由：cash 可重新分配到任意行业，"deployed capital 集中度"才是风险。

### B.3 未分类持仓

- Stock.industry 为 null/empty → 归入 sentinel `__UNKNOWN__` bucket
- 渲染为 "未分类"，提示用户去补 Stock.industry 数据

### B.4 一键再平衡

```
POST /api/portfolio/rebalance-industry
  body: {portfolio_id?, dry_run?}
```

算法：
1. 找超 35% 的"worst industry"
2. 该行业仓位按 `gain_pct DESC, symbol ASC` 排序（卖涨幅最大锁利润）
3. 模拟卖每只直到 projected industry pct < 30%
4. 最多卖 2 只（AC 限制；超过转 `partial=true` 等人工）
5. `dry_run=false` 时通过 `facade.closePosition` 真卖

### B.5 多行业并行触发

不同于 DrawdownCircuitBreaker 的单 LEVEL 短路，本 guard 允许多 RiskAlert 并行（行业 A 50% + 行业 B 36% 都写）——给用户完整视图。

---

## C. 现状 review

### C.1 实现完整

- `backend/src/portfolio/risk/IndustryConcentrationGuard.ts:1028 行`
- DEFAULT (line 120-123)：`alert_pct=0.35, rebalance_target_pct=0.30`
- `evaluateAfterClose(user_id?, dry_run?)` + `rebalanceIndustry(user_id, options)` + config CRUD
- 严格 `>` 阈值；5% buffer；`gain_pct DESC` 卖涨幅最大

### C.2 HTTP route 顺序坑已 codified

- `POST /api/portfolio/rebalance-industry` 必须注册在 `/:id` catchall 之前（US-015 + CLAUDE.md L488-493 已记录）
- 不然 Express 会把 "rebalance-industry" 当成 `:id` 参数。

### C.3 facade.closePosition 真执行

- `rebalanceIndustry` 通过 DataSource.executeFullClose → lazy-require facade（避免循环 import）
- 保留 7-method facade 不变（CLAUDE.md L475-481）
- pre-trade guards 自然串行（DrawdownCircuitBreaker SELL 永远允许）

### C.4 cash 不计入分母

- pct = industry_value / Σ(all industry market values)
- 正确反映"我把 deployed capital 多 % 押在这个行业"

### C.5 ⚠️ alert_pct 阈值 35% 硬编码 + UI 配置 tab 缺

- 用户能 PUT `/api/risk/industry-concentration` 调，但 SettingsWorkspace 无 UI tab。
- 不同风险偏好用户应该能调（保守用户 25%，激进用户 40%）。

### C.6 行业映射数据质量未监控

- Stock.industry 字段来自 AKShare 同步，可能"金融"vs"银行"vs"保险"颗粒度不一致；
- 当前 guard 直接 group by industry 字符串，可能误分散（"半导体" + "集成电路" 应该合并）。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-IC-1 | **SettingsWorkspace UI**：行业集中度 tab，能调 alert_pct + rebalance_target_pct + enabled toggle + 看历史 alert 列表 | 用户调到 40% 后下一笔 BUY 仍允许；UI 显示当前各行业占比柱图 |
| US-IC-2 | **行业映射主表**：新 table `industry_canonical_mapping`（raw_industry → canonical_industry），每月由 ops 维护；guard 用 canonical 聚合 | 半导体/集成电路 → 半导体；测试覆盖 |
| US-IC-3 | **板块崩盘联动**：guard 在 evaluate 时调 `MarketRegimeAlertService.getIndustryRegime(industry)`——若该行业近 5 日累计跌 ≥ 10%，alert level 升 HIGH + 触发 auto-rebalance（dry_run=false） | 单测：mock 行业 5 日 -12% → 自动 rebalance 触发 |
| US-IC-4 | **per-portfolio 独立 evaluate**：当前 per-user 聚合所有 portfolio 一起算行业，但每个策略 portfolio 内可能有意集中（DragonHead 100% 一行业是 by design）；改 per-portfolio + 标记 strategy 类型决定阈值 | DragonHead portfolio alert_pct 阈值升到 60% |
| US-IC-5 | **rebalance 进度审计**：每次 rebalance 写 `industry_rebalance_history`（trigger_time, industry, sold_symbols, before_pct, after_pct）；dashboard 出报表 | 跑 1 次手动 rebalance 后可在 dashboard 查到记录 |
| US-IC-6 | **dry_run preview UI**：rebalance-industry endpoint dry_run=true 后端已支持，前端缺 "preview 卖几只 → 确认 execute" 两步式按钮 | UI 跑通 preview → confirm 流程 |

### D.2 与组合 drawdown 的关系

- IndustryConcentrationGuard 触发：行业涨太多（占比超 35%）→ 卖涨幅最大降占比；
- DrawdownCircuitBreaker LEVEL_2 触发：组合跌太多 → 卖涨幅最大止血；
- 两者 SELL 排序逻辑一致（gain DESC），但触发条件相反；
- 同期触发时 facade 重复跑两次 closePosition，PaperTradingPosition 行级锁兜底（防双重）。

### D.3 与 PortfolioConstruction 的反馈

- 若 IndustryConcentration 频繁触发某行业 → PortfolioConstructionService 应该在融合时降低该行业策略的 base weight；
- 反馈链：alert 写入 → 周度统计 → 调 strategy weight in optimizer。

---

## E. 验收口径

- pre-trade 30% 卡 + post-trade 35% 告警双闸门生效
- 一键 rebalance：dry_run preview → execute 闭环
- 多行业并行 alert（不互相 dedup）
- 板块崩盘时（5 日 -10%）联动升级 HIGH + auto rebalance
- per-portfolio 独立维度
- 文件位置：`backend/src/portfolio/risk/IndustryConcentrationGuard.ts`（已存在）+ 新 `industry_canonical_mapping` 表
