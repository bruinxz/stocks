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

## Worktree gotcha (still active as of US-005)

The git worktree has no `backend/node_modules`. Symlink before typecheck:

```bash
cd backend && ln -s /Users/.../stocks/backend/node_modules node_modules
```

**Remove the symlink before `git add`** — the repo's `.gitignore` matches
`node_modules/` as a directory pattern but the symlink shows up as an
untracked symlink file, polluting commits.
