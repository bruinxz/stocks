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

## Worktree gotcha (still active as of US-005)

The git worktree has no `backend/node_modules`. Symlink before typecheck:

```bash
cd backend && ln -s /Users/.../stocks/backend/node_modules node_modules
```

**Remove the symlink before `git add`** — the repo's `.gitignore` matches
`node_modules/` as a directory pattern but the symlink shows up as an
untracked symlink file, polluting commits.
