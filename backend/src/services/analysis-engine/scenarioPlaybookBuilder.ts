/**
 * V3 场景化操作建议生成器 (CA-2) — 5 档次日开盘 playbook.
 *
 * 业务背景: 截图产品 ("炒股养家" 抖音号) 把推荐卡片的"操作建议"做成 5 档场景:
 *   - 不告诉用户"明天就买", 而是"明天高开就放量博弈, 低开就观察支撑位"
 *   - 用户带着 5 档 playbook 看盘, 不需要现场判断
 *   - 把"系统建议"转化为"用户决策框架", 责任合理转移
 *
 * 5 档阈值 (硬编码, 截图字面):
 *   - HIGH_STRONG:  next_open / prev_close - 1 >= +2%
 *   - HIGH_WEAK:    next_open ∈ [0%, +2%)
 *   - FLAT:         next_open ∈ (-1%, 0%)
 *   - LOW_MILD:     next_open ∈ (-3%, -1%]
 *   - LOW_HARD:     next_open <= -3%
 *
 * 注意 HIGH_WEAK 与 FLAT 区间衔接: 边界 0% 落 HIGH_WEAK (业务上 "稍高开" 与
 * "平开" 在 0 这一点上 HIGH_WEAK 文案更合适); 边界 -1% 落 LOW_MILD (止损位
 * 文案更有指导意义).
 *
 * 文案动态化:
 *   - 涉及 `entry_zone[0]` / `support_level` / `stop_loss` 数字时, 自动注入实际数字
 *   - evidence 含 "放量" / "突破" / "巨量" → HIGH_STRONG 文案加强 ("放量突破信号")
 *   - evidence 含 "缩量" / "量能不足" → HIGH_WEAK 警告 ("缩量需小心")
 *   - capital.score > 60 → HIGH_STRONG 文案加 "资金加速"
 *   - risk warnings 含 "高位" / "拥挤" → LOW_HARD 加 "避免抄底" 加重
 *
 * 失效条件 (returns null instead of playbook):
 *   - decision.action === 'sell' / 'strong_sell' (卖出建议不需要次日开盘 playbook)
 *   - prev_close 缺失或非正 (无法算开盘价区间)
 *
 * 纯函数模块 — 与 [[v3CardHelpers]] 同款 jsdoc + Object.freeze 风格, 无副作用,
 * 无 DB 依赖, 完全可单测.
 */

export type ScenarioBucket = 'high_strong' | 'high_weak' | 'flat' | 'low_mild' | 'low_hard';

/**
 * 5 档阈值 — 与 SCENARIO_LABEL 同 key, 由 [[classifyOpenPrice]] 实际匹配逻辑使用
 * (实现采用 if/else 链而非 min/max 二分, 因边界归属在不同档之间是非对称的).
 *
 * 此常量主要给文档 / 单测 / UI 显示参考用, 修改它**不会**自动影响 classifyOpenPrice —
 * 任何阈值调整都必须同步改 classifyOpenPrice 实现.
 */
export const SCENARIO_THRESHOLDS: Readonly<Record<ScenarioBucket, { min: number; max: number }>> =
  Object.freeze({
    high_strong: Object.freeze({ min: 0.02, max: Infinity }),
    high_weak: Object.freeze({ min: 0.0, max: 0.02 }),
    flat: Object.freeze({ min: -0.01, max: 0.0 }),
    low_mild: Object.freeze({ min: -0.03, max: -0.01 }),
    low_hard: Object.freeze({ min: -Infinity, max: -0.03 }),
  });

/** 5 档中文 label — UI / playbook trigger 文案均直接读这里. */
export const SCENARIO_LABEL: Readonly<Record<ScenarioBucket, string>> = Object.freeze({
  high_strong: '高开 +2% 以上',
  high_weak: '高开 0 ~ +2%',
  flat: '平开 -1% ~ +1%',
  low_mild: '低开 -2% 以内',
  low_hard: '低开超 -3%',
});

/** 5 档 verdict 颜色 — UI 直接读. 中股惯例: 红=买/强, 橙=持有, 蓝=观望, 绿=避开. */
export const VERDICT_COLOR: Readonly<Record<'buy' | 'hold' | 'observe' | 'avoid', string>> =
  Object.freeze({
    buy: '#cf1322',
    hold: '#fa8c16',
    observe: '#1890ff',
    avoid: '#52c41a',
  });

/** 5 档 verdict 中文短语 — UI 显示 + 单测稳定. */
export const VERDICT_LABEL: Readonly<Record<'buy' | 'hold' | 'observe' | 'avoid', string>> =
  Object.freeze({
    buy: '建议参与',
    hold: '可持有',
    observe: '观望',
    avoid: '避开',
  });

export interface ScenarioPlaybookItem {
  bucket: ScenarioBucket;
  /** "高开 +2% 以上" */
  trigger: string;
  /** "放量突破信号, 可积极参与" */
  action: string;
  /** 数值止损价 (元), 仅 high_strong / high_weak / low_mild 会给; null = 不适用. */
  stop_loss: number | null;
  /** "buy" / "hold" / "observe" / "avoid" — 用户一眼就能定性的 verdict. */
  verdict: 'buy' | 'hold' | 'observe' | 'avoid';
  /** "avoid" 时显红框 (低开 -3% 以下 强制 true). */
  avoid: boolean;
}

export interface ScenarioPlaybookContext {
  /** 上一日收盘价 (元) — 用于算开盘价区间. */
  prev_close: number;
  /** entry_zone 下沿 (decision.entry_zone[0]) — low_mild 文案备用 (support 缺失时退而求其次). */
  entry_low: number | null;
  /** 60 日内技术支撑位 — low_mild 文案主用 ("关注 ¥X 支撑"). */
  support_level: number | null;
  /** 20 日 ATR (Avg True Range, 元) — high_strong 止损精细化用 (可选). */
  atr_20d: number | null;
  /** decision.action — sell / strong_sell 直接返 null 不出 playbook. */
  action: string;
  /** 所有 evidence label/detail 拼接的全文 — keyword 检测用. */
  evidence_text: string;
  /** capital.score (>60 触发 "资金加速" 文案). null = 缺该维, 不触发. */
  capital_score: number | null;
  /** risk_warnings 全文 — 含 "高位"/"拥挤" 加重 low_hard 文案. */
  risk_warnings_text: string;
}

// ---------------------------------------------------------------------------
//  内部 helpers
// ---------------------------------------------------------------------------

const SELL_ACTIONS: ReadonlyArray<string> = Object.freeze(['sell', 'strong_sell']);
const POSITIVE_ACTIONS: ReadonlyArray<string> = Object.freeze(['buy', 'strong_buy', 'add']);

const BREAKOUT_KEYWORDS: ReadonlyArray<string> = Object.freeze(['放量', '突破', '巨量']);
const VOLUME_WEAK_KEYWORDS: ReadonlyArray<string> = Object.freeze(['缩量', '量能不足']);
const RISK_HIGH_POSITION_KEYWORDS: ReadonlyArray<string> = Object.freeze(['高位', '拥挤']);

/** 数字按 2 位小数 round, 非 finite 返 null. */
function round2(x: number | null | undefined): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function safeText(x: string | null | undefined): string {
  return typeof x === 'string' ? x : '';
}

function containsAny(haystack: string, needles: ReadonlyArray<string>): boolean {
  if (!haystack) return false;
  for (const n of needles) {
    if (n && haystack.includes(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
//  主入口
// ---------------------------------------------------------------------------

/**
 * 把 next_open 价 → 5 档之一. prev_close <= 0 或非 finite 输入返 null.
 *
 * 边界归属 (与 SCENARIO_THRESHOLDS 文档一致):
 *   - pct >= 0.02  → high_strong
 *   - 0 <= pct < 0.02 → high_weak
 *   - -0.01 < pct < 0 → flat
 *   - -0.03 < pct <= -0.01 → low_mild
 *   - pct <= -0.03 → low_hard
 */
export function classifyOpenPrice(prev_close: number, next_open: number): ScenarioBucket | null {
  if (
    typeof prev_close !== 'number' ||
    typeof next_open !== 'number' ||
    !Number.isFinite(prev_close) ||
    !Number.isFinite(next_open) ||
    prev_close <= 0
  ) {
    return null;
  }
  const pct = next_open / prev_close - 1;
  if (pct >= 0.02) return 'high_strong';
  if (pct >= 0) return 'high_weak';
  if (pct > -0.01) return 'flat';
  if (pct > -0.03) return 'low_mild';
  return 'low_hard';
}

/**
 * 5 档 playbook 主入口. 失效返 null.
 *
 * 每档 item 文案模板:
 *   high_strong: "可积极参与" + ["放量突破信号"] + ["资金加速流入"]
 *                + " · 止损 ¥X (开盘价下方 -2%)"
 *   high_weak:   "温和走强, 观察量能配合" + ["量能不足需谨慎"]
 *                + " · 持续放量可持有, 缩量减仓 · 止损 ¥X"
 *   flat:        "窄幅整理, 持股观察" + ["新进仓位等待方向选择"]
 *   low_mild:    "关注 ¥support 支撑 · 不破可低吸博弈 · 止损 ¥X"
 *                / 缺 support 时降级 "低位观察 · 不破可低吸博弈"
 *   low_hard:    "明显弱势, 观望为宜" + ["高位破位, 避免抄底"] + " · 不急于抄底"
 */
export function buildScenarioPlaybook(ctx: ScenarioPlaybookContext): ScenarioPlaybookItem[] | null {
  if (!ctx) return null;
  if (
    typeof ctx.prev_close !== 'number' ||
    !Number.isFinite(ctx.prev_close) ||
    ctx.prev_close <= 0
  ) {
    return null;
  }
  const action = String(ctx.action ?? '').toLowerCase();
  if (SELL_ACTIONS.includes(action)) return null;

  const evidenceText = safeText(ctx.evidence_text);
  const riskText = safeText(ctx.risk_warnings_text);
  const hasBreakout = containsAny(evidenceText, BREAKOUT_KEYWORDS);
  const hasVolWeak = containsAny(evidenceText, VOLUME_WEAK_KEYWORDS);
  const hasRiskHighPos = containsAny(riskText, RISK_HIGH_POSITION_KEYWORDS);
  const capitalAccel =
    typeof ctx.capital_score === 'number' &&
    Number.isFinite(ctx.capital_score) &&
    ctx.capital_score > 60;
  const isPositiveAction = POSITIVE_ACTIONS.includes(action);

  // ----- high_strong: 估算开盘价 = prev_close * 1.02 (阈值下沿), 止损下方 -2% -----
  const hsOpen = ctx.prev_close * 1.02;
  // 若 ATR 可用且 > 0, 用 1 ATR 与 2% 之中**更窄**(更靠近 open)的, 让风险敞口更可控.
  let hsStop = hsOpen * 0.98;
  if (typeof ctx.atr_20d === 'number' && Number.isFinite(ctx.atr_20d) && ctx.atr_20d > 0) {
    const atrStop = hsOpen - ctx.atr_20d;
    if (atrStop > hsStop) hsStop = atrStop; // 取更高的 → 更紧 → 风险更小
  }
  const hsStopRounded = round2(hsStop);
  let hsAction = '可积极参与';
  if (hasBreakout) hsAction += ' · 放量突破信号';
  if (capitalAccel) hsAction += ' · 资金加速流入';
  if (hsStopRounded !== null) {
    hsAction += ` · 止损 ¥${hsStopRounded.toFixed(2)} (开盘价下方 -2%)`;
  }

  // ----- high_weak: 缺 stop 用 prev_close * 0.99 (跌破前收即止损) -----
  const hwStopRounded = round2(ctx.prev_close * 0.99);
  let hwAction = '温和走强, 观察量能配合';
  if (hasVolWeak) hwAction += ' · 量能不足需谨慎';
  hwAction += ' · 持续放量可持有, 缩量减仓';
  if (hwStopRounded !== null) {
    hwAction += ` · 止损 ¥${hwStopRounded.toFixed(2)}`;
  }

  // ----- flat -----
  let flatAction = '窄幅整理, 持股观察';
  if (isPositiveAction) flatAction += ' (新进仓位等待方向选择)';

  // ----- low_mild: 优先 support_level → 退而求其次 entry_low -----
  let lmAction: string;
  let lmStopRounded: number | null = null;
  const supportLevel =
    typeof ctx.support_level === 'number' &&
    Number.isFinite(ctx.support_level) &&
    ctx.support_level > 0
      ? ctx.support_level
      : typeof ctx.entry_low === 'number' && Number.isFinite(ctx.entry_low) && ctx.entry_low > 0
      ? ctx.entry_low
      : null;
  if (supportLevel !== null) {
    lmAction = `关注 ¥${round2(supportLevel)!.toFixed(2)} 支撑 · 不破可低吸博弈`;
    lmStopRounded = round2(supportLevel * 0.99);
    if (lmStopRounded !== null) {
      lmAction += ` · 止损 ¥${lmStopRounded.toFixed(2)}`;
    }
  } else {
    lmAction = '低位观察 · 不破可低吸博弈';
    // 无 support 不给 stop, 维持 null
  }

  // ----- low_hard: 强 avoid -----
  let lhAction = '明显弱势, 观望为宜';
  if (hasRiskHighPos) lhAction += ' · 高位破位, 避免抄底';
  lhAction += ' · 不急于抄底';

  return [
    {
      bucket: 'high_strong',
      trigger: SCENARIO_LABEL.high_strong,
      action: hsAction,
      stop_loss: hsStopRounded,
      verdict: 'buy',
      avoid: false,
    },
    {
      bucket: 'high_weak',
      trigger: SCENARIO_LABEL.high_weak,
      action: hwAction,
      stop_loss: hwStopRounded,
      verdict: 'hold',
      avoid: false,
    },
    {
      bucket: 'flat',
      trigger: SCENARIO_LABEL.flat,
      action: flatAction,
      stop_loss: null,
      verdict: 'observe',
      avoid: false,
    },
    {
      bucket: 'low_mild',
      trigger: SCENARIO_LABEL.low_mild,
      action: lmAction,
      stop_loss: lmStopRounded,
      verdict: 'observe',
      avoid: false,
    },
    {
      bucket: 'low_hard',
      trigger: SCENARIO_LABEL.low_hard,
      action: lhAction,
      stop_loss: null,
      verdict: 'avoid',
      avoid: true,
    },
  ];
}
