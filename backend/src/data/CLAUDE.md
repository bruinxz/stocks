# A-Share Data Layer

This directory hosts ingestion clients and sync services for A-share market data.
The layering mirrors what's already in `quant/` and `portfolio/`: clients fetch,
services persist, CLI scripts drive both for ops.

## Directory shape

```
backend/src/data/
├── sources/      ← raw-data clients (HTTP / Python helper / SDK adapters)
├── services/     ← DB write + range / checkpoint orchestration
└── processors/   ← cross-source transformations (factor derivation, joins)
```

The CLI scripts that exercise these live in `backend/src/scripts/sync-*.ts`.

## Adding a new A-share data source

Established by **US-005 (northbound holdings)** — follow the trio + CLI shape.

1. **Model** — `backend/src/models/<Source>.ts` (sequelize-typescript).
   - Use composite PK on `(trade_date, primary_key_field)` for daily snapshots.
   - Keep a `raw_payload` JSONB column for the full upstream row (audit trail).
   - Add a `source` STRING column (default the provider name) so multi-source
     reconciliation is possible later.
   - Register the model in BOTH `models/index.ts` AND `config/database.ts`
     (the sequelize-typescript `models:` array) — `sync({alter:true})` will
     pick it up automatically in non-prod.

2. **Client** — `backend/src/data/sources/<Source>Client.ts`.
   - Wrap the Python helper (preferred for AKShare) using the same
     `spawn` + `{success,data}` JSON contract as `AKShareClient`.
   - Export a singleton (e.g. `northboundDataClient`) so services can DI it.
   - Use a per-source `<SOURCE>_TIMEOUT_MS` env so timeouts don't share.

3. **Service** — `backend/src/data/services/<Source>SyncService.ts`.
   - Expose `syncDate(date)` + `syncRange(start, end)` minimum.
   - `syncDate` uses `bulkCreate` + `updateOnDuplicate` — INCLUDE `updated_at`
     in the update list so ops can see refresh times.
   - `syncRange` skips days that already have data by default; expose
     `--force` (or `<SOURCE>_SKIP_EXISTING=0`) for backfills.
   - Empty upstream responses on weekends/holidays → log `fetched=0`, not an
     error. That distinguishes "tried but no data" from "fetch failed".

4. **Python helper** — `backend/python/akshare_helper.py`.
   - Add the function + dispatcher case in `main()`.
   - Accept both `YYYY-MM-DD` and `YYYYMMDD` — convert internally.
   - Build a柔性 col_map for Chinese column headers (akshare renames between
     versions; reading by exact name silently zeroes data on upgrade).
   - Return `[]` (not raise) on empty data so the TS layer can checkpoint.

5. **CLI** — `backend/src/scripts/sync-<source>.ts`.
   - Use `commander`. Support `--date` / `--start`/`--end` / `--force` /
     `--market` (or domain-specific) flags.
   - Auto-run `sequelize.sync({alter:true})` in non-prod so a fresh DB picks
     up new tables without a manual migration.
   - Exit 1 if any day in a range failed so cron wrappers can retry.

6. **package.json** — add `sync:<source>` npm script.

## Reusable Python utilities

- `safe_float_value(val)` — converts NaN / "−" / "未知" / "-" / "" to None.
  Use it for every numeric column extracted from AKShare DataFrames.
- `_format_iso_date(yyyymmdd)` — `20250605` → `2025-06-05`; passthrough for
  already-ISO strings. Used to canonicalise `trade_date` before TS receives it.
- `_cell_str / _cell_float / _cell_int` (US-007) — safe `row.get(col)` with
  `pd.isna` + empty-string handling baked in. Use instead of inlining
  `safe_float_value(row.get(col)) if col else None` in each new command.
- `_row_to_jsonable(row, columns)` (US-007) — pandas Series → JSON-friendly
  dict for `raw_payload` (NaN → None, numeric → float, else str). Use whenever
  you preserve the original AKShare row.
- `_is_one_word(limit_up_time, open_times)` (US-007) — robust parser for
  AKShare's inconsistent time formats (`"09:25:03"` and `"92503"` both occur).
  Pattern for any HH:MM check: strip non-digits, slice by length.

## Multi-record-per-stock pattern (US-006 dragon-tiger)

Some A-share data sources fan a single stock into MANY rows per day:
龙虎榜 is `buyer_seat × seller_seat` cartesian; eventual 涨停板 is candidate-list.
For those, the model PK is a 3-/4-tuple (not just `trade_date + stock_code`).
The Python helper does the fan-out and emits one TS row per pair so the service
layer stays a simple `bulkCreate + updateOnDuplicate`. Keep both halves of the
join in `raw_payload` (e.g. `{list_row, buyer_row, seller_row}`) for audit.

A boolean tag computed from a whitelist (e.g. `is_famous_yz` against
`constants/famousSeats.ts`) belongs in the **service**, not the Python helper:
TS owns business logic, Python is the dumb fetcher.

**US-088 extension**: when a whitelist outgrows a flat `string[]` and needs
typed metadata (席位归属机构 / 关键词风险等级 / KOL 情绪权重), upgrade it to
`ReadonlyArray<ProfileType>` (e.g. `SEAT_PROFILES: ReadonlyArray<SeatProfile>`)
as the single source of truth and **derive** the legacy string array via
`.filter(...).map(p => p.name)` for backward compat. Ship a `getXxxType(name)`
function with a multi-tier fallback chain (direct hit → alias normalize →
keyword fallback → unknown) and an `isValidXxxType(value)` type guard for HTTP
query validation. The sync service populates the new typed column at write
time so downstream factor / strategy / UI can group by it without re-running
the whitelist logic on every read. `famousSeats.ts` + `DragonTigerBoard.seat_type`
+ `DragonTigerSyncService.syncDate` is the canonical reference.

## Multi-endpoint merge (US-007 涨停 zt_pool + strong_pool)

When AKShare exposes **two endpoints with overlapping rows + each-side-unique
columns** for the same logical entity (涨停股池 + 强势股池 both keyed on stock):

1. **Python pulls both**, picks one as primary (zt_pool: has 连板数 / 封板资金 /
   炸板次数), indexes the other (strong_pool: has 入选理由) by stock_code into
   a side-car dict.
2. **One pass over the primary df** emits merged rows; a `seen_codes: set`
   tracks what's been emitted.
3. **A second loop** emits secondary-only rows (stocks in strong_pool but not
   zt_pool) with sensible defaults.
4. **`raw_payload = {primary_row, secondary_row}`** — both halves preserved.

The TS service stays a clean `bulkCreate` — no merge logic on its side.

## Cross-day derived fields (US-007 continuous_days 连板天数)

For fields that depend on N previous trading days (`continuous_days` looks back
1 day, but the pattern generalises to MA / rolling stats):

1. `syncDate(date)` calls `loadRecentHistory(today, lookbackDays)` BEFORE the
   `bulkCreate` — one query, projected columns only, sorted desc per stock_code.
2. Per row, compute the derived field with a pure function
   (`computeContinuousDays(code, today, history)`).
3. **Floor on the upstream initial value if any** — `Math.max(recomputed,
   akshareInitial)`. AKShare's own `连板数` is mostly right but occasionally
   drops to 0 on data hiccups; the floor preserves correctness.
4. **A-share weekend gap tolerance** — Friday limit-up + Monday limit-up counts
   as continuous. `daysBetween > 4 ? 1 : prev+1` handles a long weekend plus
   one trading-day skip; tighten if your field is stricter.

## Multi-endpoint join WITHOUT a shared key (US-008 industry flow)

When AKShare exposes endpoints that **must be combined to get a row's full
shape, but they don't share a stable key**: `stock_sector_fund_flow_rank` only
gives 名称 (no board code), while `stock_board_industry_name_em` is the table
that knows 板块代码 (BKxxxx). The join key is the (Chinese) industry NAME —
which is fine in practice because Eastmoney is the single source of truth for
both. Strategy:

1. **Python pulls the "wide" / metric-rich endpoint first**, then the smaller
   "name→code mapping" endpoint, indexes the latter by name into a dict, and
   joins per row.
2. **Always have a fallback for missing keys** — emit
   `industry_code = "FALLBACK-<name>"` rather than dropping the row. Dropping
   would silently break ranking analyses that rely on the full universe.
3. **Cross-DB joins (e.g. `limit_up_count` requires JOINing LimitUpStock)
   belong in the TS service**, not Python. Python is the stateless fetcher;
   the TS service queries our DB in `loadXxxByIndustry()` and merges in pure
   JS before `bulkCreate`. Same divider as `is_famous_yz` in US-006.

## Real-time-only snapshots (no historical replay)

A subset of AKShare endpoints — `stock_sector_fund_flow_rank`,
`stock_board_industry_name_em`, `stock_board_industry_cons_em`, and most of
the fund-flow family — are **point-in-time snapshots, not historical APIs**.
You can never replay yesterday's fund flow; you can only snapshot today.

Make this caller-visible:

- **Document it on the client class** ("AKShare 接口为实时快照而非历史；调用方
  应当日盘后调用").
- **The `date` param becomes a label, not a fetch filter** — Python stamps
  the supplied date onto every output row but the data is "now". Don't pretend
  to support `--start=2023-01-01` backfills on these sources; the CLI works
  but writes today's snapshot under historical dates, polluting the DB.
- **Schedule once per day, post-close**. The `INDUSTRY_FLOW_TIMEOUT_MS` default
  is 240s because per-board `cons_em` fetches dominate (~86 boards × AKShare
  rate-limit). Don't set below 120s on a busy day.

## Event-style data keyed by report period (US-013 earnings forecasts)

A few AKShare endpoints — `stock_yjyg_em` (业绩预告), `stock_yjbb_em` (业绩快报),
`stock_yjkb_em` (业绩报表) — are **keyed by report period (报告期末), not by
the announce date**. The dataframe returned for `date='20240930'` lists every
stock that has published a forecast for Q3 2024, with the actual announce date
carried as a row column.

Implications:

- **Sync at the report-period level**, not the trade-date level. The service
  method is `syncReportPeriod(period)`, not `syncDate(date)`.
- **CLI accepts `--year=YYYY` as a convenience** that expands to the 4 quarter
  ends. Pass `--report-period=YYYY-MM-DD` for one-off backfills.
- **The primary key includes the report period** — `(announce_date, stock_code,
  report_period)` 3-tuple. One stock may have multiple forecasts for different
  report periods (most companies forecast quarterly), and revisions on a NEW
  announce_date are distinct rows; revisions on the SAME announce_date overwrite
  (which is exactly what `bulkCreate + updateOnDuplicate` does).
- **Business-logic flags (`is_surprise`) live in the TS service**, not Python —
  same rule as `is_famous_yz` in US-006. The rule "forecast_type ∈ {预增/扭亏/
  续盈} AND profit_change_low ≥ 50%" may evolve as strategies tune thresholds;
  keeping it TS-side means no Python redeploy.
- **Quarter-end validation is advisory, not strict**: passing 2024-04-15 returns
  an empty dataframe (`stock_yjyg_em` simply doesn't have a key for that), so
  log a warn but don't reject. Some upstream calendars publish off-quarter
  revisions; future proofing.

## Reference / index data (US-020 IndexComponent)

Some AKShare endpoints serve **slow-changing reference data** — index
constituents, famous-trader seat lists, sector classifications. They follow
the "real-time snapshot, date is a label" pattern from US-008 industry-flow,
**plus** an extra subtlety: callers usually want "the latest known snapshot
≤ asOfDate", not "today's data". Strategies should query with `Op.lte` ordering
DESC to grab the latest snapshot, accepting a few days of staleness.

Concrete US-020 example: `IndexComponent` table holds (trade_date, index_code,
stock_code) constituent snapshots. `CTA100MomentumStrategy.loadIndexUniverse()`
queries `IndexComponent.findOne({ trade_date: { Op.lte: asOfDate }, index_code:
'000852' }, order: [['trade_date','DESC']])` to find the most recent sync,
then loads all rows for that `(snapshot_date, index_code)` as the universe.

Implications:

- **Multi-index support via composite PK**: `(trade_date, index_code, stock_code)`
  lets one snapshot date hold N indexes (000300/000852/000905 etc.) — callers
  filter by `index_code` to select universe.
- **CLI exposes both `--index=<code>` and `--indexes=<codes>` flags** so cron
  can sync multiple indexes for the same date in one invocation; the service's
  `syncIndexes` loops with per-index `skipExisting` checkpoint.
- **`raw_payload` keeps the source df row** + the AKShare helper attempts the
  best-effort weight endpoint (`index_stock_cons_weight_csindex`) on CSI series;
  failing it returns `weight=null` per row rather than failing the whole sync.
  Many use cases (CTA100 momentum) don't need weight.
- **Index code normalization**: 6-digit code without suffix (`000852`, not
  `000852.SH` or `CSI1000`); matches the `stock_code` convention in 5 sibling
  tables (NorthboundHolding / DragonTigerBoard / LimitUpStock / IndustryFlow /
  FactorScore).
- **`_KNOWN_INDEX_NAMES` Python dict** fallback: if AKShare's df doesn't carry
  Chinese name (some endpoints don't), the helper hard-codes a short list
  (000016 上证 50, 000300 沪深 300, 000852 中证 1000, etc.) so `index_name`
  is rarely null for mainstream indexes.

## Per-stock sync (US-022 DividendHistory)

A subset of AKShare endpoints — `stock_history_dividend_detail` (分红派息明细),
个股股东户数, 个股财报历史 — are **per-stock historical timelines**, not per-day
snapshots. One call returns the full multi-year history for ONE stock (typically
10-30 dividend records covering 10-20 years), so sync is keyed on `stock_code`
not `trade_date`. The sync service has `syncStock(stockCode)` + `syncStocks(codes[])`
instead of `syncDate(date)` + `syncRange(start, end)`.

Implications:

- **`syncStocks` accepts `--all` to sweep all listed A-shares** + `--listed-before`
  to filter out IPOs younger than N years (no dividend history yet). Add a
  `--interval-ms` (default 200ms) friendly throttle for AKShare — per-stock fetch
  is 1-3s, and a 5000-stock sweep without throttle gets blocked within minutes.
- **Skip-existing is per-stock**: if a stock already has any dividend_histories
  row, the whole stock is skipped. Re-running after a few months catches the
  1-2 new records added in the interim via `--force` (re-fetches and `bulkCreate +
  updateOnDuplicate` upserts everything for the stock).
- **Cross-table derived fields (e.g. `yield_pct` = dividend_per_share / ex_date 前一日
  close) belong in the TS service**, same rule as `is_famous_yz` / `continuous_days`.
  The service queries DailyBar after each `fetchForStock` returns, computes
  yield_pct per ex_date row (linear scan since `dividend rows < 50`), and includes
  it in the bulkCreate payload. Missing DailyBar data → `yield_pct = null`,
  策略 layer treats null as "skip this dividend event".
- **dividend_per_share semantics**: AKShare's 派息 column is "每 10 股派现金额（元）";
  the Python helper does the `/10` conversion so TS sees "每股派息金额".
  Document this in the model's column comment + client jsdoc — easy to mis-multiply
  by 10 again downstream and break yield calculations.
- **Python helper柔性 col_map**: column names like 派息 vs 派息(元) vs 现金分红
  drift across AKShare versions; 公告日期 vs 预案公告日 vs 除权除息日 vs 除息日
  similarly. New stories adding per-stock historical sync (财报 / 股东户数) should
  copy the same dict-build-then-iterrows pattern from `get_dividend_history`.

## Per-stock sync, multi-endpoint merge (US-024 FinancialReport)

US-024 introduces a **二级扩展模式** to the per-stock sync template (US-022): the
Python helper fetches data from **multiple AKShare endpoints** and merges them
into one normalized row payload before returning. Specifically `get_financial_report`
combines:

- `stock_financial_analysis_indicator(symbol, start_year)` — per-period rows
  with ratios (净利润 yoy / 营收 yoy / ROE / 资产负债率)
- `stock_financial_abstract(symbol)` — wide-format dataframe with raw amounts
  (归母净利润 / 营业总收入)

Both endpoints are keyed by `report_date` (YYYY-MM-DD), so the Python merge is
deterministic — index the abstract `df` by `YYYYMMDD` column, lookup per
`indicator_row.date`, build the joined row. The merge happens in **Python, not TS**
because:

1. The two endpoints have inconsistent shapes (long-form vs wide-form) and pandas
   handles wide-form column lookup naturally.
2. Per-version 列名 quirks (`归母净利润` vs `净利润` vs `归属于母公司股东的净利润`)
   live in the helper anyway — keeping all merge code there localizes the
   "data shape glue" layer.

**Implications for TS layer**:
- `FinancialReport.report_type` field is **inferred from `report_date` MMDD** in
  Python (`03-31 = 一季报`, `06-30 = 半年报`, `09-30 = 三季报`, `12-31 = 年报`),
  not parsed from a separate AKShare field. Reduces dependency on field naming
  drift. **Sync service does NOT recompute report_type from report_date** — trust
  the helper.
- **No yield_pct-style cross-table TS computation** in this story (unlike US-022
  DividendHistory's TS-side yield calc). All fields are already in the raw response
  or computable inside Python without DailyBar joins.
- **Helper timeout = 180s default** (vs 120s for dividend) because two endpoints
  + Python merge takes ~2-3s/stock. Set via `FINANCIAL_REPORT_TIMEOUT_MS` env.
- **Sync throttle = 300ms default** (vs 200ms for dividend) for same reason —
  AKShare two endpoints back-to-back is harsher on rate limits.

For future stories needing multi-endpoint Python merges (US-030 AnalystForecast =
research_report + earnings_forecast, US-031 QualityHigh = multiple income statement
pieces), copy this merge-in-Python pattern: each endpoint as a separate `df = fn(...)`
fetch, dictionary index by shared key, single-pass merge per row. **Don't return
two arrays and merge in TS** — TS rebuilding pandas semantics in Map<...> is
painful and quirks have to be replicated twice.

## Per-stock sync with dynamic column-year mapping (US-030 AnalystForecast)

US-030 introduces a **new wrinkle** to the per-stock sync template (US-022 / US-024):
AKShare's `stock_research_report_em(symbol)` returns columns whose names contain
the **forecast year as a dynamic suffix** — e.g. `2026-盈利预测-收益`,
`2027-盈利预测-收益`, `2028-盈利预测-收益`. The year part **rolls forward every
new calendar year** as analysts publish forecasts for additional years.

Hard-coding column names like `2026-盈利预测-收益` would silently zero-out the
forecast every January. The Python helper handles this with a **regex column
discovery pass**:

```python
year_eps_cols = []   # [(year, col_name), ...]
eps_re = re.compile(r'^(\d{4})-盈利预测-收益$')
for col in df.columns:
    m = eps_re.match(str(col))
    if m:
        year_eps_cols.append((int(m.group(1)), str(col)))
year_eps_cols.sort(key=lambda x: x[0])   # ascending → y1 = nearest forward year
```

Then `forecast_eps_y1 / forecast_year_y1` are mapped to the **first** (nearest)
year column, `_y2 / _year_y2` to the second, etc. The TS layer sees stable column
names `forecast_eps_y{1,2,3}` and a separate `forecast_year_y{1,2,3}` so the
factor layer can group by forecast year (critical for the AnalystConsensusFactor:
跨年时 2024 末的"2025E EPS"不能与 2025 末的"2026E EPS"直接对比).

**Implications for future stories**:
- Any AKShare endpoint with `YYYY` substring in column names (盈利预测,
  现金分红时间序列, 业绩快报 by report year) should use this regex-discover-+-sort
  pattern. **Don't hard-code year literals.**
- Store the resolved year alongside the value (`forecast_year_y1` column in
  AnalystForecast). The factor layer needs the year to group / align时序对比
  correctly. Cross-year comparisons without explicit year tracking are silent
  garbage.

**Composite PK + in-memory dedup before bulkCreate**: 3-tuple PK
`(report_date, stock_code, analyst_firm)` is the natural unique key for analyst
reports, BUT one firm occasionally publishes 2 distinct reports (深度 + 点评)
on the same day for the same stock. With `bulkCreate + updateOnDuplicate`, the
in-batch behavior on duplicate PKs is dialect-dependent — Postgres silently keeps
"the latest insert", MySQL may error. **The service layer dedups in-memory before
bulkCreate** with a deterministic `preferRow(a, b)` policy (EPS present > rating
present > longer title > later in input), making the upsert dialect-independent
and predictable for ops. `dedup_dropped` is reported in `SyncStockResult` so the
log line shows when it triggered.

**No business derivation in this sync service** (unlike US-022 DividendHistory's
yield_pct compute). target_price is a future-expansion placeholder column;
forecast_eps revision logic lives entirely in the factor (`AnalystConsensusFactor.compute()`)
so the factor stays re-runnable without re-syncing data.

## Per-stock sync with dual proxy substitution (US-034 StockSentiment)

When AC specifies endpoints / fields that **do not exist or are unreachable** in
the public data sources (US-034: AC asks for `stock_guba_em` 发帖数+浏览量 —
`stock_guba_em` is not in AKShare; guba 网页有反爬严格无 API；
`stock_hot_rank_em` returns only today's top 100, no history), use the same
**double-proxy substitution** pattern from US-031/US-032 but at the **data layer**
(not just the factor layer):

1. **Substitute the endpoint**: pick the closest historical per-stock endpoint
   (here: `stock_hot_rank_detail_em(symbol='SH600519'|'SZ000001')` returning
   ~365-day timeline of rank + 新晋粉丝 + 铁杆粉丝 ratios).
2. **Materialize the proxy field in DB at sync time** — not in factor. The
   StockSentiment model stores `post_count` as **round(100000 / rank)**, `view_count`
   as **round((new_fan + hardcore_fan) × 1000)**, `heat_score` as composite. This
   lets the factor read a stable `post_count` column without knowing the proxy
   semantics (so when US-090+ introduces real post counts from XQ/TuShare Pro, the
   factor doesn't change — just the sync code writes the real number into the
   same column).
3. **Document the proxy fact** in 4 places (US-031 范式 strict adherence):
   - Sequelize model column comment ("发帖数代理：1/rank × 100000")
   - Python helper `get_stock_sentiment` docstring (full algebra + theoretical basis)
   - TS Client jsdoc ("AC 提到的端点不存在；用 X 替代；Python 内部做双重代理")
   - Factor jsdoc ("post_count 实为 rank 倒数代理 — 详见模型 docstring")

**API class naming may keep the original AC term** (e.g. `EastMoneyQAClient` for
US-034 even though it doesn't touch the Q&A 股吧 endpoint) — keeps continuity
with the user story title and downstream references. Add a one-line jsdoc note
at the top explaining "类名沿用 AC 命名，实际数据源是 X 而非 Q&A".

**The factor formula reads materialized columns, not proxy semantics** — `east_money_qa`
just computes `avg(post_count[recent]) / avg(post_count[baseline])`. The proxy
constants `100000` / `1000` are scale-only and 5d/30d ratio is invariant to that
scaling. This means the factor will keep working when the proxy is later replaced
by real data, as long as the new data is written to the same `post_count` column.

**Friendly throttle 200ms** (default; configurable via `EAST_MONEY_QA_TIMEOUT_MS`
env / `--interval-ms` CLI flag), `EAST_MONEY_QA_TIMEOUT_MS=90000` (90s default —
faster than analyst_forecast 120s because hot_rank_detail has lighter response
than research_report).

## Per-stock historical with endpoint substitution (US-035 ShareholderCount)

`ShareholderCount` (US-035) sources shareholder count history via AKShare. PRD AC
names `stock_zh_a_gdhs`, but **that endpoint only accepts `symbol='最新'` or a
single `'YYYYMMDD'` date** — returns one snapshot for the whole market, not a
per-stock time series. The actual endpoint that fits the factor's needs is
`stock_zh_a_gdhs_detail_em(symbol=<6-digit>)`, which returns the full per-stock
historical timeline (~50-70 quarterly snapshots / 10+ years on a listed name).

**Endpoint substitution checklist (extends the US-034 dual-proxy pattern):**
1. **Document the substitution in 4 places**: Python helper docstring + TS Client
   jsdoc + Sync service jsdoc + Factor jsdoc (`ShareholderConcentrationFactor`
   doesn't re-document at the factor level since the factor only reads a column;
   the substitution surfaces at the sync layer).
2. **Same output shape**: as long as the substitute returns
   `[{report_date, stock_code, holder_count, share_change, ...}, ...]`, downstream
   bulkCreate + factor compute() see no difference.
3. **Upgrade path clear**: if AKShare adds per-stock history to `stock_zh_a_gdhs`
   later, swap the call inside `get_shareholder_count` — sync service / model /
   factor / tests need zero changes.
4. **Sync service stays dumb**: business-condition filters (e.g. "skip rows where
   share_change != 0") belong in the factor layer where they can evolve without
   re-running sync. Same divider as US-006 famous_seat / US-013 is_surprise /
   US-022 yield_pct.

**New TS factor pattern introduced: "business-condition exclusion" guard**: the
`ShareholderConcentrationFactor` skips a stock when the latest snapshot has
`share_change != 0` (送转股 / 增发 makes holder_count environmentally
incomparable to the prior quarter). This is the first "filter by business
semantic" guard — previous factor guards only filtered for data hygiene
(null / NaN / 边界值). Reuse this pattern in future stories where the data
itself is computable but its meaning is broken (ex-dividend close comparisons,
suspension-bridged price ratios, post-split PE).

**Friendly throttle 200ms** (same default as US-022/US-024/US-030/US-034);
`SHAREHOLDER_COUNT_TIMEOUT_MS=90000` (90s; same as east_money_qa — per-stock
single-endpoint call); `SHAREHOLDER_COUNT_SKIP_EXISTING=0` equivalent to
`--force` on the CLI.

## Snowball hot keywords with "新进" baseline tracking (US-058)

`SnowballHotKeyword` (PK = `(trade_date, keyword)`) lives in the same family as
US-008 industry-flow — **real-time-only AKShare endpoint** `stock_hot_follow_xq`
(symbol `'最热门'` / `'本周新增'`) returns "now" data; `trade_date` is the
**label** the SyncService stamps at scheduling time (post-market). Document
this in 3 places: model jsdoc, Client jsdoc, SyncService jsdoc.

**AC-proxy substitution (same pattern as US-034/US-056)**: AC asked for "雪球
热门话题" but AKShare exposes no topic-dimension endpoint. We map `keyword =
股票简称` (stock name) and `heat_score = 关注人数` (follower count), keeping
`related_stocks_json` as a **JSONB array** (currently length 1) so a future
real-topic data source can populate `[{stock_code, ...}, {stock_code, ...}]`
without schema migration. Per the codebase pattern, document the AC ↔ proxy
mapping at 4 spots (Python helper, TS Client, model field comment, Service
jsdoc).

**"新进" boolean — baseline-search, not naïve `trade_date - 1`**: holidays
break the simple "yesterday" assumption (long weekends, Chinese New Year 7-9
days). `SnowballHotKeywordSyncService.loadPreviousKeywords(tradeDate,
lookbackDays=14)` finds the **most recent date ≤ tradeDate - 1 day with data**
and uses its keyword set as baseline. If no baseline exists (first sync), all
rows get `is_new=false` to avoid the 200-strong false-positive blast. Default
`lookbackDays=14` covers Chinese New Year (longest continuous holiday). The
same pattern applies to any future "新增 / 突变 / 出现" boolean derived from
prior trading day (US-088 new positions, US-094 行业突变 surfacing, etc.) —
**do not** wire a literal `trade_date - 1` query; always go through the
baseline-search helper.

**Public read API (`GET /api/sentiment/snowball-keywords`)** delivered via
`SentimentController.getSnowballKeywords`. Query params follow the "loose
parse, never 4xx" rule: `date` regex-checked (`^\d{4}-\d{2}-\d{2}$`, fall to
"latest with data" on miss), `only_new=true|1` (anything else is false),
`limit` clamped to `[1, 1000]`. Service-side `listByDate` does the actual
SELECT + ORDER BY rank ASC; controller just shapes the response.

**Throttle & CLI**: `--backfill=start,end` runs day-by-day serial sync with
default `intervalMs=3000` (AKShare-friendly for repeated `stock_hot_follow_xq`
calls). `SNOWBALL_KEYWORD_TIMEOUT_MS=120000` (120s; per-call returns ~5600
rows so a touch slower than US-034). `SNOWBALL_KEYWORD_SKIP_EXISTING=0`
equivalent to `--force` on the CLI for re-pulling existing days.

## Real-time snapshot + N-tuple PK + TS-side classifier (US-090 ShareholderTradeRecord)

`ShareholderTradeRecord` (PK = `(announce_date, stock_code, shareholder_name,
trade_direction, change_start_date)` 五元组) covers股东增减持公告 (insider trades
by major shareholders / executives / institutions). Three patterns combine in
one model — each is independently reusable for future event-style sources.

**Real-time-only snapshot semantics (US-008/US-058 pattern reaffirmed)**:
AKShare `stock_ggcg_em(symbol='全部'|'股东增持'|'股东减持')` takes no date
parameter — single call returns "当下可见的近 N 月全市场" snapshot (~140k rows,
~290 pages internally, ~90 seconds). Per-row `announce_date` IS dated, but the
FULL TABLE window slides with calling time. Historical backfill only accrues
via daily scheduled syncs. Same 3-spot doc convention: model jsdoc + Client
jsdoc + SyncService jsdoc all warn about the slide.

**N-tuple PK for multi-shareholder events (extends US-006 dragon-tiger
multi-record pattern)**: a single announcement (announce_date + stock_code)
typically lists N shareholders simultaneously (e.g. all 董监高 announcing in
sync). Same shareholder can flip 增持/减持 within N months, can split a single
announcement into multiple batches (different change_start_date). So PK = 5
fields not 2. The Python helper does NO fan-out for this case — it returns one
row per (announcement, shareholder, direction, batch) tuple as AKShare already
fans them, and the service-layer `Map<5tuple, row>` in-memory dedup makes
bulkCreate + updateOnDuplicate dialect-independent (same US-030 AnalystForecast
范式: Postgres silent-overwrite vs MySQL dup-error). `change_start_date` has a
`'1970-01-01'` default for the rare row where AKShare's "变动开始日" is empty —
NULL would break the composite PK.

**TS-side heuristic classifier (US-006/US-088 范式 extended)**: AKShare's
`stock_ggcg_em` returns only `股东名称` — no structured 股东类型 field.
`ShareholderTradeSyncService.classifyShareholderType(name)` reads the name with
a 4-tier short-circuit chain:
1. null / empty / single-char → '其他'
2. 命中 `INSTITUTION_KEYWORDS` (25 关键词: 基金/信托/资本/合伙企业/QFII/RQFII/
   capital/fund/...) → '机构投资者'
3. 全中文 2-4 字 (typical 自然人 name pattern `^[一-鿿]{2,4}$`) → '自然人'
4. fallback → '其他'

The '高管' tier is **declared in the type signature but never returned** — the
endpoint exposes no "高管职务" field today; preserving the type is the
**upgrade path** for when AKShare adds it (sync service swaps one branch, no
downstream consumer changes). This is the standard "preserve schema for
future-extension" pattern — same as US-007 leader_stock_change_pct field
existing in IndustryFlow before any factor reads it. Classifier lives entirely
in the service (not the Python helper) so rule evolution doesn't trigger a
re-fetch.

**Trade amount proxy (US-031/US-032/US-034 proxy 范式)**: AKShare exposes only
`最新价` + `变动股数` — no `成交均价`. Sync writes `trade_amount = trade_shares
× latest_price` as a **粗略市值代理**. Document in 4 places: model field comment
+ Python helper docstring + TS Client jsdoc + InsiderTradeFactor jsdoc. The
factor's `net_inflow / circulating_market_cap` ratio is **scale-invariant** in
the横截面 — the systematic latest-price bias affects all stocks similarly so
ranks survive (same logic as US-034 east_money_qa post_count rank-倒数代理).
Upgrade path: if AKShare ships 成交均价 later, replace one line in
`get_shareholder_trade` Python; no factor / model / test change.

**Throttle & CLI**: `--symbol=全部|股东增持|股东减持` (default '全部' — business
runs full sync once daily then splits by trade_direction column at query time;
single-direction backfills only when needed). `SHAREHOLDER_TRADE_TIMEOUT_MS=240000`
(240s; longer than other clients because 290-page AKShare internal pagination
~90s and we want generous headroom for retries). No `--start`/`--end` flags —
the endpoint is real-time-only, range queries are meaningless.

## Worktree gotcha (still active as of US-005)

The git worktree has no `backend/node_modules`. Symlink before typecheck:

```bash
cd backend && ln -s /Users/.../stocks/backend/node_modules node_modules
```

**Remove the symlink before `git add`** — the repo's `.gitignore` matches
`node_modules/` as a directory pattern but the symlink shows up as an
untracked symlink file, polluting commits.
