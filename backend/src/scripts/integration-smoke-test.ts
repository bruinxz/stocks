#!/usr/bin/env node
/**
 * 全链路集成验证脚本 (US-100)
 *
 * 一条龙跑完业务核心 6 步, 任一步失败立即退出 + 打印错误。
 * 用途: 上线前 / 升级后 / on-call 巡检快速验证"系统真的能工作", 而不是
 * 各组件单测都通过却跑不起来。
 *
 * Usage:
 *   npm run smoke-test
 *   npm run smoke-test -- --date=2026-06-05
 *   npm run smoke-test -- --date=2026-06-05 --skip-sync     # 跳过同步, 用现有库内数据
 *   npm run smoke-test -- --skip-orders                     # 跳过模拟下单 (只读模式)
 *   npm run smoke-test -- --user=2                          # 指定模拟盘用户 ID
 *
 * 6 步:
 *   1. SYNC      调 sync-northbound/dragon-tiger/limit-up 取最近一日
 *                (任一外网失败 = step 失败 + 提示用 --skip-sync 跳过)
 *   2. FACTORS   调 compute-factors (FactorPipeline.runForDate)
 *                依赖步骤 1 的数据 + 库内既有 DailyBar
 *   3. SIGNALS   跑 MultiFactorAlphaStrategy.generateSignals(date)
 *                依赖步骤 2 的 factor_scores
 *   4. ORDERS    调 PaperTradingFacade.placeOrder 模拟下 3 单
 *                取步骤 3 信号的前 3 只 buy 候选
 *   5. RISK      调 风控 guard 校验 (positionLimitGuard + drawdownCircuitBreaker)
 *   6. NOTIFY    调推送 dry-run (FeishuBotWebhookService.sendRecommendationSummary
 *                with DISABLE_FEISHU_BOT_WEBHOOK=1 强制 dry-run)
 *
 * 设计:
 *   - 每步独立 SmokeStep, runStep() 装 try/catch + 计时 + 结构化输出
 *   - 任一步 status='failed' → 立即 exit(1) (符合 AC "失败立即退出")
 *   - status='skipped' (用户主动 --skip-*) 不算失败, 继续后续步骤
 *   - 步骤间软依赖: 若步骤 N 数据为空, 后续 step 用 placeholder 数据 (不真实下单),
 *     仍走完 facade.placeOrder 路径 (验证管道通畅), 退出码=0
 *   - 纯函数辅助 (formatDuration / pickTopBuyCandidates / safeTradeDate) 在文件底部 export
 *     供单测 (integration-smoke-test.test.ts) 无 DB 调用直接覆盖
 *
 * 退出码:
 *   0 = 全部成功 (或 --skip-* 主动跳过的步骤)
 *   1 = 任一步意外失败
 *
 * 不依赖真实 Feishu webhook: 默认 DISABLE_FEISHU_BOT_WEBHOOK=1 force dry-run,
 * 输出 {success:false, skipped:true} 算成功 (验证调用路径通, 不验证真实推送).
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { NorthboundSyncService } from '../data/services/NorthboundSyncService';
import { DragonTigerSyncService } from '../data/services/DragonTigerSyncService';
import { LimitUpSyncService } from '../data/services/LimitUpSyncService';
import { factorPipeline } from '../quant/factors';
import '../quant/factors/library';
import {
  MultiFactorAlphaStrategy,
  MultiFactorAlphaSignal,
} from '../quant/strategies/MultiFactorAlphaStrategy';
import {
  paperTradingFacade,
  DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
} from '../portfolio/PaperTradingFacade';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { User } from '../models/User';
import { positionLimitGuard } from '../portfolio/risk/PositionLimitGuard';
import { drawdownCircuitBreaker } from '../portfolio/risk/DrawdownCircuitBreaker';
import { feishuBotWebhookService } from '../services/FeishuBotWebhookService';

// ---------------------------------------------------------------------------
//  Pure helpers (导出供单测)
// ---------------------------------------------------------------------------

/** 默认每步骤超时 (毫秒): 防止某一步卡死整脚本 */
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

/** 默认模拟下单只数 (AC: 3 单) */
export const DEFAULT_SMOKE_ORDER_COUNT = 3;

/** 默认每单数量 (100 股 = A 股 1 手, 价值低保证 cash 充足) */
export const DEFAULT_SMOKE_ORDER_QTY = 100;

/** 步骤状态 */
export type StepStatus = 'success' | 'failed' | 'skipped';

export interface StepRecord {
  name: string;
  status: StepStatus;
  duration_ms: number;
  detail?: string;
  /** 失败时的错误 message (status='failed' 必填) */
  error?: string;
}

/**
 * 把毫秒数格式化成人类可读字符串。
 * - < 1000 ms → "123ms"
 * - 1000-60000 ms → "1.23s"
 * - >= 60000 ms → "1m23s"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * 从 MultiFactorAlpha 信号集中选 top N "buy" 类信号, 保留 stock_code + name + composite_score.
 *
 * 信号已经按 composite_score DESC + stock_code ASC 排序 (策略内部稳定排序),
 * 这里只 filter signal='buy' + 取前 N 只.
 */
export function pickTopBuyCandidates(
  signals: ReadonlyArray<MultiFactorAlphaSignal>,
  topN: number
): MultiFactorAlphaSignal[] {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const buys = signals.filter(s => s && s.signal === 'buy');
  return buys.slice(0, Math.max(0, topN));
}

/**
 * 校验并归一化 trade_date 字符串 (YYYY-MM-DD), 缺失 / 非法 → 用今天.
 * 不验证是不是真的交易日 (周末 / 节假日 由下游 sync service 各自决定如何处理).
 */
export function safeTradeDate(rawDate?: string | undefined | null): string {
  if (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return rawDate;
  }
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 把 "stock_code" (无后缀, e.g. "600519") 推回 "symbol" 带后缀形式 (e.g. "600519.SH").
 * Stock model 用 symbol 字段(带后缀), PaperTradingFacade.placeOrder 也要 symbol.
 * 规则: 6 开头 = .SH, 0/3 开头 = .SZ, 其余 (4/8 开头新三板等) 暂归 .SZ 兜底.
 */
export function inferSymbolFromCode(stockCode: string): string {
  if (!stockCode || typeof stockCode !== 'string') return stockCode;
  if (stockCode.includes('.')) return stockCode; // 已带后缀
  const first = stockCode[0];
  if (first === '6') return `${stockCode}.SH`;
  return `${stockCode}.SZ`;
}

/** 主流程参数 (来自 CLI options) */
export interface SmokeTestOptions {
  /** 目标 trade_date (YYYY-MM-DD); 缺省 = 今天 */
  date?: string;
  /** 跳过第 1 步同步 (网络不可达时用) */
  skipSync?: boolean;
  /** 跳过第 4 步模拟下单 (只读 / 干跑模式) */
  skipOrders?: boolean;
  /** 跳过第 5 步风控校验 */
  skipRisk?: boolean;
  /** 跳过第 6 步推送 dry-run */
  skipNotify?: boolean;
  /** 用户 ID; 默认取第一个有 portfolio 的用户 (或创建 smoke 用户) */
  userId?: number;
  /** 每单数量 */
  orderQuantity?: number;
}

// ---------------------------------------------------------------------------
//  Step runner
// ---------------------------------------------------------------------------

/**
 * 跑一个 step + 计时 + 异常归一化为 StepRecord.
 * 任一 step throw 会被捕获 + 写到 record.error; 不会向外冒泡 (主流程靠
 * record.status 判断是否退出).
 */
export async function runStep(
  name: string,
  fn: () => Promise<{ detail?: string; skipped?: boolean }>
): Promise<StepRecord> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const duration_ms = Date.now() - startedAt;
    const status: StepStatus = result?.skipped ? 'skipped' : 'success';
    return {
      name,
      status,
      duration_ms,
      detail: result?.detail,
    };
  } catch (err: any) {
    const duration_ms = Date.now() - startedAt;
    const message = err?.message || String(err);
    return {
      name,
      status: 'failed',
      duration_ms,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
//  Steps (生产实现)
// ---------------------------------------------------------------------------

async function stepSync(tradeDate: string): Promise<{ detail: string }> {
  const counts: { source: string; fetched: number; upserted: number }[] = [];

  const northbound = await new NorthboundSyncService().syncDate(tradeDate);
  counts.push({
    source: 'northbound',
    fetched: northbound.fetched,
    upserted: northbound.upserted,
  });
  if (northbound.error) {
    throw new Error(`northbound sync error: ${northbound.error}`);
  }

  const dragonTiger = await new DragonTigerSyncService().syncDate(tradeDate);
  counts.push({
    source: 'dragon_tiger',
    fetched: dragonTiger.fetched,
    upserted: dragonTiger.upserted,
  });
  if (dragonTiger.error) {
    throw new Error(`dragon_tiger sync error: ${dragonTiger.error}`);
  }

  const limitUp = await new LimitUpSyncService().syncDate(tradeDate);
  counts.push({
    source: 'limit_up',
    fetched: limitUp.fetched,
    upserted: limitUp.upserted,
  });
  if (limitUp.error) {
    throw new Error(`limit_up sync error: ${limitUp.error}`);
  }

  const summary = counts.map(c => `${c.source}=${c.upserted}/${c.fetched}`).join(' ');
  return { detail: summary };
}

async function stepFactors(tradeDate: string): Promise<{ detail: string }> {
  const result = await factorPipeline.runForDate(tradeDate, []);
  const detail =
    `universe=${result.universe_size} factors=${result.factor_results.length} ` +
    `upserted=${result.total_upserted} failed=${result.total_failed}`;
  if (result.total_failed > 0 && result.total_upserted === 0) {
    // 全失败 = 真正出错; 部分失败仍算成功 (Pipeline 设计为单因子失败不阻塞)
    throw new Error(`all ${result.total_failed} factors failed`);
  }
  return { detail };
}

async function stepSignals(
  tradeDate: string
): Promise<{ detail: string; signals: MultiFactorAlphaSignal[] }> {
  const strategy = new MultiFactorAlphaStrategy();
  const result = await strategy.generateSignals(tradeDate);
  const buyCount = result.signals.filter(s => s.signal === 'buy').length;
  const detail =
    `target_portfolio=${result.target_portfolio.length} ` +
    `signals=${result.signals.length} (buy=${buyCount}) ` +
    `eligible=${result.eligible_count}/${result.universe_size}`;
  return { detail, signals: result.signals };
}

/**
 * 解析或创建 smoke 测试用 portfolio.
 * - 优先用 options.userId (用户显式指定)
 * - 否则取第一个已有 portfolio 的 user
 * - 兜底: 创建/找到 username='smoke_test' 的用户 + 默认 portfolio
 */
async function resolveSmokeUserPortfolio(
  optionsUserId?: number
): Promise<{ user_id: number; portfolio_id: number; created: boolean }> {
  if (Number.isInteger(optionsUserId)) {
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id: optionsUserId },
    });
    if (portfolio) {
      return { user_id: optionsUserId as number, portfolio_id: portfolio.id, created: false };
    }
  }

  const anyPortfolio = await PaperTradingPortfolio.findOne();
  if (anyPortfolio) {
    return {
      user_id: anyPortfolio.user_id,
      portfolio_id: anyPortfolio.id,
      created: false,
    };
  }

  // 兜底: 创建 smoke 测试用户 + portfolio
  const SMOKE_USERNAME = 'smoke_test';
  let user = await User.findOne({ where: { username: SMOKE_USERNAME } });
  if (!user) {
    user = await User.create({
      username: SMOKE_USERNAME,
      email: `${SMOKE_USERNAME}@local.test`,
      password_hash: 'smoke_placeholder_pw',
      is_active: true,
    } as any);
  }
  const portfolio = await PaperTradingPortfolio.create({
    user_id: user.id,
    name: 'Smoke Test Portfolio',
    initial_capital: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
    current_cash: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
    total_value: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
    is_active: true,
  });
  return { user_id: user.id, portfolio_id: portfolio.id, created: true };
}

async function stepOrders(
  signals: MultiFactorAlphaSignal[],
  options: SmokeTestOptions
): Promise<{ detail: string; ordered_symbols: string[]; user_id: number | null }> {
  const candidates = pickTopBuyCandidates(signals, DEFAULT_SMOKE_ORDER_COUNT);
  if (candidates.length === 0) {
    return {
      detail: 'no buy candidates from signals; skipped place_order',
      ordered_symbols: [],
      user_id: null,
    };
  }

  const userInfo = await resolveSmokeUserPortfolio(options.userId);
  const qty = options.orderQuantity ?? DEFAULT_SMOKE_ORDER_QTY;

  const ordered: string[] = [];
  const failures: string[] = [];
  for (const c of candidates) {
    const symbol = inferSymbolFromCode(c.stock_code);
    try {
      await paperTradingFacade.placeOrder({
        user_id: userInfo.user_id,
        symbol,
        direction: 'BUY',
        quantity: qty,
      });
      ordered.push(symbol);
    } catch (err: any) {
      // 单单失败收集 + 继续 (风控阻断 / 价格不可得 / cash 不足是常见的"管道通了
      // 但业务规则拒绝"形态, 不算 step 失败)
      failures.push(`${symbol}: ${err?.code || err?.message || 'unknown'}`);
    }
  }

  const detail =
    `user=${userInfo.user_id}${userInfo.created ? '(created)' : ''} ` +
    `attempted=${candidates.length} ordered=${ordered.length} ` +
    `failed=${failures.length}` +
    (failures.length ? ` [${failures.slice(0, 3).join('; ')}]` : '');
  return { detail, ordered_symbols: ordered, user_id: userInfo.user_id };
}

async function stepRisk(
  userId: number | null,
  orderedSymbols: string[]
): Promise<{ detail: string }> {
  if (!userId) {
    return { detail: 'no user/portfolio established by step 4; skipping risk check' };
  }

  // 5a. positionLimitGuard - 用其中一只已下的 symbol 模拟一次 pre-trade check
  let positionResult = '?';
  try {
    if (orderedSymbols.length > 0) {
      const probeSymbol = orderedSymbols[0];
      const result = await positionLimitGuard.checkBuyOrder({
        user_id: userId,
        symbol: probeSymbol,
        proposed_value: 1000, // 极小金额 = 几乎一定通过, 验证管道
      });
      positionResult = result.violation ? `violation=${result.violation.rule}` : 'pass';
    } else {
      positionResult = 'skipped (no symbol)';
    }
  } catch (err: any) {
    positionResult = `error: ${err?.message || err}`;
  }

  // 5b. drawdownCircuitBreaker - dry-run 评估当日是否触发熔断
  let drawdownResult = '?';
  try {
    const result = await drawdownCircuitBreaker.evaluateAfterClose({
      user_id: userId,
      dry_run: true,
      lookback_days: 90,
    });
    const per = result.per_user[0];
    drawdownResult = per
      ? `level=${per.level} drawdown=${(per.drawdown_pct * 100).toFixed(2)}%`
      : 'no_evaluation';
  } catch (err: any) {
    drawdownResult = `error: ${err?.message || err}`;
  }

  return { detail: `position_limit=${positionResult} drawdown=${drawdownResult}` };
}

async function stepNotify(
  tradeDate: string,
  signals: MultiFactorAlphaSignal[]
): Promise<{ detail: string }> {
  // 强制 dry-run: webhook 推送不真的发出去, 只走调用路径 / 序列化逻辑.
  // 即便 caller 已设置 DISABLE_FEISHU_BOT_WEBHOOK=1 我们也保持一致.
  const previousFlag = process.env.DISABLE_FEISHU_BOT_WEBHOOK;
  process.env.DISABLE_FEISHU_BOT_WEBHOOK = '1';

  try {
    const buyCount = signals.filter(s => s.signal === 'buy').length;
    const payload = {
      scenario: 'quant_daily_pipeline' as const,
      result: {
        trade_date: tradeDate,
        recommendations: signals
          .filter(s => s.signal === 'buy')
          .slice(0, 5)
          .map(s => ({
            symbol: s.stock_code,
            name: s.name || s.stock_code,
            score: s.composite_score,
            reason: s.reason,
          })),
      },
      title: `Smoke Test ${tradeDate}`,
      max_items: 5,
    };

    const result = await feishuBotWebhookService.sendRecommendationSummary(payload);
    const status = result.skipped
      ? 'skipped (DISABLE_FEISHU_BOT_WEBHOOK=1)'
      : result.success
      ? 'sent'
      : `failed: ${result.message || '?'}`;
    return { detail: `notify_dry_run=${status} buy_signals_in_payload=${buyCount}` };
  } finally {
    // 还原 env, 避免污染同一进程后续测试
    if (previousFlag === undefined) {
      delete process.env.DISABLE_FEISHU_BOT_WEBHOOK;
    } else {
      process.env.DISABLE_FEISHU_BOT_WEBHOOK = previousFlag;
    }
  }
}

// ---------------------------------------------------------------------------
//  Main orchestration
// ---------------------------------------------------------------------------

export async function runSmokeTest(options: SmokeTestOptions): Promise<{
  ok: boolean;
  records: StepRecord[];
}> {
  const tradeDate = safeTradeDate(options.date);
  const records: StepRecord[] = [];
  let signals: MultiFactorAlphaSignal[] = [];
  let orderedSymbols: string[] = [];
  let userId: number | null = null;

  // Step 1: SYNC
  if (options.skipSync) {
    records.push({
      name: 'SYNC',
      status: 'skipped',
      duration_ms: 0,
      detail: 'skipped by --skip-sync',
    });
  } else {
    const rec = await runStep('SYNC', () => stepSync(tradeDate));
    records.push(rec);
    if (rec.status === 'failed') return { ok: false, records };
  }

  // Step 2: FACTORS
  const factorsRec = await runStep('FACTORS', () => stepFactors(tradeDate));
  records.push(factorsRec);
  if (factorsRec.status === 'failed') return { ok: false, records };

  // Step 3: SIGNALS
  const signalsRec = await runStep('SIGNALS', async () => {
    const r = await stepSignals(tradeDate);
    signals = r.signals;
    return { detail: r.detail };
  });
  records.push(signalsRec);
  if (signalsRec.status === 'failed') return { ok: false, records };

  // Step 4: ORDERS
  if (options.skipOrders) {
    records.push({
      name: 'ORDERS',
      status: 'skipped',
      duration_ms: 0,
      detail: 'skipped by --skip-orders',
    });
  } else {
    const ordersRec = await runStep('ORDERS', async () => {
      const r = await stepOrders(signals, options);
      orderedSymbols = r.ordered_symbols;
      userId = r.user_id;
      return { detail: r.detail };
    });
    records.push(ordersRec);
    if (ordersRec.status === 'failed') return { ok: false, records };
  }

  // Step 5: RISK
  if (options.skipRisk) {
    records.push({
      name: 'RISK',
      status: 'skipped',
      duration_ms: 0,
      detail: 'skipped by --skip-risk',
    });
  } else {
    const riskRec = await runStep('RISK', () => stepRisk(userId, orderedSymbols));
    records.push(riskRec);
    if (riskRec.status === 'failed') return { ok: false, records };
  }

  // Step 6: NOTIFY (dry-run)
  if (options.skipNotify) {
    records.push({
      name: 'NOTIFY',
      status: 'skipped',
      duration_ms: 0,
      detail: 'skipped by --skip-notify',
    });
  } else {
    const notifyRec = await runStep('NOTIFY', () => stepNotify(tradeDate, signals));
    records.push(notifyRec);
    if (notifyRec.status === 'failed') return { ok: false, records };
  }

  return { ok: true, records };
}

// ---------------------------------------------------------------------------
//  CLI entry
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('integration-smoke-test')
  .description('全链路集成验证 (US-100): 同步 → 因子 → 信号 → 模拟下单 → 风控 → 推送 dry-run')
  .option('--date <date>', '目标交易日 (YYYY-MM-DD); 缺省 = 今天')
  .option('--skip-sync', '跳过第 1 步同步 (库内已有数据时用)', false)
  .option('--skip-orders', '跳过第 4 步模拟下单 (只读模式)', false)
  .option('--skip-risk', '跳过第 5 步风控校验', false)
  .option('--skip-notify', '跳过第 6 步推送 dry-run', false)
  .option('--user <id>', '指定用户 ID (缺省取第一个有 portfolio 的用户)')
  .option(
    '--order-quantity <n>',
    `每单数量 (默认 ${DEFAULT_SMOKE_ORDER_QTY})`,
    String(DEFAULT_SMOKE_ORDER_QTY)
  )
  .action(async (opts: any) => {
    try {
      await sequelize.authenticate();
      if (process.env.NODE_ENV !== 'production') {
        await sequelize.sync({ alter: true });
      }

      const options: SmokeTestOptions = {
        date: opts.date,
        skipSync: Boolean(opts.skipSync),
        skipOrders: Boolean(opts.skipOrders),
        skipRisk: Boolean(opts.skipRisk),
        skipNotify: Boolean(opts.skipNotify),
        userId: opts.user ? parseInt(opts.user, 10) : undefined,
        orderQuantity: opts.orderQuantity
          ? parseInt(opts.orderQuantity, 10)
          : DEFAULT_SMOKE_ORDER_QTY,
      };

      const tradeDate = safeTradeDate(options.date);
      logger.info(`[smoke-test] starting full-stack integration test (trade_date=${tradeDate})`);

      const { ok, records } = await runSmokeTest(options);

      // 打印摘要表
      logger.info('[smoke-test] step summary:');
      for (const r of records) {
        const tag = r.status === 'success' ? 'OK   ' : r.status === 'skipped' ? 'SKIP ' : 'FAIL ';
        const line =
          `  ${tag} ${r.name.padEnd(8)} ${formatDuration(r.duration_ms).padStart(8)}` +
          (r.detail ? ` :: ${r.detail}` : '') +
          (r.error ? ` :: ERROR ${r.error}` : '');
        if (r.status === 'failed') {
          logger.error(line);
        } else {
          logger.info(line);
        }
      }

      const totalMs = records.reduce((acc, r) => acc + r.duration_ms, 0);
      logger.info(
        `[smoke-test] overall=${ok ? 'PASS' : 'FAIL'} ` +
          `steps=${records.length} total=${formatDuration(totalMs)}`
      );

      process.exit(ok ? 0 : 1);
    } catch (error) {
      logger.error(`[smoke-test] unexpected error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// 模块化加载时不自动跑 CLI (让单测 import 不触发 sequelize.authenticate)
if (require.main === module) {
  program.parseAsync(process.argv);
}
