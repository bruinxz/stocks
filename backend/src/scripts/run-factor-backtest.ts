#!/usr/bin/env node
/**
 * ETF 因子轮动历史回测 — 信号优先重构 批6 (§7.4 "因子历史回测脚本 2022-2026 验证")
 *
 * 主线核心 (Core 70%) 的离线验证器. 逐月末:
 *   1. ETFRotationStrategy.generateSignals(monthEnd) → 目标权重 (top4 买 / top6 卖, 单只≤15%, 核心≤70%)
 *   2. 用月末 → 次月末的 ETF 复权收益, 按目标权重加权 = 该月组合收益
 *   3. 现金部分 (1 - Σ权重) 按无风险日息 (默认年化 2%) 计息
 *   4. 复利成净值曲线, 与基准 (默认 sh.000300 沪深300) 对比
 *
 * 只读 daily_bars / 因子依赖表, 不写任何库 (纯验证). 与 7 关回测套件互补:
 *   7 关跑的是通用 QuantStrategy; 本脚本专测 ETF 因子轮动主线的月度调仓逻辑.
 *
 * Usage:
 *   npm run run:factor-backtest -- --start=2022-01-01 --end=2026-06-30
 *   npm run run:factor-backtest -- --start=2022-01-01 --end=2026-06-30 --benchmark=sh.000905
 *   npm run run:factor-backtest -- --start=2022-01-01 --end=2026-06-30 --rf=0.02 --json
 *
 * 选项:
 *   --start=<YYYY-MM-DD>    回测起始 (含), 默认 2022-01-01
 *   --end=<YYYY-MM-DD>      回测结束 (含), 默认今天
 *   --benchmark=<symbol>    基准 (Stock.symbol 形式), 默认 sh.000300
 *   --rf=<年化小数>          现金年化无风险利率, 默认 0.02
 *   --json                  以 JSON 输出 (供上层消费), 否则打印人类可读报告
 *
 * 退出码: 0=成功 · 2=参数/数据错误
 */

import { Command } from 'commander';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { ETF_PROFILES } from '../constants/etfIndustry';
import { ETFRotationStrategy } from '../quant/strategies/ETFRotationStrategy';
import { inferStockSymbol, stripSuffix } from '../quant/factors/library/_helpers';

interface CliOptions {
  start: string;
  end: string;
  benchmark: string;
  rf: number;
  json: boolean;
}

interface MonthlyReturn {
  from: string;
  to: string;
  portfolio_ret: number;
  benchmark_ret: number;
  excess: number;
  n_holdings: number;
  invested_weight: number;
  data_incomplete: boolean;
}

/** 生成 [start, end] 区间内每个自然月最后一日 (YYYY-MM-DD, 用日历末日; 取价时向前找最近交易日). */
function monthEnds(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  while (true) {
    const last = new Date(Date.UTC(y, m + 1, 0)); // 该月最后一天
    if (last.getTime() > e.getTime()) break;
    if (last.getTime() >= s.getTime()) out.push(last.toISOString().slice(0, 10));
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

/** 取一批 ETF 6 位代码在 [from, to] 内每只的首末复权收盘 (向内取最近), 算区间收益. key=纯6位. */
async function loadIntervalReturns(
  codes: string[],
  from: string,
  to: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!codes.length) return out;
  const symbols = Array.from(new Set(codes.map(inferStockSymbol).filter(Boolean)));
  const stocks = (await Stock.findAll({
    attributes: ['id', 'symbol'],
    where: { symbol: { [Op.in]: symbols } },
    raw: true,
  })) as unknown as Array<{ id: number; symbol: string }>;
  const codeById = new Map<number, string>();
  const ids: number[] = [];
  for (const s of stocks) {
    codeById.set(s.id, stripSuffix(s.symbol));
    ids.push(s.id);
  }
  if (!ids.length) return out;

  const bars = (await DailyBar.findAll({
    attributes: ['stock_id', 'time', 'close', 'adj_close'],
    where: {
      stock_id: { [Op.in]: ids },
      time: { [Op.gte]: `${from}T00:00:00Z`, [Op.lte]: `${to}T23:59:59Z` },
    },
    order: [['time', 'ASC']],
    raw: true,
  })) as unknown as Array<{ stock_id: number; time: Date | string; close: any; adj_close: any }>;

  const seriesById = new Map<number, Array<{ t: number; px: number }>>();
  for (const b of bars) {
    const raw = b.adj_close != null ? Number(b.adj_close) : Number(b.close);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const t = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
    if (!Number.isFinite(t)) continue;
    const arr = seriesById.get(b.stock_id) ?? [];
    arr.push({ t, px: raw });
    seriesById.set(b.stock_id, arr);
  }
  for (const [id, arr] of seriesById) {
    const code = codeById.get(id);
    if (!code || arr.length < 2) continue;
    const first = arr[0].px;
    const last = arr[arr.length - 1].px;
    if (first > 0) out.set(code, last / first - 1);
  }
  return out;
}

/** 单一 symbol (基准指数) 的区间收益. */
async function loadBenchmarkReturn(symbol: string, from: string, to: string): Promise<number | null> {
  const stock = (await Stock.findOne({ attributes: ['id'], where: { symbol }, raw: true })) as unknown as
    | { id: number }
    | null;
  if (!stock) return null;
  const bars = (await DailyBar.findAll({
    attributes: ['time', 'close', 'adj_close'],
    where: {
      stock_id: stock.id,
      time: { [Op.gte]: `${from}T00:00:00Z`, [Op.lte]: `${to}T23:59:59Z` },
    },
    order: [['time', 'ASC']],
    raw: true,
  })) as unknown as Array<{ close: any; adj_close: any }>;
  if (bars.length < 2) return null;
  const px = (b: { close: any; adj_close: any }) => (b.adj_close != null ? Number(b.adj_close) : Number(b.close));
  const first = px(bars[0]);
  const last = px(bars[bars.length - 1]);
  return first > 0 ? last / first - 1 : null;
}

/** 从月度收益序列算汇总指标. */
function summarize(monthly: MonthlyReturn[], rfAnnual: number) {
  const n = monthly.length;
  let navP = 1;
  let navB = 1;
  let peak = 1;
  let maxDD = 0;
  let wins = 0;
  const excesses: number[] = [];
  for (const m of monthly) {
    navP *= 1 + m.portfolio_ret;
    navB *= 1 + m.benchmark_ret;
    peak = Math.max(peak, navP);
    maxDD = Math.min(maxDD, navP / peak - 1);
    if (m.excess > 0) wins += 1;
    excesses.push(m.excess);
  }
  const years = n / 12;
  const cagr = years > 0 ? Math.pow(navP, 1 / years) - 1 : 0;
  const cagrB = years > 0 ? Math.pow(navB, 1 / years) - 1 : 0;
  const meanEx = n ? excesses.reduce((a, b) => a + b, 0) / n : 0;
  const varEx = n > 1 ? excesses.reduce((a, b) => a + (b - meanEx) ** 2, 0) / (n - 1) : 0;
  const stdEx = Math.sqrt(varEx);
  const infoRatio = stdEx > 0 ? (meanEx / stdEx) * Math.sqrt(12) : 0;
  const rets = monthly.map(m => m.portfolio_ret);
  const meanR = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const varR = n > 1 ? rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (n - 1) : 0;
  const stdR = Math.sqrt(varR);
  const rfMonthly = rfAnnual / 12;
  const sharpe = stdR > 0 ? ((meanR - rfMonthly) / stdR) * Math.sqrt(12) : 0;
  return {
    months: n,
    nav_portfolio: navP,
    nav_benchmark: navB,
    total_return: navP - 1,
    total_return_benchmark: navB - 1,
    cagr,
    cagr_benchmark: cagrB,
    excess_cagr: cagr - cagrB,
    max_drawdown: maxDD,
    monthly_win_rate_vs_benchmark: n ? wins / n : 0,
    info_ratio: infoRatio,
    sharpe,
  };
}

async function main() {
  const program = new Command();
  program
    .name('run-factor-backtest')
    .description('ETF 因子轮动历史回测 (§7.4 主线核心验证)')
    .option('--start <date>', '起始 YYYY-MM-DD', '2022-01-01')
    .option('--end <date>', '结束 YYYY-MM-DD', new Date().toISOString().slice(0, 10))
    .option('--benchmark <symbol>', '基准 Stock.symbol', 'sh.000300')
    .option('--rf <num>', '现金年化无风险利率', '0.02')
    .option('--json', '以 JSON 输出', false);
  program.parse(process.argv);
  const raw = program.opts();
  const opts: CliOptions = {
    start: String(raw.start),
    end: String(raw.end),
    benchmark: String(raw.benchmark),
    rf: Number(raw.rf),
    json: Boolean(raw.json),
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.start) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.end)) {
    logger.error('start/end 必须是 YYYY-MM-DD');
    process.exit(2);
  }

  const ends = monthEnds(opts.start, opts.end);
  if (ends.length < 2) {
    logger.error(`区间内月末不足 2 个 (${ends.length}), 无法回测`);
    process.exit(2);
  }

  const strategy = new ETFRotationStrategy();
  const rfMonthly = opts.rf / 12;
  const monthly: MonthlyReturn[] = [];

  // 逐月: 在 ends[i] 定权重, 持有到 ends[i+1]
  for (let i = 0; i < ends.length - 1; i++) {
    const asOf = ends[i];
    const next = ends[i + 1];
    let signals;
    try {
      signals = await strategy.generateSignals(asOf, {});
    } catch (err: any) {
      logger.warn(`[${asOf}] generateSignals 失败, 该月空仓: ${err?.message || err}`);
      monthly.push({ from: asOf, to: next, portfolio_ret: rfMonthly, benchmark_ret: 0, excess: 0, n_holdings: 0, invested_weight: 0, data_incomplete: true });
      continue;
    }
    const targets = signals.filter(s => s.target_weight > 0 && !s.data_incomplete);
    const codes = targets.map(s => s.etf_code);
    const rets = await loadIntervalReturns(codes, asOf, next);

    let invested = 0;
    let weightedRet = 0;
    for (const t of targets) {
      const r = rets.get(t.etf_code);
      if (r == null) continue; // 无价 → 该腿视为未建仓, 权重回落现金
      invested += t.target_weight;
      weightedRet += t.target_weight * r;
    }
    const cashWeight = Math.max(0, 1 - invested);
    const portRet = weightedRet + cashWeight * rfMonthly;

    const benchRet = (await loadBenchmarkReturn(opts.benchmark, asOf, next)) ?? 0;
    monthly.push({
      from: asOf,
      to: next,
      portfolio_ret: portRet,
      benchmark_ret: benchRet,
      excess: portRet - benchRet,
      n_holdings: targets.length,
      invested_weight: invested,
      data_incomplete: codes.length === 0,
    });
  }

  const summary = summarize(monthly, opts.rf);
  const dataMonths = monthly.filter(m => !m.data_incomplete).length;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ params: opts, summary, data_months: dataMonths, monthly }, null, 2) + '\n');
  } else {
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    console.log('');
    console.log('============ ETF 因子轮动历史回测 (§7.4 主线核心) ============');
    console.log(`区间:        ${opts.start} → ${opts.end}   (${summary.months} 个持有月, 其中 ${dataMonths} 月有 ETF 数据)`);
    console.log(`基准:        ${opts.benchmark}    现金年化: ${pct(opts.rf)}`);
    console.log(`ETF universe: ${ETF_PROFILES.length} 只白名单 (top4 买 / top6 卖, 单只≤15%, 核心≤70%)`);
    console.log('------------------------------------------------------------');
    console.log(`组合总收益:   ${pct(summary.total_return)}     (净值 ${summary.nav_portfolio.toFixed(4)})`);
    console.log(`基准总收益:   ${pct(summary.total_return_benchmark)}     (净值 ${summary.nav_benchmark.toFixed(4)})`);
    console.log(`组合 CAGR:    ${pct(summary.cagr)}     基准 CAGR: ${pct(summary.cagr_benchmark)}`);
    console.log(`超额 CAGR:    ${pct(summary.excess_cagr)}`);
    console.log(`最大回撤:     ${pct(summary.max_drawdown)}`);
    console.log(`月度胜率(vs基准): ${pct(summary.monthly_win_rate_vs_benchmark)}`);
    console.log(`信息比率(年化):  ${summary.info_ratio.toFixed(2)}`);
    console.log(`夏普(年化):     ${summary.sharpe.toFixed(2)}`);
    console.log('------------------------------------------------------------');
    if (dataMonths === 0) {
      console.log('⚠️  区间内无任何 ETF 行情/成分数据 — 结果全部来自现金腿, 不具参考意义。');
      console.log('   需先同步 ETF daily_bars + index_components/fund_top_holdings 再跑。');
    }
    console.log('月度明细 (前 12 / 后若干):');
    const show = monthly.length <= 24 ? monthly : [...monthly.slice(0, 12), ...monthly.slice(-6)];
    for (const m of show) {
      console.log(
        `  ${m.from}→${m.to}  组合 ${pct(m.portfolio_ret).padStart(8)}  基准 ${pct(m.benchmark_ret).padStart(8)}  超额 ${pct(m.excess).padStart(8)}  持仓 ${m.n_holdings} (投${pct(m.invested_weight)})${m.data_incomplete ? '  [无数据]' : ''}`
      );
    }
    console.log('============================================================');
    console.log('');
  }

  await sequelize.close();
  process.exit(0);
}

main().catch(async err => {
  logger.error(`run-factor-backtest 致命错误: ${err?.stack || err}`);
  try { await sequelize.close(); } catch { /* noop */ }
  process.exit(2);
});
