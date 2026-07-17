#!/usr/bin/env node

/**
 * Read-only, cross-page production data-watermark audit.
 *
 * The reference date is the newest A-share daily bar, or EXPECTED_DATA_DATE when
 * explicitly supplied. No sync, scheduler or trading action is triggered.
 */

const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendDir = path.join(repoRoot, 'backend');
const backendNodeModules = path.join(backendDir, 'node_modules');
if (fs.existsSync(backendNodeModules)) {
  require('module').Module._initPaths();
  process.env.NODE_PATH = [process.env.NODE_PATH, backendNodeModules]
    .filter(Boolean)
    .join(path.delimiter);
  require('module').Module._initPaths();
}

try {
  require('dotenv').config({ path: path.join(backendDir, '.env') });
} catch (_) {
  // dotenv is optional when the service environment is already exported.
}

const { Client } = require('pg');
const jsonOut = process.env.FRESHNESS_JSON_OUT || '';
const strictFusion = String(process.env.FRESHNESS_STRICT_FUSION || '').toLowerCase() === 'true';

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toShanghaiDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function lagDays(latest, reference) {
  if (!latest || !reference) return null;
  const from = new Date(`${latest}T00:00:00+08:00`).getTime();
  const to = new Date(`${reference}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = $1
     ) as exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function addWatermarkCheck(client, checks, referenceDate, definition) {
  if (!(await tableExists(client, definition.table))) {
    checks.push({
      name: definition.name,
      status: definition.critical ? 'missing' : 'warn',
      critical: definition.critical,
      message: 'table not found',
    });
    return;
  }
  const result = await client.query(definition.sql);
  const row = result.rows[0] || {};
  const latestDate = toShanghaiDate(row.latest_data_date);
  const lag = lagDays(latestDate, referenceDate);
  const status = lag === null ? (definition.critical ? 'missing' : 'warn') : lag <= definition.maxLag ? 'pass' : 'warn';
  checks.push({
    name: definition.name,
    status,
    critical: definition.critical,
    latest_data_date: latestDate,
    latest_at: toIso(row.latest_at),
    reference_data_date: referenceDate,
    lag_days: lag,
    max_lag_days: definition.maxLag,
    latest_count: Number(row.latest_count || 0),
    scope: definition.scope,
  });
}

async function addAShareCoverageChecks(client, checks, referenceDate) {
  const instrumentRows = await client.query(
    `SELECT COALESCE(s.type, 'unknown') AS instrument_type,
            COUNT(*) FILTER (WHERE s.is_listed)::int AS listed_count,
            COUNT(DISTINCT b.stock_id)::int AS covered_count
       FROM stocks s
       LEFT JOIN daily_bars b
         ON b.stock_id = s.id AND b.time::date = $1::date
      GROUP BY COALESCE(s.type, 'unknown')
      ORDER BY instrument_type`,
    [referenceDate]
  );
  const requiredTypes = new Set(['stock', 'index', 'fund']);
  for (const row of instrumentRows.rows) {
    const listed = Number(row.listed_count || 0);
    const covered = Number(row.covered_count || 0);
    const coverage = listed > 0 ? covered / listed : 0;
    const required = requiredTypes.has(row.instrument_type);
    checks.push({
      name: `a_share_instrument_coverage:${row.instrument_type}`,
      status: !required || (listed > 0 && coverage >= 0.99) ? 'pass' : 'missing',
      critical: required,
      reference_data_date: referenceDate,
      listed_count: listed,
      covered_count: covered,
      coverage_percent: Number((coverage * 100).toFixed(2)),
    });
    requiredTypes.delete(row.instrument_type);
  }
  for (const missingType of requiredTypes) {
    checks.push({
      name: `a_share_instrument_coverage:${missingType}`,
      status: 'missing',
      critical: true,
      message: 'required instrument type not found',
    });
  }

  const recentCoverage = await client.query(
    `WITH listed AS (
       SELECT COUNT(*)::numeric AS total FROM stocks WHERE is_listed = TRUE
     ), recent_days AS (
       SELECT time::date AS trade_date
         FROM daily_bars
        WHERE time::date <= $1::date
        GROUP BY time::date
        ORDER BY time::date DESC
        LIMIT 10
     ), coverage AS (
       SELECT d.trade_date, COUNT(DISTINCT b.stock_id)::numeric AS covered
         FROM recent_days d
         LEFT JOIN daily_bars b ON b.time::date = d.trade_date
        GROUP BY d.trade_date
     )
     SELECT MIN(covered / NULLIF(listed.total, 0)) AS min_coverage,
            MIN(trade_date)::text AS window_start,
            MAX(trade_date)::text AS window_end,
            COUNT(*)::int AS observed_trade_days
       FROM coverage CROSS JOIN listed`,
    [referenceDate]
  );
  const coverageRow = recentCoverage.rows[0] || {};
  const minimumCoverage = Number(coverageRow.min_coverage || 0);
  checks.push({
    name: 'a_share_recent_daily_bar_coverage',
    status: minimumCoverage >= 0.95 && Number(coverageRow.observed_trade_days) >= 10 ? 'pass' : 'missing',
    critical: true,
    window_start: coverageRow.window_start || null,
    window_end: coverageRow.window_end || null,
    observed_trade_days: Number(coverageRow.observed_trade_days || 0),
    minimum_coverage_percent: Number((minimumCoverage * 100).toFixed(2)),
    required_coverage_percent: 95,
  });

  const realtimeCoverage = await client.query(
    `WITH latest AS (SELECT MAX(trade_date) AS trade_date FROM realtime_quotes),
          listed AS (SELECT COUNT(*)::numeric AS total FROM stocks WHERE is_listed = TRUE)
     SELECT latest.trade_date::text AS latest_data_date,
            COUNT(DISTINCT q.symbol)::numeric AS covered,
            listed.total
       FROM latest CROSS JOIN listed
       LEFT JOIN realtime_quotes q ON q.trade_date = latest.trade_date
      GROUP BY latest.trade_date, listed.total`
  );
  const realtimeRow = realtimeCoverage.rows[0] || {};
  const realtimeTotal = Number(realtimeRow.total || 0);
  const realtimeCovered = Number(realtimeRow.covered || 0);
  const realtimePercent = realtimeTotal > 0 ? realtimeCovered / realtimeTotal : 0;
  const realtimeDate = toShanghaiDate(realtimeRow.latest_data_date);
  checks.push({
    name: 'a_share_realtime_full_market_coverage',
    status:
      lagDays(realtimeDate, referenceDate) === 0 && realtimePercent >= 0.95 ? 'pass' : 'missing',
    critical: true,
    latest_data_date: realtimeDate,
    reference_data_date: referenceDate,
    listed_count: realtimeTotal,
    covered_count: realtimeCovered,
    coverage_percent: Number((realtimePercent * 100).toFixed(2)),
    required_coverage_percent: 95,
  });
}

async function addScheduleChecks(client, checks) {
  if (!(await tableExists(client, 'scheduled_tasks'))) {
    checks.push({ name: 'scheduler_contract', status: 'missing', critical: true });
    return;
  }
  const result = await client.query(`
    select type, cron_expression, is_active
      from scheduled_tasks
     where type in ('REALTIME_QUOTE_SYNC', 'GLOBAL_MARKET_DAILY_SYNC')
     order by type
  `);
  const rows = new Map(result.rows.map(row => [row.type, row]));
  const expected = [
    ['REALTIME_QUOTE_SYNC', '*/5 9-11,13-14 * * 1-5'],
    ['GLOBAL_MARKET_DAILY_SYNC', '0 9 * * *'],
  ];
  for (const [type, cron] of expected) {
    const row = rows.get(type);
    const valid = Boolean(row?.is_active) && row?.cron_expression === cron;
    checks.push({
      name: `schedule:${type}`,
      status: valid ? 'pass' : 'missing',
      critical: true,
      expected_cron: cron,
      actual_cron: row?.cron_expression || null,
      is_active: Boolean(row?.is_active),
    });
  }
}

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'stock_backtest',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  const checks = [];
  await client.connect();
  try {
    const referenceResult = await client.query('select max(time)::date as latest from daily_bars');
    const referenceDate =
      process.env.EXPECTED_DATA_DATE || toShanghaiDate(referenceResult.rows[0]?.latest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate || '')) {
      throw new Error('cannot determine reference data date');
    }

    const definitions = [
      {
        name: 'a_share_daily_bars', table: 'daily_bars', maxLag: 0, critical: true,
        scope: 'A股行情',
        sql: `select max(time)::date latest_data_date, max(updated_at) latest_at,
                     count(*) filter (where time::date=(select max(time)::date from daily_bars)) latest_count
                from daily_bars`,
      },
      {
        name: 'a_share_factor_scores', table: 'factor_scores', maxLag: 0, critical: true,
        scope: 'A股因子',
        sql: `select max(trade_date) latest_data_date, max(updated_at) latest_at,
                     count(*) filter (where trade_date=(select max(trade_date) from factor_scores)) latest_count
                from factor_scores`,
      },
      {
        name: 'a_share_realtime_quotes', table: 'realtime_quotes', maxLag: 0, critical: true,
        scope: 'A股盘中行情',
        sql: `select max(trade_date) latest_data_date, max(quote_time) latest_at,
                     count(distinct symbol) filter (where trade_date=(select max(trade_date) from realtime_quotes)) latest_count
                from realtime_quotes`,
      },
      {
        name: 'a_share_limit_up', table: 'limit_up_stocks', maxLag: 0, critical: true,
        scope: 'A股情绪',
        sql: `select max(trade_date) latest_data_date, max(updated_at) latest_at,
                     count(*) filter (where trade_date=(select max(trade_date) from limit_up_stocks)) latest_count
                from limit_up_stocks`,
      },
      {
        name: 'a_share_announcements', table: 'announcement_summaries', maxLag: 1, critical: true,
        scope: 'A股公告',
        sql: `select max(announce_date) latest_data_date, max(updated_at) latest_at,
                     count(*) filter (where announce_date=(select max(announce_date) from announcement_summaries)) latest_count
                from announcement_summaries`,
      },
      {
        name: 'daily_report_cn_a', table: 'ai_recommendation_snapshot', maxLag: 0, critical: true,
        scope: 'A股日报',
        sql: `select max(trading_day) latest_data_date, max(created_at) latest_at,
                     count(*) filter (where trading_day=(select max(trading_day) from ai_recommendation_snapshot where profile='us_preferred' and market_scope='cn_a')) latest_count
                from ai_recommendation_snapshot where profile='us_preferred' and market_scope='cn_a'`,
      },
      {
        name: 'us_catalyst_snapshot', table: 'ai_recommendation_snapshot', maxLag: 1, critical: true,
        scope: '美股催化',
        sql: `select max(trading_day) latest_data_date, max(created_at) latest_at,
                     count(*) filter (where trading_day=(select max(trading_day) from ai_recommendation_snapshot where profile='us_preferred' and market_scope='us')) latest_count
                from ai_recommendation_snapshot where profile='us_preferred' and market_scope='us'`,
      },
      {
        name: 'jp_catalyst_snapshot', table: 'ai_recommendation_snapshot', maxLag: 1, critical: true,
        scope: '日本催化',
        sql: `select max(trading_day) latest_data_date, max(created_at) latest_at,
                     count(*) filter (where trading_day=(select max(trading_day) from ai_recommendation_snapshot where profile='japan_blue_chip' and market_scope='jp')) latest_count
                from ai_recommendation_snapshot where profile='japan_blue_chip' and market_scope='jp'`,
      },
      {
        name: 'jpkr_market', table: 'jpkr_daily_kline', maxLag: 1, critical: true,
        scope: '日韩大势',
        sql: `select max(trading_day) latest_data_date, max(available_at_utc) latest_at,
                     count(*) filter (where trading_day=(select max(trading_day) from jpkr_daily_kline)) latest_count
                from jpkr_daily_kline`,
      },
      {
        name: 'multibagger_snapshot', table: 'multibagger_candidate_snapshot', maxLag: 0, critical: true,
        scope: '高倍潜力',
        sql: `select max(as_of_utc)::date latest_data_date, max(as_of_utc) latest_at,
                     count(*) filter (where as_of_utc::date=(select max(as_of_utc)::date from multibagger_candidate_snapshot)) latest_count
                from multibagger_candidate_snapshot`,
      },
      {
        name: 'backtest_pit_snapshot', table: 'backtest_pit_snapshot', maxLag: 5, critical: false,
        scope: '回测证据',
        sql: `select max(snapshot_day) latest_data_date, max(created_at) latest_at,
                     count(*) filter (where snapshot_day=(select max(snapshot_day) from backtest_pit_snapshot)) latest_count
                from backtest_pit_snapshot`,
      },
      {
        name: 'quant_signals', table: 'quant_signals', maxLag: 5, critical: false,
        scope: '旧量化信号链',
        sql: `select max(trade_date) latest_data_date, max(updated_at) latest_at,
                     count(*) filter (where trade_date=(select max(trade_date) from quant_signals)) latest_count
                from quant_signals`,
      },
      {
        name: 'quant_fusion_audits', table: 'quant_fusion_audits',
        maxLag: Number(process.env.FRESHNESS_FUSION_MAX_AGE_DAYS || 10),
        critical: strictFusion, scope: '旧融合审计链',
        sql: `select max(signal_date) latest_data_date, max(updated_at) latest_at,
                     count(*) filter (where signal_date=(select max(signal_date) from quant_fusion_audits)) latest_count
                from quant_fusion_audits`,
      },
    ];

    for (const definition of definitions) {
      await addWatermarkCheck(client, checks, referenceDate, definition);
    }
    await addAShareCoverageChecks(client, checks, referenceDate);
    await addScheduleChecks(client, checks);
  } finally {
    await client.end();
  }

  const criticalFailed = checks.filter(
    item => item.critical && (item.status === 'missing' || item.status === 'warn')
  ).length;
  const warned = checks.filter(item => item.status === 'warn').length;
  const summary = {
    success: criticalFailed === 0,
    generated_at: new Date().toISOString(),
    critical_failed: criticalFailed,
    warned,
    checks,
  };
  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  }
  for (const check of checks) {
    const label = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${label}] ${check.name}: ${JSON.stringify(check)}`);
  }
  console.log(JSON.stringify({ success: summary.success, critical_failed: criticalFailed, warned }, null, 2));
  if (!summary.success) process.exit(1);
}

main().catch(error => {
  console.error('[FATAL]', error.message || error);
  process.exit(1);
});
