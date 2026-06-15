/**
 * L8 Activation Record — Sprint 27 (Sep 2026)
 *
 * 每笔 signal 进 autopilot 决策流程时, 沿 8 层 (L1_data → L8_reflection) 流转,
 * 每层都可能: (a) 没走到 (b) 走到但未影响决策 (c) 走到且拦截 (d) 走到且改了仓位/参数.
 *
 * 这套类型 + helper 把"每层激活状态"压成一个 JSONB-safe 结构, 由
 * PaperTradingAutomationService 沿决策流程逐层写入, 最终注入到
 * paper_trading_order_intents.metadata.l8_activation 字段。
 *
 * 设计原则:
 *   1. 零依赖 — 不 import 任何 model / service, 纯类型 + 纯函数, 可单测
 *   2. mutable in-place — 沿决策流程逐 layer mark, 不每步返回新对象 (避免拷贝开销)
 *   3. detail 字段允许任意结构 — 每层私有上下文 (decision_id / multiplier / threshold)
 *   4. JSONB-safe — 不存 Date 对象 / Map / Set, 所有字段都 string / number / boolean / plain obj
 *
 * Activation Dashboard 后端 endpoint 直接 reduce 这些 record 出聚合数据:
 *   - reached / blocked / contributed 比例 (= 各层激活率)
 *   - block_at 分布 (= 主要拦截原因落在哪层)
 *   - reached_layer 分布 (= 信号沿决策流走到的最远层)
 */

/**
 * 8 层 layer key, 与 backend/src/layers/ 下 L1_data..L8_reflection barrel 一一对应,
 * 也与 frontend SystemTopologyMap.STAGES 的 key 一致 (cross-layer 字符串契约).
 */
export type LayerKey =
  | 'L1_data'
  | 'L2_signal'
  | 'L3_meta'
  | 'L4_construction'
  | 'L5_feasibility'
  | 'L6_risk'
  | 'L7_governor'
  | 'L8_reflection';

/**
 * 按 L1..L8 顺序 — 让 reached_layer "最远走到哪层" 的比较成为简单的 index 比较.
 * 也用于 dashboard 渲染时 stable iteration order.
 */
export const LAYER_ORDER: ReadonlyArray<LayerKey> = [
  'L1_data',
  'L2_signal',
  'L3_meta',
  'L4_construction',
  'L5_feasibility',
  'L6_risk',
  'L7_governor',
  'L8_reflection',
];

/**
 * 单层快照. 三个 boolean 互不互斥 (一层可同时 reached + blocked, 因为是
 * "进了这层 + 在这层被拦").
 *
 * - reached:    决策流程真的走到了这层 (区别于 L4 这种当前没接入的 layer, 永远 false)
 * - blocked:    在这层被拦截下来, signal 流程在此终止
 * - contributed: 这层真改了下游参数 (e.g. governor multiplier < 1.0, sizing.decision_pct
 *               与 actual_pct delta != 0). 单纯"走过但没改"≠ contributed.
 */
export interface LayerSnapshot {
  reached: boolean;
  blocked: boolean;
  contributed: boolean;
  /** 各层私有上下文; 必须 JSONB-safe (无 Date / Map / Set) */
  detail?: Record<string, any>;
}

/**
 * 完整 8 层 activation 记录. 一笔 signal = 一份 record, 在 buy-decision loop
 * 顶部 newActivation() 初始化, 沿途 markXxx mutate, 最终序列化进 order intent metadata.
 */
export interface L8ActivationRecord {
  L1_data: LayerSnapshot;
  L2_signal: LayerSnapshot;
  L3_meta: LayerSnapshot;
  L4_construction: LayerSnapshot;
  L5_feasibility: LayerSnapshot;
  L6_risk: LayerSnapshot;
  L7_governor: LayerSnapshot;
  L8_reflection: LayerSnapshot;
  /** 决策流走到的最远层 (= 任何 reached=true 中 LAYER_ORDER 最大者) */
  reached_layer: LayerKey;
  /** 被拦的那层 (= blocked=true 的第一层); 未拦则 undefined */
  blocked_at?: LayerKey;
  /**
   * 最终 outcome: 与 PaperTradingOrderIntent.status 镜像
   *   - executed: 走到 L8 + 真下单
   *   - skipped: 被某 soft gate 跳过 (MetaLabel low conf / 数据质量低)
   *   - rejected: 被 hard gate 拒 (Position 上限 / DrawdownBreaker pause)
   *   - pending: 还在流程中 (init 默认状态, 调用方应在写库前 setOutcome)
   */
  final_outcome: 'executed' | 'skipped' | 'rejected' | 'pending';
}

function emptyLayer(): LayerSnapshot {
  return { reached: false, blocked: false, contributed: false };
}

/**
 * 初始化全空 record — 所有 layer reached=false, reached_layer='L1_data' (loop 入口),
 * final_outcome='pending'. 调用方在 loop iteration 顶部各 signal 一次.
 */
export function newActivation(): L8ActivationRecord {
  return {
    L1_data: emptyLayer(),
    L2_signal: emptyLayer(),
    L3_meta: emptyLayer(),
    L4_construction: emptyLayer(),
    L5_feasibility: emptyLayer(),
    L6_risk: emptyLayer(),
    L7_governor: emptyLayer(),
    L8_reflection: emptyLayer(),
    reached_layer: 'L1_data',
    final_outcome: 'pending',
  };
}

/**
 * 内部 helper: 比较两个 layer 的 LAYER_ORDER index, 返回较大者.
 * 用于 markReached 更新 reached_layer (=最远).
 */
function maxLayer(a: LayerKey, b: LayerKey): LayerKey {
  return LAYER_ORDER.indexOf(a) >= LAYER_ORDER.indexOf(b) ? a : b;
}

/**
 * 标记某层 "决策流走到了". 自动更新 record.reached_layer = max(prev, layer).
 *
 * detail 可选, 写入该层 LayerSnapshot.detail (合并而非替换 — 同层多次 mark
 * 会保留所有 detail 字段).
 *
 * 调用示例:
 *   markReached(act, 'L3_meta', { meta_label_decision_id: 42, confidence: 0.78 });
 */
export function markReached(
  rec: L8ActivationRecord,
  layer: LayerKey,
  detail?: Record<string, any>
): void {
  const snap = rec[layer];
  snap.reached = true;
  if (detail) {
    snap.detail = { ...(snap.detail || {}), ...detail };
  }
  rec.reached_layer = maxLayer(rec.reached_layer, layer);
}

/**
 * 标记某层 "在这里拦下了". 自动 set blocked + 也 set reached (拦截即意味着走到),
 * 同时 set record.blocked_at = layer (首次 block 胜出, 后续不再覆盖以保留首拦记录).
 *
 * 注意: 调用方仍需在拦截后 setOutcome('rejected'/'skipped') 以最终落地状态.
 */
export function markBlocked(
  rec: L8ActivationRecord,
  layer: LayerKey,
  detail?: Record<string, any>
): void {
  const snap = rec[layer];
  snap.reached = true;
  snap.blocked = true;
  if (detail) {
    snap.detail = { ...(snap.detail || {}), ...detail };
  }
  rec.reached_layer = maxLayer(rec.reached_layer, layer);
  if (!rec.blocked_at) {
    rec.blocked_at = layer;
  }
}

/**
 * 标记某层 "真改了下游参数". 自动 set contributed + 也 set reached.
 *
 * 调用示例:
 *   - Governor multiplier < 1.0     → markContributed(act, 'L7_governor', {multiplier: 0.7})
 *   - Sizing.decision_pct != actual → markContributed(act, 'L3_meta', {sizing_delta: 0.5})
 *   - MetaLabel decision='bet'       → markContributed(act, 'L3_meta', {confidence: 0.78})
 *
 * "走过但没改" 不算 contributed (e.g. Feasibility decision='fillable' 是 reached
 * 但 not contributed; 只有 decision='risky' 仍允过 / decision='blocked' 才算
 * contributed 或 blocked).
 */
export function markContributed(
  rec: L8ActivationRecord,
  layer: LayerKey,
  detail?: Record<string, any>
): void {
  const snap = rec[layer];
  snap.reached = true;
  snap.contributed = true;
  if (detail) {
    snap.detail = { ...(snap.detail || {}), ...detail };
  }
  rec.reached_layer = maxLayer(rec.reached_layer, layer);
}

/**
 * 设置 final outcome. 调用方在写 order intent 前调一次, 把 'pending' 落地为
 * executed / skipped / rejected.
 *
 * 通常配合 skip()/executed 路径:
 *   - skip 路径调 setOutcome(act, 'skipped' | 'rejected')
 *   - executed 路径调 setOutcome(act, 'executed') + markReached('L8_reflection')
 */
export function setOutcome(
  rec: L8ActivationRecord,
  outcome: 'executed' | 'skipped' | 'rejected'
): void {
  rec.final_outcome = outcome;
}
