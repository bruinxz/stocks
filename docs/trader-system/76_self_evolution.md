# 76 — AI 自进化（Self-Evolution）：日记 + 错误模式 + 自动建议

## A. 操盘手心智

操盘手最大的敌人不是市场，是自己——**重复犯同样的错**。

经典错误模式：
- "我总在涨停板买入"（追高）→ 一年亏 10%
- "我总在 -5% 就割肉"（早砍）→ 错过 80% 反弹机会
- "我偏好科技 + 喜欢主题概念"，但策略是价值 + 高股息 → 策略和性格背离
- "周一总是冲动操作"（行为偏差）
- "在新闻热门股上 over-trade"（噪音追逐）

**AI 自进化的价值**：
1. 自动写日记（用户懒）
2. 自动识别"重复犯的错"
3. 自动给出"改进建议"
4. 关联"策略 vs 性格"匹配度
5. 推荐"哪个策略该停 / 哪个该开"

**结合 BehaviorBiasDetector** 已经有 4 种偏差，这里把它升级为闭环系统。

---

## B. 系统设计

### B.1 AI 日记生成

```
每日 18:00 cron `AI_DIARY_GENERATE`
  ├─→ load 今日:
  │     - DailyAttributionReport (71)
  │     - BehaviorBiasDetector.detectIncremental(today)
  │     - 今日 closed/holding trades
  │     - 今日 RiskAlert
  │
  ├─→ build prompt template:
  │     "你是 user X 的私人投资助理. 今天:
  │      - 总盈亏 +1.2% / vs HS300 +0.3%
  │      - 最大盈利: 600519 +3% (持有 5 天)
  │      - 最大亏损: 002230 -2% (止损)
  │      - 今日偏差检测: chasing_high severity 60
  │      请用第一人称写一篇 ≤ 500 字投资日记,
  │      包含: (1) 今日操作复盘 (2) 情绪/偏差自省 (3) 明日计划"
  │
  ├─→ call LLM → diary text
  └─→ write `ai_diary_entries` (user_id, date, text, evidence JSONB)
```

### B.2 周期性"错误模式识别"

```
每周日 10:00 cron `AI_ERROR_PATTERN_AGGREGATE`
  ├─→ load 过去 90 天:
  │     - 所有 BehaviorBiasDetector.findings
  │     - 所有 DailyAttributionReport.bias_findings
  │     - 所有 closed trade outcomes
  │
  ├─→ pattern detection:
  │     - 频繁出现的 bias type
  │     - 出现频率随时间变化 (变好/变坏)
  │     - 偏差 vs 实际损失关联度
  │
  ├─→ AI summary:
  │     - "您过去 90 天最大问题是 chasing_high (出现 12 次)
  │        累计造成约 -4.5% 损失. 建议:
  │        (a) 加 entry_price 与近 5 日 high 距离 < 3% 时禁买规则
  │        (b) 减少 momentum 类策略权重"
  │
  └─→ 写 `error_pattern_reports` + 推送
```

### B.3 性格 vs 策略匹配度

```
每月一次 `PERSONALITY_STRATEGY_MATCH`
  ├─→ 用户性格画像:
  │     - 偏好行业 (从手动操作 / 自选股推断)
  │     - 风险承受度 (从持仓波动率推断)
  │     - 交易频率 (从 trade count 推断)
  │     - 持仓周期 (从平均 hold days 推断)
  │
  ├─→ 当前策略画像:
  │     - 每个 active strategy 的 (行业偏好 / vol / turnover / hold_days)
  │
  └─→ 匹配度评分 + 建议:
        "您是低频价值型，但您正在跑 CTA100（日频动量）
         匹配度 30%. 建议关 CTA100, 加 HighDividendValue"
```

### B.4 改进建议反哺

```
AI 自进化的所有输出 → 写入 `improvement_suggestions` 表
  - severity: low/medium/high
  - category: bias/strategy/risk_config/data
  - suggested_action: 具体动作 (e.g. "把 atr_risk_pct 从 1.5 调到 1.2")
  - applied: false (默认)
  - applied_by / applied_at

admin UI: 用户 click "apply" → 自动写 user.risk_config 对应字段
```

---

## C. 现状 review

### C.1 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/BehaviorBiasDetector.ts` | 40-460 | ✅ 4 种偏差检测：chasing_high / overtrading / anchoring_loss / loss_aversion_early_take；4 个纯函数 detector；DataSource 注入 |
| `backend/src/services/TradePostmortemService.ts` | 24-103 | ✅ 单笔事后复盘 + suggestions |
| `backend/src/services/StrategyCopilotService.ts` | 759-881 | ✅ "策略 Copilot"对话 — 用户问 → 智能回答（部分覆盖错误模式建议） |
| `backend/src/services/WeeklyReviewReportService.ts` | 449-535 | `buildHeuristicWeeklyOpinion` 模板 AI 意见 |

### C.2 关键缺口

1. **没有"投资日记"主入口**：没有 `AIDiaryService`、没有 `ai_diary_entries` 表
2. **没有"错误模式跨时段聚合"**：BehaviorBiasDetector 是单次诊断（90 天 lookback），缺"模式随时间变化"分析
3. **没有"性格 vs 策略匹配度"分析**：完全缺
4. **没有"改进建议持久化 + 反哺"**：BehaviorBias 的 suggestions 是 finding 内的 string，跑完丢失；没有"待办建议"工作流
5. **没有"已采纳建议 vs 表现改善"度量**：用户采纳后效果如何缺统计
6. **BehaviorBiasDetector.findings.suggestions 是静态模板**（不基于用户具体 trade 个性化）
7. **缺 5th + 6th bias detector**：style_drift（风格漂移）/ mood_volatility（周一冲动等时段偏差）

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| EV-001 | 新建 model `AIDiaryEntry.ts`：(id, user_id, date, text, evidence JSONB, generated_at) + migration | P0 | — |
| EV-002 | 新建 `services/self-evolution/AIDiaryService.ts`：实现 `generateForUser(user_id, date)`；prompt template + LLM call + fallback heuristic | P0 | EV-001 |
| EV-003 | SchedulerService 注册 cron `AI_DIARY_GENERATE`（每日 18:00 工作日）→ 对所有 active 用户生成 | P0 | EV-002 |
| EV-004 | 新建 model `ErrorPatternReport.ts`：(user_id, period, patterns JSONB, summary TEXT, generated_at) + migration | P0 | — |
| EV-005 | 新建 `services/self-evolution/ErrorPatternAggregator.ts`：聚合 90 天 bias / outcome / attribution → patterns | P0 | EV-004 |
| EV-006 | 在 SchedulerService 注册 cron `WEEKLY_ERROR_PATTERN_AGGREGATE`（每周日 10:00） | P0 | EV-005 |
| EV-007 | 新建 model `ImprovementSuggestion.ts`：(user_id, source 'bias'/'pattern'/'monthly'/'manual', severity, category, suggested_action JSONB, applied bool, applied_at, effect_metrics JSONB) + migration | P0 | — |
| EV-008 | 新建 `services/self-evolution/ImprovementSuggestionService.ts`：从 BiasFinding / ErrorPattern / FactorReview 汇集 suggestion → 落表 | P0 | EV-007 |
| EV-009 | admin route `POST /api/improvement-suggestion/:id/apply`：用户 click 后写 user.risk_config / strategy_config 对应字段 | P1 | EV-008 |
| EV-010 | 新建 `services/self-evolution/PersonalityStrategyMatcher.ts`：性格画像 + 策略画像 + 匹配度评分 | P1 | — |
| EV-011 | SchedulerService 注册 cron `MONTHLY_PERSONALITY_MATCH`（每月 1 号 09:00） | P1 | EV-010 |
| EV-012 | BehaviorBiasDetector 新增 2 个 detector：`detectStyleDrift`（行业/风格分布 KL divergence）+ `detectTimeBias`（周一冲动 / 收盘前 over-trade） | P1 | — |
| EV-013 | BehaviorBiasDetector 的 suggestions 个性化：基于用户具体 trade 生成（"建议把 600519 持仓减半" 而非 "建议加严 sizing 阈值") | P2 | — |
| EV-014 | 前端 PortfolioWorkspace `/review/diary` tab：日历 view 历史日记 + 错误模式趋势 + 改进 suggestion 待办 | P1 | EV-002, EV-005, EV-008 |
| EV-015 | 已采纳建议效果跟踪：apply 后 30 天采集 metrics（pnl / sharpe），写 `improvement_suggestions.effect_metrics` | P2 | EV-009 |

---

## E. 验收口径

1. 用户每个交易日在 PortfolioWorkspace 看到当日 AI 日记
2. 每周日生成 ErrorPatternReport，UI 能看到过去 12 周的"主要错误模式"变化
3. 每月 1 号生成 PersonalityStrategyMatcher 报告，至少给出 1 条匹配度建议
4. `improvement_suggestions` 表持续累积；用户能 click "apply" 落地
5. apply 后 30 天能看到 effect_metrics（pnl 变化 / bias severity 变化）
6. BehaviorBiasDetector 至少 6 种 detector
7. AI 日记字数稳定 200-600 字，引用 ≥ 2 个具体 trade
8. `npm test -- self-evolution/*.test.ts` 全绿
