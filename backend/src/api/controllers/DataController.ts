import { Request, Response } from 'express';
import { dataHealthStatusService, listDataSources } from '../../services/DataHealthStatusService';
import { NorthboundSyncService } from '../../data/services/NorthboundSyncService';
import { DragonTigerSyncService } from '../../data/services/DragonTigerSyncService';
import { LimitUpSyncService } from '../../data/services/LimitUpSyncService';
import { IndustrySyncService } from '../../data/services/IndustrySyncService';
import { SnowballHotKeywordSyncService } from '../../data/services/SnowballHotKeywordSyncService';
import { logger } from '../../utils/logger';

/**
 * US-079 数据健康度看板控制器
 *
 * - GET /api/data/health-status  → 聚合所有数据源最新同步状态
 * - POST /api/data/sync/:source  → 手动触发指定数据源的同步任务
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
}

function todayIso(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}
