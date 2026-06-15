/**
 * Sprint 41-B: TripleBarrierLabeler — López de Prado 三重障碍标签法
 *
 * 把"这笔下注赚没赚钱"的二元 label 升级成"这笔下注的路径质量"的三态 label:
 *
 *   - **UPPER_HIT (1)**:  先触发上轨 (止盈线) → 好下注 (赢 + 路径快)
 *   - **LOWER_HIT (-1)**: 先触发下轨 (止损线) → 坏下注 (输或路径差)
 *   - **TIME_HIT (0)**:   时间轨到期未触发任何障碍 → 平庸 / 中性
 *   - **NO_DATA (null)**: bars 不足无法判定
 *
 * 设计要点:
 *   1. **三轨用 % 而非绝对价**: profit_take_pct (默认 +5%) / stop_loss_pct (默认 -3%)
 *      / max_holding_days (默认 15). 与 entry_price 解耦, 不同价位 stock 可比.
 *   2. **同 bar 上下轨都触发判定**: 看最高/最低先后顺序无法从日 bar 还原 → 保守按
 *      **LOWER_HIT** (假设最坏路径), 与多数 academic 实现一致.
 *   3. **fail-open**: bars 缺 → return NO_DATA, 不抛错.
 *   4. **纯函数 + DataSource DI**: helper 全 export, 单测脱 DB.
 *   5. **不写库**: TripleBarrierLabeler 只产 label, 不持久化 — 训练 caller (train-meta-label-v2
 *      CLI) 决定何时落库, 单独 train_meta_label_v2 表存样本.
 *
 * 与现有 MetaLabel 的关系:
 *   - 现有 MetaLabel label = (profit > 0) ? 1 : 0 (二分类)
 *   - V2 label = -1/0/1 (三分类), 训练目标更细
 *   - V2 训练后 model.predict 仍输出 probability (但模型从 logistic 升级到 softmax
 *     多分类, 或独立训练 "good_bet" / "bad_bet" 两个 logistic head)
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_BARRIER_OPTIONS: TripleBarrierOptions = Object.freeze({
  /** 上轨止盈线 (从 entry_price 起涨幅), 默认 +5% */
  profit_take_pct: 0.05,
  /** 下轨止损线 (从 entry_price 起跌幅, 绝对值), 默认 3% */
  stop_loss_pct: 0.03,
  /** 时间轨上限 (自然日, 不算交易日 — 与 paper trading 一致) */
  max_holding_days: 15,
}) as TripleBarrierOptions;

export interface TripleBarrierOptions {
  profit_take_pct: number;
  stop_loss_pct: number;
  max_holding_days: number;
}

export type TripleBarrierLabel = -1 | 0 | 1;

export const TRIPLE_BARRIER_LABELS = Object.freeze({
  LOWER_HIT: -1 as TripleBarrierLabel,
  TIME_HIT: 0 as TripleBarrierLabel,
  UPPER_HIT: 1 as TripleBarrierLabel,
});

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface TripleBarrierInput {
  symbol: string;
  /** 入场价 (BUY 时的执行价). */
  entry_price: number;
  /** 入场日 (ISO YYYY-MM-DD). */
  entry_date: string;
  /** 障碍参数 (默认 DEFAULT_BARRIER_OPTIONS) */
  options?: Partial<TripleBarrierOptions>;
}

export interface DailyBarSnapshot {
  /** ISO YYYY-MM-DD */
  date: string;
  high: number;
  low: number;
  close: number;
}

export interface TripleBarrierResult {
  symbol: string;
  entry_date: string;
  entry_price: number;
  /** 实际产生的 label; null 表示数据不足 */
  label: TripleBarrierLabel | null;
  /** 触发的具体 barrier */
  trigger: 'upper' | 'lower' | 'time' | 'no_data';
  /** 触发那一天的 ISO 日期; null 表示数据不足 */
  trigger_date: string | null;
  /** 触发时的价格 (upper=high, lower=low, time=close) */
  trigger_price: number | null;
  /** 实际 pnl_pct = (trigger_price - entry_price) / entry_price */
  pnl_pct: number | null;
  /** 计算时使用的 options (合并默认 + override 后) */
  options: TripleBarrierOptions;
  /** bars 扫描数 (审计用) */
  bars_scanned: number;
}

// ---------------------------------------------------------------------------
// Pure-function helpers (all exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 合并 partial options 与默认值, 防御 NaN / 负数.
 */
export function normalizeBarrierOptions(
  input?: Partial<TripleBarrierOptions>
): TripleBarrierOptions {
  const def = DEFAULT_BARRIER_OPTIONS;
  const pt = Number(input?.profit_take_pct);
  const sl = Number(input?.stop_loss_pct);
  const md = Number(input?.max_holding_days);
  return {
    profit_take_pct: Number.isFinite(pt) && pt > 0 && pt < 1 ? pt : def.profit_take_pct,
    stop_loss_pct: Number.isFinite(sl) && sl > 0 && sl < 1 ? sl : def.stop_loss_pct,
    max_holding_days:
      Number.isFinite(md) && md >= 1 && md <= 365 ? Math.floor(md) : def.max_holding_days,
  };
}

/**
 * 对单个 bar 判定 barrier 触发情况.
 * 返回触发类型 + 触发价 + pnl_pct.
 * **同 bar 上下轨都触发 → 保守按 LOWER_HIT** (假设最坏路径).
 */
export function evaluateBarBarrier(
  bar: DailyBarSnapshot,
  entry_price: number,
  options: TripleBarrierOptions
): {
  hit: 'upper' | 'lower' | 'none';
  trigger_price: number;
  pnl_pct: number;
} {
  if (entry_price <= 0) {
    return { hit: 'none', trigger_price: bar.close, pnl_pct: 0 };
  }
  const upperTarget = entry_price * (1 + options.profit_take_pct);
  const lowerTarget = entry_price * (1 - options.stop_loss_pct);
  const hitUpper = bar.high >= upperTarget;
  const hitLower = bar.low <= lowerTarget;
  // 同 bar 都触发 → 保守按 lower
  if (hitLower) {
    return {
      hit: 'lower',
      trigger_price: lowerTarget,
      pnl_pct: -options.stop_loss_pct,
    };
  }
  if (hitUpper) {
    return {
      hit: 'upper',
      trigger_price: upperTarget,
      pnl_pct: options.profit_take_pct,
    };
  }
  return {
    hit: 'none',
    trigger_price: bar.close,
    pnl_pct: (bar.close - entry_price) / entry_price,
  };
}

/**
 * 给一组 bars (按日期升序) 跑 triple-barrier 逻辑.
 * bars 应当从 entry_date+1 开始 (不含 entry day 当日).
 */
export function applyTripleBarrier(
  bars: DailyBarSnapshot[],
  entry_price: number,
  options: TripleBarrierOptions
): {
  label: TripleBarrierLabel | null;
  trigger: 'upper' | 'lower' | 'time' | 'no_data';
  trigger_date: string | null;
  trigger_price: number | null;
  pnl_pct: number | null;
  bars_scanned: number;
} {
  if (!bars.length || entry_price <= 0) {
    return {
      label: null,
      trigger: 'no_data',
      trigger_date: null,
      trigger_price: null,
      pnl_pct: null,
      bars_scanned: 0,
    };
  }

  const limitedBars = bars.slice(0, options.max_holding_days);

  for (const bar of limitedBars) {
    const eval_ = evaluateBarBarrier(bar, entry_price, options);
    if (eval_.hit === 'lower') {
      return {
        label: TRIPLE_BARRIER_LABELS.LOWER_HIT,
        trigger: 'lower',
        trigger_date: bar.date,
        trigger_price: eval_.trigger_price,
        pnl_pct: eval_.pnl_pct,
        bars_scanned: limitedBars.indexOf(bar) + 1,
      };
    }
    if (eval_.hit === 'upper') {
      return {
        label: TRIPLE_BARRIER_LABELS.UPPER_HIT,
        trigger: 'upper',
        trigger_date: bar.date,
        trigger_price: eval_.trigger_price,
        pnl_pct: eval_.pnl_pct,
        bars_scanned: limitedBars.indexOf(bar) + 1,
      };
    }
  }

  // Time barrier: 用最后一个 bar 的 close 作为 trigger_price
  const lastBar = limitedBars[limitedBars.length - 1];
  return {
    label: TRIPLE_BARRIER_LABELS.TIME_HIT,
    trigger: 'time',
    trigger_date: lastBar.date,
    trigger_price: lastBar.close,
    pnl_pct: (lastBar.close - entry_price) / entry_price,
    bars_scanned: limitedBars.length,
  };
}

// ---------------------------------------------------------------------------
// DataSource (DI for tests)
// ---------------------------------------------------------------------------

export interface TripleBarrierDataSource {
  /**
   * 读 entry_date+1 起的连续 bars (升序), 至多 max_holding_days 个.
   * 返回 [] 表示 bars 缺.
   */
  loadBarsAfterEntry(
    symbol: string,
    entry_date: string,
    max_holding_days: number
  ): Promise<DailyBarSnapshot[]>;
}

export const PRODUCTION_TRIPLE_BARRIER_DATA_SOURCE: TripleBarrierDataSource = {
  async loadBarsAfterEntry(symbol, entry_date, max_holding_days) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) return [];
      const entryStart = new Date(`${entry_date}T00:00:00.000Z`);
      // 多拉几天 buffer 防节假日 (max_holding_days × 2 + 7)
      const lookforwardCalendarDays = max_holding_days * 2 + 7;
      const endTime = new Date(entryStart.getTime() + lookforwardCalendarDays * 86400000);
      const bars = await DailyBar.findAll({
        where: {
          stock_id: (stock as any).id,
          time: { [Op.gt]: entryStart, [Op.lte]: endTime },
        },
        attributes: ['time', 'high', 'low', 'close'],
        order: [['time', 'ASC']],
        limit: max_holding_days,
        raw: true,
      });
      return (bars as any[])
        .map(b => {
          const close = typeof b.close === 'string' ? Number(b.close) : b.close;
          const high = typeof b.high === 'string' ? Number(b.high) : b.high;
          const low = typeof b.low === 'string' ? Number(b.low) : b.low;
          return {
            date: new Date(b.time).toISOString().slice(0, 10),
            high,
            low,
            close,
          };
        })
        .filter(b => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close));
    } catch (error: any) {
      logger.warn(
        `TripleBarrier loadBarsAfterEntry 失败 (symbol=${symbol} entry=${entry_date}): ${
          error?.message || error
        }`
      );
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TripleBarrierLabeler {
  constructor(
    private dataSource: TripleBarrierDataSource = PRODUCTION_TRIPLE_BARRIER_DATA_SOURCE
  ) {}

  /**
   * 给单笔历史 trade 打 triple-barrier label.
   */
  async label(input: TripleBarrierInput): Promise<TripleBarrierResult> {
    const opts = normalizeBarrierOptions(input.options);
    const bars = await this.dataSource.loadBarsAfterEntry(
      input.symbol,
      input.entry_date,
      opts.max_holding_days
    );
    const r = applyTripleBarrier(bars, input.entry_price, opts);
    return {
      symbol: input.symbol,
      entry_date: input.entry_date,
      entry_price: input.entry_price,
      label: r.label,
      trigger: r.trigger,
      trigger_date: r.trigger_date,
      trigger_price: r.trigger_price,
      pnl_pct: r.pnl_pct,
      options: opts,
      bars_scanned: r.bars_scanned,
    };
  }

  /**
   * 批量 label, 用于训练样本生成. 单笔失败 fail-isolate.
   */
  async labelBatch(inputs: TripleBarrierInput[]): Promise<TripleBarrierResult[]> {
    const out: TripleBarrierResult[] = [];
    for (const input of inputs) {
      try {
        out.push(await this.label(input));
      } catch (error: any) {
        logger.warn(
          `TripleBarrier batch single failed (${input.symbol}@${input.entry_date}): ${
            error?.message || error
          }`
        );
        out.push({
          symbol: input.symbol,
          entry_date: input.entry_date,
          entry_price: input.entry_price,
          label: null,
          trigger: 'no_data',
          trigger_date: null,
          trigger_price: null,
          pnl_pct: null,
          options: normalizeBarrierOptions(input.options),
          bars_scanned: 0,
        });
      }
    }
    return out;
  }
}

export const tripleBarrierLabeler = new TripleBarrierLabeler();
