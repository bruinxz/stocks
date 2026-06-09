import { Request, Response } from 'express';
import { Op, fn, col, literal } from 'sequelize';
import { logger } from '../../utils/logger';
import { factorRegistry } from '../../quant/factors/FactorRegistry';
// Side-effect import: register all 8 factors into the singleton (US-010).
import '../../quant/factors/library';
import { FactorScore } from '../../models/FactorScore';
import { Stock } from '../../models/Stock';
import {
  MultiFactorAlphaStrategy,
  DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS,
  MultiFactorAlphaParams,
} from '../../quant/strategies/MultiFactorAlphaStrategy';
import {
  factorDetailService,
  clampLimitDays,
  clampICLimit,
} from '../../quant/factors/FactorDetailService';

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

  // ---------- GET /api/factors/industry-heatmap ------------------------------
  /**
   * 行业 × 因子热力图聚合 (US-074)。
   *
   * 给定 trade_date（缺省 = factor_scores 最新一日），返回每个 (industry, factor)
   * 组合的横截面 z_score 平均值与样本数，前端用 echarts heatmap 渲染。
   *
   * Query：
   *   - date?: YYYY-MM-DD；缺省 = factor_scores 表里最新的 trade_date
   *
   * 响应：
   *   {
   *     success: true,
   *     data: {
   *       trade_date: '2026-06-05' | null,
   *       factors: string[],              // 横轴（按注册顺序）
   *       industries: string[],           // 纵轴（按平均分降序，便于"哪个行业最强"扫读）
   *       cells: [{ industry, factor, avg_z, sample_size }],  // 仅非空格
   *       universe_size: number,          // 命中 stock_code 数（既在 factor_scores 又在 stocks 表）
   *       note?: string,                  // factor_scores 为空 / 给定日无数据时的解释
   *     }
   *   }
   *
   * 设计说明：
   *   - JOIN factor_scores ↔ stocks 走"在 TS 内 IN-memory 聚合"：当日全市场
   *     ~4k 股 × 8 因子 = 32k 行 + ~4k 股的 (symbol, industry) 字典，纯
   *     Sequelize 两次 findAll 足够（毫秒级）。避免 raw SQL 让单元测试用
   *     fake model 替换更方便。
   *   - stock_code 与 symbol 的 .SH/.SZ/.BJ 后缀映射复用 MFA 的
   *     guessStockSymbol → 一处定义、多处使用，与 US-015 的 loadStockMeta
   *     行为对齐。
   *   - 行业映射：每个 stock_code 一个 industry 字符串（'其他' 兜底）。无
   *     industry 字段的股票合并到 '其他' 行，前端 z 值仍参与平均（保留行
   *     业总览的全集统计）。
   *   - 排序：横轴按 FactorRegistry 注册顺序（与 overview 一致）；纵轴按
   *     "全因子平均 z 之和" 降序，让最受多因子青睐的行业排顶。
   */
  async getIndustryHeatmap(req: Request, res: Response) {
    try {
      // 1) 解析 date 参数
      const dateParam = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      let tradeDate: string | null = null;
      if (dateParam) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
          res.status(400).json({
            success: false,
            message: 'date 必须为 YYYY-MM-DD 格式',
          });
          return;
        }
        tradeDate = dateParam;
      } else {
        tradeDate = await findLatestFactorTradeDate();
      }

      const registeredFactors = factorRegistry.list().map(f => f.name);

      if (!tradeDate) {
        res.json({
          success: true,
          data: {
            trade_date: null,
            factors: registeredFactors,
            industries: [],
            cells: [],
            universe_size: 0,
            note: 'factor_scores 表为空 — 请先运行 npm run compute:factors -- --date=YYYY-MM-DD',
          },
        });
        return;
      }

      // 2) 拉当日 factor_scores（仅注册过的因子）
      const rows = (await FactorScore.findAll({
        attributes: ['stock_code', 'factor_name', 'z_score'],
        where: {
          trade_date: tradeDate,
          factor_name: { [Op.in]: registeredFactors },
          raw_value: { [Op.ne]: null }, // 中性行不参与平均
        },
        raw: true,
      })) as unknown as Array<{
        stock_code: string;
        factor_name: string;
        z_score: number | string;
      }>;

      if (rows.length === 0) {
        res.json({
          success: true,
          data: {
            trade_date: tradeDate,
            factors: registeredFactors,
            industries: [],
            cells: [],
            universe_size: 0,
            note: `${tradeDate} 日 factor_scores 无非中性数据`,
          },
        });
        return;
      }

      // 3) 拉股票元数据（industry 映射）
      const uniqueCodes = Array.from(new Set(rows.map(r => r.stock_code)));
      const symbols = uniqueCodes.map(code => guessSymbolFromCode(code));
      const stockRows = (await Stock.findAll({
        attributes: ['symbol', 'industry'],
        where: { symbol: { [Op.in]: symbols } },
        raw: true,
      })) as unknown as Array<{ symbol: string; industry: string | null }>;

      const codeToIndustry = new Map<string, string>();
      for (const r of stockRows) {
        const code = stripSymbolSuffix(r.symbol);
        codeToIndustry.set(code, (r.industry || '').trim() || '其他');
      }

      // 4) 聚合：(industry, factor) → { sum_z, count }
      const cellMap = new Map<string, { sum_z: number; count: number }>();
      const industrySet = new Set<string>();
      let universeSize = 0;
      const seenCodes = new Set<string>();

      for (const row of rows) {
        const industry = codeToIndustry.get(row.stock_code) ?? '其他';
        industrySet.add(industry);
        const z = typeof row.z_score === 'string' ? Number(row.z_score) : row.z_score;
        if (!Number.isFinite(z)) continue;
        const key = `${industry}|${row.factor_name}`;
        const prev = cellMap.get(key);
        if (prev) {
          prev.sum_z += z;
          prev.count += 1;
        } else {
          cellMap.set(key, { sum_z: z, count: 1 });
        }
        if (!seenCodes.has(row.stock_code)) {
          seenCodes.add(row.stock_code);
          universeSize += 1;
        }
      }

      // 5) 输出 cells + 行业排序（按"行业全因子均值之和"降序）
      const cells: Array<{
        industry: string;
        factor: string;
        avg_z: number;
        sample_size: number;
      }> = [];
      const industryScoreSum = new Map<string, number>();
      for (const [key, value] of cellMap.entries()) {
        const sep = key.indexOf('|');
        const industry = key.slice(0, sep);
        const factor = key.slice(sep + 1);
        const avgZ = value.count > 0 ? value.sum_z / value.count : 0;
        cells.push({
          industry,
          factor,
          avg_z: Number(avgZ.toFixed(4)),
          sample_size: value.count,
        });
        industryScoreSum.set(industry, (industryScoreSum.get(industry) ?? 0) + avgZ);
      }
      const industries = Array.from(industrySet).sort(
        (a, b) => (industryScoreSum.get(b) ?? 0) - (industryScoreSum.get(a) ?? 0)
      );

      res.json({
        success: true,
        data: {
          trade_date: tradeDate,
          factors: registeredFactors,
          industries,
          cells,
          universe_size: universeSize,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getIndustryHeatmap failed:', error);
      res.status(500).json({ success: false, message });
    }
  }

  // ---------- GET /api/factors/:name/detail ----------------------------------
  /**
   * 因子详情聚合 — US-094 因子卡片"点击 → 弹出抽屉"使用。
   *
   * 返回 3 段数据：
   *   - 因子元信息（name / description / category，从 FactorRegistry 拿）
   *   - IC 历史曲线（按 period_end ASC，默认取最近 60 条 lookForward=1 的 IC）
   *   - 5 等分组合累计净值曲线 Q1..Q5（默认最近 120 个交易日，起点 1.0）
   *
   * Query：
   *   - limit_days?: 1..250；缺省 = 120
   *   - ic_limit?:   1..200；缺省 = 60
   *
   * 路由顺序约束：必须在 factor.routes.ts 中 `/overview` / `/preview` / `/industry-heatmap`
   * 之后注册（否则 :name 通配会吞这些静态路径）。同 US-015 / US-093 的"静态优先 + :param
   * 最后"模式。
   *
   * 错误：
   *   - 400 factor name 校验（非 snake_case / 空 / 含特殊字符）；
   *   - 400 limit_days / ic_limit 非整数（service 内自动 clamp，controller 只校验 name）；
   *   - 404 factor 未注册（registry.has=false）；
   *   - 500 DB / 内部错误。
   */
  async getFactorDetail(req: Request, res: Response) {
    try {
      const name = String(req.params.name || '').trim();
      // 与 strategy_key 同款严格 pattern：snake_case，避免 path traversal / 引号注入
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        res.status(400).json({
          success: false,
          message: `factor name 必须为 snake_case（^[a-z][a-z0-9_]*$），收到："${name}"`,
        });
        return;
      }
      if (!factorRegistry.has(name)) {
        res.status(404).json({
          success: false,
          message: `factor "${name}" 未注册。已知因子：${
            factorRegistry.listNames().join(', ') || '(empty)'
          }`,
        });
        return;
      }
      const limitDays = clampLimitDays(req.query.limit_days);
      const icLimit = clampICLimit(req.query.ic_limit);
      const detail = await factorDetailService.getDetail(name, {
        limit_days: limitDays,
        ic_limit: icLimit,
      });
      res.json({ success: true, data: detail });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getFactorDetail failed:', error);
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

/** "600519" → "600519.SH"，"000001" → "000001.SZ"；已带 . 直接返回。镜像 MFA loadStockMeta 的同名逻辑。 */
function guessSymbolFromCode(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  if (head === '6') return `${stockCode}.SH`;
  if (head === '0' || head === '3') return `${stockCode}.SZ`;
  if (head === '4' || head === '8') return `${stockCode}.BJ`;
  return `${stockCode}.SZ`;
}

/** "600519.SH" → "600519" */
function stripSymbolSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

// Re-export the default weights so factor.routes.ts (and tests) can advertise them
export { DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS };

export const factorController = new FactorController();
