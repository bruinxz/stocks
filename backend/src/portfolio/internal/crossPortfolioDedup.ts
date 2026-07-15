/**
 * crossPortfolioDedup — CB-3 (2026/06/25)
 *
 * 同一 user 多组合 "策略赛马场" 设计: 不同 portfolio 用不同策略, 给同一只票
 * 信号是 alpha 共识 (5 个策略都选中说明信号强). 但默认行为是每个 portfolio
 * 都买一遍, 该 user 重仓单票, 失去多组合 diversification.
 *
 * **规则**: 同 (user_id, stock_code) 已在 ≥ N 个 portfolio (默认 N=2) 持仓时,
 * 新 BUY 信号被 skip, 让 ≥ 1 个组合代表; 其它跳过避免重仓单票.
 *
 * 设计原则:
 *   1. **同 user 才 dedup**: 不同 user 互不影响 — prod 多租户基本要求.
 *   2. **per-portfolio 信号自身判断**: dedup 在进入 createBuyTrade 之前, 不影响
 *      已下单 / 已平仓的历史 portfolio. caller (autoBuyFromSignals) 拿到 skip
 *      结果后 continue loop, 跳到下个 signal.
 *   3. **DataSource interface injection**: 单测可注入 fake 不接 DB; 生产用
 *      Sequelize impl 查 paper_trading_positions JOIN paper_trading_portfolios.
 *   4. **fail-OPEN**: DB 查失败 → log warn + 返 {should_skip: false} (放行), 不
 *      阻塞买入链 (与 BJ-7 同款理念).
 *   5. **阈值 Object.freeze**: CROSS_PORTFOLIO_DEDUP_THRESHOLD = 2, 不允许 magic
 *      number 散落代码里.
 *   6. **当前 portfolio_id 自己不算入**: 同一 portfolio 不会被 dedup (createBuyTrade
 *      自己有 "模拟盘已持有 X, 自动跟单拒绝重复加仓" 防护). 算"其它 portfolio"
 *      持仓数 (already_held_in_count) ≥ threshold 时 skip.
 */

/** 同 (user, symbol) 已在 ≥ N 个 portfolio 持仓时 skip. 默认 2. */
export const CROSS_PORTFOLIO_DEDUP_THRESHOLD = Object.freeze({ value: 2 });

export interface CrossPortfolioPositionRow {
  /** 持仓所在 portfolio_id (用于排除 current_portfolio_id 自己) */
  portfolio_id: number;
  symbol: string;
}

export interface CrossPortfolioDedupDataSource {
  /**
   * 返回该 user 下所有 quantity > 0 的持仓 (portfolio_id + symbol).
   * caller 在内存里按 symbol 过滤计数; 不在 SQL 层做 symbol 过滤可以让一次 query
   * 服务 autoBuyFromSignals loop 内多个不同 symbol 的 dedup 判断.
   */
  loadOpenPositionsByUser(user_id: number): Promise<CrossPortfolioPositionRow[]>;
}

export interface ShouldSkipForUserDedupResult {
  should_skip: boolean;
  already_held_in_count: number;
  threshold: number;
  /** skip 时附带的人类可读原因 */
  reason: string;
  /** fail-OPEN 时记录错误信息, 让 caller log */
  error?: string;
}

/**
 * 判断该 (user, symbol) 是否应跳过本次 BUY.
 *
 * @param user_id              下单的 user
 * @param symbol               目标股票代码 (与 paper_trading_positions.symbol 同款规格)
 * @param current_portfolio_id 本次下单的 portfolio (排除自己; 自己持有不阻止再判别 — createBuyTrade 内已有重复防护)
 * @param dataSource           DI 数据源
 * @param threshold            可选 override 阈值 (默认 2)
 */
export async function shouldSkipForUserDedup(
  user_id: number,
  symbol: string,
  current_portfolio_id: number,
  dataSource: CrossPortfolioDedupDataSource,
  threshold: number = CROSS_PORTFOLIO_DEDUP_THRESHOLD.value
): Promise<ShouldSkipForUserDedupResult> {
  const finalThreshold =
    Number.isFinite(threshold) && threshold > 0
      ? Math.floor(threshold)
      : CROSS_PORTFOLIO_DEDUP_THRESHOLD.value;

  try {
    const rows = await dataSource.loadOpenPositionsByUser(user_id);
    const otherCount = rows.filter(
      r => r.symbol === symbol && r.portfolio_id !== current_portfolio_id
    ).length;

    if (otherCount >= finalThreshold) {
      return {
        should_skip: true,
        already_held_in_count: otherCount,
        threshold: finalThreshold,
        reason: `cross_portfolio_dedup: user ${user_id} 已在 ${otherCount} 个组合持有 ${symbol} (阈值 ${finalThreshold}), 跳过 portfolio ${current_portfolio_id}`,
      };
    }
    return {
      should_skip: false,
      already_held_in_count: otherCount,
      threshold: finalThreshold,
      reason: '',
    };
  } catch (err: any) {
    // fail-OPEN: DB 查失败 → 放行, 让 caller log
    return {
      should_skip: false,
      already_held_in_count: 0,
      threshold: finalThreshold,
      reason: '',
      error: `crossPortfolioDedup loadOpenPositionsByUser failed (fail-open): ${
        err?.message || err
      }`,
    };
  }
}

/**
 * 生产 DataSource (lazy require Sequelize models 避免循环 import).
 */
export const PRODUCTION_CROSS_PORTFOLIO_DEDUP_DATA_SOURCE: CrossPortfolioDedupDataSource = {
  async loadOpenPositionsByUser(user_id: number) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaperTradingPosition } = require('../../models/PaperTradingPosition');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Op } = require('sequelize');

    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return [];
    const portfolioIds = portfolios.map((p: any) => p.id);

    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id: { [Op.in]: portfolioIds }, quantity: { [Op.gt]: 0 } },
      attributes: ['portfolio_id', 'symbol'],
    });
    return positions.map((p: any) => ({
      portfolio_id: Number(p.portfolio_id),
      symbol: String(p.symbol),
    }));
  },
};
