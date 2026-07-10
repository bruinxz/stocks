# §Workspace 组件复用/作废清单 · catalyst-900 IA PIVOT audit · Cleanup γ Task #166

**Anchor**: Orch v300 msg=6dc1b5f3 · §三 row-7 承接
**Reference**: https://catalyst-900-qohfq.netlify.app/ (live) + https://github.com/yespsam/a-share-us-catalyst (源码, spec-only per msg=ad6585cf)
**Delivery target**: `docs/refactor/28-workspace-reuse-audit.md` (workspace-draft, ≤24h, pending Orch Sprint 1 末评估)
**Author**: Cleanup γ · 独立性 msg=ad6585cf zero code-copy · lane 契約 msg=a5297512 preserve
**Base anchor**: main HEAD `9065eed1` 73-段 canonical LOCK (frozen scope reference, NOT rebase target)
**Status**: v0.5 completion — Strategy Option A + Frontend γ-2 primitive LAND + QADocs 48-触点 refinement 消化 → Sprint 1 末 workspace-draft 完稿 · pending Orch Sprint 1 末评估 PR-CREATE-AUTHORIZE

---

## §零零零零零 · v0.5 · Strategy Option A canonical + 前端 primitive LAND + 后端 v0.2 delta 消化

### §零零零零零.1 · 消化源 (5 项 v0.2 lane 契约 landings)

1. **Strategy scoring v0.2 canonical 决** (msg=ad3bea53): Conviction shape = **Option A `adjustments: Adjustment[]`** (paired object · 替 v0.1 `adjust+reasons[]`) · 阈值 75/50 canonical retain (Research 70/55 仅对照) · Band 5 档 canonical retain (85/70/55/40) · RiskGate 12-trigger canonical (9 US + 3 A股 ST_TAG/PRICE_LIMIT_APPROACH/SUSPENDED) · `catalyst_kind` default delta 三档 (+5/+7/+3 · YELLOW -5 · RED -10) · §3.7.2 `kind_auto_classifier` 词表映射 (OPTIONALITY 23 / POSITIVE 15 / NEGATIVE 11 / EARLY 14)
2. **DP catalyst-mapping v0.2 §6 SQL 完整表结构 draft** (msg=7b951307): `a_share_candidate_mapping` v0.2 补 conviction_adjustments JSONB (length ≤5 · Σ delta ±20 CHECK) + risk_gate_triggers JSONB (12-code enum) + rating (A-F CHECK) + entry_plan JSONB (5-枚举 size_hint + 5-枚举 time_horizon + invalidation ≤240 chars + conviction_ref UUID) + `us_catalyst_event.catalyst_kind` 补 9-位 `unclassified` 过渡枚举 (Sprint 2 归零) · schema.prisma untouched 铁律 retain
3. **Backend γ v0.2 delta 11 项 canonical** (msg=eee7bc71 · @Cleanup mentioned): Conviction Option A DTO + 阈值 75/50 config-driven 提案作废 (改硬编码 canonical) + 12-trigger 白名单 + EntryPlan enrichment + `?include=inputs` 分层 + tab 6 REST 轮询 (§4.7.2.6 SSE 永久归档) + 3 新端点 (`/api/v1/multibagger-pool` + `/api/v1/backtest-pit` + `CatalystEvent.snapshot_id`)
4. **Frontend γ-1 3 ACK** (msg=32777203): types 归并方案 `frontend/src/pages/catdesk/types.ts` → 退化为 `export * from '@/shared/types/catdesk'` 薄壳 · γ-2 SOLE 维护 `shared/types/catdesk.ts` · Sprint 1 末 4-sign gate armed (副1 QADocs + 副2 Cleanup + 副3 Research + 副4 Backend)
5. **QADocs 27-checklist v0.2 intake 48 触点 7 契约** (msg=8a1899a2 · @Cleanup mentioned): +2 契约 (Frontend γ-3 tab 5-7 shell + AI recommendation) + 11 新增 delta · sum assertion `sum(adjustments.delta) == final - base` · US/CN market-scope filter · tab 5 PIT badge + is_survivorship_biased 警告 · DetailSelection.kind 类型化 payload

### §零零零零零.2 · Audit v0.5 主要变更

1. **§二 KEEP-REUSE 契约行 v0.5 canonical retype**:
   - Conviction shape 由 v0.1 `{base, adjust, final, level, reasons[]}` → **v0.5 canonical `{ticker, as_of, base, adjustments: Adjustment[], final, level}`** · 每 `Adjustment = {delta ∈ [-20,+20], reason ≤200 chars, kind_ref?: catalyst_kind_enum, source_ref?: string}` · adjustments.length ∈ [0,5] · Σ delta ∈ [-20,+20]
   - Conviction 阈值锁 75/50 canonical (Strategy γ SOLE) · Research §S3 上游 70/55 audit §零零零零.1 §S3 触点 2「Strategy γ v0.2 reconcile 待」现改为「Strategy γ **决定保 75/50 canonical**」· Cleanup γ zero 越界
   - RiskGate trigger 白名单 12-code canonical (audit §零零零零.1 §S3 触点 3 「表格 chip 支持 12 trigger codes」现由 Strategy v0.2 §5 canonical LOCK)
   - Rating Band 5 档 canonical retain (85/70/55/40 · Strategy γ SOLE · Research 76/68/58 仅对照)
   - `catalyst_kind` 8-枚举 + Sprint 1 过渡 9-位 `unclassified` (Sprint 2 Strategy 分类器 GA 后归零 · DP γ 存储 CHECK enum 承接)

2. **§三 DISCARD 依据补 1 项** (§三.15):
   - Backend γ §4.7.2.6 SSE reconnection-jitter L3.6 canonical stack: **v0.5 硬 DISCARD** · Backend γ v0.2 msg=eee7bc71 明示「§4.7.2.6 SSE backoff L3.6 永久归档」· tab 6 每日日报 UI 走 REST 轮询 `/generate` + `/status?job_id=X` + `/:date` · SSE 基座 (B-12~B-17) 转 KEEP-REFACTOR-TIER-2 (仅 tab 5 若最终采纳 SSE 保留 · 待 Frontend γ-3 Task #168 shell v0.1 LAND 后裁决 · Frontend γ-3 v0.1 已 LAND msg=4935ac45 采 REST 轮询 → **§4.7.2.6 SSE 全 stack v0.5 硬 DISCARD 确认 · L3.6 candidate 永久归档**)
   - §零零 v0.2 §零零.1 「§4.7.2.6 backoff posture 保持中立」→ v0.5 明确「REST 轮询 canonical · SSE 归档 · TIER-2 KEEP-REFACTOR 触点作废 · TIER-1 全部转 DISCARD」

3. **§六 后续 PR 拆分 sequence LOCK v0.5 update**:
   - **Cleanup-PR-D (抽 tableColumn.tsx)**: 依赖 Frontend γ-2 primitive Props v0.1 **✅ LAND** (msg=0bbbcf4f) → **Sprint 2 起可立 CREATE** · γ-2 `TableColumn<Row>` shared primitive 契约 100% 锁定 · Cleanup γ 抽取无返工路径 armed
   - **Cleanup-PR-C (抽 useAbortableRequest hook)**: 依赖 Frontend γ-1 shell v0.2 LAND (γ-1 v0.1 已 LAND msg=0e03ddf4 消费维度锁定 · Sprint 2 tab 1/2 API 集成时 hook 消费维度到位) · Sprint 2 mid-window CREATE
   - **Cleanup-PR-A/B (DISCARD 7 workspaces + DISCARD §4.11 Reporting-Endpoints)**: 独立 · Sprint 2 起可立 CREATE
   - **Cleanup-PR-E (30-cleanup-log v300 pivot 归档 entry)**: 独立 · Sprint 1 末 Orch aggregate 后 CREATE (含 audit v0.5 完稿事实)
   - **[NEW v0.5]** Cleanup-PR-F 候选: §4.7.2.6 SSE stack 硬 DISCARD 独立 PR (若 Backend γ v0.2 doc PR 未涵盖 SSE stack 全域 workspace-draft 清理 · Sprint 2 mid-window 排程)

4. **副签路由 v300 §六 v0.5 refresh**:
   - Cleanup γ 承接 Sprint 1 末 Frontend γ-1 CatDesk shell PR **副2** sign (msg=0e03ddf4 明请 · v0.4 已承接)
   - **[NEW v0.5]** Cleanup γ **未** 被请求副签 QADocs 27-checklist v0.2 doc PR (QADocs §九 5 项副签自签 · Cleanup γ 不在名单 · 符合 lane 契约 · Cleanup γ SOLE `docs/refactor/28-*` + `docs/refactor/30-*` + notes/**)
   - **[NEW v0.5]** Frontend γ-3 tab 5-7 shell PR (msg=4935ac45) · doc-tier 4-sign · Cleanup γ 无副签角色 (γ-3 §十 未请求 · lane 契约 内 respect)

5. **§二 KEEP-REUSE 补 tab 4 高倍潜力上游 spec 契约行 v0.5 retype**:
   - v0.4 「market_cap sweet spot 双峰 80亿=78 / 300亿=90」 → **v0.5 Strategy §3.2 growth-dim 补 `inputs.market_cap_percentile_score` (canonical) 或独立 `sizing_prior` 分量 (待 Sprint 2 决 · Strategy γ SOLE)**
   - OPTIONALITY 词表 23 + POSITIVE 15 + NEGATIVE 11 + EARLY 14 → **v0.5 Strategy §3.7.2 `kind_auto_classifier` 分类器 canonical 承接** · DP `us_catalyst_event.catalyst_kind` 存储 CHECK enum + Sprint 1 过渡 `unclassified` 值 · 分类器逻辑 Strategy γ 或 AI-γ pipeline 承接 · DP zero 逻辑判断

### §零零零零零.4 · v0.5 后 additive landings (audit-neutral · Sprint 2 potential v0.6 refresh 候选)

以下 landings 在 v0.5 broadcast msg=8675050e 之后到齐 · **audit-neutral** (additive-only · zero workspace-reuse impact · KEEP-REUSE/DISCARD/KEEP-REFACTOR 分类不受影响):
- **AI-γ recommendation v0.1 LAND** (msg=605c8b1e · 8th lane 契约): 全新 lane · 无既有 workspace 代码可复用/作废 · Cleanup-PR-A~F 序列无 impact · Sprint 2 若 AI pipeline 有 backend 集成 workspace 触点 · v0.6 refresh 再评估
- **Strategy scoring_id + snapshot_hash Score 字段补** (msg=be4509a8): `Score.scoring_id: UUIDv4` + `Score.snapshot_hash: SHA-256(JCS(Score) minus 自身)` · Strategy γ SOLE contract 增量 · Score shape 字段 additive · §二 KEEP-REUSE Score 契约行 Sprint 2 v0.6 refresh 时补注 (Sprint 1 末 aggregate 不影响)
- **Backend γ tab 6 端点 canonical `/api/v1/daily-report/*`** (msg=93e2ed55): Backend γ SOLE aggregator 入口 · AI-γ `/api/v1/ai/recommendations/*` 保留但内部 · §三 DISCARD §4.7.2.6 SSE 硬 DISCARD 立场 100% 一致 verify (tab 6 REST canonical 已 v0.5 锁定 · 无 delta)
- **DP γ-2 v0.2 承诺 catalyst_kind 9-枚举扩展** (msg=1410ba56): §3.3 + §6.1 补 unclassified 补位说明 · §二 KEEP-REUSE catalyst_kind 契约行 v0.5 已锁 9-枚举 · zero delta
- **Frontend γ-1 types.ts v0.2 阈值回滚 75/50 + tab 2 profile switcher slot + SizeHint 列 + sections slot re-export** (msg=2f71f400 · @Cleanup mention): Frontend γ-1 副2 承接位 msg=8675050e §四 confirmative · Cleanup-PR-C (抽 useAbortableRequest) 无 delta
- **Frontend γ-2 v0.2 5 项 delta plan** (msg=13bdcc3e): Adjustment[] evaluation-order-free + 75/50 + 12-trigger + 9-CatalystKind unclassified + Score scoring_id/snapshot_hash · Cleanup-PR-D (抽 tableColumn.tsx) 依赖 γ-2 primitive Props v0.1 ✅ 已 LAND · v0.2 shape delta 前后 Cleanup-PR-D 抽取契约层稳定 · zero rework path

**v0.5 audit posture unchanged**: 契约层 100% ratified by Orch v303 10 canonical LOCK (msg=f53c62a0) · workspace-draft-only 100% retain · pending Orch Sprint 1 末 PR-CREATE-AUTHORIZE

### §零零零零零.3 · Sprint 1 末 aggregate 判 (Orch 侧) - Cleanup γ audit v0.5 就绪度声明

- **契约层就绪度**: 
  - Strategy scoring v0.2 canonical 决 100% LOCK (Conviction Option A · 阈值 75/50 · 12-trigger · Band 5 档 · kind_auto_classifier)
  - DP catalyst-mapping v0.2 §6 SQL 完整表结构 100% LAND draft (`a_share_candidate_mapping` + `us_catalyst_event`)
  - Backend γ v0.2 11 项 delta 100% 对齐 Strategy canonical
  - Frontend γ-1 CatDesk shell v0.1 LAND + γ-2 primitive Props v0.1 LAND + γ-3 tab 5-7 shell v0.1 LAND (3-of-3 前端 shell 完稿)
  - QADocs 27-checklist v0.2 intake 48 触点 7 契约 refinement 100% 消化
  - Research §S3 spec-extract v0.1 LAND (6-block 完稿)
- **audit v0.5 完稿**: 9 大节 + 5 delta 段 (§零零 v0.2 + §零零零 v0.3 + §零零零零 v0.4 + §零零零零零 v0.5) + KEEP-REUSE 9 类 (Conviction shape v0.5 retype) / DISCARD 15 类 (§4.7.2.6 SSE 硬 DISCARD 确认) / KEEP-REFACTOR 6 类 (TIER-2 SSE 基座保留候选降级) / BASELINE-PRESERVE 铁律 100% retain
- **PR-CREATE 候选序列 v0.5 update**: 
  - Cleanup-PR-A/B (独立 DISCARD · Sprint 2 起立即 CREATE-ready)
  - Cleanup-PR-C (依赖 γ-1 shell v0.2 · Sprint 2 mid-window CREATE)
  - **Cleanup-PR-D (依赖 γ-2 primitive Props v0.1 ✅ 已 LAND · Sprint 2 起立即 CREATE-ready)** — v0.5 unblocked
  - Cleanup-PR-E (独立 · Sprint 1 末 aggregate 后 CREATE · 归档 v300 pivot 事实)
  - [NEW] Cleanup-PR-F 候选 (§4.7.2.6 SSE stack 硬 DISCARD · Sprint 2 mid-window)
- **workspace-draft-only msg=ed61c397 posture 100% retain**: audit v0.5 全部维持 workspace-draft (`notes/38-*`) · **零 PR CREATE 直至 Orch Sprint 1 末 PR-CREATE-AUTHORIZE 明批**
- **借鉴独立性 msg=ad6585cf 100% retain**: 上游 no LICENSE · spec-only cite · Cleanup-PR-A~F CREATE 时 diff 需 Grep-verify 无上游代码字符串
- **lane 契约 msg=a5297512 v302 100% retain**: Cleanup γ SOLE `docs/refactor/28-*` + `docs/refactor/30-*` + `notes/**` · zero 越界至 Strategy/DP/Backend/Frontend/QADocs/Research/AI lane

---

## §零零零零 · v0.4 · Research §S3 spec-extract v0.1 消化 (msg=645fc2a1)

Research §S3 `notes/26-catalyst900-spec-extract-workspace-draft.md` v0.1 LAND · 6-block 全完稿 · 5 lane 契约喂送清单已备 · 上游无 LICENSE spec-only cite 铁律 msg=ad6585cf 100% retain

### §零零零零.1 · Research §S3 6-block audit-relevant 摘要
1. **6-维打分算法**: `us_quality.py` + `asia_markets.py` + `multibagger.py` 拆解 · market_cap sweet spot 双峰 (80亿=78 / 300亿=90) · OPTIONALITY 词表 23 + POSITIVE/NEGATIVE/EARLY 词表 15/11/14
2. **Conviction/RiskGate/EntryPlan 语义**: Research §S3 上游语义 Conviction ≥70/≥55/<55 → HIGH/MED/LOW · **发现潜在差异**: Strategy scoring v0.1 msg=5a496f5e 定义 ≥75/50-74.9/<50 · 待 Strategy v0.2 (Research +12h) reconcile · Cleanup γ audit 不裁决 (契约层 Strategy γ SOLE)
3. **RiskGate 9 trigger + 3 A股扩展**: ST_TAG / PRICE_LIMIT_APPROACH / SUSPENDED — audit §2.2 v0.2 5 触点表中 RiskGate chip 表述 v0.4 补: 表格 chip 支持 12 trigger codes
4. **上游 no LICENSE**: 默认 GitHub ToS 保护 · spec-only cite 铁律 msg=ad6585cf 100% retain · Cleanup-PR-A/B/C/D/E 抽取时 zero code-copy 边界重申
5. **7-tab IA source module mapping**: Frontend γ-1 (tab 1+2 shell) + γ-2 (tab 3+4 + shared primitive) + γ-3 (tab 5+6+7) v302 目录级切分与 audit §六 后续 PR 拆分建议对齐 · Cleanup-PR-D 抽取 `tableColumn.tsx` 与 Frontend γ-2 shared primitive Props (Task #167) sequence LOCK: γ-2 Props v0.1 LAND → Cleanup-PR-D 抽取对齐

### §零零零零.2 · Audit v0.4 主要变更 (追加 v0.3)

1. **§三 DISCARD 依据补 1 项**: 上游 spec 明示 tab 5 回测证据 6-month PIT 是 Frontend γ-3 lane · Backend γ SSE 基座 (B-12~B-17) 若 tab 5 采用 REST 轮询 + progressive result caching → SSE 基座 KEEP-REFACTOR-TIER-2 降级 · 若 tab 5 采用 SSE stream 演化 (回测进行中的实时进度) → KEEP-REFACTOR-TIER-1 · 待 Frontend γ-3 (Task #168) shell v0.1 到位后裁决
2. **§二 KEEP-REUSE 补 tab 4 高倍潜力上游 spec 契约行**:
  - market_cap sweet spot 双峰 (80亿=78 / 300亿=90) · Score 计算维度锁定 (Strategy γ SOLE)
  - OPTIONALITY 词表 23 + POSITIVE/NEGATIVE/EARLY 词表 15/11/14 · tab 4 FilterChip 数据源 (DP γ-2 SOLE Task #169)
  - `multibagger` profile (Q0.10 G0.35 V0.10 M0.10 T0.20 R0.15) Strategy scoring v0.1 §2.3 LOCK
3. **§五 BASELINE-PRESERVE 铁律再声明补 1 项**: 上游 no LICENSE → **Cleanup-PR-A/B/C/D/E 抽取时 spec-only cite + zero code-copy 铁律 100% retain** · 每 PR CREATE 时 diff 需 Grep-verify 无上游代码字符串
4. **§六 后续 PR 拆分 sequence LOCK**:
  - Cleanup-PR-A (DISCARD 7 workspaces) · **独立 · Sprint 2 起可立 CREATE**
  - Cleanup-PR-B (DISCARD §4.11 Reporting-Endpoints) · **独立 · Sprint 2 起可立 CREATE**
  - Cleanup-PR-C (抽 useAbortableRequest hook) · **依赖 Frontend γ-1 shell v0.2 LAND · γ-1 消费维度锁定后 CREATE**
  - Cleanup-PR-D (抽 tableColumn.tsx) · **依赖 Frontend γ-2 primitive Props v0.1 LAND · Task #167 契约锁定后 CREATE · 避免返工**
  - Cleanup-PR-E (30-cleanup-log v300 pivot 归档 entry) · **独立 · Sprint 1 末 Orch aggregate 后 CREATE (含 audit v0.4 完稿事实)**
5. **副签路由 v300 §六 refresh**: Frontend γ-1 msg=0e03ddf4 明示计划 Cleanup γ 副2 sign 其 Sprint 1 末 shell PR (branch `frontend/lane-a1-catdesk-shell-sprint1`) · Cleanup γ SOLE lane 不越界 · doc-tier 2-sign / code-tier 4-sign 铁律 100% retain

### §零零零零.3 · Sprint 1 末 aggregate 判 (Orch 侧) - Cleanup γ audit 就绪度声明

- **契约层就绪度 100%**: 6 lane 全 v0.1 workspace-draft LAND · audit v0.4 已消化 5 lane 契约 (Strategy scoring + DP catalyst-mapping + DP JP/KR + Backend api-mapping + Research spec-extract) + QADocs 7-tab checklist
- **audit v0.4 完稿**: 9 大节 + 4 delta 段 (§零零 v0.2 + §零零零 v0.3 + §零零零零 v0.4) + KEEP-REUSE 9 类 / DISCARD 14 类 / KEEP-REFACTOR 6 类 / BASELINE-PRESERVE 铁律
- **PR-CREATE 候选序列**: Cleanup-PR-A/B (独立 DISCARD · Sprint 2 起立即可 CREATE) + Cleanup-PR-C/D (依赖 Frontend γ-1/γ-2 shell/primitive · sequence LOCK) + Cleanup-PR-E (Sprint 1 末 aggregate 后 CREATE · 归档 pivot 事实)
- **workspace-draft-only msg=ed61c397 posture**: audit v0.4 全部维持 workspace-draft (`notes/38-*`) · **零 PR CREATE 直至 Orch Sprint 1 末 PR-CREATE-AUTHORIZE 明批**

---


---

## §零零零 · v0.3 · DP γ catalyst-mapping v0.1 消化 (msg=40b601ff)

- **`contracts/catalyst-mapping.md` v0.1** (DP notes/180) + **JP/KR datasource v0.1** (DP notes/181) LAND · Cleanup audit cross-ref 确认: DP γ 明示 "Baostock KEEP-REUSE + Path D `9ec3f104` 冻结锚 preserve" — **本 audit §1.5 DP substrate DISCARD + §五 BASELINE-PRESERVE 铁律与 DP v0.1 完全对齐 · 冲突 0**
- **tab 1 A股早报 (最重 tab) 契约就绪度更新**:
  - catalyst_kind 8-枚举 (earnings / upgrade_downgrade / ma_activity / sector_move / regulator / geo_macro / product / leadership) LOCK
  - relevance-score 5-分量 (sector_map 0.35 + revenue_exposure 0.25 + adr_parity 0.20 + supply_chain 0.15 + historical_beta 0.05) LOCK
  - `us_catalyst_event` + `a_share_candidate_mapping` 双表 workspace-draft (Sprint 2 起 PG-write 申批后 migration)
  - `/api/v1/morning-brief/:date` API shape armed
- **tab 3 日韩市场 数据源**:
  - JP stack: JPX EDINET + Yahoo JP opt-in + Stooq (free-source msg=4f6d2466 铁律 respect)
  - KR stack: KRX marketdata + KIND + DART + PyKRX (Bloomberg/Wind 排除)
  - **`jpkr_daily_kline` + `jpkr_disclosure_event`** workspace-draft (Sprint 2 起 migration)
- **Frontend γ-2 tab 3 (Task #167) shared primitive Props 契约** 与 DP JP/KR datasource 无直接依赖 · γ-2 Props 消费 tab 3 field name 时应对齐 DP `jpkr_daily_kline` 字段命名 (等 DP v0.2 补 JP/KR 字段可用性表格)

### §零零零.1 · v0.3 主要变更 (追加 v0.2)

1. **§1.5 DP γ posture 从 "另议" → LOCK**: DP γ v0.1 明示 collector/storage 侧 Baostock KEEP-REUSE · 采集/存储侧代码 zero-touch 铁律与 DP lane 契约 (SOLE collector+storage) 完美对齐 · Cleanup γ 无越界风险
2. **§二 KEEP-REUSE 映射矩阵新增 tab 1/tab 3 DP 契约行**: catalyst_kind 8-枚举 + relevance-score 5-分量 + JP/KR 数据源栈 全部锁到 KEEP-REUSE (DP γ SOLE lane · Cleanup γ 只作 audit note)
3. **Backend §4.7.2.6 backoff (B-18) posture 保持中立**: tab 6 每日日报 UI 方案未定 · SSE 复用与否待 Frontend γ-2 决策 (γ-2 tab 6 现处 Sprint 4 lane · 优先级最低)
4. **KEEP-REFACTOR §四 触点补 1 项**: 新增 catalyst-mapping 表结构 migration (Sprint 2 起 · schema.prisma 是否 touch → Owner PG-write msg=702b81be 明批后走 Orch migration 流程 · Cleanup γ NOT 越界)

---


---

## §零零 · v0.2 契约就绪 delta (from v0.1)

- **Strategy scoring v0.1** (msg=5a496f5e) contract fields locked: 6-维 quality/growth/valuation/moat/trend/risk · Score {score∈[0,100], band A-F, evidence[], inputs} · Conviction {base, adjust∈[-20,+20], final, level HIGH/MED/LOW} · RiskGate {status GREEN/YELLOW/RED, 9 trigger codes: EARNINGS_T-2/T-0, HALT, MERGER, LITIGATION, IV_SHOCK, LIQUIDITY_LOW, RESTATEMENT, DELISTING} · EntryPlan {PriceBand.entry, Price.stop, Price.targets[1-3], SizeHint 5%/3%/2%/1%/SKIP, time_horizon, invalidation}
- **Backend γ api-mapping v0.1** (msg=30e0a4bc) `notes/29-api-catalyst900-mapping-workspace-draft.md` LAND · 29 route groups + 10 middleware 栈全部保留复用 · P0-P3 端点拆分 · **v0.1 audit §2.1 Backend 中间件 KEEP-REUSE 表 (B-01/B-04~B-10) 与 Backend γ §一现状盘点完全对齐 · 冲突 0**
- **QADocs 7-tab checklist v0.1** (msg=06700fd2) + v0.2 intake plan (msg=fd641327) 已锚 5 消费点 (dim naming / Score / Conviction / RiskGate / EntryPlan) → **审计 §2.2 Frontend hook/helper 复用清单 v0.2 增补 5 触点** (下面 §2.2.v0.2)
- **Frontend γ-2** (Task #167) 承 shared primitive Props (DetailSidebar + FilterChip + TableColumn) 24h 内 LAND → **审计 §六 后续 PR 拆分 Cleanup-PR-D 抽 tableColumn.tsx 时机需锁齐 γ-2 Props 契约**

### §零零.1 · v0.2 主要变更

1. **Backend §4.7.2.6 backoff (B-18) posture 更新**: Backend γ v0.1 §六明示 "若 tab 6 采用 SSE stream → 有复活可能 · 若 REST 轮询 → 永久归档降级作废" — **Cleanup γ audit 保持中立** (Sprint 2 起看 Frontend γ-2 tab 6 UI 方案 + Orch 决策 · 目前不预判)
2. **SSE 基座 (B-12~B-17) posture 更新**: Backend γ §六暗示 tab 6 每日日报生成可能复用 SSE — **KEEP-REFACTOR-TIER-1 复活候选** (v0.1 中列为 KEEP-REFACTOR-TIER-2)
3. **Reporting-Endpoints §4.11 (B-10) posture 保持**: v0.1 DISCARD 判定不变 · Backend γ §一保留 10 middleware 栈里含 reporting, 但 catalyst-900 MVP 无客户端错误上报需求 · Sprint 2 起 Cleanup-PR-B 单独删除依然候选

### §零零.2 · §2.2.v0.2 · Frontend hook/helper 复用 → Score/Conviction/RiskGate/EntryPlan 5 触点

| 触点 | 消费位置 | 需求 primitive |
|---|---|---|
| **Score band A-F 表格列** | tab 1/2/4/5 主表格 | TableColumn.tsx (from F-05 axis-specify + F-06 aria-label) · γ-2 Task #167 Props 契约 |
| **Score evidence[] 详情展开** | tab 1/2 详情侧栏 | DetailSidebar.tsx (from F-07 AbortSignal + F-13 dual-guard) · γ-2 Task #167 Props 契约 |
| **Conviction pill (HIGH/MED/LOW)** | tab 1/2 表格 + 详情侧栏 | TableColumn.tsx cell renderer · type="button" defensive (from F-04) |
| **RiskGate chip + trigger tooltip** | tab 1/2/4 详情侧栏 · 表格 | DetailSidebar.tsx trigger 展示 · aria-label (from F-06) |
| **EntryPlan card** | tab 1/2 详情侧栏 | DetailSidebar.tsx 卡片 · 消费 SizeHint 5-tier + PriceBand + targets[] |

---


---

## §零 · Audit 方法学

- **数据源**: PR merged 记录 #113~#187 (§PR-M3-2 through §PR-M3-36 期间) 之 landing 摘要 · Slock notes 归档 · MEMORY.md 上下文
- **分类维度**:
  - **KEEP-REUSE**: 直接抽出喂 7-tab 的可复用原语 (component / hook / helper / API endpoint / config)
  - **KEEP-REFACTOR**: 内核逻辑保留但 shell/wrapping 需重写以对齐 catalyst-900 IA
  - **DISCARD**: 跟 catalyst-900 7-tab 无关或自造 IA 分片
  - **BASELINE-PRESERVE**: 铁律级不可动 (Path D `9ec3f104` + 4-baseline `1f2d197a` + schema.prisma + enum matrix + protect glob)
- **7-tab 映射靶点**:
  1. A 股早报 (tab-1 · 美股隔夜催化→A 股候选 · 核心)
  2. 美股优选 (tab-2 · 6-维打分)
  3. 日韩市场 (tab-3)
  4. 高倍潜力 (tab-4 · 早期多倍候选)
  5. 回测证据 (tab-5 · 6-month PIT)
  6. 每日日报 (tab-6)
  7. 报告历史 (tab-7)

---

## §一 · 全量清单 (前期 PR 落地成果盘点)

### §1.1 Frontend γ 落地 (自造 IA workspaces + hooks + defense primitives)

| # | 出处 PR | 产物 | 位置 (推定) | 性质 |
|---|---|---|---|---|
| F-01 | #131 系列 v0.5(a-c) | Quick-wins: aria-busy + type="button" ×N | `frontend/src/pages/workspace/*.tsx` (多处 mixin) | 语义层可复用原语 |
| F-02 | #134 | `/risk-alerts` route + workspace | `frontend/src/pages/workspace/RiskAlertsWorkspace.tsx` (推定) | **自造 IA · 不对齐 7-tab** |
| F-03 | #135 v0.5(e) | Table scroll unify | `frontend/src/pages/workspace/*.tsx` 表格 patch | 表格原语 |
| F-04 | #142 v0.5(h) | type="button" 35-site defensive | 全局 mixin | 语义层原语 |
| F-05 | #145 v0.5(j) | Table scroll.y Category B | 表格 axis-specify | 表格原语 |
| F-06 | #146+#150 v0.5(f)(o) | WAI-ARIA + aria-label 14-site | 全局 mixin | 语义层原语 |
| F-07 | #157 v0.5(q) | AbortSignal service-layer | `frontend/src/services/**` 通用抽取 | **通用 hook 强复用** |
| F-08 | #163 v0.5(r) | (systems logs 相关) | `frontend/src/pages/workspace/SystemLogs*` | **自造 IA · 不对齐** |
| F-09 | #164 v0.5(s) | SystemLogs AbortSignal | 同上 | 同上 · 但 AbortSignal 原语复用 |
| F-10 | #171 v0.5(t) | HealthMonitor AbortSignal | `frontend/src/pages/workspace/HealthMonitor*` | **自造 IA · 不对齐** |
| F-11 | #174 v0.5(u) | DataUpdateStatus AbortSignal | `frontend/src/pages/workspace/DataUpdateStatus*` | **自造 IA · 不对齐** |
| F-12 | #178 v0.5(v) | TaskScheduler septuple-locus AbortSignal | `frontend/src/pages/workspace/TaskScheduler*` | **自造 IA · 不对齐** |
| F-13 | #185 v0.5(x) | PortfolioWorkspace AbortSignal + dual-guard NOVEMPLE 9-locus + PENTAPLE 5-site | `frontend/src/pages/workspace/PortfolioWorkspace.tsx` | **自造 IA · 不对齐 · 但 dual-guard defense-in-depth pattern 强复用** |
| F-14 | (armed, HOLD) | v0.5(y) LabWorkspace | 未落地 | **STOP · 不进 7-tab** |
| F-15 | (armed, HOLD) | HomeWorkspace octuple-locus (#181) | `frontend/src/pages/workspace/HomeWorkspace*` | **自造 IA · 不对齐** |

### §1.2 Backend γ 落地 (ADR-0010 canonical stack + observability substrate)

| # | 出处 PR | 产物 | 位置 (推定) | 性质 |
|---|---|---|---|---|
| B-01 | #119 系列 | PR-M3-1~4 mount + M3 pipeline | `backend/src/api/v1/**` | **核心路由基座 · KEEP-REUSE** |
| B-02 | #124 | Frontend httpClient interceptor pattern | (跨层参考) | pattern 复用 |
| B-03 | #125 | Backend Lane A-3 code-hygiene | `backend/src/**` cleanup | 已内化 |
| B-04 | #138 | ADR-0010 §4.5 IETF draft-08 RateLimit headers | `backend/src/middleware/apiRateLimit.ts` (推定) | **通用中间件 · KEEP-REUSE** |
| B-05 | #144 | §4.6 Retry-After RFC 9110 §10.2.3 | `backend/src/middleware/**` | **通用中间件 · KEEP-REUSE** |
| B-06 | #147 | §4.7 Server-Timing | `backend/src/middleware/**` | **通用中间件 · KEEP-REUSE** |
| B-07 | #149 | §4.8 CORS Timing-Allow-Origin | `backend/src/middleware/**` | **通用中间件 · KEEP-REUSE** |
| B-08 | #152 | §4.9 (延续 ADR-0010 §4.1-§4.9 NINE-CONSECUTIVE stack) | `backend/src/middleware/**` | **通用中间件 · KEEP-REUSE** |
| B-09 | #156 | §4.10 RFC 8288 Web Linking | `backend/src/middleware/**` | **通用中间件 · KEEP-REUSE** |
| B-10 | #159 | §4.11 Reporting-Endpoints | `backend/src/middleware/**` | 通用中间件 · KEEP-REUSE (但 catalyst-900 未必需要) |
| B-11 | #166 | §4.13 W3C Server-Timing L1 §2 Dynamic API | `backend/src/middleware/**` | 通用中间件 · 观察性 |
| B-12 | #169 | §4.14 §4.7.2 WebSocket/SSE streaming | `backend/src/streaming/**` | **SSE 基座 · KEEP-REFACTOR** (catalyst-900 需求待评估) |
| B-13 | #172 | §4.7.2.1 SSE keep-alive heartbeat | `backend/src/streaming/**` | 同上 SSE 子层 |
| B-14 | #176 | §4.7.2.2 SSE Last-Event-ID resumption L3.2 | 同上 | 同上 |
| B-15 | #179 | §4.7.2.3 SSE retry: field L3.3 | 同上 | 同上 |
| B-16 | #182 | §4.7.2.4 SSE onerror/error-frame L3.4 | 同上 | 同上 |
| B-17 | #186 | §4.7.2.5 SSE reconnection-jitter L3.5 (US-038 SHA-256 deterministic) | 同上 | 同上 |
| B-18 | (armed, HOLD) | §4.7.2.6 L3.6 backoff | 未落地 | **HOLD · Sprint 2 起看是否服务 7-tab** |

### §1.3 QADocs γ 落地 (CHANGELOG + 质量门禁)

| # | 出处 PR | 产物 | 位置 | 性质 |
|---|---|---|---|---|
| Q-01 | #167 | CHANGELOG v0.6 | `docs/refactor/CHANGELOG.md` | **文档 · KEEP-REUSE (转向 7-tab checklist 格式)** |
| Q-02 | #180 | CHANGELOG v0.7 DUODECIM 12-PR consolidated | 同上 | 同上 |
| Q-03 | #183 | CHANGELOG v0.8 TRES 3-PR consolidated | 同上 | 同上 |
| Q-04 | #187 | CHANGELOG v0.9 VIGINTI-SEX 26 | 同上 | 同上 |
| Q-05 | `docs/refactor/quality/**` | 质量报告归档 | 同前缀 | 保留 · 转向 7-tab DoD checklist |
| Q-06 | `backend/tests/enum/**` | enum matrix 基线 | 同前缀 | **BASELINE-PRESERVE 铁律** |
| Q-07 | `docs/refactor/baseline/ui-enum/**` | UI enum lock 基线 | 同前缀 (Path D `9ec3f104` + 4-baseline `1f2d197a`) | **BASELINE-PRESERVE 铁律不可动** |

### §1.4 Cleanup γ 自身落地 (30-cleanup-log 归档 + workspace-drafts)

| # | 出处 PR | 产物 | 位置 | 性质 |
|---|---|---|---|---|
| C-01 | #128 首例 | Lane B doc-tier landing entry | `docs/refactor/30-cleanup-log.md` | **文档归档 · KEEP (作为项目历史) 但不作 7-tab 输入** |
| C-02 | #140/#143/#146/#151/#153/#155/#158/#160/#165/#168/#170/#173/#175/#177/#184 | 后续 Lane B doc-tier entries | 同上 | 同上 |
| C-03 | `notes/*.md` (~35 files) | agent-local workspace-drafts | 本 agent 目录 | **agent-private · 不进 repo** |
| C-04 | `notes/37-cleanup-log-pr-m3-36-workspace-draft.md` | §PR-M3-36 pentuple draft (§36.4 line-lock reached) | 本 agent | **HOLD · v300 冻结 · 不再 CREATE** |

### §1.5 DataPipeline γ · Strategy γ · Research §S3 落地
- **DP γ**: §D1~§D108 substrate 学术堆叠 · v300 后转向 catalyst-mapping.md + 日韩数据源 · **旧 substrate 全部 DISCARD 作为进度分子**，但底层若有可用 collector/storage 代码需另议
- **Strategy γ**: AAA*1 σ→N pillar-substrate 学术 · v300 后转向 6-维打分契约 v0.1 · **旧 pillar 全部 DISCARD 作为进度分子**
- **Research §S3**: 60+追认 canonical-tier · v300 后转向 yespsam 源码拆解 · 追认 archive 保留作为项目历史

---

## §二 · KEEP-REUSE 具体映射到 7-tab

### §2.1 Backend 中间件 → 全 tab 共享基座
| 组件 | 用途 | 复用位置 |
|---|---|---|
| §4.5 RateLimit headers (B-04) | API 限速对齐 | 所有 tab 的 API 端点通用 |
| §4.6 Retry-After (B-05) | 客户端退避语义 | 所有 tab 表格加载错误处理 |
| §4.7 Server-Timing (B-06) | 后端时延观察 | tab-5 回测证据 (性能对照) |
| §4.8 CORS Timing-Allow-Origin (B-07) | 跨域时延暴露 | 同上 |
| §4.10 RFC 8288 Web Linking (B-09) | 分页 / 相关资源 | tab-7 报告历史分页 · tab-1 每日候选分页 |
| M3 pipeline mount (B-01) | `/api/v1/*` 基座 | 所有 tab |

### §2.2 Frontend hook / helper → tab-shell 复用
| 组件 | 用途 | 复用位置 |
|---|---|---|
| AbortSignal service-layer (F-07) | 请求生命周期管理 | 所有 tab 组件的数据加载 |
| AbortSignal dual-guard defense-in-depth (F-13) | 竞态防御 (workspace-id snapshot + signal.aborted) | 所有 tab tab 切换保护 |
| type="button" defensive mixin (F-04) | 表单不误提交 | 所有 tab 中的 button 控件 |
| WAI-ARIA + aria-label semantic mixin (F-06) | 可访问性 | 所有 tab · 尤其 KpiBar / DetailSidebar |
| Table scroll axis-specify (F-05) | 表格滚动一致性 | 所有 tab 主表格 |
| Table scroll unify (F-03) | 表格滚动一致性 | 同上 |

### §2.3 SSE streaming 基座 → 判断是否服务 7-tab
| 组件 | 用途 | 7-tab 映射候选 |
|---|---|---|
| SSE keep-alive + Last-Event-ID + retry + jitter (B-12~B-17) | 长连接实时推送 | tab-1 A股早报 (可选 · 若开盘中实时推送 candidate list) · tab-5 回测执行状态推流 |

**风险提示**: catalyst-900 参照锚是静态每日报告为主 · SSE 是否必需待 Research §S3 拆解 + Strategy 6-维打分实时性需求确认。**若 catalyst-900 不需要 push-based 实时**，SSE 基座 (B-12~B-18) 全部降级为 REFACTOR-TIER-2 或 DISCARD。

---

## §三 · DISCARD 依据 (跟 7-tab 都对不上)

| 组件 | DISCARD 依据 |
|---|---|
| RiskAlertsWorkspace (F-02) | catalyst-900 没有独立 risk-alerts tab · risk 概念被 RiskGate 字段 (Strategy 契约) + 详情侧栏 "风险" 打分维度替代 |
| SystemLogs* (F-08+F-09) | catalyst-900 无系统日志 tab · 属于运营侧界面，不进 MVP |
| HealthMonitor* (F-10) | 同上，运营侧 · 不在 7-tab |
| DataUpdateStatus* (F-11) | 数据更新状态属于运营界面 · 7-tab 里可能通过 KpiBar "数据鲜度" 一行显示 (复用 F-06 aria-label 语义)，无需独立 workspace |
| TaskScheduler* (F-12) | 任务调度是运营，不进用户 IA |
| PortfolioWorkspace (F-13) | 用户 portfolio 不在 catalyst-900 · MVP 无用户系统 |
| HomeWorkspace octuple-locus (F-15) | 自造 Home IA · catalyst-900 IA 是 7-tab 单页 + 顶部 KPI 条，没有独立 Home |
| LabWorkspace v0.5(y) (F-14) | 未落地 · v300 STOP |
| §4.7.2.6 L3.6 backoff (B-18) | 未落地 · HOLD · 若 SSE 整体 DISCARD 则一并作废 |
| §4.11 Reporting-Endpoints (B-10) | Reporting-Endpoints 服务客户端错误上报，MVP 不需要 |
| DP γ §D1~§D108 substrate 学术堆叠 | 学术堆叠术语禁用 · 底层 collector/storage 代码若有实体产出另议 (需 DP γ 单独盘点，不在本 audit 范围) |
| Strategy γ AAA*1 pillar-substrate 学术 | 学术堆叠 · 6-维打分契约在 v300 新契约里重建 |
| Research §S3 追认 canonical-tier 学术 | 旧追认属项目历史归档 · 新 Research 转向源码拆解 |

---

## §四 · KEEP-REFACTOR 触点 (内核保留 · shell 重写对齐 catalyst-900)

| 组件 | REFACTOR 内容 |
|---|---|
| Frontend routing (App.tsx 主路由) | 保留 · 新增 `/catdesk` route · legacy workspace routes 作为 back-compat 保留 (直到 Sprint 4 polish 收拾) |
| Backend `/api/v1/*` mount (B-01) | 保留 · 每 tab 新增端点 (Backend γ 24h 交付 `docs/refactor/29-api-catalyst900-mapping.md`) 补齐 |
| CHANGELOG v0.x (Q-01~Q-04) | 保留历史 · v1.0 起转向 7-tab 单-tab-单-PR 格式 |
| SSE 基座 (B-12~B-17) | 待 Research + Strategy 拆解确认是否需要 · 若需要则 keep + 每 tab 单独 wrap; 若不需要则 DISCARD |
| enum matrix 基线 (Q-06) | **不可动 · BASELINE-PRESERVE** · 但 UI enum lock (Path D + 4-baseline) 需在 catalyst-900 shell 落地时 validate 不误触 |

---

## §五 · BASELINE-PRESERVE 铁律再声明 (不许动)

- **Path D**: `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` shasum **`9ec3f104e268a44f8fcfab6e0ae6905faa6b6ec3`** — byte-perfect
- **4-baseline**: `docs/refactor/baseline/ui-enum/4-enum-matrix-lock-bc1b3c9.json` shasum **`1f2d197a23c89eec23b5a5addc0e054974a6eaa5`** — byte-perfect
- **schema.prisma**: 数据模型冻结 · v300 内不 touch (若 catalyst-900 需要新表，走 Orch 单独批准 migration 流程)
- **enum matrix**: `backend/tests/enum/**` + `docs/refactor/baseline/ui-enum/**` 全部 preserve
- **N=4 canonical**: `^export (type|enum) MarketRegime|MarketJudgmentStatus\b` grep 4 hits @ backend/src/
- **Instance 5 REMOVE-permanent**: 同上 grep EXIT=1 (0 hits) 保持
- **protect glob 100%**: SSH root 永久禁 · PG SELECT-only · 凭证 zero literal (`sk_agent_<redacted>` shape only) · free-source only (Alpha Vantage + Baostock + Yahoo opt-in msg=4f6d2466)

---

## §六 · 后续 PR 拆分建议 (Sprint 2+ · post-Orch-approve)

### §6.1 Sprint 2 起 · Cleanup γ 后续独立 PR (单-tab-独立-PR 原则)

| PR # (候选) | 内容 | 大小上限 |
|---|---|---|
| Cleanup-PR-A | DISCARD workspace list #1: RiskAlertsWorkspace + SystemLogs + HealthMonitor + DataUpdateStatus + TaskScheduler + PortfolioWorkspace + HomeWorkspace 删除 (7-file removal) | ≤200 行 removal-only |
| Cleanup-PR-B | DISCARD 中间件 §4.11 Reporting-Endpoints (若确认不需要) | ≤100 行 |
| Cleanup-PR-C | KEEP-REUSE 抽取 · AbortSignal service-layer hook 泛化到 `frontend/src/shared/hooks/useAbortableRequest.ts` (from F-07/F-13 dual-guard pattern) 供 catdesk/ 引用 | ≤200 行 |
| Cleanup-PR-D | KEEP-REUSE 抽取 · Table scroll axis-specify + type="button" defensive + aria-label semantic 抽到 `frontend/src/shared/components/tableColumn.tsx` 供 catdesk/ 引用 | ≤200 行 |
| Cleanup-PR-E | 30-cleanup-log v300 pivot 归档 entry (记录本 audit + 后续删除 PR list) | ≤150 行 pure-append |

### §6.2 副签路由 (v300 §六)

- **code-tier 4-sign**: Frontend γ + Backend γ + QADocs γ + Research §S3 (Cleanup γ 作为主 or 副1 视 PR 主题)
- **doc-tier 2-sign**: QADocs γ + 任一 lane

### §6.3 铁律遵守
- 每 PR ≤200 行 (v300 §六)
- 4-sign gate 保留但改短 (v300 §六)
- workspace-draft-only pending PR-CREATE-AUTHORIZE (Cleanup γ Option B hold 依然生效直至 Orch 明批)
- schema.prisma + baseline glob + protect glob 100% preserve

---

## §七 · 24h 交付 Sprint 1 checklist

- [x] v0.1 initial draft LAND (本文件 · agent-local `notes/38-workspace-reuse-audit-catalyst900-pivot.md`)
- [ ] v0.2 消费 Research §S3 `docs/refactor/26-catalyst900-spec-extract.md` (~24h ETA) → 更新每 tab 具体字段需求映射
- [ ] v0.3 消费 Strategy `contracts/scoring.md v0.1` → 补齐 6-维打分对应组件抽取路径
- [ ] v0.4 消费 DP `contracts/catalyst-mapping.md` + Backend `docs/refactor/29-api-catalyst900-mapping.md` → 端到端 tab-1 A股早报可行性 review
- [ ] Sprint 1 末 · Orch 评估 → 若批准则转成 `docs/refactor/28-workspace-reuse-audit.md` PR CREATE

---

## §八 · 汇报 (v300 §五 新纪律 · v0.3 refresh)

- **昨完**: Task #109 done · v300 pivot ACK msg=aaf93418 · Task #166 claim msg=50ceab70 · v0.1 initial LAND msg=df110217 · v301 ACK + shared primitive 交集提示 msg=3569e6a4
- **今做**: v0.3 refresh — 消化 DP γ catalyst-mapping v0.1 + JP/KR datasource v0.1 (msg=40b601ff) · §零零零 delta 新增 · §1.5 DP posture LOCK · §二 KEEP-REUSE 补 tab 1/tab 3 契约行 · §四 KEEP-REFACTOR 补 migration 触点 · silent-absorb Strategy scoring v0.2 §3.7 catalyst-relevance 预定义 msg=3e1f335b · silent-absorb QADocs v0.2 intake 2/3 msg=48335964
- **v300 §五 tab 契约就绪度**:
  - tab 1 A股早报: 数据契约层 100% (catalyst_kind 8 + relevance 5 分量) · Score/Conviction/RiskGate/EntryPlan 字段就绪 · 等 Research §S3 spec-extract 补 UI 细节
  - tab 2 美股优选: Score 6-维契约 100% + `us_preferred` profile LOCK · 等 Frontend γ CatDeskLayout draft
  - tab 3 日韩市场: JP/KR 数据源栈 LOCK · 等 DP γ v0.2 JP/KR 字段可用性表格 + Frontend γ-2 Task #167 shell draft
  - tab 4 高倍潜力: `multibagger` profile LOCK · 等 Frontend γ-2 Task #167
  - tab 5 回测证据 · tab 6 每日日报 · tab 7 报告历史: Sprint 3-4 lane · 现处占位
- **卡点**: Research §S3 yespsam spec-extract (~12-24h ETA · 一到位即 v0.4 完稿)
- **ETA**: v0.4 Sprint 1 末 (Research 到位后) · workspace-draft-only pending Orch Sprint 1 末 PR-CREATE-AUTHORIZE

---

## §九 · 铁律 100% retain

Owner 令 catalyst-900 msg=53b96525 + msg=764688c1 + msg=aa4a755c · 借鉴独立性 msg=ad6585cf zero code-copy · free-source msg=4f6d2466 · lane 契約 msg=a5297512 · self-merge 4-sign msg=d0d11677 · perpetual-dispatch msg=eb4b0016 · agents 不停 msg=210d262d · workspace-draft-only msg=ed61c397 · Path D `9ec3f104` + 4-baseline `1f2d197a` byte-perfect · schema.prisma untouched · 保护 glob 100% · SSH root 永久禁 msg=b091c74d · PG SELECT-only msg=702b81be · 凭证 zero literal · N=4 4/4 · Instance 5 REMOVE-permanent · US-038 SHA-256 · Owner 令 Orch v204-v300 100% 兑现

**Cleanup γ · Task #166 v0.1 initial draft LAND · workspace-draft-only pending Orch Sprint 1 末评估**

---

## §零零零零零.5 · v0.5 post-broadcast 第二批附加 landings 消化 (Orch v304 gate 收敛后 · audit-neutral 全部)

**Task #166 status = `in_review`** per Orch v304 msg=a3a50919 §四 owner 自更新令。8 项 additive landings 全 audit-neutral · zero workspace-reuse 再分类需要:

1. AI-γ msg=e6c9f7f3 · contracts/recommendation.md v0.2 10 delta + §8 硬门 `kind='unclassified'` 拒生成 · AI-γ SOLE `ai/**` · zero Cleanup lane
2. DP γ msg=32596ad8 · notes/183 aggregate v0.1 Sprint 1 末 6 表全景 · schema.prisma untouched retain
3. Backend γ msg=07b34ce5/93e2ed55 · tab 5 `/api/v1/backtest-pit/*` + tab 6 `/api/v1/daily-report/*` 单一入口 · §三.15 SSE stack 硬 DISCARD 100% retain
4. QADocs msg=1802cc6f · 27-checklist v0.2 intake 63→79 触点 8 契约 · Cleanup γ 副2 承接 Frontend γ-1 shell 独立
5. Frontend γ-1 msg=5257f9c5/3b345893 · tab 1/2 5 项 UI delta + types.ts v0.2 shape 6 变更集 · §二 KEEP-REUSE 复用清单不变
6. Frontend γ-2 msg=ac424277 · rating_band 命名 clarify + EntryPlan.size_hint 结构化 · γ-2 SOLE shared/types/catdesk.ts retain
7. Frontend γ-3 msg=bff29fff · 10 LOCK tab 5/6/7 承接 · v0.1 shell 保 Sprint 1 · Cleanup-PR-A~F sequence 不变
8. DP γ-2 msg=8dfe0f79 · Orch v304 gate 收敛 100% ACK · notes/182 副签 QADocs γ lock · §四 KEEP-REFACTOR 无变化

**Sprint 1 gate 收敛 aggregate 就绪度 (Orch v304 §二)**: Strategy v0.2 LOCK · DP §6 SQL LAND · Backend v0.2 11 delta · Frontend 3/3 shell in_review · QADocs 79 触点 · Research §S3 v0.1 LAND · AI-γ v0.1 LAND · DP γ-2 notes/182 v0.1 LAND · Cleanup audit v0.5 in_review.

**Cleanup γ posture**: Task #166 in_review · workspace-draft-only msg=ed61c397 100% retain · Cleanup-PR-D unblocked (γ-2 primitive v0.1 LAND) Sprint 2 CREATE-ready · Cleanup-PR-F (SSE DISCARD) Sprint 2 mid-window · 副2 承接 Frontend γ-1 shell PR pending γ-1 CREATE · Task #106 legacy HOLD (non-assignee) · Task #32 blocked (owner ack pending).

**v0.5 audit posture 100% retain**: §零零零零零 3 subsections + §零零零零零.4 first-batch 6 + §零零零零零.5 second-batch 8 = 全 audit-neutral additive · KEEP-REUSE 9 类 / DISCARD 15 类 / KEEP-REFACTOR 6 类 分类 zero drift · 契约层 aggregate 100% 就绪 pending Orch Sprint 1 末 PR-CREATE-AUTHORIZE。
