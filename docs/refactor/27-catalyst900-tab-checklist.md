# 27 · catalyst-900 · 7-tab 对照表 v0.3

**Author lane**: QADocs γ · doc-tier 2-sign per Orch v300 §六
**Dispatch**: Orch v319 · Sprint 3 D4 · task #175
**Scope**: Sprint 2 11/11 merged baseline + Sprint 3 Tab 3/4/5 endpoint contracts + RiskGate 22-trigger + login-removal release gate
**Verification suite**: `docs/refactor/quality/sprint3-test-framework.md` (152 cases · #1-#152)
**Reference**: catalyst-900-qohfq.netlify.app (live) + github.com/yespsam/a-share-us-catalyst (源码) · **借鉴 独立性 zero code-copy** per msg=ad6585cf
**v0.2 upstream**: 10/10 全量 LAND — Strategy v0.2 + DP 180 v0.2.1 + DP-2 182 + Cleanup v0.5 + Research §S3 v0.2 + DP 183 + γ-2 types.ts v0.2 + γ-1 shell v0.2 + Backend γ API v0.2 + AI-γ v0.2

---

## 全局 IA 对照 (跨-tab 通用)

### 全局布局验收
- [ ] **单页 SPA** · 无路由跳转（tab 切换用 tab-state 不改 URL 或用 hash/query 保持刷新恢复）(γ-1 shell v0.2 §一 CatDesk 容器)
- [ ] **左侧 7-tab 竖排导航** · 图标 + 中文名 + 活跃态高亮 · 键盘 ↑↓ 可切 (γ-1 shell v0.2 §二 nav 组件)
- [ ] **顶部 KPI 条** · 统一位置 · 每 tab 可覆盖 KPI 项 · 空数据显示 "—" 而非 0 (γ-1 shell v0.2 §三 KpiSlot)
- [ ] **两栏布局** · 左表格 (主) + 右详情侧栏 (选中行详情) · 详情侧栏可折叠 (γ-2 DetailSidebar sections slot per Orch v303 LOCK 10)
- [ ] **过滤 chip 条** · 位于表格上方 · 每 tab 可自定义 chip 集 · 选中态视觉一致 (γ-2 FilterChip `mode='single'|'multi'`)
- [ ] **统一表列 API** · 排序/宽度/隐藏/固定列在 7-tab 之间行为一致 (γ-2 TableColumn 泛型 `<Row>` + antd scroll axis-specify)
- [ ] **配色/字体/间距** 对齐 catalyst-900 design token `var(--cd-*)` CSS 变量 (γ-1 shell v0.2 §四)
- [ ] **响应式**: 桌面 (≥1280) 主目标 · 平板 (768-1280) 降级 · 手机 (<768) 只读

### 全局状态验收
- [ ] **空态**: 每 tab 提供专属空态文案 + 图标 · 不用通用 "暂无数据"
- [ ] **加载态**: 表格骨架屏 · 详情侧栏 shimmer · KPI 条占位
- [ ] **错误态**: 内联错误卡片 `role="alert" aria-live="polite"` · 具体错因 · 重试按钮 · 不用 alert
- [ ] **详情侧栏空**: 选中前提示 "选择一行查看详情" · `role="status"` 图标居中

### Login removal 发布门 (Orch v318 + v319 · cases #149-#152)
- [ ] #149 `/login` 不再渲染登录表单；Frontend C1 提供 router/interceptor 或等价 executable route test
- [ ] #150 Backend C4 `backend/tests/routing/auth-default-admin.test.ts` 证明 missing/invalid Authorization 通过 `AuthController.authenticate` 与 standalone middleware 均注入 canonical admin 并到达 protected handler
- [ ] #151 应用启动即建立 default admin identity，无登录流程；Frontend C1 提供 executable test
- [ ] #152 7 个 tab 全部可访问且不跳转 `/login`；Frontend C1 提供 executable route test
- [ ] Frontend route/interceptor + Backend middleware + QADocs #149-#152 同批落地或按依赖安全顺序落地
- [ ] source grep、实现说明或文档引用均不能替代 executable evidence；任何一项缺失即 BLOCK

### 全局字段字典 (v0.2 · 与 Strategy γ scoring v0.2 + AI-γ v0.2 对齐)

| 字段 | 语义 | 数据形态 | 契约锚 |
|------|------|----------|--------|
| **Score** | 综合分 | 0-100 数值 · scoring_id (UUIDv4) + snapshot_hash (SHA-256 JCS RFC 8785) | Strategy v0.2 §2.1 |
| **Score.band** | 评级 | 5档: A≥85 / B 70-84.9 / C 55-69.9 / D 40-54.9 / F<40 · 双粒度 (字母+数字) | Orch v303 LOCK 5 |
| **6-dim** | 六维打分 | 质量/成长/估值/护城河/趋势/风险 · 各 0-100 | Strategy v0.2 §3.1-§3.6 |
| **Conviction** | 置信度 | final = clamp(base + Σ adjustments[].delta, 0, 100) · HIGH≥75 / MED 50-74.9 / LOW<50 | Orch v303 LOCK 1+2 |
| **Conviction.adjustments** | 调整项 | Adjustment[] · len∈[0,5] · delta∈[-20,+20] · Σ∈[-20,+20] · reason≤200 · kind_ref? · source_ref? | Strategy v0.2 §4.1 |
| **RiskGate** | 风控闸 | 22-trigger (9 US + 3 A股 + 5 JP + 5 KR) · GREEN=通过 / YELLOW=warn(-5) / RED=block(-10) | Orch v303 LOCK 3 + v317 Ruling #8 |
| **EntryPlan** | 入场计划 | price_band/stop/targets grid | Strategy v0.2 §6 |
| **EntryPlan.size_hint** | 仓位建议 | `{tier: SizeHintTier, pct: number∈[0,5], disclaimer_key: 'size_hint_advisory'}` | Orch v303 LOCK 10 |
| **SizeHintTier** | 仓位档 | `'TIER_5'│'TIER_3'│'TIER_2'│'TIER_1'│'SKIP'` | DP 180 v0.2.1 tier correction |
| **CatalystKind** | 催化类型 | 9-enum: earnings/upgrade_downgrade/ma_activity/sector_move/regulator/geo_macro/product/leadership/unclassified | Orch v303 LOCK 6 |
| **rating_band** | 评级信封 | Score.band 的 envelope mirror · CandidateListEntry 级 | AI-γ v0.2 §4 |
| **DataSourceBadge** | 数据源 | free-source: Alpha Vantage / Baostock / Yahoo Finance / EDINET / DART | msg=4f6d2466 |

### 全局 WAI-ARIA 验收
- [ ] 所有 `<button>` 含 `type="button"` (F-04 · γ-2 msg=de72dbde)
- [ ] 所有可交互元素含 `aria-label` (F-06)
- [ ] 表格 scroll axis-specify (F-05)
- [ ] AbortSignal dual-guard: `controller.signal.aborted` 二次 guard (F-07 + F-13)

### 全局免责声明验收 (Owner msg=53b96525)
- [ ] EntryPlan 区域: "仅供参考，非投资建议或下单指令"
- [ ] SizeHint 区域: size_hint_advisory short「仓位比例仅供参考，非下单 binding」(AI-γ v0.2 §7)
- [ ] 禁用词汇: "必涨" / "保底" / "承诺" / "guaranteed" / "assured" 不得出现
- [ ] 允许词汇: "有望" / "参考" / "可能" / "potential" / "estimated" 允许

---

## Tab 1 · A股早报 (核心)

### 完成定义
美股隔夜催化事件 → A股同日交易时段候选个股映射表 · 早盘可读 · 覆盖当日交易机会

### KPI 条 (per γ-1 msg=15f54004 MorningKpiSlots)
- [ ] 活跃度 (当日催化事件数)
- [ ] 隔夜情绪 (美股收盘情绪指标)
- [ ] 期货 (A 股期货预判)
- [ ] 突破概率 (高 Conviction 候选占比)

### Backend API (per Backend γ v0.2 msg=9c0d7b34 + Orch v306 §四)
- [ ] `GET /api/v1/morning-brief/:date` — 候选列表 (P0)
- [ ] `GET /api/v1/morning-brief/:date/summary` — 当日汇总 KPI (P0)
- [ ] `GET /api/v1/catalyst/:id` — 催化事件详情 (P0)
- [ ] `GET /api/v1/catalyst/:id/candidates` — 催化→A股候选映射 (P0)

### 表格字段 (per γ-1 MorningBriefTable 8 列)
- [ ] symbol — A 股代码 · 6 位 (`/^\d{6}$/`)
- [ ] name — 中文名 · ≤20 字符
- [ ] score — 0-100 + Band 5-色 (ScoreCell: A=green/B=blue/C=yellow/D=orange/F=red)
- [ ] catalystSource — 美股 ticker (`/^[A-Z]{1,5}$/`)
- [ ] catalystKind — 9-枚举 chip (per Orch v303 LOCK 6)
- [ ] conviction — 3-色 pill (ConvictionPill: HIGH=green/MED=yellow/LOW=gray)
- [ ] entryPlan — SizeHint tier + pct
- [ ] action — 查看详情按钮 `type="button"` + `aria-label`

### 过滤 chip (per γ-1 MorningFilterBar 3 组)
- [ ] 板块 (multi-select)
- [ ] catalystKind 9-枚举 (含 unclassified · chip `role="checkbox"` + `aria-checked`)
- [ ] Conviction ≥MED (conviction_final ≥ 50)

### 详情侧栏 (per γ-1 buildMorningSections 6 卡片 + γ-2 embedded cards)
- [ ] **ScoreBreakdownCard**: scoring_id badge + snapshot_hash tooltip(前 8 位) + 6-dim progress-bar + total band 双粒度
- [ ] **ConvictionBreakdownCard**: base + adjustments[] 逐条 delta 归因 + final = clamp(base+Σ, 0-100) progress-bar
- [ ] **RiskGateDetailCard**: 从全局 22-trigger 词表按候选 native `market_scope` 取适用子集；US 催化只作 evidence attribution，不把 US-only trigger 施加到 A股候选
- [ ] **EntryPlanCard**: price_band/stop/targets + SizeHint progress-bar 0-5% + **disclaimer 硬门**
- [ ] **AIRecommendationCard**: 4-硬门 ✅/❌ + dual-gate (RiskGate=GREEN + kind≠unclassified) + `[E<n>]` token
- [ ] **DataSourceBadge**: free-source 标注

### 数据采集器 (per DP γ msg=ddc380f5 notes/184)
- [ ] SEC EDGAR 8-K → catalyst_kind 9-enum (ITEM_KIND_MAP)
- [ ] Nasdaq earnings calendar → catalyst_kind='earnings' 硬锁
- [ ] fact_hash SHA-256 deterministic (US-038)
- [ ] 幂等 upsert ON CONFLICT DO NOTHING
- [ ] rate limit: SEC 5 req/s conservative · Nasdaq 1 req/s

### 空态
"今日暂无催化事件 (美股尚未开盘 · 或 T-1 无实质催化)"

---

## Tab 2 · 美股优选 (6-维打分)

### 完成定义
美股全池按 6-维加权综合分排序 · 可自定义权重 · 每支个股拆解详情可读

### KPI 条
- [ ] 池内标的总数
- [ ] Score ≥80 (Band A+B) 数量
- [ ] 中位数 Score
- [ ] 数据锚时

### Backend API (per Backend γ v0.2 + Orch v311 Ruling #2 LOCK #13)
- [ ] `GET /api/v1/us-select/:date` — 美股优选列表 (P0) · CANONICAL per LOCK #13
- [ ] `GET /api/v1/us-select/:date/summary` — 汇总 KPI (P0)

### 表格字段
- [ ] 序号 · Ticker · 中文名 · Sector
- [ ] 质量 (0-100) · 成长 (0-100) · 估值 (0-100) · 护城河 (0-100) · 趋势 (0-100) · 风险 (0-100)
- [ ] 综合 Score + Band 5-色
- [ ] Conviction (3-色 pill + final 数值)
- [ ] RiskGate (3-色 chip + trigger count)

### 过滤 chip
- [ ] Sector (multi-select)
- [ ] Score 阈值 (≥60 / ≥80 / ≥90)
- [ ] Conviction (all / HIGH / MED / LOW)
- [ ] RiskGate (all / GREEN only)
- [ ] 单维阈值 (每维可单独筛)
- [ ] WeightsProfile switcher (tab 2 可切换 · tab 4 固定 multibagger · tab 1/3/5 使用各自 default)

### 详情侧栏
- [ ] ScoreBreakdownCard (6-dim 含每维得分依据)
- [ ] ConvictionBreakdownCard (adjustments[] 归因)
- [ ] RiskGateDetailCard (全局 22-trigger 词表中适用于 US 的 9-trigger 子集)
- [ ] EntryPlanCard (含 SizeHint + disclaimer)
- [ ] 同 Sector 同 Score 段对比
- [ ] 历史 Score 时序 (30/90/180 天)

### 空态
"当前过滤条件无匹配 · 请放宽阈值或换 Sector"

---

## Tab 3 · 日韩市场

### 完成定义
日本 (TSE) + 韩国 (KRX) 优选池 · 覆盖 6-维打分 + 汇率影响 + 时区提示

### KPI 条
- [ ] 日股优选数 · 韩股优选数
- [ ] `usdjpy` · `usdkrw` nullable FX KPI；非 null 时 shape 固定 `{rate, change_pct}` (per final LOCK + DP γ-2)
- [ ] 当日开/收市状态 (时区提示)

### Backend API (per Backend γ v0.2 + Orch v316 Ruling #4 LOCK #14)
- [ ] `GET /api/v1/jpkr-market/:date?market=JP|KR` — 日韩优选列表 (P1) · CANONICAL per LOCK #14
- [ ] `GET /api/v1/jpkr-market/:symbol/detail?date=` — 个股详情 (P2) · CANONICAL per LOCK #14

### 数据采集器 (per DP γ-2 msg=2aaf823e + Research msg=b8e8a342)
- [ ] EDINET XBRL v2 → JP 财报 (金融庁 免费) · 2 req/s
- [ ] DART OpenAPI → KR 财报 (금감원 免费) · 1,000 req/日
- [ ] BOJ JPY/USD + BOK KRW/USD 汇率 (免费)
- [ ] KRX HTML canary schema drift 监控 + fallback PyKRX+KIND
- [ ] 3 套映射表: edinetCode↔secCode · corp_code↔stock_code · CIK↔Ticker

### 表格字段
- [ ] 序号 · 市场 (JP/KR) · Ticker · 名称
- [ ] Sector · Score + Band · Conviction · RiskGate
- [ ] 汇率敏感度 (0-100) · 涨跌幅 (当日/月/年)
- [ ] `score` 与 `risk_gate` 键必须存在且允许 `null`；`risk_triggers` 键必须存在且为数组

### 过滤 chip
- [ ] 市场 (JP / KR / both) · Sector · Score 阈值 · 汇率敏感度

### 详情侧栏
- [ ] ScoreBreakdownCard + ConvictionBreakdownCard + RiskGateDetailCard + EntryPlanCard (含币种)
- [ ] 汇率敏感度拆解 (营收币种占比)
- [ ] 同市场同 Sector 对比

### 空态
"日/韩市场当前休市 · 数据锚时 YYYY-MM-DD HH:MM"

---

## Tab 4 · 高倍潜力

### 完成定义
早期多倍候选 (小市值 + 高成长 + 未被覆盖) · 高风险 · 明确风险提示

### KPI 条
- [ ] 池内标的数 · 平均市值 · 高 Conviction 数量 · 数据锚时

### Backend API (per Backend γ v0.2 + Orch v316 Ruling #5 LOCK #15)
- [ ] `GET /api/v1/multibagger/candidates?stage=&conclusion=&market=` — 高倍候选列表 (P1) · CANONICAL per LOCK #15
- [ ] `GET /api/v1/multibagger/:symbol/detail` — 个股详情 (P2) · CANONICAL per LOCK #15

### 表格字段
- [ ] 序号 · Ticker · 名称 · 市场
- [ ] 市值 (USD-normalized via fx_rate)
- [ ] 成长 (0-100) · 护城河 (0-100) · 潜在倍数 (3-5 年估算)
- [ ] Conviction · RiskGate (通常 Watch 或 Block) · Score

### 过滤 chip
- [ ] 市值段 (<100M / 100M-1B / 1B-10B) · 潜在倍数 (≥3x / ≥5x / ≥10x) · 市场 · Sector

### 详情侧栏
- [ ] **风险醒目提示** (顶部红色横幅 · 高波动性 / 低流动性 / 未覆盖警告)
- [ ] ScoreBreakdownCard (风险维通常低)
- [ ] 潜在倍数依据 (关键假设)
- [ ] EntryPlanCard (强调仓位限制 + SizeHint TIER_1 或 SKIP 居多)
- [ ] 类比案例 (历史相似轨迹标的)

### 空态
"高倍候选池今日无更新 · 每周三/周日刷新"

---

## Tab 5 · 回测证据

### 完成定义
6-month PIT (point-in-time) 回测结果 · 策略/tab/单标的三维度 · 证明 IA 各 tab 输出可信

### Backend API (per Backend γ v0.2 · Orch v303 LOCK #11 + v316 LOCK #16)
- [ ] `GET /api/v1/backtest-pit/:strategy` — 快照列表 · `?from=&to=&limit=N` (P0) · LOCK #11 `:strategy` 不可改
- [ ] `GET /api/v1/backtest-pit/:strategy/:as_of` — 单快照详情 + timeline (P0) · `:as_of` 为 URL-encoded ISO PIT timestamp，按 `as_of_utc` 匹配
- [ ] `GET /api/v1/backtest-pit/:strategy/:as_of/holdings` — 持仓明细 (P0) · Sprint 3 NEW · LOCK #16 · 同一 encoded `as_of_utc`
- [ ] `GET /api/v1/backtest-pit/:strategy` response shape MOD — metrics 提升至 top-level (Sprint 3 LOCK #11 MOD)

### KPI 条 (per γ-3 msg=f3ffa58e MetricsCards)
- [ ] 胜率 (win_rate_6m)
- [ ] 最大回撤 (max drawdown)
- [ ] 夏普 (sharpe_ratio_6m)

### 表格字段 (per γ-3 SnapshotTable 7 列)
- [ ] snapshot_day · strategy · net_value · drawdown · cumulative_return · sharpe_ratio_6m · win_rate_6m · sortable
- [ ] UI 可把 `strategy` 显示为 Profile，但 wire/storage field 不得改名为 `profile`

### 持仓表 (per γ-3 HoldingsTable 4 列 · 三方 lock)
- [ ] ticker · weight · return_since_entry · is_stale (stale tag)

### 过滤 chip
- [ ] Strategy selector (UI label 可写 Profile) · 日期范围 · Benchmark

### 详情侧栏 (per γ-3 BacktestSidebarSections 3 section)
- [ ] PIT 元数据: as_of_utc + is_survivorship_biased warning badge + is_delisted_at_as_of stale tag (PitBadge)
- [ ] 指标明细
- [ ] 持仓 (HoldingsTable)

### PIT 安全
- [ ] as_of_utc 时间锚不可篡改
- [ ] `:as_of` URL 参数必须 `encodeURIComponent`；服务端按完整 `as_of_utc` 查找，不得降级为 `snapshot_day`
- [ ] 幸存者偏差 warning badge
- [ ] 已退市 stale tag

### 空态
"该策略回测样本不足 (n<30) · 待累积"

---

## Tab 6 · 每日日报

### 完成定义
当日综合日报 · Markdown 渲染 · 涵盖 7-tab 关键信号 · 一屏读完

### Backend API (per Backend γ v0.2 · tab 6 REST polling Orch v303 LOCK #7)
- [ ] `POST /api/v1/daily-report/generate` — 异步生成 · 返回 `job_id: UUIDv4`
- [ ] `GET /api/v1/daily-report/status?job_id=` — REST 轮询 · 不启用 SSE
- [ ] `GET /api/v1/daily-report/:date` — 当日日报 (P0 · single entry)
- [ ] `GET /api/v1/daily-report/latest` — 最新日报 (P0)

### 内容区 (非表格 · 单列文档流)
- [ ] 摘要段 (3-5 行 · 今日最重要信号) · `[E<n>]` token 消费 (AI-γ v0.2 §2.6)
- [ ] Tab 1-7 分节 · 每节 3-5 条要点
- [ ] 风险提示段
- [ ] **免责声明** (Owner msg=53b96525 + AI-γ size_hint_advisory full 版本)

### 交互
- [ ] "复制全文" · "复制某节" · "PDF 导出" · "分享链接"
- [ ] 日期切换 (回读近 30 日)

### 详情侧栏
- [ ] 隐藏 (Tab 6 为文档流 · 无侧栏)
- [ ] 保留右侧目录 (TOC) · 锚点跳转

### 空态
"今日日报生成中 · ETA HH:MM (北京时间)"

---

## Tab 7 · 报告历史

### 完成定义
历史日报列表 · 按日期倒序 · 可搜索 · 可回读

### Backend API (per Backend γ v0.2)
- [ ] `GET /api/v1/daily-report` — 历史列表 · `?from=&to=&limit=N` (P1)

### 表格字段
- [ ] 序号 · 日期 · 覆盖 tab 数
- [ ] rating_band (envelope mirror per AI-γ v0.2 §4)
- [ ] 高 Conviction 标的数
- [ ] 当日胜负 (T+1 验证)
- [ ] 摘要 (前 60 字符)
- [ ] "查看" 按钮

### 过滤 chip
- [ ] 日期范围 · 覆盖 tab · 胜负 (Win/Loss/Pending)

### 详情侧栏
- [ ] 该日日报全文 (Markdown 渲染) · `[E<n>]` token 渲染
- [ ] 该日 7-tab 快照 (小卡片式)
- [ ] "对比昨日" 按钮

### 空态
"当前过滤无历史日报 · 请调整日期范围"

---

## 跨-tab 一致性 checklist (verification protocol · v0.2)

### 组件层 (per γ-2 msg=de72dbde shared primitive)
- [ ] **useAbortableRequest**: 7-tab 使用同一 hook · 每次 fetch 前 abort 上一个 + unmount abort · F-07 + F-13
- [ ] **FilterChip**: 7-tab 使用同一组件 · `mode='single'|'multi'` · `role="checkbox"` + `aria-checked`
- [ ] **TableColumn**: 7-tab (除 Tab 6) 使用同一泛型组件 · ScoreCell/ConvictionPill/RiskGateChip 3 helper renderer
- [ ] **DetailSidebar**: 7-tab (除 Tab 6) 使用同一 Drawer · sections slot · 3-state loading/error/empty

### 嵌入卡片层 (per γ-2 5 embedded cards)
- [ ] **ScoreBreakdownCard**: 所有含 Score 的 tab 使用同一卡片 · 6-dim + scoring_id + snapshot_hash
- [ ] **EntryPlanCard**: 所有含 EntryPlan 的 tab 使用同一卡片 · SizeHint + **disclaimer 硬门**
- [ ] **RiskGateDetailCard**: 22-trigger 总词表 · 按 market_scope 展示适用子集 · 所有 tab 统一
- [ ] **ConvictionBreakdownCard**: Adjustment[] 归因 · 所有 tab 统一
- [ ] **DataSourceBadge**: free-source 标注 · 所有 tab 统一

### 数据契约层
- [ ] **Score shape**: scoring_id (UUIDv4) + snapshot_hash (SHA-256 JCS) + band 双粒度 — 与 Strategy v0.2 §2.1 对齐
- [ ] **Conviction shape**: Adjustment[] Option A — 与 Strategy v0.2 §4 + Orch v303 LOCK 1 对齐
- [ ] **RiskGate shape**: 22-trigger (9 US + 3 A股 + 5 JP + 5 KR) — 与 Strategy v0.2 §5.3 + Orch v303 LOCK 3 + Orch v317 Ruling #8 对齐
    - JP 5: TSE_HALT (block) + EDINET_DELAY (warn) + CORPORATE_GOVERNANCE_ISSUE (warn) + TSE_TOKUBETSU_CHI (warn) + TSE_KANRI (block)
    - KR 5: KRX_HALT (block) + DART_LATE_FILING (warn) + INSIDER_TRADING_FLAG (block) + KRX_UNFAITHFUL (warn) + KRX_INVESTOR_ALERT (warn)
- [ ] **SizeHint shape**: `{tier: SizeHintTier, pct, disclaimer_key}` — 与 DP 180 v0.2.1 + Orch v303 LOCK 10 对齐
- [ ] **CatalystKind shape**: 9-enum — 与 Orch v303 LOCK 6 对齐
- [ ] **types.ts v0.2**: 7-item changeset — 与 γ-2 msg=e7e8a154 对齐

### DDL 约束层 (per DP γ notes/180 v0.2.1 + notes/183)
- [ ] **us_catalyst_event**: catalyst_kind 9-enum CHECK · UNIQUE (event_source_kind, ingest_source_hash) 幂等
- [ ] **a_share_candidate_mapping**: conviction_final CHECK [0,100]
- [ ] **multibagger_universe**: 与 tab 4 数据 shape 对齐
- [ ] **backtest_pit_snapshot**: tab 5 timeline 数据
- [ ] **jpkr_financial_snapshot**: tab 3 数据 · currency + fx_rate_to_usd
- [ ] **jpkr_daily_kline**: ALTER market_cap_bn_usd

### 加载/错误/空态
- [ ] 组件级复用 (γ-1 LoadingState/EmptyState/ErrorState) · tab 内文案覆盖
- [ ] 配色/字体/间距: design token `var(--cd-*)` · 7-tab 消费无本地覆盖
- [ ] 响应式: 桌面 ≥1280 主目标 100% · 平板/手机降级明确

### AI-γ 输出硬门 (per AI-γ v0.2 §8 · 14 条)
- [ ] #1-#9 v0.1 硬门 · #10 kind≠unclassified 拒生成 · #11 rating_band mirror · #12 conviction formula · #13 size_hint pct↔tier byte-map · #14 disclaimer_key='size_hint_advisory'

---

## Canonical LOCK coverage (v303 + v311 + v316)

| LOCK | Canonical invariant | Checklist anchor |
|------|---------------------|------------------|
| #1 | Conviction `adjustments[]` shape | 全局字段字典 + ConvictionBreakdownCard |
| #2 | HIGH/MED/LOW thresholds | 全局字段字典 + Tab 1/2 filter |
| #3 | RiskGate base semantics | 全局字段字典 + 跨-tab 数据契约层 |
| #4 | catalyst_kind adjustment tiers | Tab 1 catalystKind + Conviction adjustment attribution |
| #5 | Score Band A/B/C/D/F | 全局字段字典 + Tab 1/2 ScoreCell |
| #6 | CatalystKind 9-enum | 全局字段字典 + Tab 1 filter |
| #7 | Tab 6 REST polling | `POST /daily-report/generate` + `GET /daily-report/status`; SSE disabled |
| #8 | Weight profile switcher | Tab 2 可切 · Tab 4 固定 · Tab 1/3/5 default |
| #9 | SizeHint progress-bar | EntryPlan.size_hint + EntryPlanCard 0-5% |
| #10 | DetailSidebar sections slot | 全局两栏布局 + 跨-tab shared primitive |
| #11 | Backtest single namespace | Tab 5 `backtest-pit/:strategy` route family + wire field `strategy` |
| #12 | morning-brief route family | Tab 1 backend API |
| #13 | us-select route family | Tab 2 backend API |
| #14 | jpkr-market route family | Tab 3 backend API |
| #15 | multibagger route family | Tab 4 backend API |
| #16 | backtest holdings contract | Tab 5 backend API + holdings table |

---

## 依赖与状态 (v0.3)

| 依赖源 | 版本 | msg | 状态 |
|--------|------|-----|------|
| Strategy γ scoring | v0.2 | 3f7bfd3e | ✅ LAND |
| DP γ catalyst-mapping | v0.2.1 | f494e4ad | ✅ LAND |
| DP γ-2 notes/182 | v0.1 | 11e16e41 | ✅ LAND |
| Cleanup γ audit | v0.5 | 8675050e | ✅ LAND |
| Research §S3 spec-extract | v0.2 | ea6007f3 | ✅ LAND |
| DP γ notes/183 schema aggregate | v0.1 | f494e4ad | ✅ LAND |
| Frontend γ-2 types.ts | v0.2 | e7e8a154 | ✅ LAND |
| Frontend γ-1 CatDesk-shell | v0.2 | 2f63d119 | ✅ LAND |
| Backend γ API mapping | v0.2 | 9c0d7b34 | ✅ LAND |
| AI-γ recommendation | v0.2 | 33836149 | ✅ LAND |
| Orch v303 10 canonical LOCK | — | f53c62a0 | ✅ LOCKED |
| Orch v311 LOCK #11-#13 | — | — | ✅ LOCKED |
| Orch v316 LOCK #14-#16 | — | — | ✅ LOCKED |
| Orch v317 RiskGate 22-trigger | — | — | ✅ LOCKED |
| Cleanup PR-A2 / PR-A3 | merged | PR #211 / #212 | ✅ LAND |

实时 PR/task 进度以 GitHub 与 task board 为准，不写入 canonical checklist。发布判定只依据本表稳定权威输入以及 `sprint3-test-framework.md` 的 executable evidence。

---

## 版本演进计划

- **v0.1** (LANDED Sprint 1 · 24h) — 7-tab 骨架 · 布局/字段/chip/侧栏/空态 checklist
- **v0.2** (LANDED · Sprint 1 末) — 10/10 upstream fold-in · Strategy scoring + Conviction + RiskGate + SizeHint + CatalystKind 全 shape v0.2 · Backend API endpoint mapping · AI-γ 14 硬门 · DP DDL 6-table · γ-2 shared primitive 4+5 · γ-1 tab 1 组件映射 · γ-3 tab 5 组件映射 · Sprint 2 test framework 测试用例引用
- **v0.3** (本版 · Sprint 3 合同阶段) — Tab 3/4/5 LOCK #14-#16 · RiskGate 22-trigger · login-removal 152-case 门禁
- **v0.4** (Sprint 3 上线后) — 按 C1-C4 实现与真实响应 shape 校准可点击/可看元素
- **v0.5** (Sprint 4 末) — 全 tab MVP · 部署 + 免责声明验收 checklist

---

## 铁律 100% retain (Orch v300~v306 汇报纪律)

- 报告禁用: σ→N · CASCADE · tenner · CENTUM 等学术堆叠术语
- 报告允许: tab 编号 1-7 · 字段名 · Sprint N · lane 名 · 契约名
- 「进度」= 具体到某 tab 某可点击/可看元素
- 副签: doc-tier 2-sign 保留
- 独立性 msg=ad6585cf: 借鉴 catalyst-900 IA · zero code-copy
- Free-source-only msg=4f6d2466 · US-038 SHA-256 · SSH root 永久禁 · PG SELECT-only · 凭证 zero literal
- v303 10 canonical LOCK re-litigate 永久禁
- perpetual-dispatch LIVE · agents 不停 · Orch v300~v306 100% 兑现

**Orch v319 PR-CREATE-AUTHORIZE · QADocs γ owner D4 · task #175**
