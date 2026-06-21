/**
 * fillAnomalyClassifier — US-138 [EX-013] 实盘 fill 异常分类
 *
 * 目的: 把 `live_broker_commands` 终态分类成可统计、可告警的"成交异常类别",
 *       为运营 / 风控提供"是异常 (cancelled_partial / rejected / failed / expired
 *       / aborted) 还是正常 (filled_full)" 的归一化口径.
 *
 * 设计契约:
 *   - 纯函数, 输入是 `LiveBrokerCommand` plain shape (status / quantity /
 *     filled_quantity / metadata / parent_command_id / command_type), 不依赖
 *     sequelize 实例 → DB-less 单测全覆盖.
 *   - 输入只关心"已经进入终态的命令" — pending / dispatching / dispatched /
 *     submitted / partially_filled 全部返 'in_flight', 调用方可以 filter 掉.
 *   - 输出是封闭枚举 `FillAnomalyCategory`, 顺序遵循"先终态再异常等级"
 *     (filled_full → partial_only → cancelled_unfilled → cancelled_partial →
 *      rejected → failed → expired → aborted → in_flight → unknown), 方便前端
 *     按枚举顺序展示柱状图 / pie chart.
 *   - 区分 `partial_only` vs `cancelled_partial`: 前者是"还没撤但终态留在
 *     partially_filled" (极少见, 通常被 BridgeCommandExpiryService 推到 expired);
 *     后者是常见路径"先 partial 后 cancel". status='cancelled' 且 filled>0
 *     落 cancelled_partial; status='cancelled' 且 filled=0 落 cancelled_unfilled.
 *   - rejected: 命令在 metadata.reject_reason / payload.event_type='order_error'
 *     被券商显式拒, 与"失败 (网络 / bridge 异常)" 区分. 现 BridgeService 只把
 *     这类映射为 status='failed', 所以 metadata.error_kind === 'rejected_by_broker'
 *     或 metadata.reason_code 以 'reject' 开头时分类为 rejected; 其余 status='failed'
 *     落 failed.
 *
 * 不在范围:
 *   - 不写 DB, 不发告警. 上层 `LiveTradingService.getFillAnomalyStats` 负责查表 +
 *     聚合, 之后再决定是否触发告警 / 推送统计面板.
 *   - 不解释"为什么撤单" — 撤单原因走 cancel command 的 metadata 链, 由 UI 单独
 *     展示, 不在分类口径里.
 */

export type FillAnomalyCategory =
  | 'filled_full'
  | 'partial_only'
  | 'cancelled_unfilled'
  | 'cancelled_partial'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'aborted'
  | 'in_flight'
  | 'unknown';

/**
 * 全枚举顺序 — 调用方按这个顺序展示, 保证 UI / 报表稳定.
 * 注意: 同时也是 `FILL_ANOMALY_CATEGORY_LABELS` / aggregate 默认 0 填充顺序.
 */
export const FILL_ANOMALY_CATEGORIES: readonly FillAnomalyCategory[] = Object.freeze([
  'filled_full',
  'partial_only',
  'cancelled_unfilled',
  'cancelled_partial',
  'rejected',
  'failed',
  'expired',
  'aborted',
  'in_flight',
  'unknown',
]);

/** 用于 UI / 飞书告警的人读 label. */
export const FILL_ANOMALY_CATEGORY_LABELS: Readonly<Record<FillAnomalyCategory, string>> =
  Object.freeze({
    filled_full: '全部成交',
    partial_only: '仅部分成交 (未撤)',
    cancelled_unfilled: '撤单未成交',
    cancelled_partial: '撤单部分成交',
    rejected: '券商拒单',
    failed: '执行失败',
    expired: 'TTL 过期',
    aborted: 'KillSwitch 中止',
    in_flight: '执行中',
    unknown: '未知',
  });

/** 哪些类别算"成交异常" — 用于"异常率 = 异常数 / (异常+正常)" 计算. */
export const ANOMALY_CATEGORIES: ReadonlySet<FillAnomalyCategory> = Object.freeze(
  new Set<FillAnomalyCategory>([
    'partial_only',
    'cancelled_unfilled',
    'cancelled_partial',
    'rejected',
    'failed',
    'expired',
    'aborted',
  ])
);

/** Classifier 输入只关心这些字段, 任何额外字段都被忽略 (前向兼容). */
export interface ClassifiableCommand {
  status: string | null | undefined;
  quantity?: number | string | null;
  filled_quantity?: number | string | null;
  command_type?: string | null;
  metadata?: Record<string, any> | null;
}

function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRejectedByBroker(metadata: Record<string, any> | null | undefined): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const errorKind = String(metadata.error_kind || '').toLowerCase();
  if (errorKind === 'rejected_by_broker' || errorKind === 'rejected') return true;
  const reasonCode = String(metadata.reason_code || '').toLowerCase();
  if (reasonCode.startsWith('reject')) return true;
  const rejectFlag = metadata.rejected;
  if (rejectFlag === true || String(rejectFlag).toLowerCase() === 'true') return true;
  return false;
}

/**
 * 主入口: 输入一条 LiveBrokerCommand-shaped record, 返回它落在的 anomaly 类别.
 *
 * cancel_order 命令本身的终态 (cancelled / failed) 描述的是"撤单这条指令的归宿",
 * 不是"被撤的那笔 place_order 是否部分成交" — 所以单独看待:
 *   - cancel_order + cancelled / filled (撤单成功) → filled_full (撤单达成意图)
 *   - cancel_order + failed → failed (撤单失败, 比如 broker 已成交)
 * 这样 stats 里 cancel command 不会把"place_order 的 cancelled_partial" 重复计数.
 */
export function classifyFillAnomaly(cmd: ClassifiableCommand): FillAnomalyCategory {
  if (!cmd || typeof cmd !== 'object') return 'unknown';
  const status = String(cmd.status || '').toLowerCase();
  const commandType = String(cmd.command_type || '').toLowerCase();

  if (commandType === 'cancel_order') {
    if (status === 'cancelled' || status === 'filled') return 'filled_full';
    if (status === 'failed' || status === 'cancel_error') return 'failed';
    if (status === 'expired') return 'expired';
    if (status === 'aborted') return 'aborted';
    if (
      status === 'pending' ||
      status === 'dispatching' ||
      status === 'dispatched' ||
      status === 'submitted'
    )
      return 'in_flight';
    return 'unknown';
  }

  const quantity = toNum(cmd.quantity);
  const filled = toNum(cmd.filled_quantity);

  switch (status) {
    case 'filled':
      return 'filled_full';
    case 'partially_filled':
      return 'partial_only';
    case 'cancelled':
      return filled > 0 ? 'cancelled_partial' : 'cancelled_unfilled';
    case 'failed':
      return isRejectedByBroker(cmd.metadata) ? 'rejected' : 'failed';
    case 'rejected':
      return 'rejected';
    case 'expired':
      // expired 时 filled > 0 也按 expired 计 (与 cancelled_partial 区分: 主动撤 vs 被动 TTL)
      return 'expired';
    case 'aborted':
      return 'aborted';
    case 'pending':
    case 'dispatching':
    case 'dispatched':
    case 'submitted':
      return 'in_flight';
    default:
      // 防 future 状态码漂移
      void quantity;
      return 'unknown';
  }
}

export interface FillAnomalyStatsCounts {
  total: number;
  /** 命中 ANOMALY_CATEGORIES 的总数 (不含 filled_full / in_flight / unknown) */
  anomaly_total: number;
  /** 已进入终态的总数 (排除 in_flight); 用于"异常率 = anomaly_total / terminal_total" */
  terminal_total: number;
  /** 异常率 (anomaly_total / terminal_total); terminal_total=0 时返 0 */
  anomaly_rate: number;
  /** 各类别计数, 顺序保证与 FILL_ANOMALY_CATEGORIES 一致 */
  by_category: Array<{
    category: FillAnomalyCategory;
    label: string;
    count: number;
  }>;
}

/**
 * 聚合一批已分类后的 (category) 序列成 stats 结构. 不查 DB, 调用方传 in-memory
 * 数组 — 方便测试与"先做 SQL group by 再 hydrate 到这里"两条路径共用.
 */
export function aggregateFillAnomalies(
  categories: Iterable<FillAnomalyCategory>
): FillAnomalyStatsCounts {
  const counts: Record<FillAnomalyCategory, number> = {
    filled_full: 0,
    partial_only: 0,
    cancelled_unfilled: 0,
    cancelled_partial: 0,
    rejected: 0,
    failed: 0,
    expired: 0,
    aborted: 0,
    in_flight: 0,
    unknown: 0,
  };
  let total = 0;
  for (const c of categories) {
    if (!(c in counts)) {
      counts.unknown += 1;
    } else {
      counts[c] += 1;
    }
    total += 1;
  }
  let anomalyTotal = 0;
  let terminalTotal = 0;
  for (const c of FILL_ANOMALY_CATEGORIES) {
    if (c === 'in_flight') continue;
    terminalTotal += counts[c];
    if (ANOMALY_CATEGORIES.has(c)) anomalyTotal += counts[c];
  }
  const anomalyRate = terminalTotal > 0 ? anomalyTotal / terminalTotal : 0;
  return {
    total,
    anomaly_total: anomalyTotal,
    terminal_total: terminalTotal,
    anomaly_rate: anomalyRate,
    by_category: FILL_ANOMALY_CATEGORIES.map(category => ({
      category,
      label: FILL_ANOMALY_CATEGORY_LABELS[category],
      count: counts[category],
    })),
  };
}
