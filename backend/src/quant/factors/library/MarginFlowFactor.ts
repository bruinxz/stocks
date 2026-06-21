/**
 * MarginFlowFactor (融资余额变化因子) — US-091
 *
 * 公式: raw_value = (fin_balance[T] - fin_balance[T-5]) / fin_balance[T-5]
 *   - 近 5 个交易日融资余额变化率 (%)
 *   - 正值 → 杠杆资金看多 (大幅加仓) → buy signal
 *   - 负值 → 杠杆资金撤退 (减仓 / 平仓) → sell signal
 *
 * 经济意义:
 *   - 融资余额是市场上"借钱看多"杠杆资金的存量, 5 日内大幅上涨意味着
 *     专业杠杆资金对该股看多, 已有研究表明这是中线 alpha 信号 (参考:
 *     招商证券《融资融券与个股表现相关性研究》2018, 中信证券《杠杆资金
 *     行为与个股短期收益》2020).
 *   - 不区分融资 vs 融券: 实证显示融资 (做多) 资金信号强度远高于融券
 *     (做空) 资金, 简化模型只看融资余额变化即可.
 *
 * 数据源: MarginTradingBalance 表 (US-091 同步入库)
 *   - PK = (trade_date, stock_code), stock_code 无后缀, 与 universe 直接对齐
 *   - 字段: fin_balance (元), trade_date, stock_code
 *
 * 失效 (不入 Map, 让 Pipeline 中性补全):
 *   - as_of_date 当天该股没有融资融券数据 → 跳过 (不在两融标的范围)
 *   - 5 个交易日前没有数据 → 用窗口内最早一条做基线 (类似 NorthboundFactor 范式)
 *   - 基线 fin_balance ≤ 0 → 跳过 (防分母爆炸, US-035 同款 guard)
 *   - 窗口内只有一条数据 → 无法算变化, 跳过
 *
 * 关于 "因子不做归一化" 约束 #1 (factors/CLAUDE.md):
 *   - raw_value = (T - T-5) / T-5 是 **per-stock 自身环比**, 不参照横截面统计量
 *     → 走标准模式 (不属 LiquidityFactor 例外). Pipeline 后续仍做 winsorize + zscore.
 *
 * 关于 WINDOW_DAYS = 5 自然日 + +5 兜底:
 *   - "近 5 日" 是 AC 要求, 用 5 个交易日作为业务窗口;
 *   - 查询时拉 5 + 10 = 15 自然日缓冲 (长假 + 周末), 让窗口内能找到 ≥ 5 条交易日数据;
 *   - 与 NorthboundFactor (WINDOW_DAYS=20 + 10 兜底) 同款模式.
 *
 * 与既有因子的关系:
 *   - 与 money_flow (US-010, 主力净流入) 同为"日级资金流"因子, 但 money_flow 是
 *     盘中主力席位资金 (东财数据), 本因子是融资融券账户 (官方数据);
 *     维度互补, 相关性预计 0.3-0.4.
 *   - 与 northbound (US-010, 北向 20 日变化) 同为"中线资金跟随"因子, 但前者跟外资,
 *     本因子跟境内杠杆资金; 维度互补, 相关性预计 0.2-0.4.
 *   - 与 insider_trade (US-090, 内部人 60 日净买入) 同属"资金信号"维度,
 *     但前者是低频公告 (周-月级), 本因子是日级; 预计相关性 0.1-0.2 较低,
 *     可同时启用.
 *
 * **TODO 升级路径** (未来 US-093+):
 *   - 加入 短线变化 (1 日 / 3 日 / 10 日) 作为多维度因子;
 *   - 加入 fin_buy_amt (买入额) / fin_repay_amt (偿还额) 配比作为短期方向信号;
 *   - 加入 short_balance (融券余额) 变化作为做空意愿因子.
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { MarginTradingBalance } from '../../../models/MarginTradingBalance';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

/** 因子查询窗口 (业务窗口, 交易日) — 近 5 日融资余额变化 */
export const WINDOW_TRADE_DAYS = 5;

/** 自然日缓冲: 5 业务日 ≈ 7 自然日 (含周末), +10 覆盖春节 / 十一长假 */
export const LOOKBACK_CALENDAR_DAYS = WINDOW_TRADE_DAYS + 10;

/**
 * 单只股票多日 fin_balance 序列的"近 N 日变化率" helper (抽成纯函数便于测试).
 *
 * @param series    该股票在 [as_of - LOOKBACK_CALENDAR_DAYS, as_of] 内的
 *                  全部 (trade_date, fin_balance) 记录 (已过滤 fin_balance>0)
 * @param asOfDate  截面日期 (YYYY-MM-DD)
 * @param windowTradeDays 业务窗口交易日数 (默认 5)
 * @returns         变化率 = (latest - baseline) / baseline; 数据不足 → null
 *
 * baseline 选择策略:
 *   - 优先: 取倒数第 (windowTradeDays + 1) 条 (即 T-N 日)
 *   - 兜底: 若长度不足 windowTradeDays+1, 取窗口内最早一条 (与 NorthboundFactor 同款)
 *   - 业务约束: as_of_date 距 latest trade_date 不能太远 (上交所 / 深交所
 *     公告 T+1 出, 但 sync 任务可能延迟; 默认允许 latest 在 as_of_date
 *     前 STALE_TOLERANCE_DAYS 内, 超出即认为数据停滞跳过该股).
 *
 * Batch AN 修 (2026-06-21): 原 `latest.trade_date !== asOfDate` 严格相等
 * 导致非交易日 / 当日数据未入库时全市场 margin_flow 完全失效 (factor 0 命中,
 * std=0). 改为窗口内最新一条 ≤ as_of, 距 as_of 最多 STALE_TOLERANCE_DAYS 自然日.
 */
export interface FinBalanceObservation {
  trade_date: string;
  fin_balance: number;
}

/**
 * 业务上允许的 latest 数据陈旧度 (自然日). 春节 / 国庆停盘最长 ~10 日,
 * 加 +3 兜底 sync 延迟; 超出该窗口认为数据停滞 (该股不入 Map).
 */
export const STALE_TOLERANCE_DAYS = 15;

export function computeFinBalanceChange(
  series: FinBalanceObservation[],
  asOfDate: string,
  windowTradeDays: number = WINDOW_TRADE_DAYS,
  staleToleranceDays: number = STALE_TOLERANCE_DAYS
): number | null {
  if (!series || series.length < 2) return null;
  if (!asOfDate) return null;
  if (!Number.isInteger(windowTradeDays) || windowTradeDays < 1) return null;

  // 升序排列
  const sorted = [...series].sort((a, b) => a.trade_date.localeCompare(b.trade_date));

  // lookahead bias guard: 剔除 trade_date > asOfDate
  const filtered = sorted.filter(s => s.trade_date <= asOfDate);
  if (filtered.length < 2) return null;

  const latest = filtered[filtered.length - 1];
  // Batch AN 修: 改成允许 latest 在 as_of 前 staleToleranceDays 自然日内
  // (原严格相等 latest.trade_date === asOfDate 在非交易日 / sync 滞后时全部失效).
  const asOfMs = new Date(`${asOfDate}T00:00:00Z`).getTime();
  const latestMs = new Date(`${latest.trade_date}T00:00:00Z`).getTime();
  if (!Number.isFinite(asOfMs) || !Number.isFinite(latestMs)) return null;
  const ageDays = (asOfMs - latestMs) / 86400000;
  if (ageDays > staleToleranceDays) return null; // 数据停滞 → 跳过

  // baseline: 取倒数第 (windowTradeDays + 1) 条 (即 T-N 日); 兜底取最早
  const baselineIdx = Math.max(0, filtered.length - 1 - windowTradeDays);
  const baseline = filtered[baselineIdx];
  if (baseline === latest) return null; // 只有一条数据 → 跳过
  if (!isFiniteNumber(baseline.fin_balance) || baseline.fin_balance <= 0) return null;
  if (!isFiniteNumber(latest.fin_balance)) return null;

  return (latest.fin_balance - baseline.fin_balance) / baseline.fin_balance;
}

export const marginFlowFactor: Factor = {
  name: 'margin_flow',
  description: '近 5 个交易日融资余额变化率 (杠杆资金方向)',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 拉窗口内 + 当日的全部融资融券行 (按 stock_code IN 过滤 universe)
    const startDate = lookbackStartDate(ctx.as_of_date, LOOKBACK_CALENDAR_DAYS);
    const rows = (await MarginTradingBalance.findAll({
      attributes: ['stock_code', 'trade_date', 'fin_balance'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      fin_balance: any;
    }>;

    // 按 stock_code 分组 (同股可能同日有 SZSE + SSE 两个 record, 但实际不会出现
    // 一支股票同时在两市挂牌的两融名单, 这里 dedup 由数据库 PK 保证).
    const byStock = new Map<string, FinBalanceObservation[]>();
    for (const r of rows) {
      if (r.fin_balance === null || r.fin_balance === undefined) continue;
      // `Number(null) === 0` JS 大坑 (US-031): nullable 字段必须先 null 检查再 Number 转换
      const balance = Number(r.fin_balance);
      if (!isFiniteNumber(balance) || balance <= 0) continue;
      const arr = byStock.get(r.stock_code) ?? [];
      arr.push({ trade_date: r.trade_date, fin_balance: balance });
      byStock.set(r.stock_code, arr);
    }

    // per-stock 计算 5 日变化率
    for (const [code, series] of byStock.entries()) {
      const change = computeFinBalanceChange(series, ctx.as_of_date, WINDOW_TRADE_DAYS);
      if (change === null) continue;
      out.set(code, change);
    }

    return out;
  },
};

factorRegistry.register(marginFlowFactor);
