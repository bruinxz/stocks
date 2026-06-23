/**
 * NorthboundFactor (北向资金因子) — US-010
 *
 * 公式：raw_value = hold_ratio[as_of_date] - hold_ratio[as_of_date - 20 交易日]
 *   - 北向持股比例上升越多 → 越积极（聪明钱抢筹）
 *   - 用差值（绝对百分点）而非比值，因为基数小的股票比值会爆炸
 *
 * 数据源：NorthboundHolding 表
 *   - 主键 (trade_date, stock_code)，stock_code 无后缀，与 universe 直接对齐
 *   - 字段：hold_ratio (DECIMAL 10,6) = 占流通股比 %
 *
 * ============================================================================
 * BD-1 (2026-06-23): 上游 AKShare 北向 endpoint 死了 22 个月 (latest=2024-08-16)
 * ============================================================================
 *
 * 已实测的 3 个 AKShare hsgt endpoint:
 *   - stock_hsgt_hold_stock_em (全市场单日快照, 我们之前用的): 任何 indicator
 *     日期都 raise TypeError("NoneType subscript") — 上游 EastMoney 数据中心
 *     2024-08-16 之后 stopped publishing detail.
 *   - stock_hsgt_individual_em (per-stock 历史): 返回的最大 trade_date 永远是
 *     2024-08-16 (~22 月陈旧). 同样上游死.
 *   - stock_hsgt_hist_em (全市场汇总): 还能拉到当日"日期 / 沪深 300"行, 但
 *     "当日成交净买额 / 买入成交额 / 卖出成交额 / 持股市值" 等关键金额列
 *     都是 NaN (2024-08-19 起). 上游死.
 *
 * 替代方案考察 (2026-06-23):
 *   - baostock: 无北向相关 endpoint (实测 dir(bs) 无 hsgt/north/connect 关键字)
 *   - tushare: 需要 TUSHARE_PRO_TOKEN, 当前 .env 未配置 (TUSHARE_TOKEN=空)
 *
 * 综合结论: 当前无法获取 fresh 北向数据. 因子在 raw_value 公式 (今日 - 20 日前)
 * 下永远拿到 latest=2024-08-16 != ctx.as_of_date → 全部股票 continue → effective=0.
 * 这是上游 dead 而非我们的代码 bug.
 *
 * 处理方式: 因子保留注册 (让 FactorPipeline 仍写 5532 行中性补全, 多因子模型
 * 仍能正常运行, percentile=0.5 不会让任何信号倾斜), 但加 1 行 fail-fast: 当
 * NorthboundHolding 表的最新 trade_date < as_of_date - 30 天时, 直接返回空 Map,
 * 跳过数据库查询节约耗时. 数据源恢复后 (上游 EastMoney / 替代源接通) 自动重启
 * 信号 — 无需代码改动.
 *
 * 升级路径:
 *   - 若 EastMoney 北向 detail 数据恢复, 上面的 endpoint 自然能拉到新数据,
 *     latest trade_date 一新, fail-fast 不再触发, 因子自动回到正常计算路径.
 *   - 若引入 TuShare Pro 替代源, 走 NorthboundDataClient.fetchHoldings 的另一个
 *     branch (`source='tushare'`), 一同写入 NorthboundHolding 表, 本因子无需变.
 *
 * 失效：
 *   - 数据源 stale (latest < as_of_date - 30) → 空 Map (BD-1 新增)
 *   - as_of_date 当天该股没有 北向持股数据 → 不入 Map（次新 / 不在沪深通范围）
 *   - 20 日前没有数据 → 用窗口内最早一条做基线（北向是 2014/2016 才开通，
 *     早期数据天然缺）；若窗口内连基线都没有 → 跳过
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { NorthboundHolding } from '../../../models/NorthboundHolding';
import { isFiniteNumber } from './_helpers';
import { tradingDayLookbackStartDate } from './_tradingDayWindow';

/** 业务窗口: 近 20 个交易日 (audit M-9: 从 30 自然日 +10 buffer 改成精确 20 交易日) */
const WINDOW_TRADING_DAYS = 20;
/**
 * BD-1 (2026-06-23): 数据源陈旧度阈值 (自然日).
 *
 * 当 NorthboundHolding 表的最新 trade_date 与 as_of_date 相差 > 此值时,
 * 视为 "数据源 dead", 跳过全部计算 (返空 Map → Pipeline 全部中性补全).
 *
 * 30 天: 覆盖春节 / 国庆等长假 + 数据 sync 延迟; 上游正常时长假最多 9 天
 * 全市场停更, 30 天 buffer 比较保险, 不会误杀健康数据.
 */
export const DATA_STALENESS_THRESHOLD_DAYS = 30;

/**
 * BD-1 helper: 判断数据源是否陈旧 (export 用于单测).
 *
 * @param latestIso  NorthboundHolding 表最新 trade_date (ISO YYYY-MM-DD); null = 表空
 * @param asOfIso    当前 factor 截面日 (ISO YYYY-MM-DD)
 * @param thresholdDays  超过此天数视为陈旧 (默认 DATA_STALENESS_THRESHOLD_DAYS)
 */
export function isDataSourceStale(
  latestIso: string | null,
  asOfIso: string,
  thresholdDays: number = DATA_STALENESS_THRESHOLD_DAYS
): boolean {
  if (!latestIso) return true; // 表空 = stale
  const latestMs = new Date(`${latestIso}T00:00:00Z`).getTime();
  const asOfMs = new Date(`${asOfIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(latestMs) || !Number.isFinite(asOfMs)) return true;
  const ageDays = (asOfMs - latestMs) / 86_400_000;
  return ageDays > thresholdDays;
}

export const northboundFactor: Factor = {
  name: 'northbound',
  description:
    '北向持股比例 20 日变化（聪明钱方向；上游 AKShare 2024-08-16 后 stale, BD-1 降级运行）',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // BD-1 (2026-06-23): 数据源陈旧 fail-fast.
    // 跳过 SELECT 节约 DB IO; Pipeline 仍会写中性补全 5532 行让 multi-factor 正常运行.
    try {
      const latestRaw = await NorthboundHolding.max('trade_date');
      let latestIso: string | null = null;
      if (latestRaw instanceof Date) {
        latestIso = latestRaw.toISOString().slice(0, 10);
      } else if (typeof latestRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(latestRaw)) {
        latestIso = latestRaw.slice(0, 10);
      }
      if (isDataSourceStale(latestIso, ctx.as_of_date)) {
        return out;
      }
    } catch (_e) {
      // 表 query 失败 (e.g. 表不存在) → 视同 stale, 跳过
      return out;
    }

    // 拉窗口内 + 当日的全部北向行 (audit M-9: 交易日窗口替代 +10 自然日兜底)
    const startDate = await tradingDayLookbackStartDate(ctx.as_of_date, WINDOW_TRADING_DAYS);
    const rows = (await NorthboundHolding.findAll({
      attributes: ['stock_code', 'trade_date', 'hold_ratio'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      hold_ratio: any;
    }>;

    // 按 stock_code 分组 + 排序
    const rowsByCode = new Map<string, Array<{ date: string; ratio: number }>>();
    for (const r of rows) {
      const ratio = Number(r.hold_ratio);
      if (!isFiniteNumber(ratio)) continue;
      const arr = rowsByCode.get(r.stock_code) ?? [];
      arr.push({ date: r.trade_date, ratio });
      rowsByCode.set(r.stock_code, arr);
    }

    // 当日 ratio - 窗口内最早一条 ratio（≈ 20 自然日前）
    for (const [code, arr] of rowsByCode.entries()) {
      arr.sort((a, b) => a.date.localeCompare(b.date));
      const latest = arr[arr.length - 1];
      if (latest.date !== ctx.as_of_date) continue; // 当日没有北向数据 → 不计算
      const baseline = arr[0]; // 窗口内最早一条作为基线
      if (baseline === latest) continue; // 只有一条数据 → 无法算变化

      out.set(code, latest.ratio - baseline.ratio);
    }

    return out;
  },
};

factorRegistry.register(northboundFactor);
