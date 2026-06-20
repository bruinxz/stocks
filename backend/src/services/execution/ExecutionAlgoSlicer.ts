/**
 * US-106 / EX-006: TWAP/VWAP/Iceberg 算法实现 — 大单拆 N 笔, 按 ADV 自适应.
 *
 * 上游 (Sprint 41-E ExecutionPolicyRouter) 给出"该用什么 policy"
 *   ┌─ LIMIT_AT_TOUCH / TWAP / VWAP / POV / WAIT / SKIP
 *   └─ slice_count + participation_rate + max_slippage_pct + 阈值/原因
 *
 * 本 service 把 policy → 可下单的"切片计划 (SlicePlan)":
 *   - **TWAP**: 在 duration 内均匀拆 N 片, 每片等量等间隔
 *   - **VWAP**: 按 A 股盘中量能 U-型分布 (开/收双峰) 加权拆片
 *   - **Iceberg**: 显示量 = visible_pct × total, 隐藏量逐片补足
 *   - **POV**: 按 participation_rate × 当前/预估 ADV 控制每片量
 *   - **LIMIT/WAIT/SKIP**: 退化为单片或空计划
 *
 * 设计要点 (与 ExecutionPolicyRouter 同款 pattern):
 *   1. **纯函数 builder**: buildTwapPlan / buildVwapPlan / buildIcebergPlan
 *      全 export, 单测 0 副作用
 *   2. **A 股 lot=100 强约束**: 每片 round 到 100 整数倍, 余数累计到末片;
 *      lot_size=0 走原始数 (单测/小单可关闭)
 *   3. **自适应 ADV**: 若调用方传 adv_qty, slicer 在 TWAP/VWAP slice 上
 *      cap 单片 qty ≤ adv_qty × participation_rate (默认 0.10)
 *   4. **默认 A 股 8 桶量能 profile** (9:30-11:30 + 13:00-15:00 = 4h),
 *      U-型: morning peak 0.20 → 0.10 平台 → close 0.15
 *   5. **fail-open**: 任何边界 (total_qty<=0/duration<=0/slices=0) 返回
 *      empty plan + reason, 不抛错
 *
 * 下游集成预留口子:
 *   - PaperTradingFacade.placeOrder 拿到 router result 后, 调
 *     `planExecutionSlices({ algo, total_qty, ... })` 得到 SlicePlan
 *   - 按 SlicePlan.slices[i] 顺序定时触发 child order (bridge_qmt/ptrade)
 *   - bridge layer 实时回填 fill_qty / fill_price 用于 TCA
 */

import { logger } from '../../utils/logger';

// ===========================================================================
// Types
// ===========================================================================

export type SliceAlgo =
  | 'TWAP'
  | 'VWAP'
  | 'ICEBERG'
  | 'POV'
  | 'LIMIT_AT_TOUCH'
  | 'WAIT_5M'
  | 'WAIT_15M'
  | 'WAIT_30M'
  | 'SKIP';

export interface SlicePlannerInput {
  algo: SliceAlgo;
  /** 总下单股数 (整数). 必须 > 0 才出非空 plan. */
  total_qty: number;
  /** 切片执行总时长 (分钟). 默认 240 (= A 股全日 4 小时净交易时间). */
  duration_minutes?: number;
  /** TWAP/VWAP 切片数; 不传则按 algo 默认 (TWAP=5 / VWAP=8). */
  slice_count?: number;
  /** Iceberg 单片可见占比 (0-1). 默认 0.1 = 一次只露 10%. */
  visible_pct?: number;
  /** VWAP 自定义量能 profile (长度任意, 归一化前可任意正数). */
  volume_profile?: number[];
  /** 起始时间 offset (分钟), 默认 0 (= 收到信号即开始). */
  start_offset_minutes?: number;
  /** A 股最小成交单位, 默认 100 股/手. 设 0 关闭 round. */
  lot_size?: number;
  /** POV 参与率 (0-1). */
  participation_rate?: number;
  /** 预估当日 ADV (股), POV 必填; TWAP/VWAP 若提供则启用 per-slice cap. */
  adv_qty?: number;
  /** 端到端单标识, 用于日志/审计追踪. */
  parent_order_id?: string;
}

export interface SliceItem {
  /** 0-based 切片序号. */
  index: number;
  /** 距 plan 起点的偏移分钟数. */
  time_offset_minutes: number;
  /** 该切片占总量的比例 (sum 应 = 1, lot rounding 后可能微偏). */
  qty_share: number;
  /** 该切片实际下单股数 (已 lot round). */
  qty: number;
  /** Iceberg 时为可见量 (< qty); 非 iceberg 时 = qty. */
  visible_qty: number;
  /** 是否为 iceberg chunk. */
  is_iceberg: boolean;
  /** 人类可读 reason / 量能桶来源等. */
  notes: string;
}

export interface SlicePlan {
  algo: SliceAlgo;
  /** 入参 total_qty 原值. */
  total_qty: number;
  /** 实际下单总量 (= sum(slices.qty), lot round 后可能 ≠ total_qty). */
  scheduled_qty: number;
  slices: SliceItem[];
  duration_minutes: number;
  /** 整体 plan 的 human-readable 说明. */
  reason: string;
  /** 入参 (经 normalize) 回写, 审计 / debug 用. */
  resolved: {
    slice_count: number;
    visible_pct: number;
    lot_size: number;
    participation_rate: number;
    adv_qty: number;
    start_offset_minutes: number;
    parent_order_id: string;
  };
}

// ===========================================================================
// Constants
// ===========================================================================

/**
 * A 股盘中典型 U-型量能分布 (4 小时 / 8 个 30 分钟桶):
 *   9:30-10:00  0.20  开盘冲击, 量能最大
 *   10:00-10:30 0.13
 *   10:30-11:00 0.10
 *   11:00-11:30 0.10
 *   13:00-13:30 0.10  午后续盘
 *   13:30-14:00 0.10
 *   14:00-14:30 0.12
 *   14:30-15:00 0.15  收盘对手盘活跃
 * Σ = 1.00
 */
export const DEFAULT_ASHARE_VOLUME_PROFILE: readonly number[] = Object.freeze([
  0.2, 0.13, 0.1, 0.1, 0.1, 0.1, 0.12, 0.15,
]);

export const DEFAULT_TRADING_DURATION_MIN = 240; // 4h
export const DEFAULT_TWAP_SLICES = 5;
export const DEFAULT_VWAP_SLICES = 8;
export const DEFAULT_ICEBERG_VISIBLE_PCT = 0.1;
export const DEFAULT_POV_RATE = 0.1;
export const DEFAULT_LOT_SIZE = 100; // A 股最小手数

// ===========================================================================
// Pure helpers
// ===========================================================================

/** 将 weights round 到 lot_size 整数倍, 余数累计到最后一片. */
export function roundQtyByLot(weights: number[], total_qty: number, lot_size: number): number[] {
  if (total_qty <= 0 || weights.length === 0) return [];
  const lot = Math.max(0, Math.floor(lot_size));
  const sumW = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (sumW <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (w > 0 ? (w / sumW) * total_qty : 0));
  if (lot <= 1) {
    // 无 lot 约束, 直接 floor + 末片补差
    const floored = raw.map(q => Math.floor(q));
    const diff = total_qty - floored.reduce((a, b) => a + b, 0);
    if (floored.length > 0) floored[floored.length - 1] += diff;
    return floored;
  }
  // 每片 floor 到 lot 倍数
  const rounded = raw.map(q => Math.floor(q / lot) * lot);
  const remaining = total_qty - rounded.reduce((a, b) => a + b, 0);
  // 把剩余 (一定 ≥ 0 且 < lot * slices) 按 lot 块分配到 share 最大的切片
  let resid = Math.max(0, remaining);
  // 按原始 raw 的小数部分排序, 余数优先给"被舍掉最多"的桶
  const idxOrdered = rounded
    .map((_, i) => i)
    .sort((a, b) => raw[b] - rounded[b] - (raw[a] - rounded[a]));
  let pointer = 0;
  while (resid >= lot && pointer < idxOrdered.length * 4) {
    const i = idxOrdered[pointer % idxOrdered.length];
    rounded[i] += lot;
    resid -= lot;
    pointer++;
  }
  // 末尾若仍有不足 lot 的零头, 累到最后一片 (放弃 lot 约束以保 total)
  if (resid > 0) rounded[rounded.length - 1] += resid;
  return rounded;
}

/** TWAP: 等量等间隔切片. */
export function buildTwapPlan(
  total_qty: number,
  slice_count: number,
  duration_min: number,
  lot_size: number,
  start_offset_min = 0,
  adv_cap?: number
): SliceItem[] {
  if (total_qty <= 0 || slice_count <= 0 || duration_min <= 0) return [];
  const n = Math.max(1, Math.floor(slice_count));
  const weights = Array(n).fill(1);
  let qtys = roundQtyByLot(weights, total_qty, lot_size);
  // ADV cap: 单片不得超过 adv_cap
  if (adv_cap && adv_cap > 0) {
    qtys = qtys.map(q => Math.min(q, Math.floor(adv_cap)));
  }
  const interval = duration_min / n;
  return qtys.map((qty, i) => ({
    index: i,
    time_offset_minutes: Math.round((start_offset_min + i * interval) * 100) / 100,
    qty_share: total_qty > 0 ? qty / total_qty : 0,
    qty,
    visible_qty: qty,
    is_iceberg: false,
    notes: `TWAP ${i + 1}/${n} 等量切片 (interval=${interval.toFixed(1)}min)`,
  }));
}

/** VWAP: 按量能 profile 加权切片. */
export function buildVwapPlan(
  total_qty: number,
  slice_count: number,
  duration_min: number,
  lot_size: number,
  profile: readonly number[],
  start_offset_min = 0,
  adv_cap?: number
): SliceItem[] {
  if (total_qty <= 0 || slice_count <= 0 || duration_min <= 0) return [];
  const n = Math.max(1, Math.floor(slice_count));
  // 把 profile resample 到 n 个桶 (线性插值 / 平均聚合)
  const weights = resampleProfile(profile, n);
  let qtys = roundQtyByLot(weights, total_qty, lot_size);
  if (adv_cap && adv_cap > 0) {
    qtys = qtys.map(q => Math.min(q, Math.floor(adv_cap)));
  }
  const interval = duration_min / n;
  return qtys.map((qty, i) => ({
    index: i,
    time_offset_minutes: Math.round((start_offset_min + i * interval) * 100) / 100,
    qty_share: total_qty > 0 ? qty / total_qty : 0,
    qty,
    visible_qty: qty,
    is_iceberg: false,
    notes: `VWAP ${i + 1}/${n} weight=${weights[i].toFixed(3)}`,
  }));
}

/** Iceberg: 每片 visible = total*visible_pct, 一片落地后再启下一片. */
export function buildIcebergPlan(
  total_qty: number,
  visible_pct: number,
  duration_min: number,
  lot_size: number,
  start_offset_min = 0
): SliceItem[] {
  if (total_qty <= 0 || visible_pct <= 0 || visible_pct > 1) return [];
  const lot = Math.max(1, Math.floor(lot_size) || 1);
  // 计算每片可见量, lot round 后至少 1 lot
  let visible_qty = Math.max(lot, Math.floor((total_qty * visible_pct) / lot) * lot);
  if (visible_qty > total_qty) visible_qty = total_qty;
  const chunks = Math.max(1, Math.ceil(total_qty / visible_qty));
  const interval = duration_min / chunks;
  const slices: SliceItem[] = [];
  let remaining = total_qty;
  for (let i = 0; i < chunks; i++) {
    const qty = Math.min(visible_qty, remaining);
    slices.push({
      index: i,
      time_offset_minutes: Math.round((start_offset_min + i * interval) * 100) / 100,
      qty_share: total_qty > 0 ? qty / total_qty : 0,
      qty,
      visible_qty: qty, // iceberg 单片"显示"与"成交"等量, 但与 total 比小
      is_iceberg: true,
      notes: `Iceberg ${i + 1}/${chunks} visible_pct=${(visible_pct * 100).toFixed(1)}%`,
    });
    remaining -= qty;
    if (remaining <= 0) break;
  }
  return slices;
}

/** POV: 按 participation_rate × ADV per 分钟 推算每片量 / 间隔. */
export function buildPovPlan(
  total_qty: number,
  duration_min: number,
  participation_rate: number,
  adv_qty: number,
  lot_size: number,
  start_offset_min = 0
): SliceItem[] {
  if (total_qty <= 0 || duration_min <= 0 || participation_rate <= 0 || adv_qty <= 0) return [];
  // 每分钟可参与量 = ADV / DEFAULT_TRADING_DURATION_MIN × participation_rate
  const per_min_qty = (adv_qty / DEFAULT_TRADING_DURATION_MIN) * participation_rate;
  if (per_min_qty <= 0) return [];
  // 推算切片数 = ceil(total / per_slice_qty); 默认每片 5 分钟
  const slice_interval = 5;
  const per_slice = per_min_qty * slice_interval;
  const slices_needed = Math.max(1, Math.ceil(total_qty / per_slice));
  // 实际拆片数 cap 在 duration / interval 之内
  const slice_count = Math.min(slices_needed, Math.floor(duration_min / slice_interval));
  if (slice_count <= 0) return [];
  const weights = Array(slice_count).fill(1);
  const qtys = roundQtyByLot(weights, total_qty, lot_size);
  return qtys.map((qty, i) => ({
    index: i,
    time_offset_minutes: Math.round((start_offset_min + i * slice_interval) * 100) / 100,
    qty_share: total_qty > 0 ? qty / total_qty : 0,
    qty,
    visible_qty: qty,
    is_iceberg: false,
    notes: `POV rate=${(participation_rate * 100).toFixed(1)}% per_min_qty=${per_min_qty.toFixed(
      0
    )}`,
  }));
}

/** 把任意长度的 weights 线性 resample 到 n 个桶, 桶内取面积均值. */
export function resampleProfile(profile: readonly number[], n: number): number[] {
  if (n <= 0) return [];
  if (profile.length === 0) return Array(n).fill(1);
  if (n === profile.length) return profile.slice();
  const out = Array(n).fill(0);
  const bucketSize = profile.length / n;
  for (let i = 0; i < n; i++) {
    const start = i * bucketSize;
    const end = (i + 1) * bucketSize;
    let acc = 0;
    let weight = 0;
    const startIdx = Math.floor(start);
    const endIdx = Math.min(profile.length, Math.ceil(end));
    for (let j = startIdx; j < endIdx; j++) {
      const segStart = Math.max(start, j);
      const segEnd = Math.min(end, j + 1);
      const seg = Math.max(0, segEnd - segStart);
      const v = profile[j] >= 0 ? profile[j] : 0;
      acc += v * seg;
      weight += seg;
    }
    out[i] = weight > 0 ? acc / weight : 0;
  }
  return out;
}

// ===========================================================================
// Main planner
// ===========================================================================

/**
 * 主入口: policy + total_qty → SlicePlan.
 *
 * fail-open: 任何 invalid input (total<=0 / duration<=0 / unknown algo) 返回
 * 空 slices + reason, 不抛错.
 */
export function planExecutionSlices(input: SlicePlannerInput): SlicePlan {
  const algo = input.algo;
  const total_qty = Math.max(0, Math.floor(input.total_qty || 0));
  const duration_min = input.duration_minutes ?? DEFAULT_TRADING_DURATION_MIN;
  const lot_size = input.lot_size ?? DEFAULT_LOT_SIZE;
  const start_offset = input.start_offset_minutes ?? 0;
  const visible_pct = input.visible_pct ?? DEFAULT_ICEBERG_VISIBLE_PCT;
  const participation_rate = input.participation_rate ?? DEFAULT_POV_RATE;
  const adv_qty = Math.max(0, Math.floor(input.adv_qty || 0));
  const parent_order_id = input.parent_order_id || '';
  const resolvedSliceCount =
    input.slice_count ?? (algo === 'VWAP' ? DEFAULT_VWAP_SLICES : DEFAULT_TWAP_SLICES);

  const resolved = {
    slice_count: Math.max(1, Math.floor(resolvedSliceCount)),
    visible_pct,
    lot_size,
    participation_rate,
    adv_qty,
    start_offset_minutes: start_offset,
    parent_order_id,
  };

  // 边界返回空 plan
  if (total_qty <= 0 || duration_min <= 0) {
    return {
      algo,
      total_qty,
      scheduled_qty: 0,
      slices: [],
      duration_minutes: duration_min,
      reason: `empty plan: total_qty=${total_qty} duration_min=${duration_min}`,
      resolved,
    };
  }

  // ADV cap (避免单片 > 参与率 × ADV)
  const adv_cap = adv_qty > 0 ? Math.floor(adv_qty * participation_rate) : undefined;

  let slices: SliceItem[];
  let reason: string;

  switch (algo) {
    case 'TWAP':
      slices = buildTwapPlan(
        total_qty,
        resolved.slice_count,
        duration_min,
        lot_size,
        start_offset,
        adv_cap
      );
      reason = `TWAP ${slices.length} 切片 / ${duration_min}min`;
      break;
    case 'VWAP': {
      const profile =
        input.volume_profile && input.volume_profile.length > 0
          ? input.volume_profile
          : DEFAULT_ASHARE_VOLUME_PROFILE;
      slices = buildVwapPlan(
        total_qty,
        resolved.slice_count,
        duration_min,
        lot_size,
        profile,
        start_offset,
        adv_cap
      );
      reason = `VWAP ${slices.length} 切片 / ${duration_min}min (profile len=${profile.length})`;
      break;
    }
    case 'ICEBERG':
      slices = buildIcebergPlan(total_qty, visible_pct, duration_min, lot_size, start_offset);
      reason = `ICEBERG visible_pct=${(visible_pct * 100).toFixed(1)}% (${slices.length} chunks)`;
      break;
    case 'POV':
      slices = buildPovPlan(
        total_qty,
        duration_min,
        participation_rate,
        adv_qty,
        lot_size,
        start_offset
      );
      reason =
        adv_qty <= 0
          ? `POV 缺 ADV → 空 plan (需调用方提供 adv_qty)`
          : `POV ${slices.length} 切片 / 参与率 ${(participation_rate * 100).toFixed(1)}%`;
      break;
    case 'LIMIT_AT_TOUCH':
      // 退化为单片
      slices = [
        {
          index: 0,
          time_offset_minutes: start_offset,
          qty_share: 1,
          qty: roundQtyByLot([1], total_qty, lot_size)[0] || total_qty,
          visible_qty: roundQtyByLot([1], total_qty, lot_size)[0] || total_qty,
          is_iceberg: false,
          notes: 'LIMIT 单片贴价',
        },
      ];
      reason = 'LIMIT 单片';
      break;
    case 'SKIP':
    case 'WAIT_5M':
    case 'WAIT_15M':
    case 'WAIT_30M':
      slices = [];
      reason = `${algo}: 不下单 / 等待`;
      break;
    default:
      slices = [];
      reason = `unknown algo: ${algo}`;
  }

  const scheduled_qty = slices.reduce((a, s) => a + s.qty, 0);
  return {
    algo,
    total_qty,
    scheduled_qty,
    slices,
    duration_minutes: duration_min,
    reason,
    resolved,
  };
}

// ===========================================================================
// Service wrapper
// ===========================================================================

export class ExecutionAlgoSlicer {
  /** Main API: plan slices for one parent order. fail-open. */
  plan(input: SlicePlannerInput): SlicePlan {
    try {
      const p = planExecutionSlices(input);
      logger.debug?.(
        `[ExecutionAlgoSlicer] ${input.parent_order_id || '-'} algo=${input.algo} total=${
          input.total_qty
        } → ${p.slices.length} 切片 scheduled=${p.scheduled_qty} reason=${p.reason}`
      );
      return p;
    } catch (error: any) {
      logger.warn(
        `[ExecutionAlgoSlicer] plan 失败 (algo=${input.algo} parent=${
          input.parent_order_id || '-'
        }): ${error?.message || error} — fail-open 返回空 plan`
      );
      return {
        algo: input.algo,
        total_qty: input.total_qty,
        scheduled_qty: 0,
        slices: [],
        duration_minutes: input.duration_minutes ?? DEFAULT_TRADING_DURATION_MIN,
        reason: `error: ${error?.message || error}`,
        resolved: {
          slice_count: input.slice_count ?? DEFAULT_TWAP_SLICES,
          visible_pct: input.visible_pct ?? DEFAULT_ICEBERG_VISIBLE_PCT,
          lot_size: input.lot_size ?? DEFAULT_LOT_SIZE,
          participation_rate: input.participation_rate ?? DEFAULT_POV_RATE,
          adv_qty: input.adv_qty ?? 0,
          start_offset_minutes: input.start_offset_minutes ?? 0,
          parent_order_id: input.parent_order_id || '',
        },
      };
    }
  }
}

export const executionAlgoSlicer = new ExecutionAlgoSlicer();
