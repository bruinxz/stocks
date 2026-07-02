/**
 * ETFConstituentExpander (ETF → 成分股展开) — 信号优先重构 批5-b, §4.1
 *
 * 把一只 ETF 展开成 { 成分股 code → 权重 } 的 point-in-time 快照:
 *   1. 主路径: ETF 有高置信跟踪指数映射 (etfIndexMap) → 查 index_components
 *      取 <= factor_date 的最新一期成分 + weight.
 *   2. Fallback: 无映射 or index_components 空 → 查 fund_top_holdings 前十大重仓
 *      (按 fund_code = ETF 6 位代码), 用 ratio_pct 作权重. 覆盖 60-80% 权重,
 *      §4.1 明确"已足够代表".
 *   3. 两条都空 → 返回空 Map, 调用方据此把该 ETF 当月剔除 (data_incomplete).
 *
 * 权重口径: 返回的是**归一化前的原始权重** (index weight 或 ratio_pct),
 * ETF 层聚合时用 Σ(w_i × raw_i) / Σ(w_i), 所以是否归一不影响结果.
 *
 * 只读不写. code 一律纯 6 位 (与 index_components / fund_top_holdings 口径一致).
 */

import { Op } from 'sequelize';
import { IndexComponent } from '../../models/IndexComponent';
import { FundTopHolding } from '../../models/FundTopHolding';
import { getTrackedIndexCode } from './etfIndexMap';

export type ConstituentSource = 'index_components' | 'fund_top_holdings' | 'none';

export interface ETFConstituents {
  /** ETF 6 位代码 */
  etf_code: string;
  /** 成分股 code(纯 6 位) → 原始权重 (index weight 或 ratio_pct) */
  weights: Map<string, number>;
  /** 数据来源 (供审计 / 覆盖率诊断) */
  source: ConstituentSource;
  /** 快照对应的日期 (index_components.trade_date 或 fund_top_holdings.report_date) */
  as_of?: string;
}

/**
 * 展开数据源接口 —— 注入便于单测 mock (镜像 MultiFactorAlphaDataSource 模式)。
 */
export interface ETFConstituentDataSource {
  /** 取 index_components 中 index_code 在 <= date 的最新一期成分 (code→weight, as_of) */
  loadIndexComponents(
    indexCode: string,
    asOfDate: string
  ): Promise<{ weights: Map<string, number>; as_of: string } | null>;
  /** 取 fund_top_holdings 中 fund_code 在 <= date 的最新一期前十大 (code→ratio_pct, as_of) */
  loadTopHoldings(
    fundCode: string,
    asOfDate: string
  ): Promise<{ weights: Map<string, number>; as_of: string } | null>;
}

export class DefaultETFConstituentDataSource implements ETFConstituentDataSource {
  async loadIndexComponents(
    indexCode: string,
    asOfDate: string
  ): Promise<{ weights: Map<string, number>; as_of: string } | null> {
    // 取 <= asOfDate 的最新一期 trade_date
    const latest = (await IndexComponent.findOne({
      attributes: ['trade_date'],
      where: { index_code: indexCode, trade_date: { [Op.lte]: asOfDate } },
      order: [['trade_date', 'DESC']],
      raw: true,
    })) as unknown as { trade_date: string } | null;
    if (!latest?.trade_date) return null;

    const rows = (await IndexComponent.findAll({
      attributes: ['stock_code', 'weight'],
      where: { index_code: indexCode, trade_date: latest.trade_date },
      raw: true,
    })) as unknown as Array<{ stock_code: string; weight: any }>;
    if (!rows.length) return null;

    const weights = new Map<string, number>();
    for (const r of rows) {
      const code = String(r.stock_code || '').trim();
      if (!code) continue;
      const w = Number(r.weight);
      // 权重缺失 → 等权兜底 (至少保留成分身份, 不因单条缺权重丢整只 ETF)
      weights.set(code, Number.isFinite(w) && w > 0 ? w : 1);
    }
    return weights.size ? { weights, as_of: latest.trade_date } : null;
  }

  async loadTopHoldings(
    fundCode: string,
    asOfDate: string
  ): Promise<{ weights: Map<string, number>; as_of: string } | null> {
    const latest = (await FundTopHolding.findOne({
      attributes: ['report_date'],
      where: { fund_code: fundCode, report_date: { [Op.lte]: asOfDate } },
      order: [['report_date', 'DESC']],
      raw: true,
    })) as unknown as { report_date: string } | null;
    if (!latest?.report_date) return null;

    const rows = (await FundTopHolding.findAll({
      attributes: ['stock_code', 'ratio_pct'],
      where: { fund_code: fundCode, report_date: latest.report_date },
      raw: true,
    })) as unknown as Array<{ stock_code: string; ratio_pct: any }>;
    if (!rows.length) return null;

    const weights = new Map<string, number>();
    for (const r of rows) {
      const code = String(r.stock_code || '').trim();
      if (!code) continue;
      const w = Number(r.ratio_pct);
      weights.set(code, Number.isFinite(w) && w > 0 ? w : 1);
    }
    return weights.size ? { weights, as_of: latest.report_date } : null;
  }
}

const PRODUCTION_DATA_SOURCE: ETFConstituentDataSource = new DefaultETFConstituentDataSource();

export class ETFConstituentExpander {
  private readonly dataSource: ETFConstituentDataSource;

  constructor(dataSource: ETFConstituentDataSource = PRODUCTION_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 展开单只 ETF 为成分股权重快照 (point-in-time).
   * @param etfCode ETF 6 位代码
   * @param asOfDate 月末快照日 (YYYY-MM-DD)
   */
  async expand(etfCode: string, asOfDate: string): Promise<ETFConstituents> {
    // 主路径: 高置信跟踪指数 → index_components
    const indexCode = getTrackedIndexCode(etfCode);
    if (indexCode) {
      const idx = await this.dataSource.loadIndexComponents(indexCode, asOfDate);
      if (idx) {
        return { etf_code: etfCode, weights: idx.weights, source: 'index_components', as_of: idx.as_of };
      }
    }
    // Fallback: fund_top_holdings 前十大重仓
    const top = await this.dataSource.loadTopHoldings(etfCode, asOfDate);
    if (top) {
      return { etf_code: etfCode, weights: top.weights, source: 'fund_top_holdings', as_of: top.as_of };
    }
    // 两条都空 → data_incomplete
    return { etf_code: etfCode, weights: new Map(), source: 'none' };
  }

  /** 批量展开多只 ETF (顺序执行, 避免瞬时打爆 DB 连接池). */
  async expandMany(etfCodes: string[], asOfDate: string): Promise<Map<string, ETFConstituents>> {
    const out = new Map<string, ETFConstituents>();
    for (const code of etfCodes) {
      out.set(code, await this.expand(code, asOfDate));
    }
    return out;
  }
}

export const etfConstituentExpander = new ETFConstituentExpander();
