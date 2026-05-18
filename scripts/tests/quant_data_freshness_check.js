#!/usr/bin/env node

/**
 * Read-only DB freshness check for quant automation.
 *
 * It verifies that the most important closed-loop data tables have recent rows:
 * - realtime_quotes: intraday/latest quote snapshots
 * - quant_signals: daily quant scoring output
 * - quant_fusion_audits: Agent-fused second-pass scoring output
 *
 * No data sync, Agent job, scheduler job or trade action is triggered.
 */

const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendDir = path.join(repoRoot, 'backend');
const backendNodeModules = path.join(backendDir, 'node_modules');
if (fs.existsSync(backendNodeModules)) {
  require('module').Module._initPaths();
  process.env.NODE_PATH = [process.env.NODE_PATH, backendNodeModules].filter(Boolean).join(path.delimiter);
  require('module').Module._initPaths();
}

try {
  require('dotenv').config({ path: path.join(backendDir, '.env') });
} catch (_) {
  // dotenv is optional for syntax-only checks.
}

const { Client } = require('pg');

const quoteMaxAgeMinutes = Math.max(Number(process.env.FRESHNESS_QUOTE_MAX_AGE_MINUTES || 60), 1);
const signalMaxAgeDays = Math.max(Number(process.env.FRESHNESS_SIGNAL_MAX_AGE_DAYS || 5), 1);
const fusionMaxAgeDays = Math.max(Number(process.env.FRESHNESS_FUSION_MAX_AGE_DAYS || 10), 1);
const jsonOut = process.env.FRESHNESS_JSON_OUT || '';
const strictFusion = String(process.env.FRESHNESS_STRICT_FUSION || '').toLowerCase() === 'true';

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function ageMinutes(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function ageDaysFromDateOnly(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function statusForAge(age, maxAge, missingStatus = 'missing') {
  if (age === null || age === undefined) return missingStatus;
  return age <= maxAge ? 'pass' : 'warn';
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

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'stock_backtest',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl:
      process.env.DB_SSL === 'true'
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  const checks = [];
  await client.connect();
  try {
    if (await tableExists(client, 'realtime_quotes')) {
      const latestQuote = await client.query(
        `select max(quote_time) as latest_quote_time,
                count(*) filter (where trade_date = current_date) as today_count,
                count(distinct symbol) filter (where trade_date = current_date) as today_symbol_count
         from realtime_quotes`
      );
      const row = latestQuote.rows[0] || {};
      const age = ageMinutes(row.latest_quote_time);
      checks.push({
        name: 'realtime_quotes',
        status: statusForAge(age, quoteMaxAgeMinutes),
        latest_at: toIso(row.latest_quote_time),
        age_minutes: age,
        max_age_minutes: quoteMaxAgeMinutes,
        today_count: Number(row.today_count || 0),
        today_symbol_count: Number(row.today_symbol_count || 0),
      });
    } else {
      checks.push({ name: 'realtime_quotes', status: 'missing', message: 'table not found' });
    }

    if (await tableExists(client, 'quant_signals')) {
      const latestSignal = await client.query(
        `select max(trade_date) as latest_trade_date,
                count(*) filter (where trade_date = (select max(trade_date) from quant_signals)) as latest_count
         from quant_signals`
      );
      const row = latestSignal.rows[0] || {};
      const age = ageDaysFromDateOnly(row.latest_trade_date);
      checks.push({
        name: 'quant_signals',
        status: statusForAge(age, signalMaxAgeDays),
        latest_trade_date: row.latest_trade_date ? String(row.latest_trade_date).slice(0, 10) : null,
        age_days: age,
        max_age_days: signalMaxAgeDays,
        latest_count: Number(row.latest_count || 0),
      });
    } else {
      checks.push({ name: 'quant_signals', status: 'missing', message: 'table not found' });
    }

    if (await tableExists(client, 'quant_fusion_audits')) {
      const latestFusion = await client.query(
        `select max(signal_date) as latest_signal_date,
                count(*) filter (where signal_date = (select max(signal_date) from quant_fusion_audits)) as latest_count
         from quant_fusion_audits`
      );
      const row = latestFusion.rows[0] || {};
      const age = ageDaysFromDateOnly(row.latest_signal_date);
      checks.push({
        name: 'quant_fusion_audits',
        status: statusForAge(age, fusionMaxAgeDays, strictFusion ? 'missing' : 'warn'),
        latest_signal_date: row.latest_signal_date ? String(row.latest_signal_date).slice(0, 10) : null,
        age_days: age,
        max_age_days: fusionMaxAgeDays,
        latest_count: Number(row.latest_count || 0),
        strict: strictFusion,
      });
    } else {
      checks.push({
        name: 'quant_fusion_audits',
        status: strictFusion ? 'missing' : 'warn',
        message: 'table not found',
        strict: strictFusion,
      });
    }
  } finally {
    await client.end();
  }

  const criticalFailed = checks.filter(item => item.status === 'missing').length;
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
  console.log(JSON.stringify({ success: summary.success, warned }, null, 2));

  if (!summary.success) process.exit(1);
}

main().catch(error => {
  console.error('[FATAL]', error.message || error);
  process.exit(1);
});
