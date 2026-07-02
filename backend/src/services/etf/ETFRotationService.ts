/**
 * ETFRotationService (ETF 因子轮动月度再平衡产出 + 落库) — 信号优先重构 批6
 *
 * 主线核心 (Core 70%) 的信号生产者. 编排:
 *   1. 读当前 ETF 持仓 (paper_trading_positions, symbol in ETF 白名单)
 *   2. 跑 ETFRotationStrategy.generateSignals(asOf, { currentHoldings }) 得排名 + 目标权重
 *   3. 用 ConfidenceCalibrationService 给 source_type=etf_factor_rotation 附真实胜率 confidence
 *   4. 生成 rebalance_id = rebalance-YYYY-MM (§2.3, 月度唯一)
 *   5. 落 AIInvestmentSignal: action=TARGET_WEIGHT, rebalance_id, target_pct, confidence
 *      (buy/sell/hold 全落, target_pct=0 表示清仓; V3 展示层据 action + target_pct 渲染)
 *
 * 触发: SchedulerService 月度 cron (ETF_FACTOR_ROTATION_REBALANCE). 幂等:
 *   findOrCreate by (source_type, source_id), source_id = etf_<code>_<rebalance_id>.
 *
 * §4.1: ETF 组合级不设单笔止损止盈 (波动小, 只月度换仓). 故不写 stop_loss/take_profit.
 */

import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../../models/AIInvestmentSignal';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { logger } from '../../utils/logger';
import { ETF_PROFILES } from '../../constants/etfIndustry';
import {
  ETFRotationStrategy,
  ETFRotationSignal,
} from '../../quant/strategies/ETFRotationStrategy';
import {
  ConfidenceCalibrationService,
  confidenceCalibrationService,
  CalibrationMetrics,
} from '../calibration/ConfidenceCalibrationService';

const ETF_CODES = new Set(ETF_PROFILES.map(p => p.code));

/** 提取纯 6 位 ETF 代码 (兼容 sh./sz. 前缀与 .SH/.SZ 后缀). */
function toEtfCode(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const s = symbol.trim();
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  return /^[a-zA-Z]{2}$/.test(before) ? after : before;
}

/** rebalance_id = rebalance-YYYY-MM (§2.3). */
export function buildRebalanceId(asOfDate: string): string {
  return `rebalance-${asOfDate.slice(0, 7)}`;
}

export interface ETFRotationRunOptions {
  /** 月末快照日 YYYY-MM-DD (因子 as-of 截面 + 落库 signal_date). 默认今天. */
  asOfDate?: string;
  /** 读持仓/写信号所属 paper 组合. 默认取第一个 active 组合. */
  portfolioId?: number;
  /** 覆盖 universe (默认全 ETF 白名单). */
  universe?: string[];
  /** 干跑: 只算不落库 (回测 / 预览). */
  dryRun?: boolean;
}

export interface ETFRotationRunResult {
  rebalance_id: string;
  as_of_date: string;
  portfolio_id: number | null;
  current_holdings: string[];
  confidence: number;
  confidence_source: CalibrationMetrics | null;
  signals: ETFRotationSignal[];
  created: number;
  updated: number;
  skipped_data_incomplete: number;
  dry_run: boolean;
}

export class ETFRotationService {
  constructor(
    private readonly strategy: ETFRotationStrategy = new ETFRotationStrategy(),
    private readonly calibration: ConfidenceCalibrationService = confidenceCalibrationService
  ) {}

  private getChinaToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** 解析目标组合 id: 显式 > 第一个 active. 无组合 -> null (仍可 dryRun). */
  private async resolvePortfolioId(explicit?: number): Promise<number | null> {
    if (Number.isFinite(explicit) && (explicit as number) > 0) return explicit as number;
    const p = await PaperTradingPortfolio.findOne({
      where: { is_active: true },
      order: [['id', 'ASC']],
    });
    return p ? p.id : null;
  }

  /** 读组合内当前持有的 ETF 6 位代码 (symbol in 白名单, quantity>0). */
  private async loadCurrentEtfHoldings(portfolioId: number | null): Promise<string[]> {
    if (!portfolioId) return [];
    const rows = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolioId },
      attributes: ['symbol', 'quantity'],
      raw: true,
    });
    const held: string[] = [];
    for (const r of rows as unknown as Array<{ symbol: string; quantity: number }>) {
      if (Number(r.quantity) <= 0) continue;
      const code = toEtfCode(r.symbol);
      if (ETF_CODES.has(code)) held.push(code);
    }
    return held;
  }

  /**
   * 月度再平衡主入口: 生成 + (可选) 落库 ETF 轮动信号.
   */
  async runMonthlyRebalance(options: ETFRotationRunOptions = {}): Promise<ETFRotationRunResult> {
    const asOfDate = options.asOfDate ?? this.getChinaToday();
    const rebalanceId = buildRebalanceId(asOfDate);
    const portfolioId = await this.resolvePortfolioId(options.portfolioId);
    const currentHoldings = await this.loadCurrentEtfHoldings(portfolioId);

    const signals = await this.strategy.generateSignals(asOfDate, {
      currentHoldings,
      universe: options.universe,
    });

    // confidence: 用 etf_factor_rotation 历史胜率 (§5.1). 冷启动 (无历史) -> confidence=0,
    // reliability=insufficient, 上层 gate 判定仅 paper. 组合级用 __all__ (不按 regime 分).
    let confidenceMetrics: CalibrationMetrics | null = null;
    try {
      confidenceMetrics = await this.calibration.calibrate(
        AISignalSourceType.ETF_FACTOR_ROTATION,
        '__all__',
        { asOfDate, portfolioId: portfolioId ?? undefined }
      );
    } catch (error: any) {
      logger.warn(`ETFRotation confidence 计算失败 (fail-open): ${error?.message || error}`);
    }
    const confidence = confidenceMetrics?.confidence ?? 0;

    const result: ETFRotationRunResult = {
      rebalance_id: rebalanceId,
      as_of_date: asOfDate,
      portfolio_id: portfolioId,
      current_holdings: currentHoldings,
      confidence,
      confidence_source: confidenceMetrics,
      signals,
      created: 0,
      updated: 0,
      skipped_data_incomplete: signals.filter(s => s.data_incomplete).length,
      dry_run: !!options.dryRun,
    };

    if (options.dryRun) return result;

    for (const sig of signals) {
      // data_incomplete 的 ETF 不落信号 (不参与排名, 无有效 target_weight)
      if (sig.data_incomplete) continue;
      // 只落有动作的: buy/sell, 或 hold 且有目标仓位 (持仓维持)
      if (sig.action === 'hold' && sig.target_weight <= 0) continue;

      const { created, updated } = await this.persistSignal(sig, {
        asOfDate,
        rebalanceId,
        confidence,
      });
      result.created += created;
      result.updated += updated;
    }

    logger.info(
      `ETFRotation 月度再平衡 ${rebalanceId}: 持仓=[${currentHoldings.join(',')}] ` +
        `created=${result.created} updated=${result.updated} ` +
        `skipped_incomplete=${result.skipped_data_incomplete} confidence=${confidence.toFixed(3)}`
    );
    return result;
  }

  /** 落单条 ETF 轮动信号 (action=TARGET_WEIGHT, 幂等 by source_id). */
  private async persistSignal(
    sig: ETFRotationSignal,
    ctx: { asOfDate: string; rebalanceId: string; confidence: number }
  ): Promise<{ created: number; updated: number }> {
    const symbol = sig.etf_code;
    const source_id = `etf_${symbol}_${ctx.rebalanceId}`;
    const decision =
      sig.action === 'buy'
        ? AISignalDecision.BUY
        : sig.action === 'sell'
        ? AISignalDecision.SELL
        : AISignalDecision.HOLD;
    const targetPct = Math.round(sig.target_weight * 100 * 100) / 100; // 0..15 (百分点)

    const payload: any = {
      source_type: AISignalSourceType.ETF_FACTOR_ROTATION,
      source_id,
      symbol,
      name: sig.name,
      signal_date: ctx.asOfDate,
      decision,
      normalized_decision: decision,
      // §2.2 Signal atom 新列
      action: 'TARGET_WEIGHT',
      confidence: ctx.confidence,
      rebalance_id: ctx.rebalanceId,
      target_pct: targetPct,
      // 组合级 confidence_score 保留 0-100 兼容 (旧展示排序), = confidence*100
      confidence_score: Math.round(ctx.confidence * 100),
      risk_level: 'low',
      rationale: sig.reasons.join('；'),
      detail: JSON.stringify({
        strategy_key: sig.strategy_key,
        rank: sig.rank,
        score: sig.score,
        target_weight: sig.target_weight,
        factors: sig.factors,
        reasons: sig.reasons,
      }),
      metadata: {
        etf_factor_rotation: true,
        rebalance_id: ctx.rebalanceId,
        core_satellite_bucket: 'core',
        rank: sig.rank,
        score: sig.score,
        target_weight: sig.target_weight,
        factors: sig.factors,
        strategy_key: sig.strategy_key,
      },
    };

    const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
      where: {
        source_type: AISignalSourceType.ETF_FACTOR_ROTATION,
        source_id,
      },
      defaults: payload,
    });
    if (isCreated) return { created: 1, updated: 0 };

    // merge 更新, 保留下游写入的 paper_trading 字段
    const preservedKeys = ['paper_trading', 'paper_trading_by_portfolio'];
    const existingMeta = ((record as any).metadata || {}) as Record<string, any>;
    const mergedMeta: Record<string, any> = { ...existingMeta, ...payload.metadata };
    for (const key of preservedKeys) {
      if (existingMeta[key]) mergedMeta[key] = existingMeta[key];
    }
    await record.update({ ...payload, metadata: mergedMeta });
    return { created: 0, updated: 1 };
  }
}

export const etfRotationService = new ETFRotationService();
