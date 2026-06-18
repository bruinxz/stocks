# 73 — 每月因子 IC 衰减监测（Monthly Factor IC Decay）

## A. 操盘手心智

**因子永远在死。**

5 年前用 PE 反转能赚钱（小盘 + 低估值），现在指数化 + 茅指数 + ETF 化把这个 alpha 吃干净了。**没有永远有效的因子**，只有"现在还有效的因子"。

每月我必须问：
1. 每个因子最近 90 天的 IC 还 ≥ 0.03 吗？IR 还 ≥ 0.3 吗？
2. IC 是不是单调衰减（不是噪声）？
3. 因子之间相关性涨了没？两个相关 > 0.7 的因子，等于一个因子
4. 哪些因子该下线 / 哪些该降权 / 哪些可以加新版本

**最忌讳的是"一年不动因子库"**——市场会教你做人。

---

## B. 系统设计

### B.1 月度 IC 体检流程

```
月初第一个交易日 09:00 cron `MONTHLY_FACTOR_IC_REVIEW`
  ├─→ 遍历 18+ active factor
  │     for each factor:
  │       IC_30d  = FactorICReport.run(factor, lookback=30d)
  │       IC_90d  = FactorICReport.run(factor, lookback=90d)
  │       IC_180d = FactorICReport.run(factor, lookback=180d)
  │       IC_360d = FactorICReport.run(factor, lookback=360d)
  │       half_life = computeHalfLife(IC_series)
  │
  ├─→ FactorCorrelationReport.run(all_factors, lookback=90d)
  │     → 相关性矩阵 + 高相关对清单
  │
  ├─→ classify each factor:
  │     hot:  IC_30d ≥ IC_90d ≥ IC_180d × 0.8  (近期效果好)
  │     warm: IC_90d > 0.02
  │     cold: IC_90d ∈ [0.005, 0.02]
  │     dead: IC_90d < 0.005 OR sign flipped vs IC_360d
  │
  ├─→ for each dead/cold factor → 建议下线 / 降权
  │     write `factor_review_recommendations` table
  │
  ├─→ AI 总结报告（≤ 500 字）
  └─→ feishu push + 邮件给 trader user
```

### B.2 自动调权 hook（P1 才做）

```
factor_review_recommendations 落库后
  ├─→ 若 `auto_apply=true`（用户配置）
  ├─→ 写 factor_weights_config:
  │     - dead factor → weight=0
  │     - cold factor → weight × 0.5
  │     - hot factor → weight × 1.2（cap 在 0.3）
  ├─→ 写一份 audit log
  └─→ MultiFactorAlphaStrategy.generateSignals 下次跑读取新权重
```

### B.3 输出结构

```ts
interface MonthlyFactorICReport {
  month: string;                              // YYYY-MM
  generated_at: string;
  factor_health: Array<{
    factor_key: string;
    ic_30d: number;
    ic_90d: number;
    ic_180d: number;
    ic_360d: number;
    half_life_days: number | null;
    ir_90d: number;
    sign_flipped: boolean;
    classification: 'hot'|'warm'|'cold'|'dead';
    recommendation: 'keep'|'boost'|'reduce'|'retire';
  }>;
  correlation_summary: {
    high_corr_pairs: Array<{ a: string; b: string; corr: number }>;
    redundant_clusters: string[][];
  };
  ai_summary: string;
  proposed_weight_changes: Array<{ factor_key: string; from: number; to: number; reason: string }>;
}
```

---

## C. 现状 review

### C.1 已存在（工具齐全）

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/quant/factors/FactorICReport.ts` | 85-859 | ✅ 完整：DailyICRecord / ICStatistics / FactorICReportInput / Options / Result；纯函数 spearmanCorrelation / aggregateICSeries；DefaultFactorICDataSource；class FactorICReport |
| `backend/src/quant/factors/FactorCorrelationReport.ts` | 95-185 | ✅ MIN_PAIR_SIZE=30 / REDUNDANCY_THRESHOLD=0.7 / DailyCorrelationRecord / FactorPairResult / 报告 result |
| `backend/src/quant/factors/library/` | — | 18+ factor 实现 |
| `backend/src/quant/factors/FactorPipeline.ts` | — | factor_scores 计算 + 落库 |
| `backend/src/quant/factors/FactorRegistry.ts` | — | factor 注册表（每个 factor 元信息） |

### C.2 关键缺口

1. **没有 cron 自动触发**：FactorICReport.run 必须手工调用；没有 `MONTHLY_FACTOR_IC_REVIEW` cron
2. **没有"分类 + 推荐"层**：当前只输出 ICStatistics（mean / median / ir / hit_ratio），缺 hot/warm/cold/dead 分类
3. **没有 `factor_review_recommendations` 模型**：评论不落库 → 跑完就丢
4. **没有"调权 hook"**：FactorRegistry 是静态的，没有"按时间变化的 weight" 模型
5. **MultiFactorAlphaStrategy 的权重是 hardcoded**（推断，需 grep 验证）：即使有建议，下游策略不会自动读
6. **没有"sign flip"检测**：IC 从 +0.05 翻到 -0.03 的因子，是非常危险的信号
7. **没有"half-life"计算**：IC 衰减半衰期是判断"因子还有多久 dead"的关键指标
8. **没有"vs 行业 / vs 风格"分层 IC**：当前 IC 是全市场聚合，缺分层

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| FIC-001 | 新建 model `FactorReviewRecommendation.ts`：(month, factor_key, classification, recommendation, evidence JSONB, applied bool) + migration | P0 | — |
| FIC-002 | 新建 `services/factor-review/MonthlyFactorICReviewService.ts`：聚合所有 active factor 的 IC × 4 lookback，落 `factor_review_recommendations` | P0 | FIC-001 |
| FIC-003 | 新增 `services/factor-review/ICClassifier.ts`（pure function）：根据 4 lookback IC + sign flip + half_life → hot/warm/cold/dead | P0 | — |
| FIC-004 | 新增 `services/factor-review/HalfLifeEstimator.ts`：拟合 IC time series 的 exponential decay，输出 half_life_days | P1 | — |
| FIC-005 | 在 SchedulerService 注册 cron `MONTHLY_FACTOR_IC_REVIEW`（每月第一个工作日 09:00）→ 调 MonthlyFactorICReviewService | P0 | FIC-002 |
| FIC-006 | 新建 model `FactorWeightConfig.ts`：(factor_key, effective_from, weight, reason)；MultiFactorAlphaStrategy 读它而非 hardcode | P1 | — |
| FIC-007 | 实现 `applyRecommendations(month, auto_apply=false)`：把 `factor_review_recommendations` 转 `factor_weight_config`；auto_apply=true 自动写、false 需要 admin 接口 confirm | P1 | FIC-001, FIC-006 |
| FIC-008 | 新增 admin route `POST /api/admin/factor-review/:month/apply`：人工 confirm 调权 | P1 | FIC-007 |
| FIC-009 | AI summary：调 trading-agents 输入"本月 18 因子健康表 + 相关性热点" → ≤ 500 字 markdown | P1 | FIC-002 |
| FIC-010 | 前端 FactorWorkspace 新增 `/factor/health` tab：表格 + heatmap + 历史 IC 折线图（recharts） | P2 | FIC-002 |
| FIC-011 | FactorICReport 加 `runStratified(factor, by='industry'\|'mcap_bucket')`：分层 IC（大盘 vs 小盘 vs 中盘） | P2 | — |
| FIC-012 | 飞书推送：FactorReview 完成后 feishuNotifier 发"本月因子 health 概览"卡片 | P2 | FIC-002 |

---

## E. 验收口径

1. 每月 1 号（首交易日）09:30 前 `factor_review_recommendations` 表里有当月 18 条记录
2. 至少 1 条记录的 `classification='dead'` 或 `'cold'`（不可能所有因子一直 healthy）
3. AI summary 引用 ≥ 5 个具体因子 + ≥ 2 个调权建议
4. 用户在 FactorWorkspace 能看到过去 12 月的因子健康趋势
5. `factor_weight_config` 表至少有 1 次基于本流程的写入
6. MultiFactorAlphaStrategy.generateSignals 在下一个月使用新权重，single-run smoke test 可验证
7. 高相关因子对（pearson > 0.7）在前端 heatmap 红色标记
8. 跑 `npm test -- factor-review/*.test.ts` 单测全绿
