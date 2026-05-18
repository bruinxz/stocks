#!/usr/bin/env node

/**
 * PostgreSQL runtime schema owner/grant health check.
 *
 * This is read-only. It validates that the application DB role can use the public
 * schema plus SELECT/INSERT/UPDATE/DELETE on runtime tables and USAGE/SELECT on
 * sequences. It is intended for deployment gates and smoke diagnostics.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const jsonOutPath = process.env.RUNTIME_SCHEMA_HEALTH_JSON_OUT || '';

const RUNTIME_SCHEMA_TABLES = [
  'stocks',
  'daily_bars',
  'backtest_results',
  'trades',
  'users',
  'favorite_stocks',
  'data_update_logs',
  'scheduled_tasks',
  'task_execution_logs',
  'daily_screeners',
  'paper_trading_portfolios',
  'paper_trading_positions',
  'paper_trading_trades',
  'paper_trading_snapshots',
  'risk_alerts',
  'trading_journals',
  'portfolio_simulations',
  'data_source_health',
  'ai_investment_signals',
  'recommendation_trade_outcomes',
  'recommendation_loop_policy_snapshots',
  'budget_policy_version_snapshots',
  'quant_strategies',
  'quant_backtest_tasks',
  'quant_backtest_results',
  'quant_backtest_trades',
  'quant_signals',
  'quant_strategy_performance_snapshots',
  'quant_strategy_weights',
  'quant_fusion_audits',
  'task_parameter_audit_logs',
  'realtime_quotes',
];

const CRITICAL_RUNTIME_SCHEMA_TABLES = [
  'scheduled_tasks',
  'task_execution_logs',
  'ai_investment_signals',
  'recommendation_trade_outcomes',
  'recommendation_loop_policy_snapshots',
  'quant_signals',
  'quant_fusion_audits',
  'quant_backtest_tasks',
  'quant_backtest_results',
  'quant_strategy_weights',
  'realtime_quotes',
  'paper_trading_portfolios',
  'paper_trading_trades',
  'task_parameter_audit_logs',
];

function readEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    result[key] = value;
  }
  return result;
}

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function optionalPg() {
  try {
    return require(path.join(repoRoot, 'backend/node_modules/pg'));
  } catch (error) {
    try {
      return require('pg');
    } catch (fallbackError) {
      return null;
    }
  }
}

function buildConfig() {
  const envFile = readEnvFile(path.join(repoRoot, 'backend/.env'));
  const env = { ...envFile, ...process.env };
  return {
    host: env.RUNTIME_SCHEMA_HEALTH_DB_HOST || env.DB_HOST || 'localhost',
    port: Number(env.RUNTIME_SCHEMA_HEALTH_DB_PORT || env.DB_PORT || 5432),
    database: env.RUNTIME_SCHEMA_HEALTH_DB_NAME || env.DB_NAME || 'stock_backtest',
    user: env.RUNTIME_SCHEMA_HEALTH_DB_USER || env.DB_USER || 'postgres',
    password: env.RUNTIME_SCHEMA_HEALTH_DB_PASSWORD || env.DB_PASSWORD || undefined,
    ssl:
      String(env.RUNTIME_SCHEMA_HEALTH_DB_SSL || env.DB_SSL || '').toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
    appRole: env.RUNTIME_SCHEMA_APP_ROLE || env.DB_USER || 'stock_admin',
    failOnWarning: String(env.RUNTIME_SCHEMA_HEALTH_FAIL_ON_WARNING || '').toLowerCase() === 'true',
    jsonOutPath,
  };
}

async function queryWithPg(config) {
  const pg = optionalPg();
  if (!pg) {
    return {
      skipped: true,
      reason: 'pg package is not installed; syntax-only environment',
      rows: [],
    };
  }
  const client = new pg.Client(config);
  await client.connect();
  try {
    const sql = buildHealthSql(config.appRole);
    const result = await client.query(sql);
    return { skipped: false, rows: result.rows || [] };
  } finally {
    await client.end();
  }
}

function buildHealthSql(appRole) {
  const tables = `ARRAY[${RUNTIME_SCHEMA_TABLES.map(sqlLiteral).join(',')}]::text[]`;
  const criticalTables = `ARRAY[${CRITICAL_RUNTIME_SCHEMA_TABLES.map(sqlLiteral).join(',')}]::text[]`;
  return `
    WITH expected_tables AS (
      SELECT unnest(${tables}) AS table_name
    ), critical_tables AS (
      SELECT unnest(${criticalTables}) AS table_name
    ), actual_tables AS (
      SELECT c.relname AS table_name, pg_catalog.pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    ), table_health AS (
      SELECT
        e.table_name,
        a.owner,
        a.table_name IS NOT NULL AS exists,
        e.table_name IN (SELECT table_name FROM critical_tables) AS critical,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${sqlLiteral(
          appRole
        )}, format('public.%I', e.table_name), 'SELECT') END AS can_select,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${sqlLiteral(
          appRole
        )}, format('public.%I', e.table_name), 'INSERT') END AS can_insert,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${sqlLiteral(
          appRole
        )}, format('public.%I', e.table_name), 'UPDATE') END AS can_update,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${sqlLiteral(
          appRole
        )}, format('public.%I', e.table_name), 'DELETE') END AS can_delete
      FROM expected_tables e
      LEFT JOIN actual_tables a ON a.table_name = e.table_name
    ), serial_sequences AS (
      SELECT DISTINCT pg_get_serial_sequence(format('public.%I', e.table_name), c.column_name) AS sequence_name
      FROM expected_tables e
      JOIN information_schema.columns c
        ON c.table_schema = 'public'
       AND c.table_name = e.table_name
      WHERE pg_get_serial_sequence(format('public.%I', e.table_name), c.column_name) IS NOT NULL
    ), sequence_health AS (
      SELECT
        sequence_name,
        has_sequence_privilege(${sqlLiteral(appRole)}, sequence_name, 'USAGE') AS can_usage,
        has_sequence_privilege(${sqlLiteral(appRole)}, sequence_name, 'SELECT') AS can_select
      FROM serial_sequences
    ), schema_health AS (
      SELECT
        has_schema_privilege(${sqlLiteral(appRole)}, 'public', 'USAGE') AS can_usage,
        has_schema_privilege(${sqlLiteral(appRole)}, 'public', 'CREATE') AS can_create
    )
    SELECT json_build_object(
      'checked_at', now(),
      'database', current_database(),
      'current_user', current_user,
      'app_role', ${sqlLiteral(appRole)},
      'schema', (SELECT row_to_json(schema_health) FROM schema_health),
      'tables', COALESCE((SELECT json_agg(table_health ORDER BY critical DESC, table_name) FROM table_health), '[]'::json),
      'sequences', COALESCE((SELECT json_agg(sequence_health ORDER BY sequence_name) FROM sequence_health), '[]'::json)
    ) AS health;
  `;
}

function normalizeRows(rows) {
  return rows[0]?.health || {};
}

function summarize(raw, skippedInfo) {
  if (skippedInfo?.skipped) {
    return {
      status: 'skipped',
      success: true,
      skipped: true,
      reason: skippedInfo.reason,
      critical_issues: 0,
      warnings: 0,
      missing_tables: [],
      privilege_gaps: [],
      sequence_gaps: [],
      raw: {},
    };
  }
  const tables = Array.isArray(raw.tables) ? raw.tables : [];
  const sequences = Array.isArray(raw.sequences) ? raw.sequences : [];
  const missingTables = tables.filter(item => !item.exists);
  const privilegeGaps = tables.filter(
    item => item.exists && (!item.can_select || !item.can_insert || !item.can_update || !item.can_delete)
  );
  const sequenceGaps = sequences.filter(item => !item.can_usage || !item.can_select);
  const schema = raw.schema || {};
  const schemaGaps = [];
  if (!schema.can_usage) schemaGaps.push('USAGE');
  if (!schema.can_create) schemaGaps.push('CREATE');

  const criticalIssues =
    missingTables.filter(item => item.critical).length +
    privilegeGaps.filter(item => item.critical).length +
    sequenceGaps.length +
    schemaGaps.length;
  const warnings = missingTables.filter(item => !item.critical).length + privilegeGaps.filter(item => !item.critical).length;
  return {
    status: criticalIssues > 0 ? 'critical' : warnings > 0 ? 'warning' : 'healthy',
    success: criticalIssues === 0,
    skipped: false,
    checked_at: raw.checked_at,
    database: raw.database,
    current_user: raw.current_user,
    app_role: raw.app_role,
    critical_issues: criticalIssues,
    warnings,
    schema_gaps: schemaGaps,
    missing_tables: missingTables.map(item => item.table_name),
    privilege_gaps: privilegeGaps.map(item => ({
      table_name: item.table_name,
      critical: Boolean(item.critical),
      missing_privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].filter(priv => !item[`can_${priv.toLowerCase()}`]),
      owner: item.owner,
    })),
    sequence_gaps: sequenceGaps.map(item => ({
      sequence_name: item.sequence_name,
      missing_privileges: ['USAGE', 'SELECT'].filter(priv => !item[`can_${priv.toLowerCase()}`]),
    })),
    raw,
  };
}

async function main() {
  const config = buildConfig();
  const queryResult = await queryWithPg(config);
  const summary = summarize(normalizeRows(queryResult.rows), queryResult);
  const output = { summary };
  if (config.jsonOutPath) {
    fs.mkdirSync(path.dirname(config.jsonOutPath), { recursive: true });
    fs.writeFileSync(config.jsonOutPath, JSON.stringify(output, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'critical' || (config.failOnWarning && summary.status === 'warning')) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error?.message || error);
  process.exit(1);
});
