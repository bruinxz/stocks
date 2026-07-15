/**
 * Sprint 41-F: EventIntelligenceLayer — 非量化事件作为 meta filter
 *
 * 高级操盘不是纯 K 线/因子 — 信号入场前要参考事件/产业信号:
 *   - 业绩预告大幅预增 → boost (提高入场置信度)
 *   - 北向资金 5 日大幅加仓 → boost
 *   - 龙虎榜机构净买入 → boost
 *   - ST / 停牌 / 减持 / 监管处罚 → veto (强制 skip)
 *   - 业绩报告期前 N 日 → delay (避开预告/正式报告窗口)
 *   - famous_yz 大幅净卖出 → dampen (降低置信度)
 *
 * 5 种 Action:
 *   - allow:  通过, score_multiplier=1
 *   - boost:  提升, score_multiplier > 1 (典型 1.1-1.3)
 *   - dampen: 降低, score_multiplier < 1 (典型 0.7-0.9)
 *   - veto:   否决, score_multiplier=0 → 强制 skip
 *   - delay:  延迟 N 分钟/小时再观察 (典型业绩公告前后窗口)
 *
 * 设计要点:
 *   1. **聚合多事件**: 一只票可能同时触发多个事件 (e.g. 业绩预告 + 北向加仓)
 *      → 综合 action = veto > delay > boost+dampen 加权乘
 *   2. **fail-open**: 数据缺失 (EarningsForecast 该 symbol 无记录) → allow 不阻塞
 *   3. **DataSource DI**: 测试注入 fake events, 完全脱 DB
 *   4. **不引 NLP / LLM**: 用已有结构化数据 (业绩预告 forecast_type / 北向 ratio_delta /
 *      龙虎榜 net_buy 等), 让 service 100% deterministic + 0 外部 API 依赖
 */

import { logger } from '../../utils/logger';

/**
 * `'600519.SH'` → `'600519'`. 持仓 symbol 含 '.SH/SZ/BJ' 后缀, 但底层
 * EarningsForecast / NorthboundHolding / DragonTigerBoard 三表 stock_code
 * 均为无后缀 6 位 (AKShare 入库口径). 此 helper 把 caller 输入对齐到底层
 * 存储的 stock_code, 避免事件维度永远 0 命中.
 */
function stripSymbolSuffix(symbol: string): string {
  if (typeof symbol !== 'string') return symbol as any;
  const idx = symbol.indexOf('.');
  if (idx < 0) return symbol;
  return symbol.slice(0, idx);
}

// ===========================================================================
// Types
// ===========================================================================

export type MetaFilterAction = 'allow' | 'boost' | 'dampen' | 'veto' | 'delay';

export interface EventSignal {
  /** 事件类型, 用于审计 */
  event_type:
    | 'earnings_forecast_positive'
    | 'earnings_forecast_negative'
    | 'northbound_inflow'
    | 'northbound_outflow'
    | 'dragon_tiger_inst_buy'
    | 'dragon_tiger_yz_sell'
    | 'shareholder_reduce_announce'
    | 'st_warning'
    | 'suspended'
    | 'earnings_report_window';
  /** 单事件的 score multiplier (1 = 中性) */
  score_multiplier: number;
  /** 单事件的 action 倾向 */
  action_hint: MetaFilterAction;
  /** 延迟分钟 (action='delay' 时用) */
  delay_minutes?: number;
  reason: string;
}

export interface MetaFilterResult {
  symbol: string;
  /** 综合 action */
  action: MetaFilterAction;
  /** 综合 score multiplier (boost 类相乘, dampen 类相乘, veto → 0) */
  score_multiplier: number;
  /** delay 分钟 */
  delay_minutes: number;
  /** 触发的所有事件 */
  events: EventSignal[];
  reason: string;
}

export interface MetaFilterInput {
  symbol: string;
  as_of_date: string;
  options?: Partial<EventIntelligenceOptions>;
}

export interface EventIntelligenceOptions {
  /** 业绩预告净利润增长率正向阈值 (默认 +50%) */
  earnings_positive_yoy_threshold: number;
  /** 业绩预告净利润增长率负向阈值 (默认 -30%) */
  earnings_negative_yoy_threshold: number;
  /** 业绩预告 boost 系数 */
  earnings_positive_boost: number;
  /** 业绩预告 dampen 系数 */
  earnings_negative_dampen: number;
  /** 北向加仓阈值 (5 日累计 hold_ratio_delta 百分点, 默认 +1pp) */
  northbound_inflow_pp_threshold: number;
  /** 北向减仓阈值 (默认 -1pp) */
  northbound_outflow_pp_threshold: number;
  northbound_inflow_boost: number;
  northbound_outflow_dampen: number;
  /** 龙虎榜机构净买入金额阈值 (默认 5000 万) */
  dragon_tiger_inst_buy_yuan: number;
  dragon_tiger_inst_buy_boost: number;
  /** 龙虎榜 famous_yz 净卖出阈值 (绝对值 ≥, 默认 1 亿) */
  dragon_tiger_yz_sell_yuan: number;
  dragon_tiger_yz_sell_dampen: number;
  /** 业绩公告窗口前后 N 自然日 → delay (默认 ±3 天) */
  earnings_window_days: number;
  earnings_window_delay_minutes: number;
}

export const DEFAULT_EVENT_INTELLIGENCE_OPTIONS: EventIntelligenceOptions = Object.freeze({
  earnings_positive_yoy_threshold: 0.5,
  earnings_negative_yoy_threshold: -0.3,
  earnings_positive_boost: 1.2,
  earnings_negative_dampen: 0.6,
  northbound_inflow_pp_threshold: 1.0,
  northbound_outflow_pp_threshold: -1.0,
  northbound_inflow_boost: 1.15,
  northbound_outflow_dampen: 0.75,
  dragon_tiger_inst_buy_yuan: 50000000, // 5000 万
  dragon_tiger_inst_buy_boost: 1.1,
  dragon_tiger_yz_sell_yuan: 100000000, // 1 亿
  dragon_tiger_yz_sell_dampen: 0.7,
  earnings_window_days: 3,
  earnings_window_delay_minutes: 24 * 60, // delay 一天
}) as EventIntelligenceOptions;

// ===========================================================================
// Pure helpers
// ===========================================================================

export function normalizeEventIntelligenceOptions(
  input?: Partial<EventIntelligenceOptions>
): EventIntelligenceOptions {
  const def = DEFAULT_EVENT_INTELLIGENCE_OPTIONS;
  if (!input) return def;
  const out: EventIntelligenceOptions = { ...def };
  for (const k of Object.keys(def) as Array<keyof EventIntelligenceOptions>) {
    const v = Number((input as any)[k]);
    if (Number.isFinite(v)) (out as any)[k] = v;
  }
  return out;
}

/**
 * 聚合多个事件信号 → 单一 MetaFilterResult.
 *
 * 规则:
 *   1. 任一 veto → action='veto', multiplier=0 (强制 skip)
 *   2. 任一 delay → action='delay', delay_minutes=最大值 (业绩公告优先)
 *   3. 其他: action='boost'/'dampen'/'allow' 按 multiplier 总积 vs 1 判定:
 *      multiplier > 1.05 → boost
 *      multiplier < 0.95 → dampen
 *      其余 → allow
 *   4. score_multiplier = 所有事件 multiplier 连乘 (但 veto → 0)
 */
export function aggregateEvents(symbol: string, events: EventSignal[]): MetaFilterResult {
  if (!events.length) {
    return {
      symbol,
      action: 'allow',
      score_multiplier: 1,
      delay_minutes: 0,
      events: [],
      reason: '无事件信号, 默认 allow',
    };
  }
  // veto 短路
  const veto = events.find(e => e.action_hint === 'veto');
  if (veto) {
    return {
      symbol,
      action: 'veto',
      score_multiplier: 0,
      delay_minutes: 0,
      events,
      reason: `VETO: ${veto.reason}`,
    };
  }
  // delay 优先
  const delays = events.filter(e => e.action_hint === 'delay');
  if (delays.length) {
    const maxDelay = Math.max(...delays.map(e => e.delay_minutes || 0));
    return {
      symbol,
      action: 'delay',
      score_multiplier: 1,
      delay_minutes: maxDelay,
      events,
      reason: `DELAY ${maxDelay} 分钟: ${delays.map(e => e.reason).join('; ')}`,
    };
  }
  // boost / dampen 连乘
  let multiplier = 1;
  for (const e of events) multiplier *= e.score_multiplier;
  const action: MetaFilterAction =
    multiplier > 1.05 ? 'boost' : multiplier < 0.95 ? 'dampen' : 'allow';
  return {
    symbol,
    action,
    score_multiplier: multiplier,
    delay_minutes: 0,
    events,
    reason: `${action.toUpperCase()} (multiplier=${multiplier.toFixed(3)}): ${events
      .map(e => e.reason)
      .join('; ')}`,
  };
}

// ===========================================================================
// DataSource
// ===========================================================================

export interface EventIntelligenceDataSource {
  /** 业绩预告近 N 日内 (净利润同比增长率) */
  loadEarningsForecast(
    symbol: string,
    as_of_date: string
  ): Promise<{ yoy_growth: number; report_period: string } | null>;

  /** 北向资金 5 日累计 hold_ratio_delta (百分点) */
  loadNorthboundDelta5d(symbol: string, as_of_date: string): Promise<number | null>;

  /** 当日龙虎榜聚合: 机构净买入 / famous_yz 净买入 (元) */
  loadDragonTigerSummary(
    symbol: string,
    as_of_date: string
  ): Promise<{ inst_net_buy: number; yz_net_buy: number } | null>;

  /** symbol 是否处于业绩公告窗口 (期前后 ±N 自然日) */
  isInEarningsWindow(symbol: string, as_of_date: string, window_days: number): Promise<boolean>;

  /** symbol 是否 ST / 停牌 */
  isHardBlocked(symbol: string): Promise<{ st: boolean; suspended: boolean }>;
}

export const PRODUCTION_EVENT_INTELLIGENCE_DATA_SOURCE: EventIntelligenceDataSource = {
  async loadEarningsForecast(symbol, as_of_date) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { EarningsForecast } = require('../../models/EarningsForecast');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const lookbackStart = new Date(`${as_of_date}T00:00:00.000Z`);
      lookbackStart.setDate(lookbackStart.getDate() - 30);
      const row = await EarningsForecast.findOne({
        // Bug AY-2 fix: 表列名是 stock_code (6 位无后缀), 不是 symbol.
        where: {
          stock_code: stripSymbolSuffix(symbol),
          announce_date: { [Op.gte]: lookbackStart },
        },
        order: [['announce_date', 'DESC']],
        attributes: ['profit_change_high', 'profit_change_low', 'report_period'],
        raw: true,
      });
      if (!row) return null;
      const high = Number((row as any).profit_change_high);
      const low = Number((row as any).profit_change_low);
      const avg = Number.isFinite(high) && Number.isFinite(low) ? (high + low) / 2 / 100 : NaN;
      if (!Number.isFinite(avg)) return null;
      return { yoy_growth: avg, report_period: String((row as any).report_period || '') };
    } catch (error: any) {
      logger.warn(
        `EventIntelligence loadEarningsForecast 失败 (${symbol}): ${error?.message || error}`
      );
      return null;
    }
  },

  async loadNorthboundDelta5d(symbol, as_of_date) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { NorthboundHolding } = require('../../models/NorthboundHolding');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const end = new Date(`${as_of_date}T00:00:00.000Z`);
      const start = new Date(end);
      start.setDate(start.getDate() - 7); // 7 自然日覆盖 5 交易日
      const rows = await NorthboundHolding.findAll({
        // Bug AY-2 fix: 表列名是 stock_code (6 位无后缀), 不是 symbol.
        where: {
          stock_code: stripSymbolSuffix(symbol),
          trade_date: { [Op.between]: [start, end] },
        },
        order: [['trade_date', 'ASC']],
        attributes: ['trade_date', 'hold_ratio'],
        raw: true,
      });
      if (!rows.length || rows.length < 2) return null;
      const first = Number((rows[0] as any).hold_ratio);
      const last = Number((rows[rows.length - 1] as any).hold_ratio);
      if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
      return last - first; // 百分点
    } catch (error: any) {
      logger.warn(
        `EventIntelligence loadNorthboundDelta5d 失败 (${symbol}): ${error?.message || error}`
      );
      return null;
    }
  },

  async loadDragonTigerSummary(symbol, as_of_date) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DragonTigerBoard } = require('../../models/DragonTigerBoard');
      const rows = await DragonTigerBoard.findAll({
        // Bug AY-2 fix: 表列名是 stock_code (6 位无后缀) + net_amount (非 net_buy_amount).
        where: { stock_code: stripSymbolSuffix(symbol), trade_date: as_of_date },
        attributes: ['seat_type', 'net_amount'],
        raw: true,
      });
      if (!rows.length) return null;
      let inst = 0;
      let yz = 0;
      for (const r of rows as any[]) {
        const amount = Number(r.net_amount);
        if (!Number.isFinite(amount)) continue;
        const seatType = String(r.seat_type || '');
        // seat_type 入库枚举: public_fund / foreign / private / famous_yz / unknown
        if (
          seatType === 'public_fund' ||
          seatType === 'foreign' ||
          seatType === 'private' ||
          seatType.includes('机构') ||
          seatType.includes('institutional')
        ) {
          inst += amount;
        }
        if (seatType === 'famous_yz' || seatType.includes('famous') || seatType.includes('游资')) {
          yz += amount;
        }
      }
      return { inst_net_buy: inst, yz_net_buy: yz };
    } catch (error: any) {
      logger.warn(
        `EventIntelligence loadDragonTigerSummary 失败 (${symbol}): ${error?.message || error}`
      );
      return null;
    }
  },

  async isInEarningsWindow(symbol, as_of_date, window_days) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { EarningsForecast } = require('../../models/EarningsForecast');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const asOf = new Date(`${as_of_date}T00:00:00.000Z`);
      const start = new Date(asOf);
      start.setDate(start.getDate() - window_days);
      const end = new Date(asOf);
      end.setDate(end.getDate() + window_days);
      const exists = await EarningsForecast.findOne({
        // Bug AY-2 fix: 表列名是 stock_code (6 位无后缀), 不是 symbol.
        // 该表无独立 'id' 列 (PK = announce_date + stock_code + report_period 复合主键),
        // 仅查 announce_date 字段做 EXISTS 判定 (足够触发 findOne 真行 → !! 转 boolean).
        where: {
          stock_code: stripSymbolSuffix(symbol),
          announce_date: { [Op.between]: [start, end] },
        },
        attributes: ['announce_date'],
        raw: true,
      });
      return !!exists;
    } catch (error: any) {
      logger.warn(
        `EventIntelligence isInEarningsWindow 失败 (${symbol}): ${error?.message || error}`
      );
      return false;
    }
  },

  async isHardBlocked(symbol) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      const stock = await Stock.findOne({
        where: { symbol },
        // Bug AY-2 fix: stocks 表无 is_suspended 列, 停牌字段在 daily_bars
        // 表 (按 stock_id 关联最新一根 bar 取真).
        attributes: ['id', 'name'],
        raw: true,
      });
      if (!stock) return { st: false, suspended: false };
      const name = String((stock as any).name || '');
      const st = name.includes('ST');
      let suspended = false;
      try {
        const latestBar = await DailyBar.findOne({
          where: { stock_id: (stock as any).id },
          order: [['time', 'DESC']],
          attributes: ['is_suspended'],
          raw: true,
        });
        suspended = !!(latestBar && (latestBar as any).is_suspended);
      } catch (barError: any) {
        // fail-open: bar lookup 失败时仍按 ST 字符串结果返回
        logger.warn(
          `EventIntelligence isHardBlocked bar fallback (${symbol}): ${
            barError?.message || barError
          }`
        );
      }
      return { st, suspended };
    } catch (error: any) {
      logger.warn(`EventIntelligence isHardBlocked 失败 (${symbol}): ${error?.message || error}`);
      return { st: false, suspended: false };
    }
  },
};

// ===========================================================================
// Service
// ===========================================================================

export class EventIntelligenceLayer {
  constructor(
    private dataSource: EventIntelligenceDataSource = PRODUCTION_EVENT_INTELLIGENCE_DATA_SOURCE
  ) {}

  /**
   * 主入口: 给单只 symbol 在 as_of_date 收集所有事件 → 综合 MetaFilterResult.
   *
   * fail-open: 单个事件 source 失败只 warn 不阻塞其他事件.
   */
  async filter(input: MetaFilterInput): Promise<MetaFilterResult> {
    const opts = normalizeEventIntelligenceOptions(input.options);
    const events: EventSignal[] = [];

    // 1. Hard block (ST / 停牌) - 最高优先级 veto
    try {
      const block = await this.dataSource.isHardBlocked(input.symbol);
      if (block.suspended) {
        events.push({
          event_type: 'suspended',
          score_multiplier: 0,
          action_hint: 'veto',
          reason: '停牌',
        });
      }
      if (block.st) {
        events.push({
          event_type: 'st_warning',
          score_multiplier: 0,
          action_hint: 'veto',
          reason: 'ST 标记',
        });
      }
    } catch (error: any) {
      logger.warn(`EventIntelligence hardblock 失败: ${error?.message || error}`);
    }

    // 2. 业绩公告窗口 - delay
    try {
      const inWindow = await this.dataSource.isInEarningsWindow(
        input.symbol,
        input.as_of_date,
        opts.earnings_window_days
      );
      if (inWindow) {
        events.push({
          event_type: 'earnings_report_window',
          score_multiplier: 1,
          action_hint: 'delay',
          delay_minutes: opts.earnings_window_delay_minutes,
          reason: `近 ${opts.earnings_window_days} 日有业绩公告, 延迟 ${opts.earnings_window_delay_minutes} 分钟观察`,
        });
      }
    } catch (error: any) {
      logger.warn(`EventIntelligence earnings_window 失败: ${error?.message || error}`);
    }

    // 3. 业绩预告 boost / dampen
    try {
      const forecast = await this.dataSource.loadEarningsForecast(input.symbol, input.as_of_date);
      if (forecast && Number.isFinite(forecast.yoy_growth)) {
        if (forecast.yoy_growth >= opts.earnings_positive_yoy_threshold) {
          events.push({
            event_type: 'earnings_forecast_positive',
            score_multiplier: opts.earnings_positive_boost,
            action_hint: 'boost',
            reason: `业绩预告 yoy=+${(forecast.yoy_growth * 100).toFixed(1)}% >= ${(
              opts.earnings_positive_yoy_threshold * 100
            ).toFixed(0)}% boost ×${opts.earnings_positive_boost}`,
          });
        } else if (forecast.yoy_growth <= opts.earnings_negative_yoy_threshold) {
          events.push({
            event_type: 'earnings_forecast_negative',
            score_multiplier: opts.earnings_negative_dampen,
            action_hint: 'dampen',
            reason: `业绩预告 yoy=${(forecast.yoy_growth * 100).toFixed(1)}% <= ${(
              opts.earnings_negative_yoy_threshold * 100
            ).toFixed(0)}% dampen ×${opts.earnings_negative_dampen}`,
          });
        }
      }
    } catch (error: any) {
      logger.warn(`EventIntelligence earnings_forecast 失败: ${error?.message || error}`);
    }

    // 4. 北向资金
    try {
      const delta = await this.dataSource.loadNorthboundDelta5d(input.symbol, input.as_of_date);
      if (Number.isFinite(delta as number)) {
        const d = delta as number;
        if (d >= opts.northbound_inflow_pp_threshold) {
          events.push({
            event_type: 'northbound_inflow',
            score_multiplier: opts.northbound_inflow_boost,
            action_hint: 'boost',
            reason: `北向 5 日加仓 +${d.toFixed(2)}pp >= ${
              opts.northbound_inflow_pp_threshold
            }pp boost ×${opts.northbound_inflow_boost}`,
          });
        } else if (d <= opts.northbound_outflow_pp_threshold) {
          events.push({
            event_type: 'northbound_outflow',
            score_multiplier: opts.northbound_outflow_dampen,
            action_hint: 'dampen',
            reason: `北向 5 日减仓 ${d.toFixed(2)}pp <= ${
              opts.northbound_outflow_pp_threshold
            }pp dampen ×${opts.northbound_outflow_dampen}`,
          });
        }
      }
    } catch (error: any) {
      logger.warn(`EventIntelligence northbound 失败: ${error?.message || error}`);
    }

    // 5. 龙虎榜
    try {
      const dt = await this.dataSource.loadDragonTigerSummary(input.symbol, input.as_of_date);
      if (dt) {
        if (dt.inst_net_buy >= opts.dragon_tiger_inst_buy_yuan) {
          events.push({
            event_type: 'dragon_tiger_inst_buy',
            score_multiplier: opts.dragon_tiger_inst_buy_boost,
            action_hint: 'boost',
            reason: `龙虎榜机构净买 ${(dt.inst_net_buy / 1e8).toFixed(2)} 亿 boost ×${
              opts.dragon_tiger_inst_buy_boost
            }`,
          });
        }
        if (-dt.yz_net_buy >= opts.dragon_tiger_yz_sell_yuan) {
          events.push({
            event_type: 'dragon_tiger_yz_sell',
            score_multiplier: opts.dragon_tiger_yz_sell_dampen,
            action_hint: 'dampen',
            reason: `龙虎榜游资净卖 ${(-dt.yz_net_buy / 1e8).toFixed(2)} 亿 dampen ×${
              opts.dragon_tiger_yz_sell_dampen
            }`,
          });
        }
      }
    } catch (error: any) {
      logger.warn(`EventIntelligence dragon_tiger 失败: ${error?.message || error}`);
    }

    return aggregateEvents(input.symbol, events);
  }
}

export const eventIntelligenceLayer = new EventIntelligenceLayer();
