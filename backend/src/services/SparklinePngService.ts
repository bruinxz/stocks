/**
 * SparklinePngService — CE-C K 线缩略图生成 (V0: Unicode sparkline placeholder)
 *
 * 设计意图: 在飞书"实时机会"卡片中嵌入近 N 日 K 线缩略图,
 * 让用户在卡片上一眼看出最近趋势 (无需点深页).
 *
 * **V0 决策 (2026-06-25): 不引入 puppeteer/chromium 重依赖**.
 * 改用 Unicode block 字符 `▁▂▃▄▅▆▇█` 在 8 档高度区间拼成 sparkline 字符串,
 * 写到卡片 markdown 字段 (lark_md). 优势:
 *   - 0 新 npm 依赖 (无 sharp / svg2png / canvas 安装坑)
 *   - 0 运维改动 (不需要安装 chromium / 配 docker base image)
 *   - 立刻可用 (任何 Lark/飞书客户端都能渲染 unicode)
 *   - 失败 fallback 优雅 (返 null caller 不嵌图)
 *
 * **V1 升级路径** (有需求时):
 *   1. 加 `sharp` + 自己画 SVG 路径 → renderMiniKline 返 base64 data URL
 *   2. 飞书"上传媒体" API 拿 img_key → buildOpportunityCard 用 'img' element
 *   3. 旧 caller 0 改动 — sparkline 兜底自动回退
 *
 * **设计风险**:
 *   - Unicode block 字符在某些极简字体下 baseline 不齐, V0 已接受 (远比"没图" 好)
 *   - 数据缺失 / DB 异常 / bars 不足 → 返 null, caller 0 嵌图但 push 继续
 *   - 不对外暴露 PNG 字节流 (V0 没有), V1 再加 renderToPngBuffer / uploadToFeishu
 */

import { logger } from '../utils/logger';

const BLOCK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** Bar tuple — 时间序需按时间升序 (旧 → 新). */
export interface MiniKlineBar {
  /** 收盘价 — 用于 sparkline 高度分箱 */
  close: number;
  /** 当日涨跌百分比, 可选 — 用于推断"涨/跌/平" 整体方向 */
  change_percent?: number | null;
}

export interface SparklineResult {
  /** 'sparkline_unicode' / 'png_data_url' / 'feishu_img_key' (V0 仅前者) */
  format: 'sparkline_unicode';
  /** Unicode 字符串 sparkline, e.g. '▂▃▅▆█▇▆█' */
  rendered: string;
  /** 整体方向 'up' / 'down' / 'flat' (基于 first vs last close 推断) */
  direction: 'up' | 'down' | 'flat';
  /** 区间最低 / 最高 close */
  low: number;
  high: number;
}

/**
 * Pure helper — 把数值数组映射到 8 档 unicode block.
 * - bars.length < 2 → 返 null (sparkline 无意义)
 * - bars 全相等 → 中间档 (idx=3 → '▄') × length
 * - 含 NaN / 非有限数 → 跳过该 bar (空字符)
 *
 * Export 让单测可纯函数验证.
 */
export function asciiSparklineFromBars(bars: MiniKlineBar[] | null | undefined): string | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const closes = bars
    .map(b => (b && Number.isFinite(b.close) ? Number(b.close) : null))
    .filter((v): v is number => v !== null);
  if (closes.length < 2) return null;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const range = max - min;
  if (range === 0) {
    // 全相等 → 中间档高度 (4 / 8)
    return BLOCK_CHARS[3].repeat(closes.length);
  }
  return closes
    .map(c => {
      const norm = (c - min) / range; // 0..1
      const bucket = Math.min(BLOCK_CHARS.length - 1, Math.max(0, Math.floor(norm * BLOCK_CHARS.length)));
      return BLOCK_CHARS[bucket];
    })
    .join('');
}

/** Pure helper — 由 bars 第一根 vs 最后一根 close 推断方向. */
export function inferSparklineDirection(
  bars: MiniKlineBar[]
): 'up' | 'down' | 'flat' {
  if (!Array.isArray(bars) || bars.length < 2) return 'flat';
  const closes = bars
    .map(b => (b && Number.isFinite(b.close) ? Number(b.close) : null))
    .filter((v): v is number => v !== null);
  if (closes.length < 2) return 'flat';
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return 'flat';
  const pct = ((last - first) / Math.abs(first)) * 100;
  if (pct > 0.5) return 'up';
  if (pct < -0.5) return 'down';
  return 'flat';
}

/**
 * DataSource — 数据获取层 (DI seam), 单测注入 fake 完全脱 DB.
 */
export interface SparklineDataSource {
  /**
   * 取近 `days` 个交易日 daily bar, 按时间升序返回 (旧 → 新).
   * 失败 / 找不到 stock → 返 [].
   */
  fetchRecentBars(symbol: string, days: number): Promise<MiniKlineBar[]>;
}

/** Default DataSource — Sequelize DailyBar via lazy require (避免顶部 import 重量级 model). */
export class DefaultSparklineDataSource implements SparklineDataSource {
  async fetchRecentBars(symbol: string, days: number): Promise<MiniKlineBar[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../models/DailyBar');
      const stock = await Stock.findOne({
        where: { symbol },
        attributes: ['id'],
        raw: true,
      });
      if (!stock?.id) return [];
      const rows = await DailyBar.findAll({
        where: { stock_id: stock.id },
        order: [['time', 'DESC']],
        limit: days,
        attributes: ['close', 'change_percent', 'time'],
        raw: true,
      });
      // 取出来按 DESC, 这里反转回升序便于 sparkline 渲染
      return (rows || [])
        .reverse()
        .map((r: any) => ({
          close: Number(r.close),
          change_percent:
            r.change_percent !== null && r.change_percent !== undefined
              ? Number(r.change_percent)
              : null,
        }));
    } catch (err: any) {
      logger.warn(
        `[SparklinePng] fetchRecentBars symbol=${symbol} 失败 (fail-OPEN, sparkline 返 null): ${err?.message || err}`
      );
      return [];
    }
  }
}

export const PRODUCTION_SPARKLINE_DATA_SOURCE: SparklineDataSource = new DefaultSparklineDataSource();

/**
 * SparklinePngService — 主服务. V0 仅产 unicode sparkline; V1 上 PNG/feishu img_key.
 */
export class SparklinePngService {
  constructor(private readonly dataSource: SparklineDataSource = PRODUCTION_SPARKLINE_DATA_SOURCE) {}

  /**
   * 主入口 — 拿 sparkline 字符串. 数据不足 / DB 异常 → 返 null.
   */
  async renderMiniKline(
    symbol: string,
    days = 20
  ): Promise<SparklineResult | null> {
    if (!symbol || typeof symbol !== 'string') return null;
    const safeDays = Number.isInteger(days) && days >= 2 && days <= 120 ? days : 20;
    let bars: MiniKlineBar[];
    try {
      bars = await this.dataSource.fetchRecentBars(symbol, safeDays);
    } catch (err: any) {
      logger.warn(
        `[SparklinePng] dataSource throw symbol=${symbol}: ${err?.message || err} (fail-OPEN, 返 null)`
      );
      return null;
    }
    if (!Array.isArray(bars) || bars.length < 2) return null;
    const rendered = asciiSparklineFromBars(bars);
    if (!rendered) return null;
    const closes = bars
      .map(b => Number(b.close))
      .filter(v => Number.isFinite(v));
    if (closes.length < 2) return null;
    return {
      format: 'sparkline_unicode',
      rendered,
      direction: inferSparklineDirection(bars),
      low: Math.min(...closes),
      high: Math.max(...closes),
    };
  }
}

export const sparklinePngService = new SparklinePngService();
