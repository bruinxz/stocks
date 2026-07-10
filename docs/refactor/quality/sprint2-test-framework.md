# Sprint 2 Test Framework v0.2

**Author**: QADocs γ
**Dispatch**: Orch v310 Sprint 2 · Orch v311 Ruling #1/#2 path canonical
**Base**: v0.1 workspace-draft + Sprint 1 12/12 MERGED code reality (main HEAD `2fad60ea`)
**Scope**: Tab 1 E2E + Tab 2 骨架 + Tab 5 回测 + 数据采集器集成 + 跨层端到端验证

## v0.2 delta vs v0.1

- Backend API path: `/api/v1/morning-brief/*` CANONICAL per Orch v311 Ruling #1 (two-party convergence Backend+Frontend overrides v310 draft `/a-share-morning/*`)
- Tab 2 美股优选骨架测试用例 (NEW — Sprint 2 scope per Orch v310)
- Sprint 1 code review observation items tracked as known deviations (MorningFilterBar placeholder labels, action column `<a>` vs `<button>`)
- Component import paths aligned to merged C1/C2/C3 reality (`frontend/src/pages/catdesk/**`)
- Tab 5 BacktestEvidence component test cases (aligned to merged C3 #191 `2fad60ea`)

---

## §一 · Tab 1 A股早报 端到端测试用例

### §1.1 · 表格列渲染 (8 列 · per merged C1 #198 MorningBriefTable)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-COL-01 | symbol 列渲染 A 股代码 6 位数字 | `/^\d{6}$/` match | P0 |
| T1-COL-02 | name 列渲染中文名 | non-empty string · length ≤ 20 | P0 |
| T1-COL-03 | score 列渲染 0-100 数值 + Band 5-色 | `A≥85 green / B 70-84.9 blue / C 55-69.9 yellow / D 40-54.9 orange / F<40 red` | P0 |
| T1-COL-04 | catalystSource 列渲染美股 ticker | US ticker format `/^[A-Z]{1,5}$/` | P1 |
| T1-COL-05 | catalystKind 列渲染 9-枚举 chip | chip text ∈ {earnings, upgrade_downgrade, ma_activity, sector_move, regulator, geo_macro, product, leadership, unclassified} | P0 |
| T1-COL-06 | conviction 列渲染 3-色 pill | HIGH(green)/MED(yellow)/LOW(gray) · 阈值 HIGH≥75 / MED 50-74.9 / LOW<50 | P0 |
| T1-COL-07 | entryPlan 列渲染 SizeHint | tier ∈ {TIER_5, TIER_3, TIER_2, TIER_1, SKIP} · pct ∈ [0,5] | P1 |
| T1-COL-08 | action 列渲染查看详情按钮 | `type="button"` · `aria-label` present · **⚠ Sprint 1 observation: C1 uses `<a>` tag — Sprint 2 应修正为 `<button type="button">`** | P1 |

### §1.2 · DetailSidebar 6 卡片 (per merged C1 #198 detail/ cards + C2 #193 embedded cards)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-SD-01 | ScoreBreakdownCard 渲染 | scoring_id badge visible · 6-dim progress-bar × 6 · total band 双粒度 (数字 + 字母) | P0 |
| T1-SD-02 | ScoreBreakdownCard snapshot_hash 校验 | SHA-256 format `/^[a-f0-9]{64}$/` · tooltip 显示 hash 前 8 位 | P1 |
| T1-SD-03 | ConvictionBreakdownCard 渲染 | base score + adjustments[] 逐条 delta 归因 · `|delta| ∈ [1,20]` · `adjustments.length ∈ [0,5]` · `Σ delta ∈ [-20,+20]` · `final = clamp(base + Σ delta, 0, 100)` | P0 |
| T1-SD-04 | RiskGateDetailCard 渲染 | 12-trigger 逐条展开 · code ∈ 12-trigger canonical (9 US + 3 A股) · severity ∈ {GREEN, YELLOW, RED} · YELLOW=-5 / RED=-10 penalty visible | P0 |
| T1-SD-05 | EntryPlanCard 渲染 | price_band/stop/targets grid · SizeHint progress-bar 0-5% · **disclaimer 硬门 "仅供参考，非投资建议或下单指令"** visible (Owner msg=53b96525) | P0 |
| T1-SD-06 | DataSourceBadge 渲染 | source ∈ {Alpha Vantage, Baostock, Yahoo Finance} (free-source msg=4f6d2466) | P1 |
| T1-SD-07 | AIRecommendationCard dual-gate | RiskGate=GREEN + kind≠unclassified → 推荐可见 · 任一不满足 → 推荐隐藏 + 原因提示 | P0 |

### §1.3 · 过滤 chip 9-枚举 (per merged C1 #198 MorningFilterBar)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-FC-01 | 9-枚举 chip 全部渲染 | 9 chip visible · text exact match canonical 9-enum · **⚠ Sprint 1 observation: C1 MorningFilterBar CATALYST_KINDS uses placeholder labels (policy/earnings/sector_rotation etc.) — Sprint 2 应对齐 canonical 9-enum (earnings/upgrade_downgrade/ma_activity/sector_move/regulator/geo_macro/product/leadership/unclassified)** | P0 |
| T1-FC-02 | multi-select 行为 | 点击 chip → table filter → 仅显示 matching rows · 再点击 → deselect → 全显 | P0 |
| T1-FC-03 | unclassified chip 特殊标识 | unclassified chip 使用灰色/虚线边框 区分 | P2 |
| T1-FC-04 | Conviction chip 过滤 | chip ≥MED → 仅显示 conviction_final ≥ 50 的行 | P0 |
| T1-FC-05 | chip ARIA | 每 chip `role="checkbox"` + `aria-checked` + `aria-label` (per merged C2 #193 FilterChip) | P1 |

### §1.4 · 免责声明措辞审计

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-DIS-01 | EntryPlan disclaimer 措辞 | 包含 "仅供参考" + ("非投资建议" 或 "非下单指令") | P0 |
| T1-DIS-02 | 禁用词汇 | 不含 "必涨" / "保底" / "承诺" / "guaranteed" / "assured" | P0 |
| T1-DIS-03 | 允许词汇 | "有望" / "参考" / "可能" / "potential" / "estimated" 允许出现 | P2 |
| T1-DIS-04 | SizeHint disclaimer | size_hint_advisory short 「仓位比例仅供参考，非下单 binding」(AI-γ v0.2 §7) | P0 |

### §1.5 · 状态流转

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-ST-01 | EmptyState → loading | 初始 EmptyState "今日暂无催化事件" → fetch 触发 → Skeleton 骨架屏 | P0 |
| T1-ST-02 | loading → DataLoaded | Skeleton → 数据到达 → 表格渲染 ≥1 行 · KPI 4 slot 有值 | P0 |
| T1-ST-03 | loading → Error | fetch 失败 → `role="alert"` 错误卡片 · 具体错因 · 重试按钮 | P0 |
| T1-ST-04 | Error → retry → DataLoaded | 重试按钮 click → re-fetch → 成功 → 表格渲染 | P1 |
| T1-ST-05 | AbortSignal on tab switch | 切换到 tab 2 → 前次 fetch abort → 无 setState-after-unmount 错误 (per merged C2 #193 useAbortableRequest) | P0 |
| T1-ST-06 | AbortSignal on refetch | 快速连续 refetch → 前次 abort → 仅最后一次 response 渲染 · signal.aborted 二次 guard | P1 |

### §1.6 · 排序

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-SORT-01 | Score 列降序默认 | 首次加载 → Score 列 desc 排序 | P1 |
| T1-SORT-02 | 列头点击切换排序 | click → asc → click → desc → click → none | P1 |
| T1-SORT-03 | 排序稳定性 | 同 score 行保持原始顺序 | P2 |

### §1.7 · Backend API 端点 (per Orch v311 Ruling #1 canonical path)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T1-API-01 | `GET /api/v1/morning-brief/:date` 候选列表 | 200 + body.candidates[].{symbol, name, score, catalyst_source, catalyst_kind, conviction, entry_plan} | P0 |
| T1-API-02 | `GET /api/v1/morning-brief/:date/summary` 当日汇总 KPI | 200 + body.{total_catalysts, sentiment, futures, high_conviction_pct} | P0 |
| T1-API-03 | `GET /api/v1/catalyst/:id` 催化事件详情 | 200 + body.{id, kind, source_ticker, description, fact_hash} | P0 |
| T1-API-04 | `GET /api/v1/catalyst/:id/candidates` 候选映射 | 200 + body.candidates[].{symbol, relevance_breakdown} | P0 |
| T1-API-05 | 无效日期 404 | `GET /api/v1/morning-brief/9999-99-99` → 404 | P1 |
| T1-API-06 | 无效催化 ID 404 | `GET /api/v1/catalyst/nonexistent` → 404 | P1 |

---

## §二 · Tab 2 美股优选 骨架测试用例 (NEW Sprint 2)

### §2.1 · 表格列渲染

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T2-COL-01 | Ticker 列渲染美股代码 | US ticker format `/^[A-Z]{1,5}$/` | P0 |
| T2-COL-02 | 6-dim 各列渲染 0-100 数值 | 质量/成长/估值/护城河/趋势/风险 · 各 0-100 · NaN-safe | P0 |
| T2-COL-03 | Score + Band 5-色 | ScoreCell: A=green/B=blue/C=yellow/D=orange/F=red (reuse from C2 #193 TableColumn) | P0 |
| T2-COL-04 | Conviction 3-色 pill | ConvictionPill: HIGH=green/MED=yellow/LOW=gray (reuse from C2 #193 TableColumn) | P0 |
| T2-COL-05 | RiskGate 3-色 chip + trigger count | RiskGateChip: GREEN/YELLOW/RED + hover tooltip count (reuse from C2 #193 TableColumn) | P0 |

### §2.2 · 过滤 chip

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T2-FC-01 | Sector multi-select | 点击多个 Sector chip → 交集过滤 · deselect 恢复 | P0 |
| T2-FC-02 | Score 阈值 single-select | ≥60 / ≥80 / ≥90 · 仅显示 matching rows | P0 |
| T2-FC-03 | Conviction level filter | all / HIGH / MED / LOW · 精确过滤 | P1 |
| T2-FC-04 | RiskGate GREEN only | 仅显示 risk_gate.overall_status=GREEN 行 | P1 |

### §2.3 · DetailSidebar (reuse 5 embedded cards from C2 #193)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T2-SD-01 | ScoreBreakdownCard 6-dim 含每维得分依据 | 6 progress bar + dimensional label + individual score | P0 |
| T2-SD-02 | ConvictionBreakdownCard adjustments 归因 | adjustments[] delta list + clamp formula | P0 |
| T2-SD-03 | EntryPlanCard SizeHint + disclaimer | same as T1-SD-05 | P0 |
| T2-SD-04 | RiskGateDetailCard 12-trigger | same as T1-SD-04 | P0 |

### §2.4 · Backend API 端点

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T2-API-01 | `GET /api/v1/us-select` 美股优选列表 | 200 + body.candidates[].{ticker, name, sector, score, band, conviction, risk_gate} | P0 |
| T2-API-02 | `GET /api/v1/us-select/:ticker` 个股详情 | 200 + body.{score_breakdown, conviction, risk_gate, entry_plan} | P1 |
| T2-API-03 | 无效 ticker 404 | `GET /api/v1/us-select/ZZZZZZ` → 404 | P1 |

### §2.5 · 空态

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T2-EMPTY-01 | 过滤无结果 | 所有 chip 选中使过滤为空 → EmptyState "当前过滤条件无匹配 · 请放宽阈值或换 Sector" | P1 |

---

## §三 · Tab 5 回测证据 测试用例 (per merged C3 #191)

### §3.1 · KPI 条 (per C3 BacktestEvidence.tsx + buildBacktestKpi)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T5-KPI-01 | win_rate KPI slot | win_rate ≥0.5 → --cd-up color · <0.5 → --cd-down | P0 |
| T5-KPI-02 | max_drawdown KPI slot | drawdown > -0.1 → --cd-up · ≤ -0.1 → --cd-down | P0 |
| T5-KPI-03 | sharpe KPI slot | sharpe ≥1 → --cd-up · <1 → --cd-down | P0 |

### §3.2 · PIT 安全 (per C3 types BacktestSnapshotSlot)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T5-PIT-01 | is_survivorship_biased warning badge | biased=true → warning badge visible | P0 |
| T5-PIT-02 | is_delisted_at_as_of stale tag | delisted=true → stale tag visible | P0 |
| T5-PIT-03 | as_of_utc 时间锚不可篡改 | read-only display · no user editable | P1 |

### §3.3 · Backend API 端点 (per Backend γ v0.2 · tab 5)

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T5-API-01 | `GET /api/v1/backtest-pit/:strategy` 快照列表 | 200 + body.snapshots[] with pagination | P0 |
| T5-API-02 | `GET /api/v1/backtest-pit/:strategy/:as_of` 单快照 | 200 + body.{as_of_utc, is_survivorship_biased, metrics} | P0 |
| T5-API-03 | `GET /api/v1/backtest-pit/:strategy/:as_of/holdings` 持仓 | 200 + body.holdings[].{ticker, weight, return_since_entry, is_stale} | P0 |

---

## §四 · 数据采集器集成测试框架

### §4.1 · SEC EDGAR 采集器测试 (per DP γ msg=ddc380f5)

```python
# test_sec_edgar_8k_collector.py
# Target: datapipeline/collectors/us_catalyst_collector/sec_edgar_8k.py

class TestSECEdgar8KCollector:

    def test_parse_8k_item_to_catalyst_kind(self, mock_8k_filing):
        """8-K item number → catalyst_kind 9-enum mapping"""
        result = collector.parse_filing(mock_8k_filing)
        assert result.catalyst_kind in CATALYST_KIND_9_ENUM
        assert result.catalyst_kind != ''

    def test_rate_limit_5_req_per_sec(self, mock_server):
        """SEC EDGAR 10 req/s limit respected (DP uses 5 conservative)"""
        timestamps = []
        for i in range(10):
            collector.fetch_filing(f"cik_{i}")
            timestamps.append(time.monotonic())
        for i in range(5, 10):
            assert timestamps[i] - timestamps[i-5] >= 1.0

    def test_idempotent_upsert(self, mock_db):
        """same filing ingested twice → single row (ON CONFLICT DO NOTHING)"""
        event = make_catalyst_event(source_kind='sec_8k')
        collector.write_event(event)
        collector.write_event(event)
        assert mock_db.count('us_catalyst_event') == 1

    def test_fact_hash_deterministic(self):
        """SHA-256 fact_hash is deterministic for same input (US-038)"""
        event1 = make_catalyst_event(ticker='AAPL', kind='earnings')
        event2 = make_catalyst_event(ticker='AAPL', kind='earnings')
        assert event1.fact_hash == event2.fact_hash
        assert re.match(r'^[a-f0-9]{64}$', event1.fact_hash)

    @pytest.mark.skipif(os.environ.get('RUN_LIVE_SEC') != '1',
                        reason='live SEC test requires RUN_LIVE_SEC=1')
    def test_live_efts_search(self):
        """EFTS full-text search returns valid results"""
        results = collector.search_efts('8-K', date_from='2026-07-01')
        assert len(results) > 0
        assert all(r.form_type == '8-K' for r in results)

    @pytest.mark.skipif(os.environ.get('RUN_LIVE_SEC') != '1',
                        reason='live SEC test requires RUN_LIVE_SEC=1')
    def test_live_submissions_endpoint(self):
        """Submissions API returns filings for known CIK"""
        filings = collector.get_submissions('0000320193')
        assert len(filings.recent) > 0
```

### §4.2 · Nasdaq Earnings Calendar 采集器测试

```python
# test_nasdaq_earnings_calendar.py

class TestNasdaqEarningsCalendar:

    def test_earnings_event_always_earnings_kind(self, mock_calendar):
        """Nasdaq earnings → catalyst_kind='earnings' hardcoded"""
        events = collector.parse_calendar(mock_calendar)
        assert all(e.catalyst_kind == 'earnings' for e in events)

    def test_rate_limit_1_req_per_sec(self, mock_server):
        """Nasdaq 1 req/s conservative limit"""
        ts = []
        for i in range(3):
            collector.fetch_page(i)
            ts.append(time.monotonic())
        for i in range(1, 3):
            assert ts[i] - ts[i-1] >= 1.0

    def test_idempotent_calendar_ingest(self, mock_db):
        """duplicate calendar entry → single row"""
        event = make_earnings_event(ticker='MSFT', date='2026-07-15')
        collector.write_event(event)
        collector.write_event(event)
        assert mock_db.count('us_catalyst_event') == 1
```

### §4.3 · EDINET XBRL 采集器测试

```python
# test_edinet_xbrl_collector.py

class TestEdinetXBRL:

    def test_parse_xbrl_jp_namespace(self, mock_xbrl_zip):
        """JP jppfs_cor namespace → jpkr_financial_snapshot fields"""
        row = collector.parse_xbrl(mock_xbrl_zip, market='JP')
        assert row.revenue_local is not None
        assert row.eps_local is not None
        assert row.currency == 'JPY'

    def test_edinet_code_to_sec_code_mapping(self, mock_code_list):
        """edinetCode↔secCode mapping table present and consistent"""
        mapping = collector.load_code_mapping(mock_code_list)
        assert len(mapping) > 0
        assert all(isinstance(v, str) and len(v) <= 10 for v in mapping.values())

    def test_rate_limit_2_req_per_sec(self, mock_server):
        """EDINET 2 req/s rate limit"""
        ts = []
        for i in range(4):
            collector.fetch_document(f"doc_{i}")
            ts.append(time.monotonic())
        for i in range(2, 4):
            assert ts[i] - ts[i-2] >= 1.0

    def test_fx_rate_usd_conversion(self):
        """market_cap_bn_usd = market_cap_local * fx_rate"""
        row = make_snapshot(market_cap_local=1000, currency='JPY')
        fx = FxRateFetcher.get_rate('JPY', 'USD', date='2026-07-10')
        converted = row.market_cap_local * fx
        assert abs(row.market_cap_bn_usd - converted) < 0.01
```

### §4.4 · DART XBRL 采集器测试

```python
# test_dart_xbrl_collector.py

class TestDartXBRL:

    def test_parse_dart_statements_json(self, mock_dart_response):
        """DART statements JSON → jpkr_financial_snapshot fields"""
        row = collector.parse_statements(mock_dart_response, market='KR')
        assert row.revenue_local is not None
        assert row.currency == 'KRW'

    def test_daily_quota_1000(self, mock_counter):
        """DART 1,000 req/day hard limit enforced"""
        mock_counter.set(999)
        collector.fetch_filing('corp_001')
        with pytest.raises(QuotaExhaustedError):
            collector.fetch_filing('corp_002')

    def test_corp_code_to_stock_code_mapping(self, mock_corp_xml):
        """corp_code↔stock_code mapping XML parse"""
        mapping = collector.load_corp_mapping(mock_corp_xml)
        assert len(mapping) > 0
```

### §4.5 · KRX Canary 测试

```python
# test_krx_canary.py

class TestKRXCanary:

    def test_schema_drift_detection(self, mock_krx_html_changed):
        """HTML structure change → drift alert raised"""
        result = canary.check_schema(mock_krx_html_changed)
        assert result.drifted is True
        assert result.alert_level in ('WARNING', 'CRITICAL')

    def test_fallback_to_pykrx(self, mock_krx_down):
        """KRX down → fallback to PyKRX + KIND"""
        data = canary.fetch_with_fallback(market='KRX')
        assert data.source in ('PyKRX', 'KIND')
        assert len(data.rows) > 0
```

### §4.6 · 共享底座测试

```python
# test_shared_collector_base.py

class TestSharedBase:

    def test_retry_with_backoff_5_attempts(self, mock_flaky_server):
        """5 retry + exponential backoff + jitter"""
        call_count = [0]
        def flaky():
            call_count[0] += 1
            if call_count[0] < 4:
                raise ConnectionError()
            return 'ok'
        result = retry_with_backoff(flaky, max_retries=5)
        assert result == 'ok'
        assert call_count[0] == 4

    def test_idempotency_hash_sha256_deterministic(self):
        """SHA-256 idempotency hash deterministic (US-038 Math.random=0)"""
        h1 = compute_idempotency_hash({'ticker': 'AAPL', 'date': '2026-07-10'})
        h2 = compute_idempotency_hash({'ticker': 'AAPL', 'date': '2026-07-10'})
        assert h1 == h2
        assert re.match(r'^[a-f0-9]{64}$', h1)

    def test_idempotency_hash_jcs_canonical(self):
        """key order does not affect hash (JCS RFC 8785)"""
        h1 = compute_idempotency_hash({'a': 1, 'b': 2})
        h2 = compute_idempotency_hash({'b': 2, 'a': 1})
        assert h1 == h2
```

---

## §五 · 跨层端到端验证

### §5.1 · 采集器 output → DDL CHECK 验证

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T3-DDL-01 | catalyst_kind 值域 CHECK | collector output → INSERT → catalyst_kind CHECK PASS · 无效值 → PG CHECK violation | P0 |
| T3-DDL-02 | conviction_final 范围 CHECK | `conviction_final ∈ [0, 100]` · 超出 → PG CHECK violation | P0 |
| T3-DDL-03 | risk_gate_severity 枚举 CHECK | severity ∈ {GREEN, YELLOW, RED} · 无效 → PG CHECK violation | P0 |
| T3-DDL-04 | size_hint_tier 枚举 CHECK | tier ∈ {TIER_5, TIER_3, TIER_2, TIER_1, SKIP} · 无效 → PG CHECK violation | P0 |
| T3-DDL-05 | adjustment_delta 范围 CHECK | `delta ∈ [-20, +20]` · 超出 → PG CHECK violation | P0 |
| T3-DDL-06 | adjustments 长度 CHECK | `length ∈ [0, 5]` · 超出 → application-level reject | P1 |
| T3-DDL-07 | scoring_id UUIDv4 format | `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/` | P0 |
| T3-DDL-08 | snapshot_hash SHA-256 format | `/^[a-f0-9]{64}$/` · JCS RFC 8785 canonical | P0 |

### §5.2 · 9-枚举 全链路一致性

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T3-ENUM-01 | Frontend chip set = Backend enum = DDL CHECK | 3 层 9-枚举值集 byte-exact match | P0 |
| T3-ENUM-02 | types.ts CatalystKind = Backend CatalystKind | Frontend `catdesk.ts` 枚举值 = Backend contract 枚举值 (per merged C2 #193 `shared/types/catdesk.ts`) | P0 |
| T3-ENUM-03 | collector kind_classifier output ⊂ 9-enum | classifier 所有可能输出 ∈ {9-enum} · 无 orphan 值 | P0 |

### §5.3 · Conviction 公式全链路验证

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T3-CONV-01 | final = clamp(base + Σ delta, 0, 100) | base=70 + [{delta:+10}, {delta:-5}] → final = 75 | P0 |
| T3-CONV-02 | final clamp lower bound | base=10 + [{delta:-20}] → final = 0 | P0 |
| T3-CONV-03 | final clamp upper bound | base=95 + [{delta:+20}] → final = 100 | P0 |
| T3-CONV-04 | Σ delta bound | [{delta:+10}×5] → Σ=50 → application reject (Σ ∈ [-20,+20]) | P0 |
| T3-CONV-05 | conviction level from final | final=75 → HIGH · final=60 → MED · final=40 → LOW | P0 |

### §5.4 · RiskGate 12-trigger 全链路覆盖

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T3-RG-01 | 9 US trigger 全覆盖 | Backend returns all 9 US triggers when applicable | P0 |
| T3-RG-02 | 3 A股 trigger 全覆盖 | Backend returns all 3 A股 triggers when applicable | P0 |
| T3-RG-03 | GREEN = no block | severity=GREEN → no conviction penalty | P0 |
| T3-RG-04 | YELLOW = warn(-5) | severity=YELLOW → conviction_final -= 5 | P0 |
| T3-RG-05 | RED = block(-10) | severity=RED → conviction_final -= 10 + block flag | P0 |
| T3-RG-06 | multi-trigger stacking | 2×YELLOW + 1×RED = total -20 penalty | P1 |

### §5.5 · Rating 5档 一致性

| TC-ID | 测试用例 | 断言 | 优先级 |
|-------|---------|------|--------|
| T3-RAT-01 | Score → rating_band mapping | score=90 → A · 75 → B · 60 → C · 45 → D · 30 → F | P0 |
| T3-RAT-02 | Band boundary precision | 84.9 → B · 85.0 → A · 69.9 → C · 70.0 → B | P0 |
| T3-RAT-03 | Frontend ScoreCell 色与 Band 对应 | A=green · B=blue · C=yellow · D=orange · F=red (per merged C2 #193 TableColumn ScoreCell) | P1 |

---

## §六 · Sprint 1 Code Review 已知偏差追踪 (Sprint 2 修正目标)

| # | 来源 | 偏差 | 影响 | Sprint 2 修正 |
|---|------|------|------|--------------|
| OBS-01 | C1 #198 MorningFilterBar | CATALYST_KINDS 使用 placeholder labels (policy/earnings/sector_rotation) 而非 canonical 9-enum | 过滤功能 chip text 与契约不一致 | γ-1 对齐 canonical 9-enum |
| OBS-02 | C1 #198 MorningBriefTable | `action` 列使用 `<a>` tag | 应为 `<button type="button">` + `aria-label` per checklist §全局 WAI-ARIA | γ-1 修正为 button |

---

## §七 · 测试配置与执行策略

### §7.1 · mock/live 双模式

```
# 默认 mock mode (CI 友好 · 无外部依赖)
pytest tests/collectors/ -m "not live"

# live mode (手动触发 · 需网络)
RUN_LIVE_SEC=1 RUN_LIVE_EDINET=1 RUN_LIVE_DART=1 \
  pytest tests/collectors/ -m "live"
```

### §7.2 · 测试文件目录 (Sprint 2 PR 搬 · v0.2 updated)

```
backend/tests/
├── collectors/
│   ├── test_sec_edgar_8k_collector.py
│   ├── test_nasdaq_earnings_calendar.py
│   ├── test_edinet_xbrl_collector.py
│   ├── test_dart_xbrl_collector.py
│   ├── test_krx_canary.py
│   └── test_shared_collector_base.py
├── e2e/
│   ├── test_catalyst_kind_cross_layer.py
│   ├── test_conviction_formula.py
│   ├── test_risk_gate_12_trigger.py
│   └── test_rating_band_consistency.py
├── api/
│   ├── test_morning_brief_endpoints.py      # v0.2 NEW (CANONICAL per Orch v311 Ruling #1)
│   ├── test_us_select_endpoints.py          # v0.2 NEW
│   └── test_backtest_pit_endpoints.py       # v0.2 NEW
frontend/src/__tests__/
├── tab1/
│   ├── MorningBriefTable.test.tsx
│   ├── MorningFilterBar.test.tsx
│   ├── DetailSidebarCards.test.tsx
│   ├── StateTransitions.test.tsx
│   └── DisclaimerAudit.test.tsx
├── tab2/
│   ├── USSelectTable.test.tsx               # v0.2 NEW
│   └── USSelectFilters.test.tsx             # v0.2 NEW
├── tab5/
│   ├── BacktestKpi.test.tsx                 # v0.2 NEW
│   └── PitSafety.test.tsx                   # v0.2 NEW
```

### §7.3 · CI 门禁集成

```yaml
# .github/workflows/sprint2-tests.yml (Sprint 2 PR 时新增)
name: Sprint 2 Tests
on: [push, pull_request]
jobs:
  collector-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install -r requirements-test.txt
      - run: pytest backend/tests/collectors/ -m "not live" --tb=short

  e2e-cross-layer:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pytest backend/tests/e2e/ --tb=short

  api-endpoint-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pytest backend/tests/api/ --tb=short

  frontend-tab1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd frontend && npm ci && npm test -- --testPathPattern="tab1"

  frontend-tab2:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd frontend && npm ci && npm test -- --testPathPattern="tab2"

  frontend-tab5:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd frontend && npm ci && npm test -- --testPathPattern="tab5"
```

---

## §八 · Test case summary (v0.2)

| section | P0 | P1 | P2 | total |
|---------|----|----|-----|-------|
| §一 Tab 1 columns | 5 | 3 | 0 | 8 |
| §一 Tab 1 sidebar | 5 | 2 | 0 | 7 |
| §一 Tab 1 filter | 3 | 1 | 1 | 5 |
| §一 Tab 1 disclaimer | 3 | 0 | 1 | 4 |
| §一 Tab 1 state | 4 | 2 | 0 | 6 |
| §一 Tab 1 sort | 0 | 2 | 1 | 3 |
| §一 Tab 1 API | 4 | 2 | 0 | 6 |
| §二 Tab 2 columns | 5 | 0 | 0 | 5 |
| §二 Tab 2 filter | 2 | 2 | 0 | 4 |
| §二 Tab 2 sidebar | 4 | 0 | 0 | 4 |
| §二 Tab 2 API | 1 | 2 | 0 | 3 |
| §二 Tab 2 empty | 0 | 1 | 0 | 1 |
| §三 Tab 5 KPI | 3 | 0 | 0 | 3 |
| §三 Tab 5 PIT | 2 | 1 | 0 | 3 |
| §三 Tab 5 API | 3 | 0 | 0 | 3 |
| §四 collectors | — | — | — | 18 (skeleton) |
| §五 cross-layer | 17 | 4 | 0 | 21 |
| **total** | **61** | **22** | **3** | **86 + 18 collector skeleton = 104** |

v0.2 delta: +17 tab 2 test cases, +9 tab 5 test cases, +6 tab 1 API test cases, +2 known deviations tracked, API path canonical per Orch v311 Ruling #1/#2.
