import { Request, Response } from 'express';
import { Op, fn, col, literal } from 'sequelize';
import { logger } from '../../utils/logger';
import { factorRegistry } from '../../quant/factors/FactorRegistry';
// Side-effect import: register all 8 factors into the singleton (US-010).
import '../../quant/factors/library';
import { FactorScore } from '../../models/FactorScore';
import {
  MultiFactorAlphaStrategy,
  DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS,
  MultiFactorAlphaParams,
} from '../../quant/strategies/MultiFactorAlphaStrategy';

/**
 * FactorController — US-015 因子选股工作区后端
 *
 * 三个 HTTP 端点：
 *   GET  /api/factors/overview                      → 8 因子列表 + 最新计算日 + 覆盖统计
 *   POST /api/factors/preview                       → 自定义权重 + 参数预览 top-N 选股
 *   GET  /api/strategies/multi-factor/latest-picks  → 多因子策略最近一次调仓结果
 *
 * 依赖：
 *   - factorRegistry (单例) ← library/*.ts 在 import-time self-register
 *   - MultiFactorAlphaStrategy (默认 PRODUCTION_DATA_SOURCE，走 FactorScore + Stock)
 *
 * 注意：MFA `latest-picks` 路由必须在 strategy.routes.ts 的 `/:strategyId` 之前注册，
 *      否则会被 :strategyId 通配。本 controller 仅暴露 handler，路由次序由
 *      strategy.routes.ts 负责。
 */
export class FactorController {
  private readonly multiFactorStrategy = new MultiFactorAlphaStrategy();

  // ---------- GET /api/factors/overview --------------------------------------
  /**
   * 返回所有已注册因子的元数据 + 最近一次计算的统计信息。
   *
   * 响应 shape：
   *   {
   *     success: true,
   *     data: {
   *       latest_trade_date: '2026-06-05' | null,
   *       factors: [{
   *         name, description, category,
   *         latest_trade_date: string | null,
   *         universe_size: number,          // 该日该因子写了多少行
   *         non_neutral_count: number,      // raw_value != null 的行数（有效覆盖）
   *       }]
   *     }
   *   }
   *
   * 边缘情况：
   *   - factor_scores 表为空：latest_trade_date=null, 每个因子统计 0
   *   - 因子未跑 pipeline：该因子 latest_trade_date=null, universe_size=0
   */
  async getOverview(_req: Request, res: Response) {
    try {
      const factors = factorRegistry.list();
      const factorNames = factors.map(f => f.name);

      // 1) 找出整张表里最新的 trade_date（作为前端 KPI 用）
      const latestRow = await FactorScore.findOne({
        attributes: [[fn('MAX', col('trade_date')), 'latest_trade_date']],
        raw: true,
      });
      const latestTradeDate =
        (latestRow as unknown as { latest_trade_date?: string | Date | null } | null)
          ?.latest_trade_date ?? null;
      const latestDateIso = normalizeDateIso(latestTradeDate);

      // 2) 对每个因子单独算 (latest_trade_date, universe_size, non_neutral_count)
      //    一次查询拿所有，再按 factor_name 分组——避免 8 次 round-trip。
      type StatRow = {
        factor_name: string;
        latest_trade_date: string | Date | null;
      };
      const perFactorLatest = (await FactorScore.findAll({
        attributes: ['factor_name', [fn('MAX', col('trade_date')), 'latest_trade_date']],
        where: { factor_name: { [Op.in]: factorNames } },
        group: ['factor_name'],
        raw: true,
      })) as unknown as StatRow[];

      const latestByFactor = new Map<string, string | null>();
      for (const r of perFactorLatest) {
        latestByFactor.set(r.factor_name, normalizeDateIso(r.latest_trade_date));
      }

      // 3) 对每个因子在其 latest_trade_date 的横截面，分别算 universe / non-neutral
      //    并发执行，避免线性等待
      const factorStats = await Promise.all(
        factors.map(async f => {
          const latest = latestByFactor.get(f.name);
          if (!latest) {
            return {
              name: f.name,
              description: f.description,
              category: f.category ?? 'other',
              latest_trade_date: null as string | null,
              universe_size: 0,
              non_neutral_count: 0,
            };
          }
          const [{ universe_size }, { non_neutral_count }] = (await Promise.all([
            FactorScore.findOne({
              attributes: [[fn('COUNT', literal('*')), 'universe_size']],
              where: { trade_date: latest, factor_name: f.name },
              raw: true,
            }),
            FactorScore.findOne({
              attributes: [[fn('COUNT', literal('*')), 'non_neutral_count']],
              where: {
                trade_date: latest,
                factor_name: f.name,
                raw_value: { [Op.ne]: null },
              },
              raw: true,
            }),
          ])) as unknown as [
            { universe_size: string | number },
            { non_neutral_count: string | number }
          ];
          return {
            name: f.name,
            description: f.description,
            category: f.category ?? 'other',
            latest_trade_date: latest,
            universe_size: Number(universe_size ?? 0),
            non_neutral_count: Number(non_neutral_count ?? 0),
          };
        })
      );

      res.json({
        success: true,
        data: {
          latest_trade_date: latestDateIso,
          factors: factorStats,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getOverview failed:', error);
      res.status(500).json({ success: false, message });
    }
  }

  // ---------- POST /api/factors/preview --------------------------------------
  /**
   * 自定义权重 + 参数预览多因子选股结果。
   *
   * 请求 body（全部可选）：
   *   {
   *     trade_date?: string,              // YYYY-MM-DD；缺省 = factor_scores 最新一日
   *     weights?: Record<string, number>, // 因子权重；缺省 = MFA 默认 8 因子等权
   *     topN?: number,                    // 默认 30
   *     industryNeutral?: boolean,        // 默认 true
   *     maxPerIndustry?: number,          // 默认 3
   *     excludeST?: boolean,              // 默认 true
   *     excludeNew60d?: boolean,          // 默认 true
   *   }
   *
   * 响应 = MFA.generateSignals 完整结果（包含 target_portfolio / signals / filtered / params）。
   */
  async previewSelection(req: Request, res: Response) {
    try {
      const body = (req.body ?? {}) as Partial<{
        trade_date: unknown;
        weights: unknown;
        topN: unknown;
        industryNeutral: unknown;
        maxPerIndustry: unknown;
        excludeST: unknown;
        excludeNew60d: unknown;
      }>;

      // 1) 确定 trade_date：用户传了用用户的；否则取库里最新
      let tradeDate: string;
      if (typeof body.trade_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.trade_date)) {
        tradeDate = body.trade_date;
      } else {
        const latest = await findLatestFactorTradeDate();
        if (!latest) {
          res.status(400).json({
            success: false,
            message: '因子表为空：请先运行 npm run compute:factors -- --date=YYYY-MM-DD',
          });
          return;
        }
        tradeDate = latest;
      }

      // 2) 构造 override params；非法字段直接拒绝
      const override: Partial<MultiFactorAlphaParams> = {};
      if (body.weights !== undefined) {
        if (!isWeightRecord(body.weights)) {
          res.status(400).json({
            success: false,
            message: 'weights must be an object of {factor_name: number > 0}',
          });
          return;
        }
        override.weights = body.weights;
      }
      if (body.topN !== undefined) {
        const n = Number(body.topN);
        if (!Number.isInteger(n) || n <= 0 || n > 500) {
          res
            .status(400)
            .json({ success: false, message: 'topN must be a positive integer ≤ 500' });
          return;
        }
        override.topN = n;
      }
      if (body.industryNeutral !== undefined)
        override.industryNeutral = Boolean(body.industryNeutral);
      if (body.maxPerIndustry !== undefined) {
        const n = Number(body.maxPerIndustry);
        if (!Number.isInteger(n) || n <= 0) {
          res
            .status(400)
            .json({ success: false, message: 'maxPerIndustry must be a positive integer' });
          return;
        }
        override.maxPerIndustry = n;
      }
      if (body.excludeST !== undefined) override.excludeST = Boolean(body.excludeST);
      if (body.excludeNew60d !== undefined) override.excludeNew60d = Boolean(body.excludeNew60d);

      const result = await this.multiFactorStrategy.generateSignals(tradeDate, {
        params: override,
      });

      res.json({ success: true, data: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.previewSelection failed:', error);
      res.status(500).json({ success: false, message });
    }
  }

  // ---------- GET /api/strategies/multi-factor/latest-picks ------------------
  /**
   * 多因子策略最近一次调仓结果。
   *
   * 实现：取 factor_scores 表的最新 trade_date，跑一次 MFA（使用默认参数与权重），
   *      返回 generateSignals 的完整结果。
   *
   * 注意：本端点是 read-through cache 的简化版——每次实时计算（保证总是最新）。
   *      调用方负责短期缓存（5min）以减少 DB 压力。
   */
  async getMultiFactorLatestPicks(_req: Request, res: Response) {
    try {
      const latest = await findLatestFactorTradeDate();
      if (!latest) {
        res.json({
          success: true,
          data: {
            trade_date: null,
            target_portfolio: [],
            signals: [],
            filtered: { st: 0, new60d: 0, industry_capped: 0, no_factor_data: 0 },
            params: null,
            universe_size: 0,
            eligible_count: 0,
            note: 'factor_scores 表为空 — 请先运行 npm run compute:factors',
          },
        });
        return;
      }
      const result = await this.multiFactorStrategy.generateSignals(latest);
      res.json({ success: true, data: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getMultiFactorLatestPicks failed:', error);
      res.status(500).json({ success: false, message });
    }
  }
}

// ---------- helpers --------------------------------------------------------

/** factor_scores 表里的最新 trade_date；空表返回 null */
async function findLatestFactorTradeDate(): Promise<string | null> {
  const row = await FactorScore.findOne({
    attributes: [[fn('MAX', col('trade_date')), 'latest_trade_date']],
    raw: true,
  });
  return normalizeDateIso(
    (row as unknown as { latest_trade_date?: string | Date | null } | null)?.latest_trade_date ??
      null
  );
}

/** Date | string | null → YYYY-MM-DD | null */
function normalizeDateIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return null;
}

/** 校验 weights 是 Record<string, number> 且所有 value > 0 */
function isWeightRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  for (const [, v] of entries) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return false;
  }
  return true;
}

// Re-export the default weights so factor.routes.ts (and tests) can advertise them
export { DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS };

export const factorController = new FactorController();
