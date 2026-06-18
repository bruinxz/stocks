import { Request, Response } from 'express';
import { Op, fn, col, literal } from 'sequelize';
import { logger } from '../../utils/logger';
import { factorRegistry } from '../../quant/factors/FactorRegistry';
// Side-effect import: register all 8 factors into the singleton (US-010).
import '../../quant/factors/library';
import { FactorScore } from '../../models/FactorScore';
import { Stock } from '../../models/Stock';
import { IndustryFlow } from '../../models/IndustryFlow';
import { LimitUpStock } from '../../models/LimitUpStock';
import { SnowballHotKeyword } from '../../models/SnowballHotKeyword';
import { MarketNews } from '../../models/MarketNews';
import { SocialSentimentSnapshot } from '../../models/SocialSentimentSnapshot';
import { MarketHotSearch } from '../../models/MarketHotSearch';
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
  /**
   * In-memory 缓存：overview / industry-heatmap / factor-detail 5min TTL。
   * 因子分数一天才跑一次，没必要每次重算。
   */
  private cache = new Map<string, { expiresAt: number; payload: any }>();
  private readonly CACHE_TTL_MS = 5 * 60_000;

  private getCached<T>(key: string): T | null {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.payload as T;
    if (hit) this.cache.delete(key);
    return null;
  }

  private setCached(key: string, payload: any) {
    this.cache.set(key, { expiresAt: Date.now() + this.CACHE_TTL_MS, payload });
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (v.expiresAt < now) this.cache.delete(k);
      }
    }
  }

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
      // 缓存命中（5min）
      const cached = this.getCached<any>('overview');
      if (cached) {
        return res.json({ success: true, data: cached });
      }

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

      const payload = {
        latest_trade_date: latestDateIso,
        factors: factorStats,
      };
      this.setCached('overview', payload);
      res.json({ success: true, data: payload });
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

      // 缓存命中（5min）
      const cacheKey = `heatmap:${dateParam || 'auto'}`;
      const cached = this.getCached<any>(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached });
      }

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

      const payload = {
        trade_date: tradeDate,
        factors: registeredFactors,
        industries,
        cells,
        universe_size: universeSize,
      };
      this.setCached(cacheKey, payload);
      res.json({ success: true, data: payload });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getIndustryHeatmap failed:', error);
      res.status(500).json({ success: false, message });
    }
  }

  // ---------- GET /api/factors/industry-board --------------------------------
  /**
   * Batch AF (2026-06-18) — 行业决策面板 (面向"今天买什么板块/什么股").
   *
   * 和老 industry-heatmap (因子 z_score 平均) 完全不同：本端点直接读
   * IndustryFlow / LimitUpStock / SnowballHotKeyword 真盘口数据,
   * 让用户在一个屏幕看到:
   *   - "今天哪些板块在涨 + 主力在流入" (industries — 按今日 main_inflow desc)
   *   - "板块龙头股 + 涨停个数" (一眼看到能跟谁)
   *   - "近 5 日的连续表现" (per industry 时间序列, 用于辨"持续轮动" vs "一日游")
   *   - "今日热门概念 / 关联股" (跨行业主题, 比如 'AI 算力')
   *
   * Query:
   *   - date?: YYYY-MM-DD  缺省 = IndustryFlow 最新交易日
   *   - top?:  number       行业行数 (按今日 main_inflow desc), 默认 30, 上限 100
   *   - lookback?: number   时间序列窗口, 默认 5 个交易日, 范围 [1, 20]
   *
   * Response:
   *   {
   *     trade_date: '2026-06-18',
   *     dates: ['2026-06-12', ..., '2026-06-18'],   // 由近到远顺序 ASC
   *     industries: [{
   *       industry_code, industry_name,
   *       today: { change_pct, main_inflow, main_inflow_ratio, limit_up_count,
   *                advancing_count, declining_count,
   *                leader_stock_code, leader_stock_name, leader_stock_change_pct },
   *       series: Array<{ trade_date, change_pct, main_inflow_ratio }>   // 长度 = lookback
   *     }],
   *     hot_concepts: [{
   *       keyword, heat_score, rank, is_new,
   *       related_stocks: [{stock_code, stock_name}]   // 截断 top 5
   *     }],
   *     universe_size: number,    // 当日 IndustryFlow 行数
   *     note?: string,
   *   }
   *
   * 设计:
   *   - 不做 join: IndustryFlow 已宽表 (含 leader stock + limit_up_count), 一次查就够
   *   - hot_concepts 来自 SnowballHotKeyword 当日榜单 (按 heat_score desc, 取 top 12)
   *   - 缓存 5min (盘中只在 15:30 sync 后变化, 缓存命中率高)
   */
  async getIndustryBoard(req: Request, res: Response) {
    try {
      const dateParam = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      const topParam = Number(req.query.top);
      const lookbackParam = Number(req.query.lookback);

      if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        res.status(400).json({ success: false, message: 'date 必须为 YYYY-MM-DD 格式' });
        return;
      }
      const topN = Number.isInteger(topParam) && topParam > 0 ? Math.min(topParam, 100) : 30;
      const lookback =
        Number.isInteger(lookbackParam) && lookbackParam > 0 ? Math.min(lookbackParam, 20) : 5;

      const cacheKey = `industry-board:${dateParam || 'auto'}:${topN}:${lookback}`;
      const cached = this.getCached<any>(cacheKey);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      // 1) 确定 trade_date — 缺省取 IndustryFlow 最新一日
      let tradeDate: string | null;
      if (dateParam) {
        tradeDate = dateParam;
      } else {
        const row = (await IndustryFlow.findOne({
          attributes: [[fn('MAX', col('trade_date')), 'd']],
          raw: true,
        })) as unknown as { d?: string | Date | null } | null;
        tradeDate = normalizeDateIso(row?.d ?? null);
      }

      if (!tradeDate) {
        res.json({
          success: true,
          data: {
            trade_date: null,
            dates: [],
            industries: [],
            hot_concepts: [],
            universe_size: 0,
            note: 'industry_flows 表为空 — 请在 SchedulerService 启用 INDUSTRY_FLOW_SYNC 后再访问',
          },
        });
        return;
      }

      // 2) 今日全部 IndustryFlow 行 → 按 main_inflow desc 取 topN
      const todayRows = (await IndustryFlow.findAll({
        where: { trade_date: tradeDate },
        raw: true,
      })) as unknown as Array<{
        industry_code: string;
        industry_name: string;
        change_pct: number | string | null;
        main_inflow: number | string | null;
        main_inflow_ratio: number | string | null;
        limit_up_count: number | string | null;
        leader_stock_code: string | null;
        leader_stock_name: string | null;
        leader_stock_change_pct: number | string | null;
        advancing_count: number | string | null;
        declining_count: number | string | null;
      }>;

      if (todayRows.length === 0) {
        res.json({
          success: true,
          data: {
            trade_date: tradeDate,
            dates: [],
            industries: [],
            hot_concepts: [],
            universe_size: 0,
            note: `${tradeDate} 当日 industry_flows 无数据 — 该日可能未做 sync`,
          },
        });
        return;
      }

      // 排序: 按今日主力净流入 desc; null 视作 -Infinity 排尾
      todayRows.sort((a, b) => {
        const av = toNum(a.main_inflow);
        const bv = toNum(b.main_inflow);
        const an = av === null ? Number.NEGATIVE_INFINITY : av;
        const bn = bv === null ? Number.NEGATIVE_INFINITY : bv;
        return bn - an;
      });
      const topRows = todayRows.slice(0, topN);
      const topCodes = topRows.map(r => r.industry_code);

      // 3) 近 lookback 个 distinct trade_date (含今日)
      const distinctDates = (await IndustryFlow.findAll({
        attributes: [[fn('DISTINCT', col('trade_date')), 'trade_date']],
        where: { trade_date: { [Op.lte]: tradeDate } },
        order: [['trade_date', 'DESC']],
        limit: lookback,
        raw: true,
      })) as unknown as Array<{ trade_date: string | Date }>;
      const dates = distinctDates
        .map(r => normalizeDateIso(r.trade_date))
        .filter((d): d is string => !!d)
        .sort(); // ASC

      // 4) 拉这些日期里 topCodes 的 series
      const seriesRows = (await IndustryFlow.findAll({
        attributes: ['trade_date', 'industry_code', 'change_pct', 'main_inflow_ratio'],
        where: {
          trade_date: { [Op.in]: dates },
          industry_code: { [Op.in]: topCodes },
        },
        raw: true,
      })) as unknown as Array<{
        trade_date: string | Date;
        industry_code: string;
        change_pct: number | string | null;
        main_inflow_ratio: number | string | null;
      }>;

      const seriesByCode = new Map<
        string,
        Map<string, { change_pct: number | null; main_inflow_ratio: number | null }>
      >();
      for (const r of seriesRows) {
        const dt = normalizeDateIso(r.trade_date);
        if (!dt) continue;
        let m = seriesByCode.get(r.industry_code);
        if (!m) {
          m = new Map();
          seriesByCode.set(r.industry_code, m);
        }
        m.set(dt, {
          change_pct: toNum(r.change_pct),
          main_inflow_ratio: toNum(r.main_inflow_ratio),
        });
      }

      const industries = topRows.map(row => {
        const m = seriesByCode.get(row.industry_code) ?? new Map();
        const series = dates.map(d => {
          const cell = m.get(d);
          return {
            trade_date: d,
            change_pct: cell?.change_pct ?? null,
            main_inflow_ratio: cell?.main_inflow_ratio ?? null,
          };
        });
        return {
          industry_code: row.industry_code,
          industry_name: row.industry_name,
          today: {
            change_pct: toNum(row.change_pct),
            main_inflow: toNum(row.main_inflow),
            main_inflow_ratio: toNum(row.main_inflow_ratio),
            limit_up_count: toNum(row.limit_up_count) ?? 0,
            advancing_count: toNum(row.advancing_count),
            declining_count: toNum(row.declining_count),
            leader_stock_code: row.leader_stock_code,
            leader_stock_name: row.leader_stock_name,
            leader_stock_change_pct: toNum(row.leader_stock_change_pct),
          },
          series,
        };
      });

      // 5) 今日热门概念 (top 12 by heat_score)
      // SnowballHotKeyword 表里 keyword = 股票简称 (按数据源约定), 用户在前端能直观
      // 看到当下市场关注度排前的标的。
      const conceptRows = (await SnowballHotKeyword.findAll({
        where: { trade_date: tradeDate },
        attributes: ['keyword', 'heat_score', 'rank', 'is_new', 'related_stocks_json'],
        order: [['heat_score', 'DESC']],
        limit: 12,
        raw: true,
      })) as unknown as Array<{
        keyword: string;
        heat_score: number | string | null;
        rank: number | string | null;
        is_new: boolean;
        related_stocks_json: any;
      }>;
      const hot_concepts = conceptRows.map(r => {
        const related = Array.isArray(r.related_stocks_json) ? r.related_stocks_json : [];
        return {
          keyword: r.keyword,
          heat_score: toNum(r.heat_score) ?? 0,
          rank: toNum(r.rank),
          is_new: Boolean(r.is_new),
          related_stocks: related.slice(0, 5).map((s: any) => ({
            stock_code: String(s?.stock_code ?? ''),
            stock_name: String(s?.stock_name ?? ''),
          })),
        };
      });

      // 6) 今日涨停统计 (附加 KPI) — 注意 limit_up_today 是当前 trade_date (可能滞后) 的
      const limitUpToday = await LimitUpStock.count({ where: { trade_date: tradeDate } });

      // 6b) 数据陈旧度检测 — trade_date vs 实际今日的差
      const todayIso = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // 上海时区粗略
      const lagDays = Math.max(
        0,
        Math.round((new Date(todayIso).getTime() - new Date(tradeDate).getTime()) / 86_400_000)
      );
      const dataStaleness =
        lagDays === 0 ? 'fresh' : lagDays <= 2 ? 'recent' : lagDays <= 7 ? 'stale' : 'very_stale';

      // 7) 近 2 日市场要闻 (Batch AG) — 同一 endpoint 给前端时间线用
      let recentNews: Array<{
        title: string;
        publish_time: string;
        source: string;
        category: string | null;
        url: string | null;
      }> = [];
      try {
        const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
        const newsRows = (await MarketNews.findAll({
          attributes: ['title', 'publish_time', 'source', 'category', 'url'],
          where: { publish_date: { [Op.gte]: twoDaysAgo } },
          order: [['publish_time', 'DESC']],
          limit: 25,
          raw: true,
        })) as unknown as Array<{
          title: string;
          publish_time: Date | string;
          source: string;
          category: string | null;
          url: string | null;
        }>;
        recentNews = newsRows.map(n => ({
          title: n.title,
          publish_time:
            n.publish_time instanceof Date ? n.publish_time.toISOString() : String(n.publish_time),
          source: n.source,
          category: n.category,
          url: n.url,
        }));
      } catch (err) {
        // MarketNews 表可能未创建或为空, 不要阻塞 industry board
        logger.warn(
          `getIndustryBoard MarketNews fetch failed: ${(err as Error).message} (board 仍正常返回)`
        );
      }

      const payload = {
        trade_date: tradeDate,
        today_iso: todayIso,
        lag_days: lagDays,
        data_staleness: dataStaleness,
        dates,
        industries,
        hot_concepts,
        universe_size: todayRows.length,
        limit_up_today: limitUpToday,
        recent_news: recentNews,
      };
      this.setCached(cacheKey, payload);
      res.json({ success: true, data: payload });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getIndustryBoard failed:', error);
      res.status(500).json({ success: false, message });
    }
  }

  // ---------- GET /api/factors/sentiment-board -------------------------------
  /**
   * Batch AH (2026-06-18) — 舆情雷达面板.
   *
   * 一站式聚合 (避免前端发 N 个请求):
   *   - today_hot_rank_top20:   东财人气榜 top 20 (按 hot_rank_em ASC)
   *   - today_baidu_top20:      百度搜索热度榜 top 20 (按 rank ASC)
   *   - rank_breakouts:         今日 rank 较 5 日均值跃升 top 10 (异动股发现)
   *   - sentiment_scatter:      机构参与 vs 综合评分 散点 (top-100 universe)
   *   - recent_sentiment_news:  MarketNews 中含情绪关键词的近 2 日要闻
   *
   * 每个 block 独立 try/catch + fallback (同 TodayWorkspace 3-card 范式),
   * 单 block 失败不阻塞其它 block. 缓存 5min.
   *
   * Query:
   *   - date?: YYYY-MM-DD (default = social_sentiment_snapshots 最新日)
   *   - top?:  number     (1-50, default 20)
   *   - breakout_lookback?: number (1-20, default 5)
   *   - news_keywords_csv?: 覆盖默认情绪关键词 (用","分隔)
   *
   * 数据依赖: 需要 SocialSentimentSyncService + MarketHotSearchSyncService cron
   * 已运行. 全 empty 时返回 note 提示运维.
   */
  async getSentimentBoard(req: Request, res: Response) {
    try {
      const dateParam = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        res.status(400).json({ success: false, message: 'date 必须为 YYYY-MM-DD 格式' });
        return;
      }
      const topRaw = Number(req.query.top);
      const top = Number.isInteger(topRaw) && topRaw > 0 ? Math.min(50, topRaw) : 20;

      const cacheKey = `sentiment-board:${dateParam || 'auto'}:${top}`;
      const cached = this.getCached<any>(cacheKey);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      // 1) 确定 trade_date — social_sentiment_snapshots 最新一日
      let tradeDate: string | null;
      if (dateParam) {
        tradeDate = dateParam;
      } else {
        const row = (await SocialSentimentSnapshot.findOne({
          attributes: [[fn('MAX', col('trade_date')), 'd']],
          raw: true,
        })) as unknown as { d?: string | Date | null } | null;
        tradeDate = normalizeDateIso(row?.d ?? null);
      }

      if (!tradeDate) {
        res.json({
          success: true,
          data: {
            trade_date: null,
            today_hot_rank_top20: [],
            today_baidu_top20: [],
            rank_breakouts: [],
            sentiment_scatter: [],
            recent_sentiment_news: [],
            universe_size: 0,
            note: 'social_sentiment_snapshots 表为空 — 请运行 npm run sync:social-sentiment 或等待 cron (16:20)',
          },
        });
        return;
      }

      // 2) 各 block 独立 try/catch
      const errors: Record<string, string> = {};

      // 2a) today_hot_rank_top20
      let today_hot_rank_top20: any[] = [];
      try {
        const rows = (await SocialSentimentSnapshot.findAll({
          where: {
            trade_date: tradeDate,
            hot_rank_em: { [Op.ne]: null },
          },
          attributes: [
            'stock_code',
            'stock_name',
            'hot_rank_em',
            'comment_score',
            'institution_participation',
            'focus_index',
          ],
          order: [['hot_rank_em', 'ASC']],
          limit: top,
          raw: true,
        })) as unknown as Array<{
          stock_code: string;
          stock_name: string | null;
          hot_rank_em: number;
          comment_score: number | string | null;
          institution_participation: number | string | null;
          focus_index: number | string | null;
        }>;
        today_hot_rank_top20 = rows.map(r => ({
          stock_code: r.stock_code,
          stock_name: r.stock_name,
          hot_rank_em: r.hot_rank_em,
          comment_score: toNum(r.comment_score),
          institution_participation: toNum(r.institution_participation),
          focus_index: toNum(r.focus_index),
        }));
      } catch (err) {
        errors.today_hot_rank_top20 = (err as Error).message;
        logger.warn(`sentiment-board hot_rank block failed: ${(err as Error).message}`);
      }

      // 2b) today_baidu_top20
      let today_baidu_top20: any[] = [];
      try {
        const rows = (await MarketHotSearch.findAll({
          where: { trade_date: tradeDate },
          attributes: ['keyword', 'rank', 'search_index', 'change_rate', 'related_stock_code'],
          order: [['rank', 'ASC']],
          limit: top,
          raw: true,
        })) as unknown as Array<{
          keyword: string;
          rank: number;
          search_index: number | string | null;
          change_rate: number | string | null;
          related_stock_code: string | null;
        }>;
        today_baidu_top20 = rows.map(r => ({
          keyword: r.keyword,
          rank: r.rank,
          search_index: toNum(r.search_index),
          change_rate: toNum(r.change_rate),
          related_stock_code: r.related_stock_code,
        }));
      } catch (err) {
        errors.today_baidu_top20 = (err as Error).message;
        logger.warn(`sentiment-board baidu block failed: ${(err as Error).message}`);
      }

      // 2c) rank_breakouts
      let rank_breakouts: any[] = [];
      try {
        const rows = (await SocialSentimentSnapshot.findAll({
          where: {
            trade_date: tradeDate,
            rank_breakout_delta: { [Op.gt]: 0 },
          },
          attributes: [
            'stock_code',
            'stock_name',
            'hot_rank_em',
            'rank_5d_avg',
            'rank_breakout_delta',
            'comment_score',
          ],
          order: [['rank_breakout_delta', 'DESC']],
          limit: 10,
          raw: true,
        })) as unknown as Array<{
          stock_code: string;
          stock_name: string | null;
          hot_rank_em: number | null;
          rank_5d_avg: number | string | null;
          rank_breakout_delta: number | string | null;
          comment_score: number | string | null;
        }>;
        rank_breakouts = rows.map(r => ({
          stock_code: r.stock_code,
          stock_name: r.stock_name,
          hot_rank_em: r.hot_rank_em,
          rank_5d_avg: toNum(r.rank_5d_avg),
          rank_breakout_delta: toNum(r.rank_breakout_delta),
          comment_score: toNum(r.comment_score),
        }));
      } catch (err) {
        errors.rank_breakouts = (err as Error).message;
        logger.warn(`sentiment-board breakout block failed: ${(err as Error).message}`);
      }

      // 2d) sentiment_scatter (top-100 universe by comment_score)
      let sentiment_scatter: any[] = [];
      try {
        const rows = (await SocialSentimentSnapshot.findAll({
          where: {
            trade_date: tradeDate,
            comment_score: { [Op.ne]: null },
            institution_participation: { [Op.ne]: null },
          },
          attributes: [
            'stock_code',
            'stock_name',
            'comment_score',
            'institution_participation',
            'hot_rank_em',
          ],
          order: [['comment_score', 'DESC']],
          limit: 100,
          raw: true,
        })) as unknown as Array<{
          stock_code: string;
          stock_name: string | null;
          comment_score: number | string;
          institution_participation: number | string;
          hot_rank_em: number | null;
        }>;
        sentiment_scatter = rows
          .map(r => {
            const cs = toNum(r.comment_score);
            const ip = toNum(r.institution_participation);
            if (cs == null || ip == null) return null;
            return {
              stock_code: r.stock_code,
              stock_name: r.stock_name,
              comment_score: cs,
              institution_participation: ip,
              hot_rank_em: r.hot_rank_em,
            };
          })
          .filter(Boolean);
      } catch (err) {
        errors.sentiment_scatter = (err as Error).message;
        logger.warn(`sentiment-board scatter block failed: ${(err as Error).message}`);
      }

      // 2e) recent_sentiment_news — MarketNews 关键词过滤
      const newsKeywordsRaw = String(req.query.news_keywords_csv || '').trim();
      const defaultKw = [
        '情绪',
        '关注',
        '抢筹',
        '炒作',
        '热度',
        '躁动',
        '人气',
        '风口',
        '逼空',
        '机构',
        '游资',
        '主力',
        '调研',
        '增持',
        '减持',
        '券商',
        '研报',
        '热门',
        '板块',
        '题材',
        '概念',
        '龙头',
      ];
      const newsKeywords = newsKeywordsRaw
        ? newsKeywordsRaw
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : defaultKw;
      let recent_sentiment_news: any[] = [];
      try {
        const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
        const orClauses = newsKeywords.map(kw => ({ title: { [Op.iLike]: `%${kw}%` } }));
        let newsRows = (await MarketNews.findAll({
          where: {
            publish_date: { [Op.gte]: twoDaysAgo },
            [Op.or]: orClauses,
          },
          attributes: ['title', 'publish_time', 'source', 'category', 'url'],
          order: [['publish_time', 'DESC']],
          limit: 30,
          raw: true,
        })) as unknown as Array<{
          title: string;
          publish_time: Date | string;
          source: string;
          category: string | null;
          url: string | null;
        }>;
        // Fallback: 关键词过滤命中 0 → 直接拿近 2 日 top 15 最新
        if (newsRows.length === 0) {
          newsRows = (await MarketNews.findAll({
            where: { publish_date: { [Op.gte]: twoDaysAgo } },
            attributes: ['title', 'publish_time', 'source', 'category', 'url'],
            order: [['publish_time', 'DESC']],
            limit: 15,
            raw: true,
          })) as any;
        }
        recent_sentiment_news = newsRows.map(n => ({
          title: n.title,
          publish_time:
            n.publish_time instanceof Date ? n.publish_time.toISOString() : String(n.publish_time),
          source: n.source,
          category: n.category,
          url: n.url,
        }));
      } catch (err) {
        errors.recent_sentiment_news = (err as Error).message;
        logger.warn(`sentiment-board news block failed: ${(err as Error).message}`);
      }

      const universeSize = await SocialSentimentSnapshot.count({
        where: { trade_date: tradeDate },
      });

      const todayIso = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const lagDays = Math.max(
        0,
        Math.round((new Date(todayIso).getTime() - new Date(tradeDate).getTime()) / 86_400_000)
      );
      const dataStaleness =
        lagDays === 0 ? 'fresh' : lagDays <= 2 ? 'recent' : lagDays <= 7 ? 'stale' : 'very_stale';

      const payload = {
        trade_date: tradeDate,
        today_iso: todayIso,
        lag_days: lagDays,
        data_staleness: dataStaleness,
        today_hot_rank_top20,
        today_baidu_top20,
        rank_breakouts,
        sentiment_scatter,
        recent_sentiment_news,
        universe_size: universeSize,
        keywords_used: newsKeywords,
        ...(Object.keys(errors).length > 0 ? { block_errors: errors } : {}),
      };
      this.setCached(cacheKey, payload);
      res.json({ success: true, data: payload });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getSentimentBoard failed:', error);
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

  /**
   * GET /api/factors/stock/:stock_code
   * 单股横截面因子分数：返回该股票在最新一天所有因子的 z_score / percentile.
   * Pure code (6 digits) only, e.g. 600519.
   */
  async getStockFactors(req: Request, res: Response) {
    try {
      const rawCode = String(req.params.stock_code || '').trim();
      const code = rawCode.replace(/[a-z]+\.?/i, '');
      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: 'stock_code 必须是 6 位数字' });
      }
      // 找最新 trade_date
      const latestRow = await FactorScore.findOne({
        where: { stock_code: code },
        attributes: [[fn('MAX', col('trade_date')), 'latest_trade_date']],
        raw: true,
      });
      const latest = (latestRow as any)?.latest_trade_date;
      if (!latest) {
        return res.json({
          success: true,
          data: { stock_code: code, trade_date: null, factors: [] },
        });
      }
      const tradeDate = normalizeDateIso(latest);
      const rows = await FactorScore.findAll({
        where: { stock_code: code, trade_date: tradeDate },
        attributes: ['factor_name', 'z_score', 'percentile', 'raw_value'],
        raw: true,
      });
      // join factor metadata (description / category)
      const allFactors = factorRegistry.list();
      const metaMap = new Map(allFactors.map(f => [f.name, f]));
      const items = (rows as any[]).map(r => {
        const meta = metaMap.get(r.factor_name);
        return {
          factor_name: r.factor_name,
          description: meta?.description || '',
          category: meta?.category || 'other',
          z_score: r.z_score != null ? Number(r.z_score) : null,
          percentile: r.percentile != null ? Number(r.percentile) : null,
          raw_value: r.raw_value != null ? Number(r.raw_value) : null,
        };
      });
      // sort by |z_score| desc
      items.sort((a, b) => Math.abs(b.z_score ?? 0) - Math.abs(a.z_score ?? 0));
      res.json({
        success: true,
        data: { stock_code: code, trade_date: tradeDate, factors: items },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('FactorController.getStockFactors failed:', error);
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

/** number|string|null → number|null (NaN/Infinity 也归 null) */
function toNum(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

// Re-export the default weights so factor.routes.ts (and tests) can advertise them
export { DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS };

export const factorController = new FactorController();
