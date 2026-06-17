import { Op } from 'sequelize';
import { AIInvestmentSignal } from '../../models/AIInvestmentSignal';
import { DailyBar } from '../../models/DailyBar';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { Stock } from '../../models/Stock';
import { PAPER_PORTFOLIO_FAMILIES } from './PaperTradingPortfolioFamilies';
import { logger } from '../../utils/logger';
import { normalizeSymbol } from '../../utils/stockSymbol';

const DEFAULT_LIMITS = {
  min_cash_reserve_pct: 8,
  max_portfolio_drawdown_pct: 12,
  max_total_exposure_pct: 60,
  max_industry_exposure_pct: 25,
  max_position_correlation: 0.82,
  max_portfolio_var_pct: 10,
  max_single_stock_volatility_pct: 7,
};

interface PositionRiskItem {
  symbol: string;
  name?: string;
  industry: string;
  market_value: number;
  exposure_pct: number;
  volatility_20d_pct: number;
  max_correlation: number;
  strategy_keys: string[];
  risk_flags: string[];
}

interface RiskProfileOptions {
  user_id: number;
  portfolio_name?: string;
  /** 显式 portfolio_id (优先于 portfolio_name); 多账户多盘场景必传 (2026-06-17 串盘修) */
  portfolio_id?: number;
  include_family?: boolean | string;
  min_cash_reserve_pct?: number;
  max_portfolio_drawdown_pct?: number;
  max_total_exposure_pct?: number;
  max_industry_exposure_pct?: number;
  max_position_correlation?: number;
  max_portfolio_var_pct?: number;
  max_single_stock_volatility_pct?: number;
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function paperTradingMetaForPortfolio(metadata: Record<string, any>, portfolio_id?: number) {
  const legacy = asPlainObject(metadata.paper_trading);
  const byPortfolio = asPlainObject(metadata.paper_trading_by_portfolio);
  const keyed = portfolio_id ? asPlainObject(byPortfolio[String(portfolio_id)]) : {};
  return Object.keys(keyed).length > 0 ? keyed : legacy;
}

function executedSignalWhereForPortfolio(portfolio_id: number) {
  const keyedPortfolioId = String(portfolio_id);
  return [
    {
      metadata: {
        [Op.contains]: {
          paper_trading: {
            portfolio_id,
            status: 'executed',
          },
        },
      },
    },
    {
      metadata: {
        [Op.contains]: {
          paper_trading_by_portfolio: {
            [keyedPortfolioId]: {
              portfolio_id,
              status: 'executed',
            },
          },
        },
      },
    },
  ];
}

function executedSignalWhereForPortfolios(portfolio_ids: number[]) {
  return {
    [Op.or]: portfolio_ids.flatMap(portfolio_id => executedSignalWhereForPortfolio(portfolio_id)),
  } as any;
}

function calculateReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index++) {
    const prev = closes[index - 1];
    const curr = closes[index];
    if (prev > 0 && curr > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

function calculateVolatilityPct(returns: number[]): number {
  if (returns.length < 5) return 0;
  const avg = returns.reduce((sum, item) => sum + item, 0) / returns.length;
  const variance =
    returns.reduce((sum, item) => sum + (item - avg) ** 2, 0) / Math.max(1, returns.length - 1);
  return roundNumber(Math.sqrt(variance) * 100, 2);
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length < 5) return 0;
  const ax = a.slice(-length);
  const bx = b.slice(-length);
  const avgA = ax.reduce((sum, value) => sum + value, 0) / length;
  const avgB = bx.reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let index = 0; index < length; index++) {
    const da = ax[index] - avgA;
    const db = bx[index] - avgB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denominator = Math.sqrt(denomA * denomB);
  if (!denominator) return 0;
  return roundNumber(numerator / denominator, 4);
}

function strategyKeysFromSignalMetadata(
  metadata: Record<string, any>,
  portfolio_id?: number
): string[] {
  const strategyVariant = asPlainObject(metadata.strategy_variant);
  const paperTrading = paperTradingMetaForPortfolio(metadata, portfolio_id);
  const paperVariant = asPlainObject(paperTrading.strategy_variant);
  const keys = [
    metadata.strategy_key,
    strategyVariant.strategy_key,
    paperTrading.strategy_key,
    paperVariant.strategy_key,
    ...(Array.isArray(strategyVariant.strategy_keys) ? strategyVariant.strategy_keys : []),
    ...(Array.isArray(paperVariant.strategy_keys) ? paperVariant.strategy_keys : []),
    ...(Array.isArray(metadata.consensus_variants) ? metadata.consensus_variants : []),
  ]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(keys.length ? keys : ['unknown'])];
}

export class PaperTradingRiskProfileService {
  async getRiskProfile(options: RiskProfileOptions) {
    const limits = {
      min_cash_reserve_pct: clamp(
        toNumber(options.min_cash_reserve_pct, DEFAULT_LIMITS.min_cash_reserve_pct),
        0,
        80
      ),
      max_portfolio_drawdown_pct: clamp(
        toNumber(options.max_portfolio_drawdown_pct, DEFAULT_LIMITS.max_portfolio_drawdown_pct),
        1,
        80
      ),
      max_total_exposure_pct: clamp(
        toNumber(options.max_total_exposure_pct, DEFAULT_LIMITS.max_total_exposure_pct),
        1,
        100
      ),
      max_industry_exposure_pct: clamp(
        toNumber(options.max_industry_exposure_pct, DEFAULT_LIMITS.max_industry_exposure_pct),
        1,
        100
      ),
      max_position_correlation: clamp(
        toNumber(options.max_position_correlation, DEFAULT_LIMITS.max_position_correlation),
        0.1,
        0.99
      ),
      max_portfolio_var_pct: clamp(
        toNumber(options.max_portfolio_var_pct, DEFAULT_LIMITS.max_portfolio_var_pct),
        1,
        50
      ),
      max_single_stock_volatility_pct: clamp(
        toNumber(
          options.max_single_stock_volatility_pct,
          DEFAULT_LIMITS.max_single_stock_volatility_pct
        ),
        1,
        30
      ),
    };

    const includeFamily =
      options.include_family === true ||
      String(options.include_family || '').toLowerCase() === 'true';
    if (includeFamily && !options.portfolio_name) {
      return this.getFamilyRiskProfile({ ...options, include_family: false }, limits);
    }

    // 修复 (2026-06-17 串盘续): 优先 portfolio_id 精确匹配, 缺则 portfolio_name, 都缺时
    // 走 user_id active id ASC 第一个 fallback.
    const portfolioWhere: Record<string, any> = { user_id: options.user_id };
    if (options.portfolio_id) portfolioWhere.id = options.portfolio_id;
    else if (options.portfolio_name) portfolioWhere.name = options.portfolio_name;

    const portfolio = await PaperTradingPortfolio.findOne({
      where: portfolioWhere,
      order: [['id', 'ASC']],
    });
    if (!portfolio) {
      return this.buildEmptyProfile(limits);
    }

    const positions = await PaperTradingPosition.findAll({ where: { portfolio_id: portfolio.id } });
    const totalValue = Math.max(toNumber(portfolio.total_value, 0), 1);
    const currentCash = toNumber(portfolio.current_cash, 0);
    const initialCapital = toNumber(portfolio.initial_capital, 0);
    const positionValue = positions.reduce(
      (sum, position) => sum + toNumber(position.market_value, 0),
      0
    );
    const cashPct = roundNumber((currentCash / totalValue) * 100, 2);
    const exposurePct = roundNumber((positionValue / totalValue) * 100, 2);

    const snapshots = await PaperTradingSnapshot.findAll({
      where: {
        portfolio_id: portfolio.id,
        date: {
          [Op.gte]: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        },
      },
      order: [['date', 'ASC']],
      raw: true,
    });
    const peakTotalValue = Math.max(
      totalValue,
      ...snapshots.map(snapshot => toNumber((snapshot as any).total_value, 0))
    );
    const drawdownPct =
      peakTotalValue > 0
        ? roundNumber(((totalValue - peakTotalValue) / peakTotalValue) * 100, 2)
        : 0;

    const symbols = [
      ...new Set(positions.map(position => normalizeSymbol(position.symbol))),
    ].filter(Boolean);

    const [stocks, executedSignals] = await Promise.all([
      symbols.length
        ? Stock.findAll({ where: { symbol: { [Op.in]: symbols } }, raw: true })
        : Promise.resolve([]),
      AIInvestmentSignal.findAll({
        where: executedSignalWhereForPortfolios([portfolio.id]),
        order: [['updated_at', 'DESC']],
        limit: 2000,
      }).catch(error => {
        logger.warn(`读取模拟盘信号策略来源失败: ${error?.message || error}`);
        return [] as AIInvestmentSignal[];
      }),
    ]);

    const stockMap = new Map<string, any>(
      (stocks as any[]).map(stock => [normalizeSymbol(stock.symbol), stock])
    );
    const signalMetadataBySymbol = new Map<string, Record<string, any>>();
    for (const signal of executedSignals) {
      const symbol = normalizeSymbol(signal.symbol);
      if (!symbol || signalMetadataBySymbol.has(symbol)) continue;
      signalMetadataBySymbol.set(symbol, asPlainObject(signal.metadata));
    }

    const returnSeriesBySymbol = await this.loadReturnSeries(symbols);
    const maxCorrelationBySymbol = new Map<string, number>();
    let maxPairCorrelation = 0;
    for (let left = 0; left < symbols.length; left++) {
      for (let right = left + 1; right < symbols.length; right++) {
        const leftSymbol = symbols[left];
        const rightSymbol = symbols[right];
        const correlation = pearsonCorrelation(
          returnSeriesBySymbol.get(leftSymbol) || [],
          returnSeriesBySymbol.get(rightSymbol) || []
        );
        const absCorrelation = Math.abs(correlation);
        maxPairCorrelation = Math.max(maxPairCorrelation, absCorrelation);
        maxCorrelationBySymbol.set(
          leftSymbol,
          Math.max(toNumber(maxCorrelationBySymbol.get(leftSymbol), 0), absCorrelation)
        );
        maxCorrelationBySymbol.set(
          rightSymbol,
          Math.max(toNumber(maxCorrelationBySymbol.get(rightSymbol), 0), absCorrelation)
        );
      }
    }

    const industryExposure = new Map<string, { market_value: number; count: number }>();
    const strategyExposure = new Map<string, { market_value: number; count: number }>();
    const positionRisks: PositionRiskItem[] = [];

    for (const position of positions) {
      const symbol = normalizeSymbol(position.symbol);
      const stock = stockMap.get(symbol);
      const industry = stock?.industry || '未分类';
      const marketValue = toNumber(position.market_value, 0);
      const exposure = totalValue > 0 ? (marketValue / totalValue) * 100 : 0;
      const returns = returnSeriesBySymbol.get(symbol) || [];
      const volatility20dPct = calculateVolatilityPct(returns.slice(-20));
      const maxCorrelation = roundNumber(toNumber(maxCorrelationBySymbol.get(symbol), 0), 4);
      const signalMetadata = signalMetadataBySymbol.get(symbol) || {};
      const strategyKeys = strategyKeysFromSignalMetadata(signalMetadata, portfolio.id);
      const riskFlags: string[] = [];
      if (volatility20dPct > limits.max_single_stock_volatility_pct) {
        riskFlags.push(`波动 ${volatility20dPct}% 高于阈值`);
      }
      if (maxCorrelation > limits.max_position_correlation) {
        riskFlags.push(`相关性 ${roundNumber(maxCorrelation * 100, 1)}% 偏高`);
      }
      if (exposure > 15) riskFlags.push(`单票暴露 ${roundNumber(exposure, 1)}% 偏高`);

      const currentIndustry = industryExposure.get(industry) || { market_value: 0, count: 0 };
      industryExposure.set(industry, {
        market_value: currentIndustry.market_value + marketValue,
        count: currentIndustry.count + 1,
      });

      for (const strategyKey of strategyKeys) {
        const currentStrategy = strategyExposure.get(strategyKey) || { market_value: 0, count: 0 };
        strategyExposure.set(strategyKey, {
          market_value: currentStrategy.market_value + marketValue,
          count: currentStrategy.count + 1,
        });
      }

      positionRisks.push({
        symbol,
        name: position.name || stock?.name || symbol,
        industry,
        market_value: roundNumber(marketValue, 2),
        exposure_pct: roundNumber(exposure, 2),
        volatility_20d_pct: volatility20dPct,
        max_correlation: maxCorrelation,
        strategy_keys: strategyKeys,
        risk_flags: riskFlags,
      });
    }

    const topIndustries = [...industryExposure.entries()]
      .map(([industry, item]) => ({
        industry,
        market_value: roundNumber(item.market_value, 2),
        exposure_pct: roundNumber((item.market_value / totalValue) * 100, 2),
        count: item.count,
      }))
      .sort((a, b) => b.exposure_pct - a.exposure_pct);

    const topStrategies = [...strategyExposure.entries()]
      .map(([strategy_key, item]) => ({
        strategy_key,
        exposure_pct: roundNumber((item.market_value / totalValue) * 100, 2),
        count: item.count,
      }))
      .sort((a, b) => b.exposure_pct - a.exposure_pct);

    const maxIndustryExposurePct = topIndustries[0]?.exposure_pct || 0;
    const maxStrategyExposurePct = topStrategies[0]?.exposure_pct || 0;
    const avgVolatility20dPct = positionRisks.length
      ? roundNumber(
          positionRisks.reduce((sum, item) => sum + item.volatility_20d_pct, 0) /
            positionRisks.length,
          2
        )
      : 0;
    const maxVolatility20dPct = positionRisks.reduce(
      (max, item) => Math.max(max, item.volatility_20d_pct),
      0
    );
    const portfolioVarProxyPct = this.calculatePortfolioVarProxyPct(positionRisks, totalValue);

    const warnings: string[] = [];
    const watchWarnings: string[] = [];
    this.pushRiskWarnings({
      warnings,
      watchWarnings,
      cashPct,
      exposurePct,
      drawdownPct,
      maxIndustryExposurePct,
      maxPairCorrelation,
      maxVolatility20dPct,
      portfolioVarProxyPct,
      limits,
    });

    const level = warnings.length > 0 ? 'danger' : watchWarnings.length > 0 ? 'watch' : 'safe';
    const status = {
      level,
      label: level === 'danger' ? '暂停新增' : level === 'watch' ? '谨慎加仓' : '可继续小仓',
      conclusion:
        level === 'danger'
          ? warnings[0]
          : level === 'watch'
          ? watchWarnings[0]
          : '组合现金、回撤、行业集中度和波动均处于可控区间，可按策略预算小仓验证。',
    };

    const nextActions = this.buildNextActions({
      level,
      warnings,
      watchWarnings,
      cashPct,
      exposurePct,
      topIndustries,
      positionRisks,
      limits,
    });

    return {
      generated_at: new Date().toISOString(),
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        total_value: roundNumber(totalValue, 2),
        current_cash: roundNumber(currentCash, 2),
        initial_capital: roundNumber(initialCapital, 2),
        position_value: roundNumber(positionValue, 2),
        cash_pct: cashPct,
        exposure_pct: exposurePct,
        drawdown_pct: drawdownPct,
        peak_total_value: roundNumber(peakTotalValue, 2),
        open_position_count: positions.length,
      },
      status,
      limits,
      risk_metrics: {
        cash_pct: cashPct,
        exposure_pct: exposurePct,
        drawdown_pct: drawdownPct,
        max_industry_exposure_pct: maxIndustryExposurePct,
        max_strategy_exposure_pct: maxStrategyExposurePct,
        avg_volatility_20d_pct: avgVolatility20dPct,
        max_volatility_20d_pct: roundNumber(maxVolatility20dPct, 2),
        max_pair_correlation: roundNumber(maxPairCorrelation, 4),
        portfolio_var_proxy_pct: portfolioVarProxyPct,
      },
      top_industries: topIndustries.slice(0, 5),
      top_strategies: topStrategies.slice(0, 5),
      position_risks: positionRisks.sort((a, b) => b.exposure_pct - a.exposure_pct),
      warnings: [...warnings, ...watchWarnings].slice(0, 8),
      next_actions: nextActions,
    };
  }

  private async getFamilyRiskProfile(options: RiskProfileOptions, limits: typeof DEFAULT_LIMITS) {
    const portfolios = await PaperTradingPortfolio.findAll({
      where: {
        user_id: options.user_id,
        name: { [Op.in]: PAPER_PORTFOLIO_FAMILIES.map(item => item.name) },
      },
      order: [['id', 'ASC']],
    });

    if (portfolios.length === 0) return this.buildEmptyProfile(limits);

    const familyByName = new Map<string, (typeof PAPER_PORTFOLIO_FAMILIES)[number]>(
      PAPER_PORTFOLIO_FAMILIES.map(item => [item.name, item])
    );
    const portfolioIds = portfolios.map(portfolio => portfolio.id);
    const [positions, snapshots] = await Promise.all([
      PaperTradingPosition.findAll({
        where: { portfolio_id: { [Op.in]: portfolioIds } },
        raw: true,
      }) as any,
      PaperTradingSnapshot.findAll({
        where: {
          portfolio_id: { [Op.in]: portfolioIds },
          date: {
            [Op.gte]: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          },
        },
        order: [
          ['portfolio_id', 'ASC'],
          ['date', 'ASC'],
        ],
        raw: true,
      }) as any,
    ]);
    const portfolioById = new Map(portfolios.map(portfolio => [portfolio.id, portfolio]));
    const totalValue = Math.max(
      portfolios.reduce((sum, portfolio) => sum + toNumber(portfolio.total_value, 0), 0),
      1
    );
    const currentCash = portfolios.reduce(
      (sum, portfolio) => sum + toNumber(portfolio.current_cash, 0),
      0
    );
    const initialCapital = portfolios.reduce(
      (sum, portfolio) => sum + toNumber(portfolio.initial_capital, 0),
      0
    );
    const positionValue = (positions as any[]).reduce(
      (sum: number, position: any) => sum + toNumber(position.market_value, 0),
      0
    );
    const peakByPortfolio = new Map<number, number>();
    for (const portfolio of portfolios) {
      peakByPortfolio.set(portfolio.id, toNumber(portfolio.total_value, 0));
    }
    for (const snapshot of snapshots as any[]) {
      const portfolioId = Number(snapshot.portfolio_id);
      peakByPortfolio.set(
        portfolioId,
        Math.max(toNumber(peakByPortfolio.get(portfolioId), 0), toNumber(snapshot.total_value, 0))
      );
    }
    const peakTotalValue = Math.max(
      totalValue,
      [...peakByPortfolio.values()].reduce((sum, value) => sum + toNumber(value, 0), 0)
    );
    const cashPct = roundNumber((currentCash / totalValue) * 100, 2);
    const exposurePct = roundNumber((positionValue / totalValue) * 100, 2);
    const drawdownPct =
      peakTotalValue > 0
        ? roundNumber(((totalValue - peakTotalValue) / peakTotalValue) * 100, 2)
        : 0;

    const symbols = [
      ...new Set((positions as any[]).map(position => normalizeSymbol(position.symbol))),
    ].filter(Boolean);
    const [stocks, executedSignals] = await Promise.all([
      symbols.length
        ? Stock.findAll({ where: { symbol: { [Op.in]: symbols } }, raw: true })
        : Promise.resolve([]),
      AIInvestmentSignal.findAll({
        where: executedSignalWhereForPortfolios(portfolioIds),
        order: [['updated_at', 'DESC']],
        limit: 5000,
      }).catch(error => {
        logger.warn(`读取多账户模拟盘信号策略来源失败: ${error?.message || error}`);
        return [] as AIInvestmentSignal[];
      }),
    ]);
    const stockMap = new Map<string, any>(
      (stocks as any[]).map(stock => [normalizeSymbol(stock.symbol), stock])
    );
    const signalMetadataByPortfolioSymbol = new Map<string, Record<string, any>>();
    for (const signal of executedSignals) {
      const symbol = normalizeSymbol(signal.symbol);
      if (!symbol) continue;
      const metadata = asPlainObject(signal.metadata);
      for (const portfolioId of portfolioIds) {
        const paperMeta = paperTradingMetaForPortfolio(metadata, portfolioId);
        if (toNumber(paperMeta.portfolio_id, 0) !== portfolioId) continue;
        const key = `${portfolioId}:${symbol}`;
        if (!signalMetadataByPortfolioSymbol.has(key)) {
          signalMetadataByPortfolioSymbol.set(key, metadata);
        }
      }
    }

    const returnSeriesBySymbol = await this.loadReturnSeries(symbols);
    const maxCorrelationBySymbol = new Map<string, number>();
    let maxPairCorrelation = 0;
    for (let left = 0; left < symbols.length; left++) {
      for (let right = left + 1; right < symbols.length; right++) {
        const leftSymbol = symbols[left];
        const rightSymbol = symbols[right];
        const correlation = pearsonCorrelation(
          returnSeriesBySymbol.get(leftSymbol) || [],
          returnSeriesBySymbol.get(rightSymbol) || []
        );
        const absCorrelation = Math.abs(correlation);
        maxPairCorrelation = Math.max(maxPairCorrelation, absCorrelation);
        maxCorrelationBySymbol.set(
          leftSymbol,
          Math.max(toNumber(maxCorrelationBySymbol.get(leftSymbol), 0), absCorrelation)
        );
        maxCorrelationBySymbol.set(
          rightSymbol,
          Math.max(toNumber(maxCorrelationBySymbol.get(rightSymbol), 0), absCorrelation)
        );
      }
    }

    const industryExposure = new Map<string, { market_value: number; count: number }>();
    const strategyExposure = new Map<string, { market_value: number; count: number }>();
    const positionRisks: PositionRiskItem[] = [];
    const accountRisks = new Map<string, any>();

    for (const position of positions as any[]) {
      const symbol = normalizeSymbol(position.symbol);
      const portfolioId = Number(position.portfolio_id);
      const portfolio = portfolioById.get(portfolioId);
      const family = familyByName.get(portfolio?.name || '');
      const accountName = portfolio?.name || `账户 ${portfolioId}`;
      const accountKey = family?.key || `portfolio_${portfolioId}`;
      const accountLabel = family?.label || accountName;
      const stock = stockMap.get(symbol);
      const industry = stock?.industry || '未分类';
      const marketValue = toNumber(position.market_value, 0);
      const exposure = totalValue > 0 ? (marketValue / totalValue) * 100 : 0;
      const returns = returnSeriesBySymbol.get(symbol) || [];
      const volatility20dPct = calculateVolatilityPct(returns.slice(-20));
      const maxCorrelation = roundNumber(toNumber(maxCorrelationBySymbol.get(symbol), 0), 4);
      const signalMetadata = signalMetadataByPortfolioSymbol.get(`${portfolioId}:${symbol}`) || {};
      const strategyKeys = strategyKeysFromSignalMetadata(signalMetadata, portfolioId);
      const riskFlags: string[] = [];
      if (volatility20dPct > limits.max_single_stock_volatility_pct) {
        riskFlags.push(`波动 ${volatility20dPct}% 高于阈值`);
      }
      if (maxCorrelation > limits.max_position_correlation) {
        riskFlags.push(`相关性 ${roundNumber(maxCorrelation * 100, 1)}% 偏高`);
      }
      if (exposure > 15) riskFlags.push(`单票暴露 ${roundNumber(exposure, 1)}% 偏高`);

      const currentIndustry = industryExposure.get(industry) || { market_value: 0, count: 0 };
      industryExposure.set(industry, {
        market_value: currentIndustry.market_value + marketValue,
        count: currentIndustry.count + 1,
      });

      for (const strategyKey of strategyKeys) {
        const currentStrategy = strategyExposure.get(strategyKey) || { market_value: 0, count: 0 };
        strategyExposure.set(strategyKey, {
          market_value: currentStrategy.market_value + marketValue,
          count: currentStrategy.count + 1,
        });
      }

      const account = accountRisks.get(accountKey) || {
        key: accountKey,
        label: accountLabel,
        portfolio_id: portfolioId,
        name: accountName,
        total_value: roundNumber(toNumber(portfolio?.total_value, 0), 2),
        position_value: 0,
        exposure_pct: 0,
        open_position_count: 0,
        risk_count: 0,
      };
      account.position_value += marketValue;
      account.open_position_count += 1;
      account.risk_count += riskFlags.length > 0 ? 1 : 0;
      accountRisks.set(accountKey, account);

      positionRisks.push({
        symbol,
        name: position.name || stock?.name || symbol,
        industry,
        market_value: roundNumber(marketValue, 2),
        exposure_pct: roundNumber(exposure, 2),
        volatility_20d_pct: volatility20dPct,
        max_correlation: maxCorrelation,
        strategy_keys: strategyKeys,
        risk_flags: riskFlags,
        ...(family
          ? {
              account_key: family.key,
              account_label: family.label,
              account_name: family.name,
              portfolio_id: portfolioId,
            }
          : {
              account_key: accountKey,
              account_label: accountLabel,
              account_name: accountName,
              portfolio_id: portfolioId,
            }),
      } as any);
    }

    const topIndustries = [...industryExposure.entries()]
      .map(([industry, item]) => ({
        industry,
        market_value: roundNumber(item.market_value, 2),
        exposure_pct: roundNumber((item.market_value / totalValue) * 100, 2),
        count: item.count,
      }))
      .sort((a, b) => b.exposure_pct - a.exposure_pct);
    const topStrategies = [...strategyExposure.entries()]
      .map(([strategy_key, item]) => ({
        strategy_key,
        exposure_pct: roundNumber((item.market_value / totalValue) * 100, 2),
        count: item.count,
      }))
      .sort((a, b) => b.exposure_pct - a.exposure_pct);
    const account_exposures = [...accountRisks.values()]
      .map(item => ({
        ...item,
        position_value: roundNumber(item.position_value, 2),
        exposure_pct: roundNumber((item.position_value / totalValue) * 100, 2),
      }))
      .sort((a, b) => b.exposure_pct - a.exposure_pct);

    const maxIndustryExposurePct = topIndustries[0]?.exposure_pct || 0;
    const maxStrategyExposurePct = topStrategies[0]?.exposure_pct || 0;
    const avgVolatility20dPct = positionRisks.length
      ? roundNumber(
          positionRisks.reduce((sum, item) => sum + item.volatility_20d_pct, 0) /
            positionRisks.length,
          2
        )
      : 0;
    const maxVolatility20dPct = positionRisks.reduce(
      (max, item) => Math.max(max, item.volatility_20d_pct),
      0
    );
    const portfolioVarProxyPct = this.calculatePortfolioVarProxyPct(positionRisks, totalValue);

    const warnings: string[] = [];
    const watchWarnings: string[] = [];
    this.pushRiskWarnings({
      warnings,
      watchWarnings,
      cashPct,
      exposurePct,
      drawdownPct,
      maxIndustryExposurePct,
      maxPairCorrelation,
      maxVolatility20dPct,
      portfolioVarProxyPct,
      limits,
    });
    const level = warnings.length > 0 ? 'danger' : watchWarnings.length > 0 ? 'watch' : 'safe';
    const status = {
      level,
      label: level === 'danger' ? '暂停新增' : level === 'watch' ? '谨慎加仓' : '可继续小仓',
      conclusion:
        level === 'danger'
          ? warnings[0]
          : level === 'watch'
          ? watchWarnings[0]
          : '全部策略账户现金、回撤、行业集中度和波动均处于可控区间，可按策略预算小仓验证。',
    };
    const nextActions = this.buildNextActions({
      level,
      warnings,
      watchWarnings,
      cashPct,
      exposurePct,
      topIndustries,
      positionRisks,
      limits,
    });

    return {
      generated_at: new Date().toISOString(),
      portfolio: {
        id: null,
        name: '全部策略模拟账户',
        total_value: roundNumber(totalValue, 2),
        current_cash: roundNumber(currentCash, 2),
        initial_capital: roundNumber(initialCapital, 2),
        position_value: roundNumber(positionValue, 2),
        cash_pct: cashPct,
        exposure_pct: exposurePct,
        drawdown_pct: drawdownPct,
        peak_total_value: roundNumber(peakTotalValue, 2),
        open_position_count: (positions as any[]).length,
      },
      status,
      limits,
      risk_metrics: {
        cash_pct: cashPct,
        exposure_pct: exposurePct,
        drawdown_pct: drawdownPct,
        max_industry_exposure_pct: maxIndustryExposurePct,
        max_strategy_exposure_pct: maxStrategyExposurePct,
        avg_volatility_20d_pct: avgVolatility20dPct,
        max_volatility_20d_pct: roundNumber(maxVolatility20dPct, 2),
        max_pair_correlation: roundNumber(maxPairCorrelation, 4),
        portfolio_var_proxy_pct: portfolioVarProxyPct,
      },
      top_industries: topIndustries.slice(0, 5),
      top_strategies: topStrategies.slice(0, 5),
      position_risks: positionRisks.sort((a, b) => b.exposure_pct - a.exposure_pct),
      account_exposures,
      portfolio_family_summary: {
        family_count: PAPER_PORTFOLIO_FAMILIES.length,
        active_family_count: account_exposures.length,
        open_position_count: (positions as any[]).length,
        total_position_value: roundNumber(positionValue, 2),
      },
      warnings: [...warnings, ...watchWarnings].slice(0, 8),
      next_actions: nextActions,
    };
  }

  private buildEmptyProfile(limits: typeof DEFAULT_LIMITS) {
    return {
      generated_at: new Date().toISOString(),
      portfolio: null,
      status: {
        level: 'safe',
        label: '等待建仓',
        conclusion: '当前还没有模拟盘或持仓，建议先用自动荐股小仓建立可验证样本。',
      },
      limits,
      risk_metrics: {
        cash_pct: 100,
        exposure_pct: 0,
        drawdown_pct: 0,
        max_industry_exposure_pct: 0,
        max_strategy_exposure_pct: 0,
        avg_volatility_20d_pct: 0,
        max_volatility_20d_pct: 0,
        max_pair_correlation: 0,
        portfolio_var_proxy_pct: 0,
      },
      top_industries: [],
      top_strategies: [],
      position_risks: [],
      warnings: [],
      next_actions: ['先运行量化机会台生成候选，再用模拟盘小仓跟踪收益闭环。'],
    };
  }

  private async loadReturnSeries(symbols: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (symbols.length === 0) return result;

    const stocks = await Stock.findAll({ where: { symbol: { [Op.in]: symbols } }, raw: true });
    const stockIdToSymbol = new Map<number, string>();
    for (const stock of stocks as any[]) {
      stockIdToSymbol.set(Number(stock.id), normalizeSymbol(stock.symbol));
    }
    if (stockIdToSymbol.size === 0) return result;

    const bars = await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: [...stockIdToSymbol.keys()] },
        time: { [Op.gte]: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      },
      order: [
        ['stock_id', 'ASC'],
        ['time', 'ASC'],
      ],
      raw: true,
    });

    const closesBySymbol = new Map<string, number[]>();
    for (const bar of bars as any[]) {
      const symbol = stockIdToSymbol.get(Number(bar.stock_id));
      if (!symbol) continue;
      const close = toNumber(bar.close, 0);
      if (close <= 0) continue;
      const closes = closesBySymbol.get(symbol) || [];
      closes.push(close);
      closesBySymbol.set(symbol, closes);
    }

    for (const [symbol, closes] of closesBySymbol.entries()) {
      result.set(symbol, calculateReturns(closes).slice(-60));
    }
    return result;
  }

  private calculatePortfolioVarProxyPct(positionRisks: PositionRiskItem[], totalValue: number) {
    if (!positionRisks.length || totalValue <= 0) return 0;
    const varianceProxy = positionRisks.reduce((sum, item) => {
      const weight = item.market_value / totalValue;
      const dailyVol = item.volatility_20d_pct / 100;
      return sum + (weight * dailyVol) ** 2;
    }, 0);
    return roundNumber(Math.sqrt(varianceProxy) * 100, 2);
  }

  private pushRiskWarnings(options: {
    warnings: string[];
    watchWarnings: string[];
    cashPct: number;
    exposurePct: number;
    drawdownPct: number;
    maxIndustryExposurePct: number;
    maxPairCorrelation: number;
    maxVolatility20dPct: number;
    portfolioVarProxyPct: number;
    limits: typeof DEFAULT_LIMITS;
  }) {
    const {
      warnings,
      watchWarnings,
      cashPct,
      exposurePct,
      drawdownPct,
      maxIndustryExposurePct,
      maxPairCorrelation,
      maxVolatility20dPct,
      portfolioVarProxyPct,
      limits,
    } = options;

    if (cashPct < limits.min_cash_reserve_pct) {
      warnings.push(
        `现金水位 ${cashPct}% 低于 ${limits.min_cash_reserve_pct}% 底线，暂停新增仓位。`
      );
    } else if (cashPct < limits.min_cash_reserve_pct * 1.4) {
      watchWarnings.push(`现金水位 ${cashPct}% 接近底线，新增仓位需要更保守。`);
    }

    const absDrawdown = Math.abs(Math.min(drawdownPct, 0));
    if (absDrawdown > limits.max_portfolio_drawdown_pct) {
      warnings.push(
        `组合回撤 ${absDrawdown}% 超过 ${limits.max_portfolio_drawdown_pct}% 上限，优先降风险。`
      );
    } else if (absDrawdown > limits.max_portfolio_drawdown_pct * 0.75) {
      watchWarnings.push(`组合回撤 ${absDrawdown}% 接近上限，建议先观察再加仓。`);
    }

    if (exposurePct > limits.max_total_exposure_pct) {
      warnings.push(`总仓位 ${exposurePct}% 超过 ${limits.max_total_exposure_pct}% 上限。`);
    } else if (exposurePct > limits.max_total_exposure_pct * 0.85) {
      watchWarnings.push(`总仓位 ${exposurePct}% 已接近上限，后续只允许小仓。`);
    }

    if (maxIndustryExposurePct > limits.max_industry_exposure_pct) {
      warnings.push(
        `单行业暴露 ${maxIndustryExposurePct}% 超过 ${limits.max_industry_exposure_pct}% 上限。`
      );
    } else if (maxIndustryExposurePct > limits.max_industry_exposure_pct * 0.8) {
      watchWarnings.push(`单行业暴露 ${maxIndustryExposurePct}% 偏高，新增候选需避开同一行业。`);
    }

    if (maxPairCorrelation > limits.max_position_correlation) {
      warnings.push(
        `持仓相关性 ${roundNumber(maxPairCorrelation * 100, 1)}% 超过 ${roundNumber(
          limits.max_position_correlation * 100,
          1
        )}% 上限。`
      );
    } else if (maxPairCorrelation > limits.max_position_correlation * 0.85) {
      watchWarnings.push(`持仓相关性 ${roundNumber(maxPairCorrelation * 100, 1)}% 偏高。`);
    }

    if (maxVolatility20dPct > limits.max_single_stock_volatility_pct) {
      warnings.push(
        `最高个股 20 日波动 ${maxVolatility20dPct}% 超过 ${limits.max_single_stock_volatility_pct}% 阈值。`
      );
    } else if (maxVolatility20dPct > limits.max_single_stock_volatility_pct * 0.85) {
      watchWarnings.push(`最高个股波动 ${maxVolatility20dPct}% 接近阈值。`);
    }

    if (portfolioVarProxyPct > limits.max_portfolio_var_pct) {
      warnings.push(
        `组合 VaR 代理 ${portfolioVarProxyPct}% 超过 ${limits.max_portfolio_var_pct}% 上限。`
      );
    } else if (portfolioVarProxyPct > limits.max_portfolio_var_pct * 0.8) {
      watchWarnings.push(`组合 VaR 代理 ${portfolioVarProxyPct}% 偏高。`);
    }
  }

  private buildNextActions(options: {
    level: string;
    warnings: string[];
    watchWarnings: string[];
    cashPct: number;
    exposurePct: number;
    topIndustries: Array<{ industry: string; exposure_pct: number }>;
    positionRisks: PositionRiskItem[];
    limits: typeof DEFAULT_LIMITS;
  }): string[] {
    const {
      level,
      warnings,
      watchWarnings,
      cashPct,
      exposurePct,
      topIndustries,
      positionRisks,
      limits,
    } = options;
    const actions: string[] = [];
    if (level === 'danger') {
      actions.push('暂停新增买入，先执行风控预演并处理触发止损/止盈的持仓。');
      if (cashPct < limits.min_cash_reserve_pct)
        actions.push('优先卖出弱势仓位，把现金恢复到 8% 以上。');
      if (warnings.some(item => item.includes('单行业'))) {
        actions.push(
          `降低 ${topIndustries[0]?.industry || '高集中行业'} 暴露，避免继续买同一行业。`
        );
      }
    } else if (level === 'watch') {
      actions.push('只允许半仓位以内的小额验证，优先选择低相关、低波动、不同策略来源的候选。');
      if (watchWarnings.some(item => item.includes('总仓位')))
        actions.push('新增前先等待一笔退出或盈利保护信号。');
    } else {
      actions.push('可继续小仓跟随高分候选，但单票仍建议控制在策略预算上限内。');
      actions.push('新增时优先补充非同业、低相关的候选，继续扩大可验证样本。');
    }

    const highRiskPosition = positionRisks.find(item => item.risk_flags.length > 0);
    if (highRiskPosition) {
      actions.push(
        `重点观察 ${highRiskPosition.name || highRiskPosition.symbol}：${
          highRiskPosition.risk_flags[0]
        }。`
      );
    }
    if (exposurePct <= 0) actions.push('当前无持仓，可先从 1-2 只高分候选开始建立样本。');
    return [...new Set(actions)].slice(0, 5);
  }
}

export const paperTradingRiskProfileService = new PaperTradingRiskProfileService();
