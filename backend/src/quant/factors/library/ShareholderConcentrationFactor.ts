/**
 * ShareholderConcentrationFactor (股东户数环比变化因子 / 筹码集中度因子) — US-035
 *
 * 公式：raw_value = -(holder_count[最新一期] - holder_count[上一期])
 *                   / holder_count[上一期]
 *
 *   - holder_count 下降 → 筹码集中 → 比率为负 → raw_value 取负后为正 → 正分
 *   - holder_count 上升 → 筹码分散 → 比率为正 → raw_value 取负后为负 → 负分
 *   - 越正分代表筹码越集中（机构 / 大户在悄悄吸筹）→ 多因子模型买入信号
 *   - 越负分代表筹码越分散（散户接盘加剧）→ 卖出 / 减仓信号
 *
 *   经济意义：A 股市场实证里筹码集中度变化与中期超额收益相关性显著
 *   （参考：东方证券《筹码集中度因子有效性研究》2019）。机构 / 大户增持
 *   通常先于股价上涨，故 holder_count 环比下降是常用的 alpha 来源。
 *
 * 数据源：ShareholderCount 表（US-035 同步入库）
 *   - PK (report_date, stock_code)
 *   - 关键字段：holder_count (整数 > 0)，可选 share_change (送转股 / 增发会让
 *     holder_count 环比含噪音；本因子可选过滤 share_change != 0 的行)
 *
 * 失效（不入 Map，让 Pipeline 中性补全）：
 *   - 该股票在 [as_of_date - LOOKBACK_DAYS] 窗口内有效快照 < 2 (无法环比) → 跳过
 *   - 最新一期 share_change != 0 且 EXCLUDE_SHARE_CHANGE_PERIODS=true → 跳过
 *     (送转股后 holder_count 自然增加，环比变化无业务意义)
 *   - holder_count[上一期] = 0 或 < 0 (数据异常) → 跳过 (防分母爆炸)
 *   - latest report_date 超出 as_of_date 后 (lookahead bias) → 跳过 (US-030 范式)
 *
 * 关于"因子不做归一化"约束 #1 (factors/CLAUDE.md)：
 *   - 本因子计算的 raw_value 是"环比变化率 × -1"，是 **绝对业务量**（per-stock
 *     自身新旧 holder_count 之比），不参照横截面统计量 — 走标准模式（不属
 *     LiquidityFactor 例外）。Pipeline 后续仍做 winsorize + zscore 跨因子归一化
 *     保证可比性。
 *
 * 关于"绝对业务量 vs 横截面参照量 二分类" (US-030 起):
 *   - 判据：raw_value 公式里是否出现"全市场 X 的分位 / 均值 / sd"？否（只看本股
 *     自己两期 holder_count）→ 第一类（绝对业务量），走标准模式。
 *
 * 关于 LOOKBACK_DAYS = 200 自然日：
 *   - 股东户数披露多数为季度末（3 月底 / 6 月底 / 9 月底 / 12 月底），最长间隔
 *     ~ 90 天 + 公告滞后 30 天 = 120 天。200 天 buffer 覆盖：
 *     a) 半年报披露真空期股票（部分公司只在季报披露）
 *     b) 公告日 vs 截止日的滞后 (announce_date 通常滞后 7-30 日)
 *     c) 春节 / 五一长假可能导致披露延迟
 *   - 上限 200 防止把 12 个月前的快照也作为"上一期"（早就过时）
 *
 * 与既有因子的关系：
 *   - 与 money_flow (US-010, 主力净流入) 相关性中等 (~0.3-0.4)：都反映"机构/大户
 *     吸筹"，但 money_flow 是日级高频信号，本因子是季度低频信号；可同时启用，
 *     高频信号决定短中线，低频信号决定中长线持仓 dur。
 *   - 与 northbound (US-010, 北向持股) 相关性较低 (~0.1-0.2)：北向是外资流入，
 *     本因子是境内机构 / 大户行为；维度不同，组合可同时启用。
 *   - FactorIC (US-041) 上线后可验证；当前预期非冗余可同时启用。
 *
 * 升级路径：
 *   - 若未来引入更频繁的股东户数数据源（如 TuShare Pro 月度披露），可缩短
 *     LOOKBACK_DAYS 到 90，对短期信号更敏感。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { ShareholderCount } from '../../../models/ShareholderCount';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

/** 因子查询窗口（自然日）— 200 天 ≈ 2 个季度披露周期 + 公告滞后 buffer */
export const LOOKBACK_DAYS = 200;

/** 至少要有 N 期 holder_count 观测才能算环比变化（必须 ≥ 2） */
export const MIN_OBSERVATIONS_TOTAL = 2;

/**
 * 是否过滤最新一期 share_change != 0 的行（送转股 / 增发后 holder_count 自然增
 * 加，环比变化无业务意义）。默认 true。
 *
 * 设 false 可让因子覆盖更多股票，但代价是噪音变大 — 实证默认开启过滤。
 */
export const EXCLUDE_SHARE_CHANGE_PERIODS = true;

/**
 * 单只股票多期 holder_count 观测的"最新 vs 上一期"环比变化 helper（抽成纯函数
 * 便于测试）.
 *
 * @param observations  该股票在 [as_of - LOOKBACK_DAYS, as_of] 内的全部
 *                      (report_date, holder_count, share_change) 记录
 *                      （report_date 字符串 ISO YYYY-MM-DD）
 * @param asOfDate      截面日期 (YYYY-MM-DD)
 * @returns             计算出的 -(latest - prev) / prev；任一前置条件不满足 → null
 */
export interface ShareholderObservation {
  report_date: string;
  holder_count: number | null | undefined;
  share_change?: number | null | undefined;
}

export interface ConcentrationBreakdown {
  latest_count: number;
  prev_count: number;
  raw_change_pct: number;
  raw_value: number;
  latest_report_date: string;
  prev_report_date: string;
}

export function computeConcentrationChange(
  observations: ShareholderObservation[],
  asOfDate: string,
  excludeShareChangePeriods: boolean = EXCLUDE_SHARE_CHANGE_PERIODS
): ConcentrationBreakdown | null {
  if (!observations || !observations.length || !asOfDate) return null;

  // 1) 过滤无效行 + lookahead bias guard
  const valid: Array<{ report_date: string; holder_count: number; share_change: number | null }> =
    [];
  for (const obs of observations) {
    if (!obs.report_date) continue;
    if (obs.report_date > asOfDate) continue; // lookahead bias guard (US-030 范式)

    if (obs.holder_count === null || obs.holder_count === undefined) continue;
    // `Number(null) === 0` JS 大坑 (US-031): nullable 字段必须先 null 检查再 Number 转换
    const hc = Number(obs.holder_count);
    if (!isFiniteNumber(hc)) continue;
    if (hc <= 0) continue; // holder_count 必须 > 0

    const sc =
      obs.share_change === null || obs.share_change === undefined ? null : Number(obs.share_change);

    valid.push({
      report_date: obs.report_date,
      holder_count: hc,
      share_change: sc !== null && isFiniteNumber(sc) ? sc : null,
    });
  }

  if (valid.length < MIN_OBSERVATIONS_TOTAL) return null;

  // 2) 按 report_date 升序排序，便于取"最新 vs 上一期"
  valid.sort((a, b) => a.report_date.localeCompare(b.report_date));

  const latest = valid[valid.length - 1];
  const prev = valid[valid.length - 2];

  // 3) 最新一期若发生股本变动 → 跳过（送转股 / 增发让 holder_count 自然增加）
  if (excludeShareChangePeriods && latest.share_change !== null && latest.share_change !== 0) {
    return null;
  }

  // 4) 分母 guard（holder_count_prev > 0 上面已保证；这里 paranoid 再 check）
  if (prev.holder_count <= 0) return null;

  // 5) 环比变化率
  const rawChangePct = (latest.holder_count - prev.holder_count) / prev.holder_count;
  if (!isFiniteNumber(rawChangePct)) return null;

  // 6) 取负 — 集中 (count↓) = 正分；分散 (count↑) = 负分
  const rawValue = -rawChangePct;

  return {
    latest_count: latest.holder_count,
    prev_count: prev.holder_count,
    raw_change_pct: rawChangePct,
    raw_value: rawValue,
    latest_report_date: latest.report_date,
    prev_report_date: prev.report_date,
  };
}

export const shareholderConcentrationFactor: Factor = {
  name: 'shareholder_concentration',
  description:
    '最新一期股东户数环比变化（负值 = 户数下降 = 筹码集中 = 正分；正值 = 户数上升 = 筹码分散 = 负分）',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 拉窗口内的 ShareholderCount（按 stock_code IN 过滤 universe）
    const startDate = lookbackStartDate(ctx.as_of_date, LOOKBACK_DAYS);
    const rows = (await ShareholderCount.findAll({
      attributes: ['stock_code', 'report_date', 'holder_count', 'share_change'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        report_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      holder_count: any;
      share_change: any;
    }>;

    // 按 stock_code 分组
    const byStock = new Map<string, ShareholderObservation[]>();
    for (const r of rows) {
      const arr = byStock.get(r.stock_code) ?? [];
      const hc =
        r.holder_count === null || r.holder_count === undefined ? null : Number(r.holder_count);
      const sc =
        r.share_change === null || r.share_change === undefined ? null : Number(r.share_change);
      arr.push({
        report_date: r.report_date,
        holder_count: isFiniteNumber(hc as number) ? (hc as number) : null,
        share_change: sc !== null && isFiniteNumber(sc) ? sc : null,
      });
      byStock.set(r.stock_code, arr);
    }

    // per-stock 计算环比变化
    for (const [code, observations] of byStock.entries()) {
      const result = computeConcentrationChange(observations, ctx.as_of_date);
      if (result === null) continue;
      out.set(code, result.raw_value);
    }

    return out;
  },
};

factorRegistry.register(shareholderConcentrationFactor);
