/**
 * portfolioCrudService (Batch AT-2 2026-06-21) — 模拟盘完整 CRUD 前端 API 客户端.
 *
 * 与后端 contract (paperTradingController 扩展):
 *   - GET    /api/paper-trading/portfolios              → listPortfolios()           // 列表 (含 strategy/factor display)
 *   - GET    /api/paper-trading/portfolios/:id          → getPortfolioDetail()       // 详情 (含 trades + snapshots)
 *   - POST   /api/paper-trading/portfolios              → createPortfolio()          // 新建
 *   - PUT    /api/paper-trading/portfolios/:id          → updatePortfolio()          // 更新 (不可改资金)
 *   - DELETE /api/paper-trading/portfolios/:id?hard=    → deletePortfolio()          // 软删 (hard=true → 硬删)
 *   - POST   /api/paper-trading/portfolios/:id/reset    → resetPortfolio()           // 清仓 + 重置 cash
 *   - GET    /api/paper-trading/strategies/available    → listAvailableStrategies()  // 29 个策略
 *   - GET    /api/paper-trading/factors/available       → listAvailableFactors()     // 22 个因子
 *
 * 所有响应遵循统一信封 { success, data, message? }; success=false 抛 JS Error,
 * 与 factorService / portfolioWorkspaceService 同款行为.
 */
import api from './api';

// ---------------- 类型 ----------------

export interface StrategyDisplayChip {
  key: string;
  name: string;
  brief?: string;
}

export interface FactorDisplayChip {
  key: string;
  name: string;
  category: string;
}

export interface PortfolioListItem {
  id: number;
  name: string;
  description: string | null;
  initial_capital: number;
  current_cash: number;
  total_value: number;
  /** 用户保存的策略 key 列表 (后端原始). UI 优先使用 strategy_display. */
  strategy_keys: string[];
  /** 策略 chip — 后端 join 策略注册表的中文名 + brief, 给 UI 直接渲染. */
  strategy_display: StrategyDisplayChip[];
  /** 用户保存的因子 key 列表 (后端原始). UI 优先使用 factor_display. */
  enabled_factors: string[];
  /** 因子 chip — 后端 join 因子注册表的中文名 + 大类, 给 UI 直接渲染. */
  factor_display: FactorDisplayChip[];
  /** 是否启用 cron 自动跟单 (每日 14:35 系统自主). false = 只手工下单. */
  auto_trade_enabled: boolean;
  /** soft-delete 标记. is_active=false → 列表默认隐藏. */
  is_active: boolean;
  position_count: number;
  /** 近 7 天收益百分比 ((today.total_value - 7d_ago.total_value)/7d_ago * 100); null = 历史不足 7 天. */
  recent_7d_return_pct: number | null;
  created_at: string;
}

export interface PortfolioDetailTrade {
  id: number;
  symbol: string;
  name: string | null;
  direction: 'BUY' | 'SELL';
  execute_price: number;
  quantity: number;
  amount: number;
  realized_pnl: number | null;
  created_at: string;
}

export interface PortfolioDetailSnapshot {
  date: string;
  total_value: number;
}

export interface PortfolioDetail extends PortfolioListItem {
  recent_trades: PortfolioDetailTrade[];
  recent_snapshots: PortfolioDetailSnapshot[];
}

export interface CreatePortfolioInput {
  name: string;
  description?: string;
  initial_capital: number;
  strategy_keys?: string[];
  enabled_factors?: string[];
  auto_trade_enabled?: boolean;
}

export interface UpdatePortfolioInput {
  name?: string;
  description?: string | null;
  strategy_keys?: string[];
  enabled_factors?: string[];
  auto_trade_enabled?: boolean;
}

export interface AvailableStrategy {
  key: string;
  name: string;
  brief: string;
}

export interface AvailableFactor {
  key: string;
  name: string;
  category: string;
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

export async function listPortfolios(): Promise<PortfolioListItem[]> {
  const res = await api.get('/paper-trading/portfolios');
  return unwrap<PortfolioListItem[]>(res, '获取模拟盘列表失败');
}

export async function getPortfolioDetail(id: number): Promise<PortfolioDetail> {
  const res = await api.get(`/paper-trading/portfolios/${id}`);
  return unwrap<PortfolioDetail>(res, '获取模拟盘详情失败');
}

export async function createPortfolio(
  input: CreatePortfolioInput
): Promise<{ id: number; name: string }> {
  const res = await api.post('/paper-trading/portfolios', input);
  return unwrap<{ id: number; name: string }>(res, '新建模拟盘失败');
}

export async function updatePortfolio(id: number, patch: UpdatePortfolioInput): Promise<void> {
  const res = await api.put(`/paper-trading/portfolios/${id}`, patch);
  // 这里允许后端返回 data=null/void, 只要 success=true 即可
  if (!res.data?.success) {
    throw new Error(res.data?.message || '更新模拟盘失败');
  }
}

export async function deletePortfolio(id: number, hard = false): Promise<void> {
  const url = hard
    ? `/paper-trading/portfolios/${id}?hard=true`
    : `/paper-trading/portfolios/${id}`;
  const res = await api.delete(url);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '删除模拟盘失败');
  }
}

export async function resetPortfolio(id: number): Promise<void> {
  const res = await api.post(`/paper-trading/portfolios/${id}/reset`, {});
  if (!res.data?.success) {
    throw new Error(res.data?.message || '重置模拟盘失败');
  }
}

export async function listAvailableStrategies(): Promise<AvailableStrategy[]> {
  const res = await api.get('/paper-trading/strategies/available');
  return unwrap<AvailableStrategy[]>(res, '获取可用策略列表失败');
}

export async function listAvailableFactors(): Promise<AvailableFactor[]> {
  const res = await api.get('/paper-trading/factors/available');
  return unwrap<AvailableFactor[]>(res, '获取可用因子列表失败');
}

// ---------------- bundled export ----------------

export const portfolioCrudService = {
  listPortfolios,
  getPortfolioDetail,
  createPortfolio,
  updatePortfolio,
  deletePortfolio,
  resetPortfolio,
  listAvailableStrategies,
  listAvailableFactors,
};

export default portfolioCrudService;
