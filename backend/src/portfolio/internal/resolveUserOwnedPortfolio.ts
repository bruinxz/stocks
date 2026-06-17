/**
 * resolveUserOwnedPortfolio — Batch G (2026-06-17)
 *
 * Shared helper used by every internal PaperTrading* service to resolve a
 * `PaperTradingPortfolio` row **with mandatory user_id ownership check**.
 *
 * Background: facade.getPortfolio / placeOrder / closePosition 等 7 个公开方法
 * 都加了 `where:{id, user_id}` 防越权. 但 4 个 internal service 的
 * `resolvePortfolio` 实现里都还在 `PaperTradingPortfolio.findByPk(portfolio_id)`
 * 没带 user_id 限定. 任意登录用户 GET `?portfolio_id=<别人的>` 直接拿到他人
 * dashboard / outcome / trace / attribution.
 *
 * 这个 helper 把"按 portfolio_id 拿盘"统一收敛到一处, 强制 user_id 匹配:
 *
 *   - 传 portfolio_id + user_id → findByPk + 校验 portfolio.user_id === user_id
 *   - 校验失败 → 抛 statusCode=404 的错误 (不暴露"这个盘存在但不是你的"的信息)
 *   - 传 portfolio_id 但不传 user_id → 抛 500 (programmer error, 不允许)
 *
 * 不负责 fallback / 不负责 create — caller 拿到 null 后自己决定回退路径.
 */

import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';

export interface FindOwnedPortfolioInput {
  portfolio_id?: number | string | null;
  user_id?: number | string | null;
}

/**
 * 按 portfolio_id + user_id 查 portfolio. 找到返回 instance, 找不到 / 越权返回 null.
 *
 * 调用方典型用法:
 * ```
 *   if (options.portfolio_id) {
 *     const p = await findOwnedPortfolio(options);
 *     if (p) return p;
 *     // 找不到 / 越权 → 不要 fallback 到 "user 名下任意盘", 抛 404
 *     const err: any = new Error('未找到模拟盘或无权访问');
 *     err.statusCode = 404;
 *     throw err;
 *   }
 *   // 没传 portfolio_id → 走自己的 fallback (active 第一个 / 创建)
 * ```
 */
export async function findOwnedPortfolio(
  input: FindOwnedPortfolioInput
): Promise<PaperTradingPortfolio | null> {
  const portfolioId = Number(input.portfolio_id);
  const userId = Number(input.user_id);
  if (!Number.isFinite(portfolioId) || portfolioId <= 0) return null;
  if (!Number.isFinite(userId) || userId <= 0) {
    const err: any = new Error(
      'findOwnedPortfolio: user_id is required to look up portfolio by portfolio_id (越权防护)'
    );
    err.statusCode = 500;
    throw err;
  }
  return PaperTradingPortfolio.findOne({
    where: { id: portfolioId, user_id: userId },
  });
}

/**
 * 同 findOwnedPortfolio, 但找不到时直接抛 404 (不返 null), 适合 caller 不打算
 * fallback 的场景. err.statusCode = 404, err.code = 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN'.
 */
export async function requireOwnedPortfolio(
  input: FindOwnedPortfolioInput
): Promise<PaperTradingPortfolio> {
  const portfolio = await findOwnedPortfolio(input);
  if (portfolio) return portfolio;
  const err: any = new Error('未找到模拟盘或无权访问');
  err.statusCode = 404;
  err.code = 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN';
  throw err;
}
