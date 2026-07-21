/**
 * 简易版创建观察盘所需的最小客户端。
 *
 * 与后端 contract (paperTradingController 扩展):
 *   - POST   /api/paper-trading/portfolios              → createPortfolio()          // 新建
 *
 * 所有响应遵循统一信封 { success, data, message? }; success=false 抛 JS Error,
 * 与 factorService / portfolioWorkspaceService 同款行为.
 */
import api from './api';

// ---------------- 类型 ----------------

export interface CreatePortfolioInput {
  name: string;
  description?: string;
  initial_capital: number;
  strategy_keys?: string[];
  enabled_factors?: string[];
  auto_trade_enabled?: boolean;
}

// ---------------- 通用 unwrap ----------------

function unwrap<T>(
  res: { data?: { success?: boolean; data?: T; message?: string } },
  fallback: string
): T {
  if (!res.data?.success) {
    throw new Error(res.data?.message || fallback);
  }
  return res.data.data as T;
}

// ---------------- API 函数 ----------------

export async function createPortfolio(
  input: CreatePortfolioInput
): Promise<{ id: number; name: string }> {
  const res = await api.post('/paper-trading/portfolios', input);
  return unwrap<{ id: number; name: string }>(res, '新建模拟盘失败');
}

// ---------------- bundled export ----------------

export const portfolioCrudService = {
  createPortfolio,
};

export default portfolioCrudService;
