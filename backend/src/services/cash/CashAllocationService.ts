/**
 * CashAllocationService (§4.3 现金 10% 闲置管理)
 * ------------------------------------------------------------------
 * 主线「核心 70% + 卫星 20% + 现金 10%」的现金层信号生产者.
 *
 * §4.3 口径:
 *   - 5% 应急现金 (活期 / 余额宝, 年化 ~2%) —— 压舱石, 不落信号, 不做任何操作
 *   - 5% 收益现金 —— 配置到最保守的国债 ETF 511010 / 短融 ETF 511360 (年化 ~3%)
 *   - 这 10% 不做股票短线, 只吃利息
 *
 * 产出: 每月对收益现金 ETF 落 AIInvestmentSignal(source_type='cash_management',
 *   action='TARGET_WEIGHT', target_pct, rebalance_id, metadata.core_satellite_bucket='cash').
 * 复用 ETFRotationService 的 rebalance_id / findOrCreate 幂等 / metadata merge 模式.
 *
 * 触发: SchedulerService 月度 cron (CASH_ALLOCATION_REBALANCE), 与核心再平衡同频.
 * 幂等: findOrCreate by (source_type, source_id), source_id = cash_<code>_<rebalance_id>.
 *
 * §4.3: 现金层为保守持有, 不设单笔止损止盈.
 */
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { logger } from '../../utils/logger';
import { buildRebalanceId } from '../etf/ETFRotationService';

// ---- §4.3 常量 ----
/** 收益现金标的: 国债 ETF + 短融 ETF, 各分一半收益现金仓位. */
export interface CashInstrument {
  code: string;
  name: string;
  /** 占组合总仓位的目标百分点 (收益现金 5% 内部再分). */
  target_pct: number;
  kind: 'treasury_etf' | 'short_bond_etf';
}

export const CASH_TOTAL_PCT = 10; // 现金桶总占比
export const CASH_EMERGENCY_PCT = 5; // 应急现金 (不落信号)
export const CASH_YIELD_PCT = 5; // 收益现金 (配 ETF)

/** 收益现金 5% 均分到国债 ETF 511010 + 短融 ETF 511360, 各 2.5%. */
export const CASH_YIELD_INSTRUMENTS: ReadonlyArray<CashInstrument> = Object.freeze([
  { code: '511010', name: '国债ETF', target_pct: 2.5, kind: 'treasury_etf' },
  { code: '511360', name: '短融ETF', target_pct: 2.5, kind: 'short_bond_etf' },
]);

export interface CashAllocationRunOptions {
  /** 快照日 YYYY-MM-DD (落库 signal_date + rebalance_id 月份). 默认今天. */
  asOfDate?: string;
  /** 写信号所属 paper 组合. 默认第一个 active 组合. */
  portfolioId?: number;
  /** 干跑: 只算不落库. */
  dryRun?: boolean;
}

export interface CashAllocationRunResult {
  rebalance_id: string;
  as_of_date: string;
  portfolio_id: number | null;
  emergency_pct: number;
  yield_pct: number;
  instruments: CashInstrument[];
  created: number;
  updated: number;
  dry_run: boolean;
}

export class CashAllocationService {
  private getChinaToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private async resolvePortfolioId(explicit?: number): Promise<number | null> {
    if (Number.isFinite(explicit) && (explicit as number) > 0) return explicit as number;
    const p = await PaperTradingPortfolio.findOne({
      where: { is_active: true },
      order: [['id', 'ASC']],
    });
    return p ? p.id : null;
  }

  /** 主入口: 对收益现金 ETF 落 target-weight 信号. */
  async runMonthlyRebalance(
    options: CashAllocationRunOptions = {}
  ): Promise<CashAllocationRunResult> {
    const asOfDate = options.asOfDate || this.getChinaToday();
    const rebalanceId = buildRebalanceId(asOfDate);
    const portfolioId = await this.resolvePortfolioId(options.portfolioId);

    const result: CashAllocationRunResult = {
      rebalance_id: rebalanceId,
      as_of_date: asOfDate,
      portfolio_id: portfolioId,
      emergency_pct: CASH_EMERGENCY_PCT,
      yield_pct: CASH_YIELD_PCT,
      instruments: CASH_YIELD_INSTRUMENTS.map(x => ({ ...x })),
      created: 0,
      updated: 0,
      dry_run: !!options.dryRun,
    };

    if (options.dryRun) {
      logger.info(
        `[CASH_ALLOCATION] DRY rebalance_id=${rebalanceId} yield=${CASH_YIELD_PCT}% ` +
          `instruments=${CASH_YIELD_INSTRUMENTS.map(x => x.code).join(',')}`
      );
      return result;
    }

    for (const inst of CASH_YIELD_INSTRUMENTS) {
      const { created, updated } = await this.persistSignal(inst, {
        asOfDate,
        rebalanceId,
      });
      result.created += created;
      result.updated += updated;
    }

    logger.info(
      `[CASH_ALLOCATION] rebalance_id=${rebalanceId} created=${result.created} ` +
        `updated=${result.updated} emergency=${CASH_EMERGENCY_PCT}% yield=${CASH_YIELD_PCT}%`
    );
    return result;
  }

  private async persistSignal(
    inst: CashInstrument,
    ctx: { asOfDate: string; rebalanceId: string }
  ): Promise<{ created: number; updated: number }> {
    const symbol = inst.code;
    const source_id = `cash_${symbol}_${ctx.rebalanceId}`;

    const payload: any = {
      source_type: AISignalSourceType.CASH_MANAGEMENT,
      source_id,
      symbol,
      name: inst.name,
      signal_date: ctx.asOfDate,
      decision: AISignalDecision.BUY,
      normalized_decision: AISignalDecision.BUY,
      action: 'TARGET_WEIGHT',
      confidence: 1, // 保守现金标的, 无胜率概念, 置信度按满
      rebalance_id: ctx.rebalanceId,
      target_pct: inst.target_pct,
      confidence_score: 100,
      risk_level: 'low',
      rationale: `现金 10% 收益层: ${inst.name} (${inst.kind}) 目标 ${inst.target_pct}% 吃利息, 压舱石不做短线`,
      detail: JSON.stringify({
        cash_bucket: true,
        kind: inst.kind,
        target_pct: inst.target_pct,
        emergency_pct: CASH_EMERGENCY_PCT,
        yield_pct: CASH_YIELD_PCT,
      }),
      metadata: {
        cash_management: true,
        rebalance_id: ctx.rebalanceId,
        core_satellite_bucket: 'cash',
        cash_kind: inst.kind,
        target_pct: inst.target_pct,
      },
    };

    const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
      where: {
        source_type: AISignalSourceType.CASH_MANAGEMENT,
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

export const cashAllocationService = new CashAllocationService();
