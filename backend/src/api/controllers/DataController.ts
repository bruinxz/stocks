import { Request, Response } from 'express';
import { dataHealthStatusService, listDataSources } from '../../services/DataHealthStatusService';
import { NorthboundSyncService } from '../../data/services/NorthboundSyncService';
import {
  DragonTigerSyncService,
  ListDragonTigerOptions,
} from '../../data/services/DragonTigerSyncService';
import { LimitUpSyncService } from '../../data/services/LimitUpSyncService';
import { IndustrySyncService } from '../../data/services/IndustrySyncService';
import { SnowballHotKeywordSyncService } from '../../data/services/SnowballHotKeywordSyncService';
import { ETFFlowSyncService, ListFlowOptions } from '../../data/services/ETFFlowSyncService';
import { getAllETFIndustries } from '../../constants/etfIndustry';
import { isValidSeatType, SeatType } from '../../constants/famousSeats';
import { logger } from '../../utils/logger';

/**
 * US-079 数据健康度看板控制器（US-088 扩展龙虎榜查询端点 / US-092 扩展 ETF 资金流查询端点）
 *
 * - GET /api/data/health-status                          → 聚合所有数据源最新同步状态
 * - POST /api/data/sync/:source                          → 手动触发指定数据源的同步任务
 * - GET /api/data/dragon-tiger?stock_code=&seat_type=…   → US-088: 按归属机构查询龙虎榜
 * - GET /api/data/etf-flow?industry=&days=…              → US-092: 行业 ETF 资金流查询
 *
 * 手动触发只覆盖"日级 syncDate(date)"类数据源（北向 / 龙虎榜 / 涨停 / 行业流 /
 * 雪球热词）；周期性数据源（财报 / 业绩预告 / 分析师 / 分红 / 股东户数）和
 * 事件流数据源（公告 / KOL）的同步走 per-stock 批量模式，靠 cron 调度而非
 * 用户单次按钮触发——本 controller 返回 400 提示用户走运维 CLI 同步。
 */
export class DataController {
  constructor() {
    this.getHealthStatus = this.getHealthStatus.bind(this);
    this.triggerSync = this.triggerSync.bind(this);
    this.listDragonTiger = this.listDragonTiger.bind(this);
    this.listEtfFlow = this.listEtfFlow.bind(this);
  }

  /**
   * GET /api/data/health-status
   * 返回所有数据源的健康状态卡片 + 汇总。
   */
  async getHealthStatus(_req: Request, res: Response) {
    try {
      const result = await dataHealthStatusService.getHealthStatus();
      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error(`DataController.getHealthStatus failed: ${error?.message ?? error}`);
      return res.status(500).json({
        success: false,
        error: error?.message ?? '获取数据源健康状态失败',
      });
    }
  }

  /**
   * POST /api/data/sync/:source
   *
   * 触发指定数据源的当日同步。:source 必须对应注册中心的 sync_source 字段
   * （northbound / dragon_tiger / limit_up / industry_flow / snowball_hot 之一）。
   *
   * Body 可选 `date` (YYYY-MM-DD)，默认今天 ISO 日期。
   *
   * 返回结构：
   *   { success: true, source, date, result: <服务返回的 SyncDateResult> }
   *
   * 周期性 / per-stock 类数据源（财报 / 分析师 / 公告等）当前返回 400，
   * 提示走运维 CLI（npm run sync:financial-report -- --code=600519）。
   */
  async triggerSync(req: Request, res: Response) {
    const source = String(req.params.source || '').trim();
    const date = String((req.body && req.body.date) || todayIso());

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        error: 'date 必须为 YYYY-MM-DD 格式',
      });
    }

    // 只有 daily 类数据源支持 web 端一键触发
    const dailyRoutes: Record<string, () => Promise<unknown>> = {
      northbound: () => new NorthboundSyncService().syncDate(date),
      dragon_tiger: () => new DragonTigerSyncService().syncDate(date),
      limit_up: () => new LimitUpSyncService().syncDate(date),
      industry_flow: () => new IndustrySyncService().syncDate(date),
      snowball_hot: () => new SnowballHotKeywordSyncService().syncDate(date),
    };

    if (!Object.prototype.hasOwnProperty.call(dailyRoutes, source)) {
      // 校验是 已知 source 但非 daily 类 vs 完全未知 source
      const known = listDataSources().some(s => s.sync_source === source);
      if (known) {
        return res.status(400).json({
          success: false,
          error: `数据源 ${source} 为周期性 / per-stock 同步，请通过运维 CLI 触发 (npm run sync:${source.replace(
            '_',
            '-'
          )})`,
        });
      }
      return res.status(404).json({
        success: false,
        error: `未知数据源: ${source}`,
      });
    }

    try {
      const result = await dailyRoutes[source]();
      return res.json({
        success: true,
        source,
        date,
        result,
      });
    } catch (error: any) {
      logger.error(
        `DataController.triggerSync(${source}, ${date}) failed: ${error?.message ?? error}`
      );
      return res.status(500).json({
        success: false,
        source,
        date,
        error: error?.message ?? '数据源同步失败',
      });
    }
  }

  /**
   * US-088: GET /api/data/dragon-tiger
   *
   * 按归属机构类型 + 股票 + 日期范围查询龙虎榜营业部明细。短线策略 / 前端
   * "机构跟随面板"会按 `seat_type=public_fund` 或 `seat_type=foreign` 拉取。
   *
   * Query 参数：
   *   - `stock_code` (optional) 股票代码（无后缀，例如 600519），缺省返回全市场
   *   - `seat_type`  (optional) 归属机构类型，必须为枚举值之一：
   *                  public_fund | foreign | private_fund | famous_yz | unknown
   *   - `start`      (optional) YYYY-MM-DD，缺省 end-7d
   *   - `end`        (optional) YYYY-MM-DD，缺省今天
   *   - `limit`      (optional) 1..1000，默认 200
   *
   * 返回结构：
   *   { success: true, count, filters, data: DragonTigerEntry[] }
   *
   * seat_type 非法值返回 400；其他参数缺省 fallback 不报错（service 层兜底）。
   */
  async listDragonTiger(req: Request, res: Response) {
    const stockCode =
      typeof req.query.stock_code === 'string' && req.query.stock_code.trim()
        ? String(req.query.stock_code).trim()
        : undefined;
    const seatTypeRaw =
      typeof req.query.seat_type === 'string' && req.query.seat_type.trim()
        ? String(req.query.seat_type).trim()
        : undefined;
    const startRaw =
      typeof req.query.start === 'string' ? String(req.query.start).trim() : undefined;
    const endRaw = typeof req.query.end === 'string' ? String(req.query.end).trim() : undefined;
    const limitRaw =
      typeof req.query.limit === 'string' && req.query.limit.trim()
        ? Number(req.query.limit)
        : undefined;

    let seatType: SeatType | undefined;
    if (seatTypeRaw !== undefined) {
      if (!isValidSeatType(seatTypeRaw)) {
        return res.status(400).json({
          success: false,
          error: `seat_type 必须为 public_fund / foreign / private_fund / famous_yz / unknown 之一，收到: ${seatTypeRaw}`,
        });
      }
      seatType = seatTypeRaw;
    }

    const options: ListDragonTigerOptions = {
      stock_code: stockCode,
      seat_type: seatType,
      start: startRaw,
      end: endRaw,
      limit: limitRaw,
    };

    try {
      const service = new DragonTigerSyncService();
      const data = await service.listEntries(options);
      return res.json({
        success: true,
        count: data.length,
        filters: {
          stock_code: stockCode ?? null,
          seat_type: seatType ?? null,
          start: startRaw ?? null,
          end: endRaw ?? null,
          limit: limitRaw ?? null,
        },
        data,
      });
    } catch (error: any) {
      logger.error(`DataController.listDragonTiger failed: ${error?.message ?? error}`);
      return res.status(500).json({
        success: false,
        error: error?.message ?? '龙虎榜查询失败',
      });
    }
  }

  /**
   * US-092: GET /api/data/etf-flow
   *
   * 行业 ETF 资金流入流出查询. 前端"数据中心 / 行业研究"页面据此展示
   * "近 30 日哪些行业被资金大额申购 / 赎回".
   *
   * Query 参数 (industry 与 etf_code 互斥, industry 优先):
   *   - `industry` (optional) 行业标签 (e.g. "半导体" / "医药"), 必须在白名单内
   *   - `etf_code` (optional) ETF 代码 (e.g. "159995")
   *   - `days`     (optional) 回看自然日数, 默认 30, max 365
   *   - `end`      (optional) 终止日 YYYY-MM-DD, 默认今天
   *   - `limit`    (optional) 行数上限, 默认 5000, max 50000
   *
   * 返回结构:
   *   {
   *     success: true, count, filters,
   *     industries: string[]  ← 全部白名单行业 (供前端下拉)
   *     data: FlowEntry[]    ← (trade_date DESC, etf_code ASC) 排序
   *   }
   *
   * industry 非白名单值不会 4xx, 直接返回 count=0 (与 normalize 风格一致).
   */
  async listEtfFlow(req: Request, res: Response) {
    const industry =
      typeof req.query.industry === 'string' && req.query.industry.trim()
        ? String(req.query.industry).trim()
        : undefined;
    const etfCode =
      typeof req.query.etf_code === 'string' && req.query.etf_code.trim()
        ? String(req.query.etf_code).trim()
        : undefined;
    const daysRaw =
      typeof req.query.days === 'string' && req.query.days.trim()
        ? Number(req.query.days)
        : undefined;
    const endRaw =
      typeof req.query.end === 'string' && req.query.end.trim()
        ? String(req.query.end).trim()
        : undefined;
    const limitRaw =
      typeof req.query.limit === 'string' && req.query.limit.trim()
        ? Number(req.query.limit)
        : undefined;

    const options: ListFlowOptions = {
      industry,
      etf_code: etfCode,
      days: daysRaw,
      end: endRaw,
      limit: limitRaw,
    };

    try {
      const service = new ETFFlowSyncService();
      const data = await service.listFlow(options);
      return res.json({
        success: true,
        count: data.length,
        filters: {
          industry: industry ?? null,
          etf_code: etfCode ?? null,
          days: daysRaw ?? null,
          end: endRaw ?? null,
          limit: limitRaw ?? null,
        },
        industries: getAllETFIndustries(),
        data,
      });
    } catch (error: any) {
      logger.error(`DataController.listEtfFlow failed: ${error?.message ?? error}`);
      return res.status(500).json({
        success: false,
        error: error?.message ?? 'ETF 资金流查询失败',
      });
    }
  }
}

function todayIso(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}
