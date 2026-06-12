/**
 * PortfolioCorrelationService — Phase 6 持仓相关性热力图
 *
 * 输入：用户的当前持仓 (N 只) + 60 日 daily close
 * 输出：N×N Pearson 相关系数矩阵 + 高相关 cluster (>0.7) 警告
 *
 * 用途：
 *   - 用户在 PortfolioWorkspace 看一眼就知道"持仓是否过度集中在同 beta"
 *   - 若 5 只持仓有 4 只彼此 corr > 0.7，组合实际等于 1 只 + 一些噪音，
 *     极易在系统性 risk-off 一起暴跌（A 股 2018/2024 跌停潮典型场景）
 *
 * 设计:
 *   - 纯函数 helpers 全 export 让单测脱 DB (computePearsonCorr / buildMatrix /
 *     findHighCorrelationClusters)
 *   - DataSource 接口注入 (生产 Sequelize / 测试 fake)
 *   - 缺数据保守降级: 单只 < 30 日有效数据 → 排除该股；矩阵剩 < 2 只 → 返 null
 */

import { Op } from 'sequelize';
import { DailyBar } from '../models/DailyBar';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';

// ============================================================
// Types
// ============================================================

export interface CorrelationContext {
  /** 持仓股 [stock_code, name, market_value, industry?] */
  positions: Array<{
    stock_code: string;
    name: string;
    market_value: number;
    industry?: string | null;
  }>;
  /** 每只股的 daily close 数组（按 trade_date 升序，最后一个=最新）；长度可能不一 */
  closes: Map<string, number[]>;
}

export interface CorrelationMatrix {
  /** 行/列对应的 stock_codes (与 positions 顺序一致) */
  symbols: string[];
  /** N×N 相关系数 (range [-1, 1]); null 表数据不足无法计算 */
  matrix: Array<Array<number | null>>;
}

export interface CorrelationCluster {
  /** 该 cluster 包含的 stock_codes */
  members: string[];
  /** cluster 平均相关性 */
  avg_correlation: number;
  /** cluster 总市值 */
  total_market_value: number;
  /** cluster 占持仓总市值的百分比 (0-100) */
  pct_of_portfolio: number;
  /** 主导行业 (如果 cluster 内 > 50% 共享一个 industry) */
  dominant_industry?: string;
}

export interface PortfolioCorrelationReport {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  position_count: number;
  insufficient_data_symbols: string[];
  lookback_days: number;
  matrix: CorrelationMatrix;
  /** 高相关 cluster (corr > threshold) 警告 */
  high_correlation_clusters: CorrelationCluster[];
  /** 整体平均相关性 (排除对角线) */
  avg_off_diagonal_correlation: number | null;
  /** 警告级别：high (avg>0.5) / medium (avg>0.3) / low */
  diversification_level: 'high' | 'medium' | 'low' | 'insufficient';
}

// ============================================================
// 纯函数 (export 让单测脱 DB)
// ============================================================

/**
 * 计算两个等长数列的 Pearson 相关系数。
 *
 * 返回 null 当：
 *   - 数列长度 < MIN_OBSERVATIONS (默认 30)
 *   - 任一数列方差为 0 (全相等 → 相关无意义)
 *
 * 公式: r = Σ((x_i - mean_x)(y_i - mean_y)) / sqrt(Σ(x-mean_x)² × Σ(y-mean_y)²)
 */
export const MIN_OBSERVATIONS = 30;

export function computePearsonCorr(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < MIN_OBSERVATIONS) return null;
  // 过滤掉 NaN 对（任一为 NaN 整对剔除）
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      pairs.push([x[i], y[i]]);
    }
  }
  if (pairs.length < MIN_OBSERVATIONS) return null;

  const n = pairs.length;
  const sumX = pairs.reduce((s, [a]) => s + a, 0);
  const sumY = pairs.reduce((s, [_, b]) => s + b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const [a, b] of pairs) {
    const dx = a - meanX;
    const dy = b - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  if (denX <= 1e-12 || denY <= 1e-12) return null; // 全相等
  const denom = Math.sqrt(denX * denY);
  if (denom <= 1e-12) return null;
  return num / denom;
}

/**
 * 把 close 价格序列转成 daily returns 序列（pct change）。
 * 长度 = close.length - 1。
 * 第一天 NaN 因为没前一天对比。
 */
export function closeToDailyReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(curr)) {
      returns.push(NaN);
    } else {
      returns.push((curr - prev) / prev);
    }
  }
  return returns;
}

/**
 * 把 closes Map 对齐到等长序列（取最短长度，从后往前对齐 = 用最新 N 天）。
 * 返回 Map<stock_code, returns[]>。
 */
export function alignReturns(closesMap: Map<string, number[]>): Map<string, number[]> {
  const returnsMap = new Map<string, number[]>();
  for (const [code, closes] of closesMap) {
    returnsMap.set(code, closeToDailyReturns(closes));
  }
  // 取最短长度对齐 (使用尾部最近 K 天)
  let minLen = Infinity;
  for (const r of returnsMap.values()) {
    if (r.length < minLen) minLen = r.length;
  }
  if (!Number.isFinite(minLen) || minLen <= 0) return new Map();
  const aligned = new Map<string, number[]>();
  for (const [code, r] of returnsMap) {
    aligned.set(code, r.slice(-minLen));
  }
  return aligned;
}

/**
 * 构造 N×N 相关系数矩阵。
 *
 * 输入：symbols 顺序数组 + returnsMap
 * 输出：matrix[i][j] = corr(symbols[i], symbols[j])，i=j 时 1
 *
 * 缺数据 (任一 returns 太短 / 全 NaN) → 该 cell null
 */
export function buildMatrix(
  symbols: string[],
  returnsMap: Map<string, number[]>
): Array<Array<number | null>> {
  const N = symbols.length;
  const matrix: Array<Array<number | null>> = [];
  for (let i = 0; i < N; i++) {
    const row: Array<number | null> = [];
    for (let j = 0; j < N; j++) {
      if (i === j) {
        row.push(1);
        continue;
      }
      const x = returnsMap.get(symbols[i]) || [];
      const y = returnsMap.get(symbols[j]) || [];
      row.push(computePearsonCorr(x, y));
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * 找高相关 cluster (使用简单 transitive 聚类: 若 A-B > thr 且 B-C > thr 则 A-B-C 同 cluster)。
 *
 * 用 union-find 实现。返回的 cluster 都 ≥ 2 只持仓。
 */
export function findHighCorrelationClusters(
  symbols: string[],
  matrix: Array<Array<number | null>>,
  threshold: number,
  positionMVMap: Map<string, number>, // stock_code → market_value
  industryMap?: Map<string, string | null>
): CorrelationCluster[] {
  const N = symbols.length;
  if (N < 2) return [];

  // Union-Find
  const parent = new Array(N).fill(0).map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  // Pair-wise: 若 corr > threshold 则 union
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const c = matrix[i][j];
      if (c !== null && c > threshold) {
        union(i, j);
      }
    }
  }

  // 分组到 root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }

  const totalMV = symbols.reduce((s, code) => s + (positionMVMap.get(code) || 0), 0);
  const clusters: CorrelationCluster[] = [];
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const members = indices.map(i => symbols[i]);
    // 算 cluster 平均相关性 (pair-wise avg, 排除对角)
    let pairCount = 0;
    let pairSum = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const c = matrix[indices[a]][indices[b]];
        if (c !== null) {
          pairSum += c;
          pairCount++;
        }
      }
    }
    const avgCorr = pairCount > 0 ? pairSum / pairCount : 0;
    const clusterMV = members.reduce((s, code) => s + (positionMVMap.get(code) || 0), 0);
    const pct = totalMV > 0 ? (clusterMV / totalMV) * 100 : 0;
    // 主导行业 (> 50%)
    let dominantIndustry: string | undefined;
    if (industryMap) {
      const industryCount = new Map<string, number>();
      for (const code of members) {
        const ind = industryMap.get(code) || null;
        if (ind) industryCount.set(ind, (industryCount.get(ind) || 0) + 1);
      }
      for (const [ind, cnt] of industryCount) {
        if (cnt > members.length / 2) {
          dominantIndustry = ind;
          break;
        }
      }
    }
    clusters.push({
      members: members.sort(),
      avg_correlation: Math.round(avgCorr * 1000) / 1000,
      total_market_value: clusterMV,
      pct_of_portfolio: Math.round(pct * 10) / 10,
      dominant_industry: dominantIndustry,
    });
  }
  // 按 cluster 大小降序，市值占比降序
  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return b.pct_of_portfolio - a.pct_of_portfolio;
  });
  return clusters;
}

/**
 * 算整体平均 off-diagonal correlation (排除对角线 + null cell)。
 * 用于判定 diversification_level。
 */
export function avgOffDiagonalCorrelation(matrix: Array<Array<number | null>>): number | null {
  const N = matrix.length;
  if (N < 2) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const c = matrix[i][j];
      if (c !== null) {
        sum += c;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : null;
}

// ============================================================
// DataSource 注入 (生产 Sequelize / 测试 fake)
// ============================================================

export interface PortfolioCorrelationDataSource {
  loadPortfolioHeader(portfolio_id: number): Promise<{ user_id: number } | null>;
  loadPositionsWithMV(portfolio_id: number): Promise<
    Array<{ stock_code: string; name: string; market_value: number; industry?: string | null }>
  >;
  loadClosesSeries(
    stock_codes: string[],
    asOfDate: Date,
    lookbackDays: number
  ): Promise<Map<string, number[]>>;
}

export const PRODUCTION_PORTFOLIO_CORRELATION_DATA_SOURCE: PortfolioCorrelationDataSource = {
  async loadPortfolioHeader(portfolio_id) {
    const p = await PaperTradingPortfolio.findByPk(portfolio_id, { attributes: ['user_id'] });
    return p ? { user_id: p.user_id } : null;
  },
  async loadPositionsWithMV(portfolio_id) {
    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id, quantity: { [Op.gt]: 0 } },
    });
    const codes = positions.map(p => p.symbol);
    const stocks = codes.length
      ? await Stock.findAll({ where: { symbol: { [Op.in]: codes } }, attributes: ['symbol', 'industry'] })
      : [];
    const indMap = new Map(stocks.map(s => [s.symbol, s.industry || null]));
    return positions.map(p => ({
      stock_code: p.symbol,
      name: p.name,
      market_value: Number(p.market_value || 0),
      industry: indMap.get(p.symbol) || null,
    }));
  },
  async loadClosesSeries(stock_codes, asOfDate, lookbackDays) {
    if (stock_codes.length === 0) return new Map();
    // DailyBar 用 stock_id 索引, 不用 symbol —— 先 Stock 找 id 反查
    const stocks = await Stock.findAll({
      where: { symbol: { [Op.in]: stock_codes } },
      attributes: ['id', 'symbol'],
    });
    const symbolToId = new Map(stocks.map(s => [s.symbol, s.id]));
    const idToSymbol = new Map(stocks.map(s => [s.id, s.symbol]));
    const map = new Map<string, number[]>();
    for (const code of stock_codes) map.set(code, []);
    if (stocks.length === 0) return map;

    const start = new Date(asOfDate);
    start.setDate(start.getDate() - Math.max(60, lookbackDays * 2));
    const rows = await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: Array.from(symbolToId.values()) },
        time: {
          [Op.gte]: start,
          [Op.lte]: asOfDate,
        },
      },
      attributes: ['stock_id', 'time', 'close'],
      order: [['time', 'ASC']],
    });
    for (const r of rows) {
      const sym = idToSymbol.get(r.stock_id);
      if (sym) {
        const arr = map.get(sym);
        if (arr) arr.push(Number(r.close));
      }
    }
    return map;
  },
};

// ============================================================
// Service
// ============================================================

export class PortfolioCorrelationService {
  constructor(private dataSource: PortfolioCorrelationDataSource = PRODUCTION_PORTFOLIO_CORRELATION_DATA_SOURCE) {}

  /**
   * 计算某 portfolio 的相关性报告。
   *
   * @param portfolio_id 目标 portfolio
   * @param options.lookback_days 回看天数（默认 60）
   * @param options.cluster_threshold cluster 判定阈值（默认 0.7）
   * @param options.as_of 截止日期（默认今日）
   */
  async getReport(
    portfolio_id: number,
    options: { lookback_days?: number; cluster_threshold?: number; as_of?: Date } = {}
  ): Promise<PortfolioCorrelationReport | null> {
    const lookback = Math.max(30, Math.min(252, options.lookback_days || 60));
    const threshold = Math.max(0.1, Math.min(0.99, options.cluster_threshold || 0.7));
    const asOf = options.as_of || new Date();

    const header = await this.dataSource.loadPortfolioHeader(portfolio_id);
    if (!header) return null;

    const positions = await this.dataSource.loadPositionsWithMV(portfolio_id);
    if (positions.length < 2) {
      // 单股或空 portfolio — 没有"相关性"概念
      return {
        generated_at: new Date().toISOString(),
        portfolio_id,
        user_id: header.user_id,
        position_count: positions.length,
        insufficient_data_symbols: [],
        lookback_days: lookback,
        matrix: { symbols: positions.map(p => p.stock_code), matrix: [[1]] },
        high_correlation_clusters: [],
        avg_off_diagonal_correlation: null,
        diversification_level: 'insufficient',
      };
    }

    const codes = positions.map(p => p.stock_code);
    let closesMap: Map<string, number[]>;
    try {
      closesMap = await this.dataSource.loadClosesSeries(codes, asOf, lookback);
    } catch (err: any) {
      logger.warn(`[PortfolioCorrelation] loadClosesSeries failed: ${err?.message || err}`);
      closesMap = new Map();
    }

    // 过滤掉数据不足的股票 (< MIN_OBSERVATIONS + 1 close → returns < MIN)
    const insufficientSymbols: string[] = [];
    const validCodes: string[] = [];
    for (const code of codes) {
      const arr = closesMap.get(code) || [];
      if (arr.length < MIN_OBSERVATIONS + 1) {
        insufficientSymbols.push(code);
      } else {
        validCodes.push(code);
      }
    }

    if (validCodes.length < 2) {
      return {
        generated_at: new Date().toISOString(),
        portfolio_id,
        user_id: header.user_id,
        position_count: positions.length,
        insufficient_data_symbols: insufficientSymbols,
        lookback_days: lookback,
        matrix: { symbols: validCodes, matrix: validCodes.map((_, i) => validCodes.map((__, j) => (i === j ? 1 : null))) },
        high_correlation_clusters: [],
        avg_off_diagonal_correlation: null,
        diversification_level: 'insufficient',
      };
    }

    // 对齐 + 建矩阵
    const returnsMap = alignReturns(new Map(validCodes.map(c => [c, closesMap.get(c)!])));
    const matrix = buildMatrix(validCodes, returnsMap);

    // cluster 检测
    const mvMap = new Map(positions.map(p => [p.stock_code, p.market_value]));
    const indMap = new Map(positions.map(p => [p.stock_code, p.industry || null]));
    const clusters = findHighCorrelationClusters(validCodes, matrix, threshold, mvMap, indMap);

    const avgCorr = avgOffDiagonalCorrelation(matrix);
    let level: PortfolioCorrelationReport['diversification_level'];
    if (avgCorr === null) level = 'insufficient';
    else if (avgCorr > 0.5) level = 'low'; // diversification 低
    else if (avgCorr > 0.3) level = 'medium';
    else level = 'high';

    return {
      generated_at: new Date().toISOString(),
      portfolio_id,
      user_id: header.user_id,
      position_count: positions.length,
      insufficient_data_symbols: insufficientSymbols,
      lookback_days: lookback,
      matrix: { symbols: validCodes, matrix },
      high_correlation_clusters: clusters,
      avg_off_diagonal_correlation: avgCorr !== null ? Math.round(avgCorr * 1000) / 1000 : null,
      diversification_level: level,
    };
  }
}

export const portfolioCorrelationService = new PortfolioCorrelationService();
