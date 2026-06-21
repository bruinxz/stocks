/**
 * AT-1 (2026-06-22) — PaperTradingPortfolioCrudService
 *
 * 用户原话: "现在的模拟盘我都不知道它是什么策略，用的是什么因子，而且
 * 我也没法自己新建、更新、删除模拟盘等操作"
 *
 * 之前 paper_trading_portfolios 只能通过 ensurePortfolio 隐式被 automation
 * service 创建; 字段只有 7 列 (id/user_id/name/initial_capital/current_cash/
 * total_value/is_active). 本 service 是 portfolio 的"用户面 CRUD" 唯一入口:
 *   - listForUser     — 列表 (扩展现有 listPortfolios 字段)
 *   - getDetailForUser — 详情 (含 strategy_display + factor_display + 最近 10 笔 trade)
 *   - createForUser   — 创建 (校验 name 唯一 + cap 范围 + strategy/factor 存在)
 *   - updateForUser   — 更新 (只允许改 name/description/strategy_keys/enabled_factors/auto_trade_enabled)
 *   - deleteForUser   — 软删 (默认; hard=true 物理删 + cascade)
 *   - resetForUser    — 清持仓 + cash 还原到 initial_capital (保留 id 用于复盘对照)
 *   - listAvailableStrategies — 返回所有 active 策略 + 中文名 + 简介
 *   - listAvailableFactors    — 返回 22 个 factor + 中文名 + category
 *
 * 关键约束:
 *   - 所有方法都校验 user_id 匹配 (防越权 — 业务层硬隔离不依赖 ORM scope)
 *   - 资金字段 (initial_capital / current_cash / total_value) **不允许 update**
 *     (只能通过 createForUser 设置, 或 resetForUser 重置)
 *   - 校验 strategy_keys / enabled_factors 都是已注册的 key (拒绝写入 typo)
 *   - 所有 mutation 操作写 RiskAlert(level='LOW', rule_id='portfolio_crud')
 *     做 audit log (后续可在 UI 看到 "用户 X 删了 portfolio Y")
 *   - 软删 (is_active=false) 保留历史 trades/snapshots 供复盘; hard=true 才级联删
 *   - listForUser 默认 include_inactive=false (软删盘不进列表)
 */

import { Op, Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { PaperTradingOrderIntent } from '../../models/PaperTradingOrderIntent';
import { RiskAlert } from '../../models/RiskAlert';
import { strategyRegistry } from '../../quant/engine/StrategyRegistry';
import { factorRegistry } from '../../quant/factors/FactorRegistry';
import { logger } from '../../utils/logger';

// ---------- Constants ----------

const MIN_INITIAL_CAPITAL = 10_000; // 1 万
const MAX_INITIAL_CAPITAL = 100_000_000; // 1 亿
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1000;
const AUDIT_RULE_ID = 'portfolio_crud';
const AUDIT_LEVEL = 'LOW';
// AT-2-FIX (2026-06-22 二轮 review): risk_alerts.symbol 列 VARCHAR(20), "SYSTEM:PORTFOLIO_CRUD"
// 是 21 字节, INSERT 永远 fail. audit log try/catch 吞错让"删除/更新/重置/创建" 4 个
// mutation 操作的审计全部丢失. 改成 19 字节 (留 1 字节余量).
const AUDIT_SYMBOL = 'SYSTEM:PT_CRUD';

// ---------- Public types ----------

/**
 * AT-2-FIX (2026-06-22 二轮 review): chip 形态 (含 key + 中文 name + 描述), 让 UI
 * 直接 join 不用再回查 strategyRegistry / factorRegistry. 之前是 string[] 让前端
 * 渲染时 chip 缺 tooltip 也找不到 key, transfer 控件无法 anchor.
 */
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
  is_active: boolean;
  auto_trade_enabled: boolean;
  strategy_keys: string[];
  strategy_display: StrategyDisplayChip[];
  enabled_factors: string[];
  factor_display: FactorDisplayChip[];
  /**
   * AT-2-FIX (2026-06-22 二轮 review): 字段名与 FE/CRUD service contract 对齐.
   * 之前后端用 `positions_count` 而 FE/Modal 读 `position_count`, 表格 "持仓数" 列
   * 永远显示空. position_count 是单数 (一个数), 不是复数.
   */
  position_count: number;
  /**
   * AT-2-FIX (2026-06-22 二轮 review): 字段名与 FE contract 对齐.
   * 之前 return_7d_pct / return_30d_pct, FE 读 recent_7d_return_pct.
   * 旧字段保留向后兼容 (deprecated), 给 7d 收益 column 用; 30d 因 FE 不读所以
   * 重命名为 recent_30d_return_pct 以保持一致.
   */
  recent_7d_return_pct: number | null;
  recent_30d_return_pct: number | null;
  total_return_pct: number;
  created_at: Date;
}

/**
 * AT-2-FIX (2026-06-22 二轮 review): 详情 trade 形态对齐 FE contract.
 * 之前 backend 写 price/trade_date, FE 读 execute_price/realized_pnl/created_at.
 * Trade 表的真实列就是 execute_price + realized_pnl, FE 字段是对的; backend 错.
 * trade_date 是不存在的列, 之前序列化 "undefined" string.
 */
export interface PortfolioDetailTrade {
  id: number;
  symbol: string;
  name: string | null;
  direction: string;
  quantity: number;
  execute_price: number;
  amount: number;
  commission: number;
  realized_pnl: number | null;
  trade_reason_summary: string | null;
  trade_reason_source: string | null;
  created_at: Date;
}

/**
 * AT-2-FIX (2026-06-22 二轮 review): 最近 7 天 net value snapshot 给 FE Drawer
 * 画曲线. 之前 detail endpoint 没返这个字段, recharts LineChart 永远是空 Empty.
 */
export interface PortfolioDetailSnapshot {
  date: string;
  total_value: number;
}

export interface PortfolioDetail extends PortfolioListItem {
  risk_profile_overrides: Record<string, unknown>;
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
  risk_profile_overrides?: Record<string, unknown>;
}

export interface UpdatePortfolioInput {
  name?: string;
  description?: string | null;
  strategy_keys?: string[];
  enabled_factors?: string[];
  auto_trade_enabled?: boolean;
  risk_profile_overrides?: Record<string, unknown>;
}

export interface AvailableStrategy {
  /**
   * AT-2-FIX (2026-06-22 二轮 review): 与 FE Transfer/Modal contract 对齐.
   * 之前 backend 返 strategy_key, FE Transfer 读 `s.key`; 导致 Transfer 控件
   * 整个空, 用户无法创建/编辑模拟盘时选策略 (P0 阻塞).
   */
  key: string;
  name: string;
  /**
   * UI Transfer 控件读 `s.brief`; 之前 backend 给 description, FE 读不到 → tooltip 空.
   */
  brief: string;
  category: string;
  risk_level: 'low' | 'medium' | 'high';
  tags: string[];
  enabled: boolean;
}

export interface AvailableFactor {
  /**
   * AT-2-FIX (2026-06-22 二轮 review): 与 FE Transfer contract 对齐, 同上.
   * FE Transfer 读 `f.key`/`f.name`/`f.category`; 之前 backend 返 name+description+category
   * (没有 key), 因子 Transfer 空, P0 阻塞.
   */
  key: string;
  name: string;
  brief: string;
  category: string;
}

// ---------- Error class ----------

/**
 * CRUD 业务错误 (区别于 5xx 系统错误). statusCode 默认 400; 越权 = 403, 未找到 = 404.
 * sendError() (PaperTradingController) 会读 statusCode 字段映射 HTTP status.
 */
export class PortfolioCrudError extends Error {
  statusCode: number;
  code: string;
  detail?: any;
  constructor(message: string, opts: { statusCode?: number; code?: string; detail?: any } = {}) {
    super(message);
    this.name = 'PortfolioCrudError';
    this.statusCode = opts.statusCode || 400;
    this.code = opts.code || 'PORTFOLIO_CRUD_ERROR';
    this.detail = opts.detail;
  }
}

// ---------- Pure helpers (export 供单测) ----------

export function normalizeName(raw: any): string {
  const s = String(raw || '').trim();
  if (!s) throw new PortfolioCrudError('name 不能为空', { code: 'INVALID_NAME' });
  if (s.length > MAX_NAME_LENGTH) {
    throw new PortfolioCrudError(`name 长度不能超过 ${MAX_NAME_LENGTH} 字符`, {
      code: 'INVALID_NAME',
    });
  }
  return s;
}

export function normalizeDescription(raw: any): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > MAX_DESCRIPTION_LENGTH) {
    throw new PortfolioCrudError(`description 长度不能超过 ${MAX_DESCRIPTION_LENGTH} 字符`, {
      code: 'INVALID_DESCRIPTION',
    });
  }
  return s;
}

export function normalizeInitialCapital(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new PortfolioCrudError('initial_capital 必须是有效数字', {
      code: 'INVALID_INITIAL_CAPITAL',
    });
  }
  if (n < MIN_INITIAL_CAPITAL) {
    throw new PortfolioCrudError(`initial_capital 不能小于 ${MIN_INITIAL_CAPITAL} (1 万)`, {
      code: 'INVALID_INITIAL_CAPITAL',
    });
  }
  if (n > MAX_INITIAL_CAPITAL) {
    throw new PortfolioCrudError(`initial_capital 不能大于 ${MAX_INITIAL_CAPITAL} (1 亿)`, {
      code: 'INVALID_INITIAL_CAPITAL',
    });
  }
  return Math.round(n * 100) / 100;
}

/**
 * 校验 strategy_keys: 必须是 string 数组, 每个 key 必须是 strategyRegistry 已知的.
 * 空数组 OK (语义 = "接所有 active 策略", 与 ensurePortfolio 默认行为一致).
 */
export function normalizeStrategyKeys(raw: any): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new PortfolioCrudError('strategy_keys 必须是数组', {
      code: 'INVALID_STRATEGY_KEYS',
    });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const key = String(item || '').trim();
    if (!key) continue;
    if (seen.has(key)) continue; // 去重
    if (!strategyRegistry.get(key)) {
      const known = strategyRegistry
        .list()
        .map(d => d.strategy_key)
        .sort()
        .slice(0, 5)
        .join(', ');
      throw new PortfolioCrudError(
        `strategy_keys 包含未注册的策略 "${key}". 已知 (前 5): ${known}…`,
        { code: 'INVALID_STRATEGY_KEYS', detail: { unknown_key: key } }
      );
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 校验 enabled_factors: 同 strategy_keys 模式.
 * 空数组 OK (语义 = "用策略层默认 factor weights").
 */
export function normalizeEnabledFactors(raw: any): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new PortfolioCrudError('enabled_factors 必须是数组', {
      code: 'INVALID_ENABLED_FACTORS',
    });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = String(item || '').trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    if (!factorRegistry.has(name)) {
      const known = factorRegistry.listNames().slice(0, 5).join(', ');
      throw new PortfolioCrudError(
        `enabled_factors 包含未注册的因子 "${name}". 已知 (前 5): ${known}…`,
        { code: 'INVALID_ENABLED_FACTORS', detail: { unknown_factor: name } }
      );
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function normalizeRiskOverrides(raw: any): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PortfolioCrudError('risk_profile_overrides 必须是 object', {
      code: 'INVALID_RISK_OVERRIDES',
    });
  }
  // 不强限制内部 schema (per-strategy / per-guard 各自 schema); 只保证是 plain obj
  return { ...raw };
}

/**
 * 展开 strategy_keys 到 chip 对象 (含 key + 中文 name + brief), 让 UI 直接渲染
 * 不用再回查 strategyRegistry. registry 无该 key 时显示 key 本身.
 */
export function expandStrategyDisplay(keys: string[]): StrategyDisplayChip[] {
  return keys.map(k => {
    const def = strategyRegistry.get(k);
    if (!def) return { key: k, name: k, brief: '' };
    return {
      key: k,
      name: def.definition.name,
      brief: def.definition.description,
    };
  });
}

/**
 * 展开 enabled_factors 到 chip 对象 (含 key + 中文 name + category).
 * factor 没有独立中文 name 字段, 用 description 当 name. 无注册时显示 key.
 */
export function expandFactorDisplay(names: string[]): FactorDisplayChip[] {
  return names.map(n => {
    if (!factorRegistry.has(n)) return { key: n, name: n, category: 'unknown' };
    const f = factorRegistry.get(n);
    return {
      key: n,
      name: f.description || n,
      category: String(f.category || 'other'),
    };
  });
}

/**
 * 计算 N 日收益率: (current - baseline) / initial_capital * 100
 *
 * 用 initial_capital 做分母而不是 baseline.total_value 让前端显示稳定 ("我这盘从 0 开始
 * 7 日跌 -3%" 比 "7 日跌 -0.5%, 但你已经亏 -50%" 更直观). 与 PaperTradingDashboardService
 * 既有收益率口径一致.
 *
 * baseline snapshot 缺失 (盘建立 < N 日 / 没有当日 snapshot) → null, UI 显示 "—"
 * 而非 0% (区分"数据不足"和"持平").
 */
export function computeReturnPct(
  currentTotalValue: number,
  baselineTotalValue: number | null,
  initialCapital: number
): number | null {
  if (baselineTotalValue === null || baselineTotalValue === undefined) return null;
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) return null;
  const diff = Number(currentTotalValue) - Number(baselineTotalValue);
  return Math.round((diff / initialCapital) * 10000) / 100; // 保 2 位小数 %
}

// ---------- Service ----------

export class PaperTradingPortfolioCrudService {
  /**
   * 列表 — 默认仅 active. include_inactive=true 时把软删盘也列出 (供 admin 看).
   */
  async listForUser(
    userId: number,
    opts: { include_inactive?: boolean } = {}
  ): Promise<PortfolioListItem[]> {
    this.assertUserId(userId);
    const where: any = { user_id: userId };
    if (!opts.include_inactive) where.is_active = true;

    const rows = await PaperTradingPortfolio.findAll({
      where,
      order: [['id', 'ASC']],
    });

    return Promise.all(rows.map(p => this.toListItem(p)));
  }

  /**
   * 详情 — 含 risk_profile_overrides + 最近 10 笔 trade + 最近 7 日 snapshot.
   * 越权访问 → 404 (不区分 "盘不存在"和"盘不属于你"防 enumeration 泄露).
   */
  async getDetailForUser(userId: number, portfolioId: number): Promise<PortfolioDetail> {
    this.assertUserId(userId);
    const p = await this.findOwnedPortfolio(userId, portfolioId, { allowInactive: true });
    const base = await this.toListItem(p);
    const [trades, snapshots] = await Promise.all([
      PaperTradingTrade.findAll({
        where: { portfolio_id: p.id },
        order: [['created_at', 'DESC']],
        limit: 10,
      }),
      // AT-2-FIX (2026-06-22): 最近 7 日净值快照, FE Drawer recharts 直接渲染.
      // 倒序拉再 reverse 让前端按时间正序 (Recharts XAxis 期望升序).
      PaperTradingSnapshot.findAll({
        where: { portfolio_id: p.id },
        order: [['date', 'DESC']],
        limit: 7,
        attributes: ['date', 'total_value'],
      }),
    ]);
    const recent_trades: PortfolioDetailTrade[] = trades.map(t => {
      const raw: any = t.toJSON ? t.toJSON() : t;
      const reason = raw.trade_reason || {};
      const rawExec = raw.execute_price;
      const rawPnl = raw.realized_pnl;
      return {
        id: Number(raw.id),
        symbol: String(raw.symbol),
        name: raw.name || null,
        direction: String(raw.direction),
        quantity: Number(raw.quantity),
        execute_price: rawExec == null ? 0 : Number(rawExec),
        amount: Number(raw.amount),
        commission: Number(raw.commission),
        realized_pnl: rawPnl == null ? null : Number(rawPnl),
        trade_reason_summary: raw.trade_reason_summary || null,
        trade_reason_source: reason?.source || null,
        created_at: raw.created_at,
      };
    });
    const recent_snapshots: PortfolioDetailSnapshot[] = snapshots
      .map(s => {
        const raw: any = s.toJSON ? s.toJSON() : s;
        return {
          date: String(raw.date),
          total_value: Number(raw.total_value),
        };
      })
      .reverse();
    return {
      ...base,
      risk_profile_overrides: (p.risk_profile_overrides as any) || {},
      recent_trades,
      recent_snapshots,
    };
  }

  /**
   * 创建 — 校验 name 唯一 (per-user). 默认 current_cash = total_value = initial_capital,
   * strategy_keys / enabled_factors 默认空数组, auto_trade_enabled 默认 false.
   */
  async createForUser(
    userId: number,
    input: CreatePortfolioInput
  ): Promise<{ id: number; name: string }> {
    this.assertUserId(userId);
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const initial_capital = normalizeInitialCapital(input.initial_capital);
    const strategy_keys = normalizeStrategyKeys(input.strategy_keys);
    const enabled_factors = normalizeEnabledFactors(input.enabled_factors);
    const auto_trade_enabled = input.auto_trade_enabled === true;
    const risk_profile_overrides = normalizeRiskOverrides(input.risk_profile_overrides);

    // name 唯一性 (per-user); 不限制全局, 不同用户可以同名.
    const dup = await PaperTradingPortfolio.findOne({
      where: { user_id: userId, name },
    });
    if (dup) {
      throw new PortfolioCrudError(`已存在同名模拟盘 "${name}"`, {
        code: 'DUPLICATE_NAME',
        detail: { existing_id: dup.id, is_active: dup.is_active },
      });
    }

    const created = await PaperTradingPortfolio.create({
      user_id: userId,
      name,
      description,
      initial_capital,
      current_cash: initial_capital,
      total_value: initial_capital,
      is_active: true,
      strategy_keys,
      enabled_factors,
      auto_trade_enabled,
      risk_profile_overrides,
    } as any);

    await this.writeAuditLog(userId, 'create', created.id, {
      name,
      initial_capital,
      strategy_keys,
      auto_trade_enabled,
    });

    return { id: created.id, name: created.name };
  }

  /**
   * 更新 — 只允许改 name / description / strategy_keys / enabled_factors /
   * auto_trade_enabled / risk_profile_overrides. **不允许改资金字段**
   * (initial_capital / current_cash / total_value): 资金一旦设置就是历史事实,
   * 想"清零重置"用 resetForUser, 想"重设规模"用 deleteForUser + createForUser.
   */
  async updateForUser(
    userId: number,
    portfolioId: number,
    patch: UpdatePortfolioInput
  ): Promise<void> {
    this.assertUserId(userId);
    const p = await this.findOwnedPortfolio(userId, portfolioId, { allowInactive: false });
    const changes: Record<string, any> = {};

    if (patch.name !== undefined) {
      const newName = normalizeName(patch.name);
      if (newName !== p.name) {
        const dup = await PaperTradingPortfolio.findOne({
          where: { user_id: userId, name: newName, id: { [Op.ne]: p.id } },
        });
        if (dup) {
          throw new PortfolioCrudError(`已存在同名模拟盘 "${newName}"`, {
            code: 'DUPLICATE_NAME',
          });
        }
        changes.name = newName;
      }
    }
    if (patch.description !== undefined) {
      changes.description = normalizeDescription(patch.description);
    }
    if (patch.strategy_keys !== undefined) {
      changes.strategy_keys = normalizeStrategyKeys(patch.strategy_keys);
    }
    if (patch.enabled_factors !== undefined) {
      changes.enabled_factors = normalizeEnabledFactors(patch.enabled_factors);
    }
    if (patch.auto_trade_enabled !== undefined) {
      changes.auto_trade_enabled = patch.auto_trade_enabled === true;
    }
    if (patch.risk_profile_overrides !== undefined) {
      changes.risk_profile_overrides = normalizeRiskOverrides(patch.risk_profile_overrides);
    }

    if (Object.keys(changes).length === 0) return;

    Object.assign(p, changes);
    // JSONB 列改动后必须 changed() 否则 Sequelize 不会写 (US-017 lesson)
    if (changes.strategy_keys) p.changed('strategy_keys', true);
    if (changes.enabled_factors) p.changed('enabled_factors', true);
    if (changes.risk_profile_overrides) p.changed('risk_profile_overrides', true);
    await p.save();

    await this.writeAuditLog(userId, 'update', p.id, { changes });
  }

  /**
   * 删除 — 默认软删 (is_active=false 保留历史). hard=true 物理删 + cascade 删
   * positions/trades/snapshots/order_intents (transaction 保证一致性).
   *
   * 软删保护策略: 用户误点删 → 软删后还能恢复 (admin SQL update is_active=true);
   * hard delete 不可逆, 但用户要"彻底从历史里抹去某个策略测试盘"也有需求.
   */
  async deleteForUser(
    userId: number,
    portfolioId: number,
    opts: { hard?: boolean } = {}
  ): Promise<void> {
    this.assertUserId(userId);
    const p = await this.findOwnedPortfolio(userId, portfolioId, { allowInactive: true });
    const hard = opts.hard === true;

    if (!hard) {
      // 软删
      if (!p.is_active) {
        // 已软删过, idempotent return (不抛错, 让 UI 不区分"已删"和"再删")
        return;
      }
      p.is_active = false;
      // 软删盘自动停止自动跟单防止用户已经按"删"还在被动失血
      p.auto_trade_enabled = false;
      await p.save();
      await this.writeAuditLog(userId, 'delete_soft', p.id, { name: p.name });
      return;
    }

    // hard delete — cascade 删所有关联表
    await sequelize.transaction(async (tx: Transaction) => {
      await PaperTradingPosition.destroy({ where: { portfolio_id: p.id }, transaction: tx });
      await PaperTradingTrade.destroy({ where: { portfolio_id: p.id }, transaction: tx });
      await PaperTradingSnapshot.destroy({ where: { portfolio_id: p.id }, transaction: tx });
      await PaperTradingOrderIntent.destroy({
        where: { portfolio_id: p.id },
        transaction: tx,
      });
      await p.destroy({ transaction: tx });
    });
    await this.writeAuditLog(userId, 'delete_hard', portfolioId, { name: p.name });
  }

  /**
   * 重置 — 清零持仓 + cash 还原到 initial_capital. 保留 portfolio.id /
   * historical trades / historical snapshots 用于复盘对照 (用户想看
   * "上次跑这策略效果如何, 这次重新跑").
   *
   * 注意: trades / snapshots 不删 (用户可能想看历史曲线). 如要"真正干净重启"
   * 应该用 deleteForUser hard=true 然后 createForUser.
   */
  async resetForUser(userId: number, portfolioId: number): Promise<void> {
    this.assertUserId(userId);
    const p = await this.findOwnedPortfolio(userId, portfolioId, { allowInactive: false });

    await sequelize.transaction(async (tx: Transaction) => {
      await PaperTradingPosition.destroy({ where: { portfolio_id: p.id }, transaction: tx });
      const cap = Number(p.initial_capital);
      p.current_cash = cap;
      p.total_value = cap;
      await p.save({ transaction: tx });
    });

    await this.writeAuditLog(userId, 'reset', p.id, {
      name: p.name,
      restored_cash: Number(p.initial_capital),
    });
  }

  /**
   * 列出所有 active 策略 (UI 选盘配置时用).
   * AT-2-FIX (2026-06-22 二轮 review): contract 改 strategy_key → key, description → brief
   * 对齐 FE Transfer/Modal contract. 之前 Transfer 因为读 `s.key` 拿 undefined,
   * 选择整个失效 (P0 阻塞模拟盘创建).
   */
  listAvailableStrategies(): AvailableStrategy[] {
    return strategyRegistry.list().map(def => ({
      key: def.strategy_key,
      name: def.name,
      brief: def.description,
      category: String(def.category || 'other'),
      risk_level: def.risk_level,
      tags: Array.isArray(def.tags) ? [...def.tags] : [],
      enabled: def.enabled === true,
    }));
  }

  /**
   * 列出所有已注册因子 (UI 选盘配置时用).
   * AT-2-FIX (2026-06-22 二轮 review): contract 加 key 字段对齐 FE Transfer.
   */
  listAvailableFactors(): AvailableFactor[] {
    return factorRegistry.list().map(f => ({
      key: f.name, // factor registry 的 name 就是 unique key
      name: f.description || f.name,
      brief: f.description || '',
      category: String(f.category || 'other'),
    }));
  }

  // ---------- Private helpers ----------

  private assertUserId(userId: number): void {
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new PortfolioCrudError('user_id 缺失或无效', {
        code: 'INVALID_USER_ID',
        statusCode: 401,
      });
    }
  }

  /**
   * 查指定 user 名下的指定 portfolio. 不存在 / 不属于该 user → throw 404.
   * 不区分 "盘不存在" 和 "盘不属于你" 防 enumeration 泄露.
   */
  private async findOwnedPortfolio(
    userId: number,
    portfolioId: number,
    opts: { allowInactive?: boolean } = {}
  ): Promise<PaperTradingPortfolio> {
    if (!Number.isFinite(portfolioId) || portfolioId <= 0) {
      throw new PortfolioCrudError('portfolio_id 无效', {
        code: 'INVALID_PORTFOLIO_ID',
        statusCode: 400,
      });
    }
    const where: any = { id: portfolioId, user_id: userId };
    if (!opts.allowInactive) where.is_active = true;
    const p = await PaperTradingPortfolio.findOne({ where });
    if (!p) {
      throw new PortfolioCrudError('未找到模拟盘 (或无权访问)', {
        code: 'PORTFOLIO_NOT_FOUND',
        statusCode: 404,
      });
    }
    return p;
  }

  private async toListItem(p: PaperTradingPortfolio): Promise<PortfolioListItem> {
    const [position_count, baseline7, baseline30] = await Promise.all([
      PaperTradingPosition.count({
        where: { portfolio_id: p.id, quantity: { [Op.gt]: 0 } },
      }),
      this.findBaselineSnapshot(p.id, 7),
      this.findBaselineSnapshot(p.id, 30),
    ]);
    const strategy_keys = Array.isArray(p.strategy_keys) ? [...p.strategy_keys] : [];
    const enabled_factors = Array.isArray(p.enabled_factors) ? [...p.enabled_factors] : [];
    const initial = Number(p.initial_capital);
    const total = Number(p.total_value);
    return {
      id: p.id,
      name: p.name,
      description: p.description || null,
      initial_capital: initial,
      current_cash: Number(p.current_cash),
      total_value: total,
      is_active: p.is_active === true,
      auto_trade_enabled: p.auto_trade_enabled === true,
      strategy_keys,
      strategy_display: expandStrategyDisplay(strategy_keys),
      enabled_factors,
      factor_display: expandFactorDisplay(enabled_factors),
      position_count,
      recent_7d_return_pct: computeReturnPct(total, baseline7, initial),
      recent_30d_return_pct: computeReturnPct(total, baseline30, initial),
      total_return_pct: initial > 0 ? Math.round(((total - initial) / initial) * 10000) / 100 : 0,
      created_at: p.created_at,
    };
  }

  /**
   * 找该 portfolio 在 N 天前 (或更早最近一条) 的 snapshot.total_value 作为基线.
   * 缺数据 (盘建立 < N 日) → null.
   */
  private async findBaselineSnapshot(portfolioId: number, daysAgo: number): Promise<number | null> {
    const cutoffDate = new Date(Date.now() - daysAgo * 86400_000);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const snap = await PaperTradingSnapshot.findOne({
      where: { portfolio_id: portfolioId, date: { [Op.lte]: cutoff } },
      order: [['date', 'DESC']],
      attributes: ['total_value', 'date'],
    });
    if (!snap) return null;
    const tv = Number(snap.total_value);
    return Number.isFinite(tv) ? tv : null;
  }

  /**
   * 写 audit log (RiskAlert level=LOW). 失败 try/catch + log warn, 不阻塞主流程
   * (audit 是审计副作用, 操作本身已经成功).
   */
  private async writeAuditLog(
    userId: number,
    action: 'create' | 'update' | 'delete_soft' | 'delete_hard' | 'reset',
    portfolioId: number,
    detail: Record<string, unknown>
  ): Promise<void> {
    try {
      const actionLabel = {
        create: '创建',
        update: '更新',
        delete_soft: '软删除',
        delete_hard: '物理删除',
        reset: '重置',
      }[action];
      const summary = `用户 ${userId} ${actionLabel} portfolio ${portfolioId}`;
      await RiskAlert.create({
        user_id: userId,
        symbol: AUDIT_SYMBOL,
        name: `portfolio:${portfolioId}`,
        level: AUDIT_LEVEL,
        rule_id: AUDIT_RULE_ID,
        message: `${summary} | ${JSON.stringify(detail)}`,
      } as any);
    } catch (err: any) {
      logger.warn(
        `[PaperTradingPortfolioCrudService] audit log 写入失败 (user=${userId} action=${action} pid=${portfolioId}): ${
          err?.message || err
        }`
      );
    }
  }
}

export const paperTradingPortfolioCrudService = new PaperTradingPortfolioCrudService();
