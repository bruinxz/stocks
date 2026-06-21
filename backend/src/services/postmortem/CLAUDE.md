# services/postmortem/

L8-Postmortem 系列 service. 每日 / 每周 / 增量地把 trading_agents + paper trading
+ attribution 结果总结成 **可解释 / 可回溯** 的复盘产物 (AI 投资日记 / 行为偏差
诊断 / 错误模式聚类 / 改进建议).

与 [[services/attribution/]] 的边界:
- attribution = 算 6 维归因数字 (Brinson-Fachler, factor/industry/timing/...)
- postmortem = 把数字翻译成 **叙事性反思**, 让操盘手看得懂 / 改得动

## 文件清单

- **AIDiaryService.ts** — US-090 [PM-019] 每日 AI 投资日记主入口
  generateForUser(user_id, {date, data_source, llm_source?, cron_run_id?}) →
  LLM ≤ 500 字 / heuristic fallback / upsert AIDiaryEntry. 永不 throw.

- **AIDiaryCronRunner.ts** — US-091 [PM-020] AI_DIARY_GENERATE cron 批量驱动
  runAIDiaryGenerate({date?, user_ids?, dry_run?, enable_llm?, ...}) — 枚举所有
  active user, 逐个 generateForUser, 返聚合 {total/ok/skipped/failed/persisted +
  per_user[]}. 默认 dry_run=false + enable_llm=false (零外网 heuristic).
  挂在 SchedulerService AI_DIARY_GENERATE dispatch + cronRegistry analytics 段,
  推荐 cron `0 18 * * 1-5` (工作日 18:00 — DAILY_ATTRIBUTION_GENERATE 17:00 之后).

- **ErrorPatternAggregator.ts** — US-092 [PM-021] 90 天错误模式聚合主入口
  aggregateForUser(user_id, {period_end, data_source, lookback_days?, cron_run_id?}) →
  bias_patterns / outcome_patterns / attribution_patterns / top_findings / summary
  ≤ 500 字 → upsert error_pattern_reports. 永不 throw (load throw → failed 留痕,
  records < MIN_DATA_DAYS → skipped 留痕, upsert 失败 → persisted=false).
  (user_id, period_end) UNIQUE 走 ON CONFLICT.

- **ErrorPatternCronRunner.ts** — US-093 [PM-022] WEEKLY_ERROR_PATTERN_AGGREGATE
  cron 批量驱动. runWeeklyErrorPattern({period_end?, lookback_days?, user_ids?,
  dry_run?, ...}) — 枚举所有 active user, 逐个 aggregateForUser, 返聚合
  {total/ok/skipped/failed/persisted + per_user[]}. 默认 dry_run=false +
  lookback_days=90. 挂在 SchedulerService WEEKLY_ERROR_PATTERN_AGGREGATE dispatch
  + cronRegistry analytics 段, 推荐 cron `0 10 * * 0` (周日 10:00).

- **ImprovementSuggestionService.ts** — US-094 [PM-023] 改进建议主入口
  generateForUser(user_id, {data_source, period_end?, cron_run_id?}) → 读最近 1 行
  ErrorPatternReport (status=ok) → 把 bias / outcome / attribution / top_findings
  各路 builder 展开为 ImprovementSuggestionUpsertRow → bulkUpsert
  improvement_suggestions. 永不 throw (load throw → failed, no report → skipped
  no_error_pattern, patterns 全空 → skipped patterns_empty, bulkUpsert 失败 →
  failed persisted_count=0). **本 service 与 ErrorPatternAggregator 范式差异**:
  不写"留痕空行" — 没建议就 skipped 返回 (UI 显示"暂无建议"). attribution
  只取 total_contrib<0 维度 (正贡献不需要建议). top_findings 单独 category='top'
  key='cat:original_key' 避免与原始三类冲突. (user_id, period_end, category, key)
  UNIQUE 走 ON CONFLICT.

(后续 story 接入: PM-024 ImprovementSuggestion apply route, ...)

## 范式 — 与 [[services/attribution/AIAttributionSummary]] 5 件套对齐

每个 PM 系列 service 走同一模板, 让单测 / 接入 / fail-OPEN 行为一致:

1. **常量 export** — MAX/MIN/ENDPOINT/TIMEOUT + SOURCE/STATUS Frozen 双枚举
2. **类型 export** — Context (输入摘要) + DataSource (I/O DI) + LLMSource
   (LLM 调用 DI) + Result (返值) + UpsertRow (落库行)
3. **纯函数 export** — buildXxxPrompt / enforceXxxConstraints / heuristicXxx /
   buildXxxEvidence / mapModelRowToContext
4. **主入口 export async** — 三层 fail-OPEN: loadContext throw → skipped 不留痕;
   no ctx → skipped 空留痕; LLM throw/null/invalid → heuristic fallback; upsert
   throw → failed persisted=false. **主流程永不 throw**.
5. **PRODUCTION factory + 单例** — lazy-require model + axios, 单测进程无需 DB /
   网络也能加载 module

## fail-OPEN 留痕分级

| 阶段 | 异常 | status | 是否留痕 | reason |
|---|---|---|---|---|
| loadContext | throw | skipped | 否 (无 ctx 无 evidence) | load_context_threw |
| loadContext | 返 null | skipped | 是 (空 text + status=skipped) | no_attribution_today |
| LLM | throw / 返 null / invalid | ok | 是 (heuristic text + source=heuristic) | llm_threw / llm_returned_null / empty / too_short_N |
| upsert | throw / 返 false | failed | 否 (DB 写不进去) | upsert_threw / persist_failed |

## 三层校验 (与 [[AI_VIEW_MAX_CHARS 5 件套]] 同款)

1. **prompt 上游** — buildXxxPrompt 显式告 LLM "≤ {MAX_CHARS} 字" + 任何业务约束
2. **中游 hard-cap** — enforceXxxConstraints 收 LLM 返值后, 超 cap 截断 (Array.from
   计字符 + `…` 收尾); 空 / 非 string / < MIN_CHARS → fallback
3. **下游 fallback** — heuristicXxx 从 Context 静态拼接, **永远满足契约**, 调用方
   不需校验

## lazy-require chain — 多 model 时 require **全部** model

PRODUCTION DataSource 实现侧调多个 model (e.g. AIDiaryService 同时 lazy-require
PaperTradingPortfolio + DailyAttributionReport + User + AIDiaryEntry) 时:
- 每个 require 在 try/catch 内单独执行 — 任一 model 缺 sequelize init 都 logger.warn
  + 返 null (不抛, fail-OPEN)
- 单测注入 fake DataSource 完全脱离 DB, 不需 mock 任何 model 实例

## (user_id, date) 或 (portfolio_id, date) 业务唯一

所有 PM 系列 model 都走 (entity_key, date) UNIQUE 索引 + service upsert 走
ON CONFLICT DO UPDATE — 当日重跑 (cron 第二次跑 / 手动 replay) 覆盖最新结果.
历史多版本靠 created_at / updated_at 时间戳, 不依赖多版本行.
