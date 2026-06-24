/**
 * IndustryFlowIntradayService — BK-2 (2026-06-24)
 *
 * 盘中 10min 行业资金流时序同步.
 *
 * - cron INDUSTRY_FLOW_INTRADAY_SYNC: 工作日盘中 9:35-15:00 每 10min (含集合竞价 9:30+5min 缓冲),
 *   调 AKShare 拉当前累计净流入 → upsert (snapshot_ts, industry_code) 到 industry_flow_intraday.
 * - cron INDUSTRY_FLOW_INTRADAY_CLEANUP: 每日 16:00 删除 > 3 个交易日的快照.
 *
 * Design constraints:
 * 1. fail-OPEN: 单次 Python 调用失败 → 仅 warn 不抛 (单点漏没关系, 5min 后下次再补).
 * 2. snapshot_ts 截断到 10min 整点 (避免不同 cron 触发时刻有 ±30s 抖动让前端时序错位).
 * 3. 非交易日 / 非交易时段 → 立即返 0 (cron 自身 expression 已约束, 但兜底再加一层).
 * 4. 累计语义: AKShare main_inflow 已经是"9:30 到当前"累计, 不做差分 — 前端直接画.
 *
 * 与 IndustryFlowService (日度) 不冲突: 表名 industry_flow_intraday vs industry_flows.
 */

import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import * as path from 'path';

export interface IntradayFlowSnapshot {
  industry_code: string;
  industry_name: string;
  change_pct: number | null;
  main_inflow: number | null;
  main_inflow_ratio: number | null;
}

export interface IntradayFlowDataSource {
  fetchSnapshot(): Promise<IntradayFlowSnapshot[]>;
  upsertSnapshot(snapshotTs: Date, rows: IntradayFlowSnapshot[]): Promise<number>;
  cleanupBefore(cutoff: Date): Promise<number>;
}

/** 把任意时刻截断到最近的 10min 整点 (向下取整, Asia/Shanghai 视角). */
export function truncateTo10Min(d: Date): Date {
  const ms = d.getTime();
  const tenMin = 10 * 60 * 1000;
  return new Date(Math.floor(ms / tenMin) * tenMin);
}

/** 判断是否盘中时段 (9:30-11:30 + 13:00-15:00 Asia/Shanghai). */
export function isInTradingSession(d: Date): boolean {
  // 取 Asia/Shanghai 当地的小时分钟. Node 跑在 prod 时 TZ=Asia/Shanghai (.env 已配),
  // 但保险起见用 Intl 显式转 (服务器若 UTC 也对).
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hh, mm] = fmt.format(d).split(':').map(s => parseInt(s, 10));
  const totalMin = hh * 60 + mm;
  const am = totalMin >= 9 * 60 + 30 && totalMin <= 11 * 60 + 30;
  const pm = totalMin >= 13 * 60 && totalMin <= 15 * 60;
  return am || pm;
}

/** 默认 production data source: 调真 Python helper + 真 DB. */
export const PRODUCTION_INTRADAY_FLOW_DATA_SOURCE: IntradayFlowDataSource = {
  async fetchSnapshot() {
    const pythonPath = process.env.PYTHON_PATH || 'python3';
    const scriptPath = path.join(__dirname, '../../python/akshare_helper.py');
    return new Promise((resolve, reject) => {
      const child = spawn(pythonPath, [scriptPath, 'get_industry_flow_intraday']);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('intraday snapshot timeout (30s)'));
      }, 30_000);
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`python exit ${code}: ${stderr.slice(-200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed?.success) {
            reject(new Error(`python returned success=false: ${parsed?.error || 'unknown'}`));
            return;
          }
          resolve(Array.isArray(parsed.data) ? parsed.data : []);
        } catch (e: any) {
          reject(new Error(`json parse fail: ${e?.message ?? e}`));
        }
      });
      child.on('error', e => {
        clearTimeout(timer);
        reject(e);
      });
    });
  },
  async upsertSnapshot(snapshotTs, rows) {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { IndustryFlowIntraday } = require('../models/IndustryFlowIntraday');
    /* eslint-enable @typescript-eslint/no-var-requires */
    if (rows.length === 0) return 0;
    const payload = rows.map(r => ({
      snapshot_ts: snapshotTs,
      industry_code: r.industry_code,
      industry_name: r.industry_name,
      change_pct: r.change_pct,
      main_inflow: r.main_inflow,
      main_inflow_ratio: r.main_inflow_ratio,
    }));
    await IndustryFlowIntraday.bulkCreate(payload, {
      updateOnDuplicate: ['industry_name', 'change_pct', 'main_inflow', 'main_inflow_ratio'],
    });
    return payload.length;
  },
  async cleanupBefore(cutoff) {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { IndustryFlowIntraday } = require('../models/IndustryFlowIntraday');
    const { Op } = require('sequelize');
    /* eslint-enable @typescript-eslint/no-var-requires */
    return await IndustryFlowIntraday.destroy({
      where: { snapshot_ts: { [Op.lt]: cutoff } },
    });
  },
};

export class IndustryFlowIntradayService {
  constructor(private ds: IntradayFlowDataSource = PRODUCTION_INTRADAY_FLOW_DATA_SOURCE) {}

  /**
   * 拉取当前快照并 upsert.
   * @param options.now 测试注入"现在时刻"; 生产默认 new Date()
   * @param options.force 跳过盘中时段守卫 (单测 / 手动补数据)
   */
  async pullSnapshot(options: { now?: Date; force?: boolean } = {}): Promise<{
    snapshot_ts: Date;
    inserted: number;
    skipped_reason: string | null;
  }> {
    const now = options.now || new Date();
    if (!options.force && !isInTradingSession(now)) {
      return { snapshot_ts: now, inserted: 0, skipped_reason: 'not_in_session' };
    }
    const ts = truncateTo10Min(now);
    let rows: IntradayFlowSnapshot[] = [];
    try {
      rows = await this.ds.fetchSnapshot();
    } catch (e: any) {
      logger.warn(`[IndustryFlowIntradayService] fetch failed: ${e?.message ?? e}`);
      return { snapshot_ts: ts, inserted: 0, skipped_reason: 'fetch_failed' };
    }
    if (rows.length === 0) {
      return { snapshot_ts: ts, inserted: 0, skipped_reason: 'empty_snapshot' };
    }
    try {
      const n = await this.ds.upsertSnapshot(ts, rows);
      logger.info(`[IndustryFlowIntradayService] ts=${ts.toISOString()} upserted=${n}`);
      return { snapshot_ts: ts, inserted: n, skipped_reason: null };
    } catch (e: any) {
      logger.warn(`[IndustryFlowIntradayService] upsert failed: ${e?.message ?? e}`);
      return { snapshot_ts: ts, inserted: 0, skipped_reason: 'upsert_failed' };
    }
  }

  /** 删除 > retainDays 个自然日的旧快照. retainDays 默认 3. */
  async cleanup(retainDays = 3): Promise<number> {
    const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
    try {
      const n = await this.ds.cleanupBefore(cutoff);
      logger.info(
        `[IndustryFlowIntradayService] cleanup cutoff=${cutoff.toISOString()} deleted=${n}`
      );
      return n;
    } catch (e: any) {
      logger.warn(`[IndustryFlowIntradayService] cleanup failed: ${e?.message ?? e}`);
      return 0;
    }
  }
}

export const industryFlowIntradayService = new IndustryFlowIntradayService();
