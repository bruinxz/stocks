# services/recommendationLoop

`AutomatedRecommendationLoopService.run` 的辅助 helper 集中放这里 — service 主文件已经
~2300 行, 任何"新增分支/跟单/特殊路径"都抽 helper, 不要往 service 里继续堆.

## 文件

- `analysisEngineHardFollowup.ts` — US-023 [AE-004]. 主 QUANT_RECOMMENDATION 跟单完成后,
  追加一轮 `source_type=analysis_engine` 的 autoBuyFromSignals, 让 hard mode
  (US-021/US-022) 落库的 `AIInvestmentSignal(source_type=ANALYSIS_ENGINE)` 也能跟单.

## 抽 helper 的 5 步模板 (与 US-018/US-019/US-020/US-021/US-022 同款)

1. 纯函数 builder (e.g. `buildXxxOptions`) — 从 caller 已有的 base options 派生, 显式
   列出"锁/清/默认值/透传"四类字段, 注释每一行 *为什么* 这样改 (否则 future 维护
   不知道哪些可以动). source_type 类锁定字段必须用 enum 引用, 不要字符串字面量.
2. DataSource interface 把所有 I/O 抽出来 — 即便只有 1 个 method 也要 interface 化,
   是单测的入口. 内层 lazy `require` 而不是顶层 import, 才能在 DB-less 单测环境注入
   fake DataSource 不拽起 sequelize.
3. `createProductionXxxDataSource()` 工厂 + `PRODUCTION_XXX_DATA_SOURCE` singleton
   (caller 默认拿 singleton, 单测注入 fake).
4. 主入口 `async runXxx(source, input): Promise<RunXxxResult>` — 返
   `{ok:true, result}` / `{ok:false, reason, error?}` 标准 envelope, 不抛.
   reason 必须用 export 的常量 enum (e.g. `ANALYSIS_ENGINE_FOLLOWUP_REASONS.XXX`),
   不要在 caller 自创字符串 — Grafana / 看板 group-by reason label 要靠这套枚举.
5. caller (AutomatedRecommendationLoopService.run) 内一行调到, 派生
   base_options 字段透传所有 risk/sizing/gate 参数, 不重新推导. caller 永远
   `await runXxx(PRODUCTION_..., {enabled: ..., base_options: {...}})` 不直接
   import helper 内部纯函数.

## fail-OPEN 而非 fail-CLOSED

本目录的 helper 都是 fail-OPEN 语义 — 失败不阻塞主 loop result.
理由: 这些是 "在主 quant 流程之外追加的额外步骤", 失败不应让整个 loop
返 undefined. 与 risk guard (US-011 wrapFailClosed + handleRiskGuardUnavailable)
对偶 — 后者是 fail-CLOSED, 风控失败必须拒单.
