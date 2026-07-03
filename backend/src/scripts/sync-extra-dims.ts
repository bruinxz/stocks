#!/usr/bin/env node
/**
 * 4 个新数据维度统一同步 CLI (2026-06-11).
 *
 * 数据维度：
 *   1. 宏观经济指标（PMI/CPI/M2/SHIBOR/10Y国债/GDP）→ macro_indicators
 *   2. 期权波动率指数（50/300/500ETF + 创业板 QVIX）→ option_qvix
 *   4. 公募基金重仓股（季报）→ fund_top_holdings (单独跑慢，可选)
 *
 * Usage:
 *   npm run sync:extra-dims                 # 默认跑 macro+qvix (快)
 *   npm run sync:extra-dims -- --dim=macro
 *   npm run sync:extra-dims -- --dim=qvix
 *   npm run sync:extra-dims -- --dim=fund --funds=001186,005827 --date=2025
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { MacroIndicator, OptionQvix, FundTopHolding } from '../models';

const PYTHON = process.env.PYTHON_BIN || '/opt/stocks/shared/venv/bin/python';
const HELPER = process.env.AKSHARE_HELPER || `${process.cwd()}/python/akshare_helper.py`;

function callPython(command: string, args: string[] = [], timeoutMs = 120_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [HELPER, command, ...args]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Python timeout (${timeoutMs}ms): ${command}`));
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Python exit ${code}: ${stderr.substring(0, 500)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error(`Python error: ${parsed.error}`));
      } catch (e: any) {
        reject(new Error(`JSON parse failed: ${e.message}`));
      }
    });
  });
}

async function syncMacro() {
  logger.info('[extra-dims] 拉宏观经济指标 6 个 series...');
  const result = await callPython('get_macro_indicators', [], 180_000);

  let total = 0;
  for (const [seriesKey, rows] of Object.entries(result)) {
    if (!Array.isArray(rows)) continue;
    const records: any[] = [];
    for (const r of rows as any[]) {
      // 不同 series 字段不一样，统一塞到 macro_indicators
      let date = r.date;
      // 日期归一化 (PMI/CPI/M2 可能是 "2026年5月" 形式)
      if (typeof date === 'string') {
        const m = date.match(/(\d{4})[年\-/](\d{1,2})(?:[月\-/](\d{1,2}))?/);
        if (m) {
          const y = m[1];
          const mo = String(m[2]).padStart(2, '0');
          const d = m[3] ? String(m[3]).padStart(2, '0') : '01';
          date = `${y}-${mo}-${d}`;
        }
      }
      if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      const value =
        seriesKey === 'm2'
          ? r.m2_value
          : seriesKey === 'shibor_overnight'
          ? r.rate
          : seriesKey === 'treasury_10y'
          ? r.china_10y
          : r.value;
      if (value == null || !Number.isFinite(value)) continue;

      // treasury_10y 单独存 china_10y 主值; raw 含其他 maturity
      const indicatorKey = seriesKey === 'treasury_10y' ? 'treasury_10y_china' : seriesKey;

      records.push({
        indicator_key: indicatorKey,
        observation_date: date,
        value,
        yoy_pct: r.m2_yoy ?? null,
        mom_pct: null,
        raw_payload: r,
        source: 'akshare',
      });
    }
    if (records.length === 0) continue;
    await MacroIndicator.bulkCreate(records, {
      updateOnDuplicate: ['value', 'yoy_pct', 'mom_pct', 'raw_payload', 'updated_at'],
    });
    total += records.length;
    logger.info(`  ${seriesKey}: upserted ${records.length}`);
  }
  return total;
}

async function syncQvix() {
  logger.info('[extra-dims] 拉期权波动率指数 4 个 underlying...');
  const result = await callPython('get_option_qvix', [], 120_000);
  let total = 0;
  for (const [underlying, rows] of Object.entries(result)) {
    if (!Array.isArray(rows)) continue;
    const records = (rows as any[])
      .filter(r => r.date && r.close != null && Number.isFinite(r.close))
      .map(r => ({
        underlying,
        observation_date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        source: 'akshare',
      }));
    if (records.length === 0) continue;
    await OptionQvix.bulkCreate(records, {
      updateOnDuplicate: ['open', 'high', 'low', 'close', 'updated_at'],
    });
    total += records.length;
    logger.info(`  ${underlying}: upserted ${records.length}`);
  }
  return total;
}

async function syncFundHoldings(fundCodes: string[], date: string) {
  logger.info(`[extra-dims] 拉 ${fundCodes.length} 个基金重仓 (${date})...`);
  const rows = (await callPython(
    'get_fund_top_holdings',
    [fundCodes.join(','), date],
    600_000
  )) as any[];
  if (!Array.isArray(rows) || rows.length === 0) {
    logger.warn('  无数据');
    return 0;
  }
  const reportDate =
    date.length === 4
      ? `${date}-12-31`
      : date.length === 8
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : date;
  // 去重: 同一 (fund_code, stock_code, report_date) 在 helper 返回里可能有多条
  // (不同季报披露顺序), 同 batch 内 PK 冲突会触发 ON CONFLICT DO UPDATE row affected 2 times
  const seenPK = new Set<string>();
  const records: any[] = [];
  for (const r of rows) {
    if (!r.fund_code || !r.stock_code) continue;
    const pk = `${r.fund_code}|${r.stock_code}|${reportDate}`;
    if (seenPK.has(pk)) continue;
    seenPK.add(pk);
    records.push({
      fund_code: r.fund_code,
      stock_code: r.stock_code,
      stock_name: r.stock_name || null,
      report_date: reportDate,
      ratio_pct: r.ratio_pct,
      shares: r.shares,
      market_value: r.market_value,
      source: 'akshare',
    });
  }
  if (records.length === 0) {
    logger.warn('  无有效记录');
    return 0;
  }
  await FundTopHolding.bulkCreate(records, {
    updateOnDuplicate: ['stock_name', 'ratio_pct', 'shares', 'market_value', 'updated_at'],
  });
  logger.info(`  fund_top_holdings: upserted ${records.length} (去重前 ${rows.length})`);
  return records.length;
}

const program = new Command();
program
  .name('sync-extra-dims')
  .description('同步数据维度: 宏观 / 期权 / 基金')
  .option('--dim <name>', '维度 (all|macro|qvix|fund)', 'all')
  .option('--funds <codes>', '基金代码 csv (基金维度)')
  .option('--date <date>', '基金 date 参数 (e.g. "2025" 或 "20250630")', '2025')
  .parse(process.argv);

const opts = program.opts();

(async () => {
  await sequelize.authenticate();
  let total = 0;
  try {
    if (opts.dim === 'all' || opts.dim === 'macro') {
      total += await syncMacro();
    }
    if (opts.dim === 'all' || opts.dim === 'qvix') {
      total += await syncQvix();
    }
    if (opts.dim === 'fund') {
      // 默认 universe = 12 只有代表性的主动权益/灵活配置基金
      const DEFAULT_FUNDS = [
        '110011',
        '161725',
        '519005',
        '001186',
        '005827',
        '270002',
        '003095',
        '163406',
        '002251',
        '519066',
        '110022',
        '161005',
      ];
      const codes = opts.funds
        ? String(opts.funds)
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : DEFAULT_FUNDS;
      total += await syncFundHoldings(codes, opts.date);
    }
    logger.info(`✅ sync-extra-dims done, total upserted: ${total}`);
    process.exit(0);
  } catch (e: any) {
    logger.error(`sync-extra-dims ERROR: ${e.message}`);
    process.exit(1);
  }
})();
