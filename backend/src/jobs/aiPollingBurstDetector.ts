/**
 * aiPollingBurstDetector — Phase 10 缺漏 P0-2 (2026-06-28)
 *
 * 单 job 失败只进日志；达到 burst 阈值后由统一飞书 outbox 发 OPS 告警。
 * 100 个 job 集体失败 admin 不知道. 用一个 5min sliding window 检测 burst:
 * 窗口内 ≥ 10 次失败 → 推一次 HIGH 告警 (dedup_key='ai_polling_burst', 1h dedup
 * 由 SystemAdminAlertPusher 兜底防 burst 内多次推).
 *
 * 进程内 Array<ts>, 重启清零 (burst 检测重新开始). 跨进程不汇总 — 单进程超阈值
 * 就告警即可.
 *
 * 抽出独立文件原因: aiPollingWorker.ts 顶层 require aiPollingQueue 会启 Bull
 * Redis 连接, 单测 import 整 worker 模块会 hang. 这里只是纯函数 + 进程内 state,
 * 单测可直接 import 而不连 Redis.
 */

import { pushSystemAdminAlertFireAndForget } from '../services/SystemAdminAlertPusher';

const AI_POLLING_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const AI_POLLING_FAILURE_BURST_THRESHOLD = 10;
const aiPollingFailureWindow: number[] = [];

/** 测试入口 — 清空 window. */
export function clearAiPollingFailureWindowForTests(): void {
  aiPollingFailureWindow.length = 0;
}

/** 测试入口 — 暴露当前 window snapshot (返 copy, mutate 不影响 internal). */
export function getAiPollingFailureWindowForTests(): number[] {
  return [...aiPollingFailureWindow];
}

/**
 * 记录一次失败 + 若 5min 内累计 ≥ 10 次, fire-and-forget 告警.
 * pure-ish: state 默认全局 aiPollingFailureWindow; 测试可注入 state + push.
 */
export function recordAiPollingFailureForBurst(
  nowMs: number = Date.now(),
  state: number[] = aiPollingFailureWindow,
  options: {
    /** 测试 — 替换 pushSystemAdminAlertFireAndForget */
    push?: (input: any) => void;
  } = {}
): { window_size: number; burst_triggered: boolean } {
  const cutoff = nowMs - AI_POLLING_FAILURE_WINDOW_MS;
  // 清理过期 + 添加当前
  while (state.length > 0 && state[0] < cutoff) state.shift();
  state.push(nowMs);
  const burstTriggered = state.length >= AI_POLLING_FAILURE_BURST_THRESHOLD;
  if (burstTriggered) {
    const pushFn = options.push || pushSystemAdminAlertFireAndForget;
    pushFn({
      dedup_key: 'ai_polling_burst',
      level: 'HIGH',
      title: `[HIGH] AI 轮询 worker burst — 5min 内 ${state.length} 次失败`,
      body_markdown:
        `**触发原因**: 5 分钟滑动窗口内累计 ${state.length} 次 AI polling job 失败\n` +
        `**阈值**: ≥ ${AI_POLLING_FAILURE_BURST_THRESHOLD} 次\n` +
        `**dedup**: 1h 内本 burst 只推 1 次 (复用 SystemAdminAlertPusher 默认窗口)\n` +
        `**排查方向**: TradingAgents 远端 / aiPollingQueue Bull Redis / 单 job timeout`,
      triggered_at: new Date(nowMs).toISOString(),
    });
  }
  return { window_size: state.length, burst_triggered: burstTriggered };
}

export const AI_POLLING_BURST_CONFIG = Object.freeze({
  WINDOW_MS: AI_POLLING_FAILURE_WINDOW_MS,
  THRESHOLD: AI_POLLING_FAILURE_BURST_THRESHOLD,
});
