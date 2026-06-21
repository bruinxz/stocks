/**
 * cronNextRun.ts — 计算 cron 表达式的下一次触发时间.
 *
 * 背景 (AR-2, 2026-06-21):
 *   node-cron@4.2.1 内的 `MatcherWalker.matchNext()` 在 `findNextDateIgnoringWeekday`
 *   返回的日期 weekday 不在 `expressions[5]` 时, 进入 while-loop 仅
 *   `date.set('year', year + 1)` 自增, 永远不退. 结果:
 *     - `0 10 * * 0` (周日 10:00) → 返 2034-01-01 (而非次周日)
 *     - `0 9 * * 2` (周二 9:00)  → 返 2030-01-01
 *     - `0 10 * * 4`            → 返 2032-01-01
 *   这只影响 `getNextRun()` 显示值; cron 实际 fire 由
 *   `scheduler/runner.js` 内 `getDelay()` cap 到 maxDelay=86400000ms (1 天)
 *   + 每次 heartBeat 重新 match(date), **所以 cron 实际还会触发** (验证: 86 / 89
 *   tasks 已成功 last_run_at). 但 `getNextRun()` 给运维 / dashboard 看的
 *   "下次触发时间" 是错的 — 误导排障.
 *
 *   解决: 用 `cron-parser` (已是 bull 的 transitive dep, 4.9.0 在 node_modules
 *   里现成可用) 替代 node-cron 的 getNextRun() 计算. cron-parser 是 cron 标准
 *   parser, 在 Asia/Shanghai 时区下对所有 7 个 DoW 都返正确日期 (单测 + 直跑验证).
 *
 *   未来若 upgrade 到修复了 matcher-walker bug 的 node-cron 版本, 本 helper
 *   可保留作冗余兜底, 或视情况移除.
 */

import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cronParser = require('cron-parser');

export interface CronNextRunOptions {
  /** IANA tz, 默认 'Asia/Shanghai' (与 SchedulerService.scheduleTask 同) */
  timezone?: string;
  /** 起点 (用于回归测试 / 显式注入), 默认 new Date() */
  currentDate?: Date;
}

/**
 * 计算 cron 表达式下一次触发时刻; 失败 (非法表达式 / parser 异常) 返 null,
 * 不抛错. caller 自行决定显示 "n/a" 还是 fallback 别的逻辑.
 */
export function computeNextRunAt(
  cronExpression: string,
  options: CronNextRunOptions = {}
): Date | null {
  if (!cronExpression || typeof cronExpression !== 'string') return null;
  try {
    const it = cronParser.parseExpression(cronExpression, {
      tz: options.timezone ?? 'Asia/Shanghai',
      currentDate: options.currentDate ?? new Date(),
    });
    const next = it.next();
    const d = next.toDate();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return d;
  } catch (e: any) {
    logger.warn(
      `[cronNextRun] parseExpression failed for "${cronExpression}" (tz=${
        options.timezone ?? 'Asia/Shanghai'
      }): ${e?.message ?? e}`
    );
    return null;
  }
}

/**
 * 给定一个 node-cron 算出来的 nextRun, 判断是否"明显错误" (>1 年外).
 * node-cron@4.2.1 matcher-walker 的 bug 会把某些 DoW-only cron 推到 2027~2034 年,
 * 这是我们用 cron-parser 兜底的触发条件.
 */
export function isImplausibleNextRun(d: Date | null | undefined): boolean {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return true;
  const ahead = d.getTime() - Date.now();
  // 任何超过 380 天的"下次触发"都视为可疑 — 业务里没有 1 年触发一次的 cron
  // (季度 cron 已是最长周期 = 90 天).
  return ahead > 380 * 24 * 60 * 60 * 1000;
}
