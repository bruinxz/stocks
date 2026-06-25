/**
 * V3 卡片详情区结构化模板生成器 (CA-3).
 *
 * 业务背景: 截图产品 ("炒股养家" 抖音号) 把单只推荐卡的下半区拆成 3 段:
 *   1. 技术面 — *结构化* 模板, 把当日盘面指标 (涨跌/振幅/换手/量比/成交额/市值) 串成
 *      一段中文段落, 末尾用 evidence 提取"上涨逻辑"短语 + 近 20 日累计涨跌的中期视角;
 *      给用户"专业研报"密度而非纯数字罗列.
 *   2. 观察点 — 5 条动态生成的"接下来需要盯什么": 题材跟风 / 关键价位站稳 / 量比维持 /
 *      支撑/阻力 / 技术指标背离. 缺少触发条件则该条不出, 不强行凑数.
 *   3. 风险 (红框) — 2 条"什么情况就放弃"硬规则: 低开超 -3% / 竞价缩量; 命中额外
 *      触发器再追加 (短线遇阻 / 情绪过热 / ST 类). 红框 + warning 图标突出.
 *
 * 这 3 段都是 **派生** 字段, 不增加任何分析负载, 全部从 AnalyzerOutput.evidence +
 * decision + daily_bars + RealtimeQuote 拼出来. 与 [[scenarioPlaybookBuilder]] /
 * [[v3CardHelpers]] 同款风格: 纯函数 + Object.freeze 常量 + jsdoc + 零副作用,
 * 完全可单测.
 *
 * 失败兜底: 所有字段 ctx 全 null 时, 函数仍返合理默认 (技术面给一段"数据加载中, 请稍候"
 * 的兜底文案; 观察点返空数组; 风险返默认 2 条硬规则), 让 UI 不至于布局崩裂.
 */

// ---------------------------------------------------------------------------
//  公共常量
// ---------------------------------------------------------------------------

/** 风险红框背景色 — UI 直接读 (与 VERDICT_COLOR.buy 同色但语义是"危险"). */
export const RISK_RULE_COLOR = '#cf1322';

/** 数字按 2 位小数 round, 非 finite 返 null. */
function round2(x: number | null | undefined): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

/** 数字按 1 位小数 round, 非 finite 返 null. */
function round1(x: number | null | undefined): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return Math.round(x * 10) / 10;
}

function safeText(x: string | null | undefined): string {
  return typeof x === 'string' ? x : '';
}

// ===========================================================================
//  Section 1: 技术面段
// ===========================================================================

export interface TechnicalSummaryContext {
  /** 今日涨跌幅 (%), 已是 ×100 标度 (与 RealtimeQuote.change_percent 一致). */
  change_pct_today: number | null;
  /** 换手率 (%), 已是 ×100 标度. */
  turnover_rate: number | null;
  /** 量比 = today_volume / avg_5d_volume, 倍数标度 (非 %). */
  volume_ratio: number | null;
  /** 成交额, 单位"亿". */
  amount_yi: number | null;
  /** 流通市值, 单位"亿". */
  market_cap_yi: number | null;
  /** 今日振幅 (%), 已是 ×100 标度. */
  amplitude_pct: number | null;
  /** 全 evidence label/detail 拼接的文本, 给"上涨逻辑"提取用. */
  evidence_text: string;
  /** 近 20 日累计涨跌 (%), ×100 标度. */
  change_pct_20d: number | null;
}

/**
 * 振幅档位: 截图惯例
 *   - < 2%: "窄幅震荡"
 *   - 2-5%: "正常波动"
 *   - 5-8%: "显著波动"
 *   - >= 8%: "剧烈震荡"
 */
export function amplitudeDesc(pct: number | null): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '振幅未知';
  const a = Math.abs(pct);
  if (a < 2) return '窄幅震荡';
  if (a < 5) return '正常波动';
  if (a < 8) return '显著波动';
  return '剧烈震荡';
}

/**
 * 换手率档位:
 *   - < 1%: "极低"
 *   - 1-5%: "偏低"
 *   - 5-15%: "适中"
 *   - 15-25%: "活跃"
 *   - >= 25%: "过热"
 */
export function turnoverDesc(pct: number | null): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return '';
  if (pct < 1) return '极低';
  if (pct < 5) return '偏低';
  if (pct < 15) return '适中';
  if (pct < 25) return '活跃';
  return '过热';
}

/**
 * 量比档位 (倍数标度):
 *   - < 0.8: "缩量"
 *   - 0.8-1.5: "平量"
 *   - 1.5-3: "温和放量"
 *   - 3-8: "显著放量"
 *   - >= 8: "巨量"
 */
export function volumeRatioDesc(ratio: number | null): string {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) return '';
  if (ratio < 0.8) return '缩量';
  if (ratio < 1.5) return '平量';
  if (ratio < 3) return '温和放量';
  if (ratio < 8) return '显著放量';
  return '巨量';
}

/**
 * 成交额档位 (单位亿):
 *   - < 5: "成交清淡"
 *   - 5-20: "正常成交"
 *   - 20-50: "大额成交"
 *   - >= 50: "巨量成交"
 */
export function amountDesc(yi: number | null): string {
  if (typeof yi !== 'number' || !Number.isFinite(yi) || yi < 0) return '';
  if (yi < 5) return '成交清淡';
  if (yi < 20) return '正常成交';
  if (yi < 50) return '大额成交';
  return '巨量成交';
}

/**
 * 市值档位 (单位亿):
 *   - >= 1000: "超大盘"
 *   - 500-1000: "大盘"
 *   - 100-500: "中盘"
 *   - < 100: "小盘"
 */
export function marketCapDesc(yi: number | null): string {
  if (typeof yi !== 'number' || !Number.isFinite(yi) || yi <= 0) return '';
  if (yi >= 1000) return '超大盘';
  if (yi >= 500) return '大盘';
  if (yi >= 100) return '中盘';
  return '小盘';
}

/**
 * 中期趋势档位 (近 20 日累计涨跌 %):
 *   - >= 10: "强势上涨"
 *   - 2-10: "温和走强"
 *   - -2-+2: "横盘震荡"
 *   - -10--2: "中期调整"
 *   - <= -10: "深度回调"
 */
export function trendDesc(pct20d: number | null): string {
  if (typeof pct20d !== 'number' || !Number.isFinite(pct20d)) return '';
  if (pct20d >= 10) return '强势上涨';
  if (pct20d >= 2) return '温和走强';
  if (pct20d > -2) return '横盘震荡';
  if (pct20d > -10) return '中期调整';
  return '深度回调';
}

/**
 * 涨跌幅格式化: "+1.37%" / "-0.5%" / "平开".
 */
export function formatChangePct(pct: number | null): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '涨跌未知';
  if (Math.abs(pct) < 0.05) return '平开';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * 从 evidence 全文抽取"上涨逻辑"短语 — 6 类 keyword 命中字典.
 *
 * 命中表 (按优先级):
 *   "题材" / "概念" / "热点"        → "题材活跃"
 *   "突破" / "新高" / "形态"        → "技术突破"
 *   "放量" / "量能"                 → "放量上攻"
 *   "北向" / "主力" / "资金"        → "资金流入"
 *   "业绩" / "财报" / "盈利"        → "业绩驱动"
 *   "行业" / "板块"                 → "板块共振"
 *
 * 取前 2 个命中, 用 " · " 连; 0 个返 "技术形态".
 */
const LOGIC_KEYWORD_MAP: ReadonlyArray<{ keywords: ReadonlyArray<string>; label: string }> =
  Object.freeze([
    Object.freeze({ keywords: Object.freeze(['题材', '概念', '热点']), label: '题材活跃' }),
    Object.freeze({ keywords: Object.freeze(['突破', '新高', '形态']), label: '技术突破' }),
    Object.freeze({ keywords: Object.freeze(['放量', '量能']), label: '放量上攻' }),
    Object.freeze({ keywords: Object.freeze(['北向', '主力', '资金']), label: '资金流入' }),
    Object.freeze({ keywords: Object.freeze(['业绩', '财报', '盈利']), label: '业绩驱动' }),
    Object.freeze({ keywords: Object.freeze(['行业', '板块']), label: '板块共振' }),
  ]) as ReadonlyArray<{ keywords: ReadonlyArray<string>; label: string }>;

export function extractLogicDesc(evidence_text: string): string {
  const text = safeText(evidence_text);
  if (!text) return '技术形态';
  const hits: string[] = [];
  for (const entry of LOGIC_KEYWORD_MAP) {
    for (const kw of entry.keywords) {
      if (kw && text.includes(kw)) {
        hits.push(entry.label);
        break; // 同条目内一个 keyword 命中即可, 不重复
      }
    }
    if (hits.length >= 2) break;
  }
  if (hits.length === 0) return '技术形态';
  return hits.join(' · ');
}

/**
 * 生成结构化技术面段 (一段 markdown 文本, 无换行).
 *
 * 模板格式 (字段缺失时自动跳过):
 *   今日{change_pct_today}, {amplitude_desc}, 换手率 {turnover_rate}% {turnover_desc},
 *   量比 {volume_ratio} {volume_desc}, 成交额 {amount_yi} 亿 ({amount_desc}),
 *   市值 {market_cap_yi} 亿 ({market_cap_desc}), 上涨逻辑: {logic_desc},
 *   近 20 日 {change_pct_20d}% {trend_desc}.
 *
 * ctx 全空: 返"数据加载中, 暂无技术面摘要."
 */
export function buildTechnicalSummary(ctx: TechnicalSummaryContext): string {
  if (!ctx) return '数据加载中, 暂无技术面摘要.';

  const parts: string[] = [];

  // 今日涨跌 + 振幅
  if (typeof ctx.change_pct_today === 'number' && Number.isFinite(ctx.change_pct_today)) {
    parts.push(`今日${formatChangePct(ctx.change_pct_today)}`);
  }
  const ampDescStr =
    typeof ctx.amplitude_pct === 'number' && Number.isFinite(ctx.amplitude_pct)
      ? amplitudeDesc(ctx.amplitude_pct)
      : '';
  if (ampDescStr) parts.push(ampDescStr);

  // 换手
  if (
    typeof ctx.turnover_rate === 'number' &&
    Number.isFinite(ctx.turnover_rate) &&
    ctx.turnover_rate >= 0
  ) {
    const tdesc = turnoverDesc(ctx.turnover_rate);
    const trVal = round1(ctx.turnover_rate);
    parts.push(`换手率 ${trVal !== null ? trVal.toFixed(1) : '—'}%${tdesc ? ' ' + tdesc : ''}`);
  }

  // 量比
  if (
    typeof ctx.volume_ratio === 'number' &&
    Number.isFinite(ctx.volume_ratio) &&
    ctx.volume_ratio >= 0
  ) {
    const vdesc = volumeRatioDesc(ctx.volume_ratio);
    const vrVal = round2(ctx.volume_ratio);
    parts.push(`量比 ${vrVal !== null ? vrVal.toFixed(2) : '—'}${vdesc ? ' ' + vdesc : ''}`);
  }

  // 成交额
  if (
    typeof ctx.amount_yi === 'number' &&
    Number.isFinite(ctx.amount_yi) &&
    ctx.amount_yi >= 0
  ) {
    const adesc = amountDesc(ctx.amount_yi);
    const aVal = round1(ctx.amount_yi);
    parts.push(`成交额 ${aVal !== null ? aVal.toFixed(1) : '—'} 亿${adesc ? ' (' + adesc + ')' : ''}`);
  }

  // 市值
  if (
    typeof ctx.market_cap_yi === 'number' &&
    Number.isFinite(ctx.market_cap_yi) &&
    ctx.market_cap_yi > 0
  ) {
    const mdesc = marketCapDesc(ctx.market_cap_yi);
    const mVal = Math.round(ctx.market_cap_yi);
    parts.push(`市值 ${mVal} 亿${mdesc ? ' (' + mdesc + ')' : ''}`);
  }

  // 上涨逻辑 (始终出, evidence 为空也给 "技术形态")
  parts.push(`上涨逻辑: ${extractLogicDesc(ctx.evidence_text)}`);

  // 中期趋势 (近 20 日累计涨跌)
  if (typeof ctx.change_pct_20d === 'number' && Number.isFinite(ctx.change_pct_20d)) {
    const tdesc = trendDesc(ctx.change_pct_20d);
    const pctStr =
      ctx.change_pct_20d >= 0
        ? `+${ctx.change_pct_20d.toFixed(1)}%`
        : `${ctx.change_pct_20d.toFixed(1)}%`;
    parts.push(`近 20 日 ${pctStr}${tdesc ? ' ' + tdesc : ''}`);
  }

  if (parts.length === 0) return '数据加载中, 暂无技术面摘要.';
  return parts.join(', ') + '.';
}

// ===========================================================================
//  Section 2: 观察点
// ===========================================================================

export interface ObservationPointsContext {
  /** 近 60 日阻力位 (从 technical evidence 抽或 60 日 high). */
  resistance_level: number | null;
  /** 近 60 日支撑位. */
  support_level: number | null;
  /** 当前量比. */
  current_volume_ratio: number | null;
  /** 今日高点 (key level), 用于"站稳今日高点"提示. */
  today_high: number | null;
  /** 是否有显著行业题材 — industry_regime.score > 50 或 sentiment.score > 50. */
  has_industry_theme: boolean;
  /** technical evidence 全文 — 检测 MACD/KDJ 等指标提示. */
  technical_evidence: string;
  /** 近 20 日累计涨跌 % — 显著正向 + 高量比 时提示背离. */
  change_pct_20d: number | null;
}

/**
 * 5 条 bullet, 触发条件不满足则该条不出. 至多 5 条, 至少 0 条.
 *
 * 触发器:
 *   1. 题材轮动: has_industry_theme = true
 *   2. 关键价位: today_high 有 → "关注能否站稳今日高点 ¥{X} 上方"
 *   3. 量比维持: current_volume_ratio > 2 → "成交量是否持续, 量比维持 {X} 以上"
 *   4. 支撑/阻力: support 或 resistance 有 → "阻力 ¥{X} / 支撑 ¥{Y} 关键位"
 *   5. 技术背离: change_pct_20d >= 5% 且 current_volume_ratio > 2, 或 technical_evidence
 *      含 MACD/KDJ/RSI → "MACD/KDJ 等指标是否出现顶背离信号"
 */
const TECHNICAL_INDICATOR_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  'MACD',
  'KDJ',
  'RSI',
  '背离',
  '顶背离',
]);

export function buildObservationPoints(ctx: ObservationPointsContext): string[] {
  if (!ctx) return [];
  const out: string[] = [];

  // 1. 题材轮动
  if (ctx.has_industry_theme === true) {
    out.push('题材轮动情况, 板块内有无跟风个股');
  }

  // 2. 关键价位 (今日高点)
  if (typeof ctx.today_high === 'number' && Number.isFinite(ctx.today_high) && ctx.today_high > 0) {
    const high = round2(ctx.today_high);
    out.push(`关注能否站稳今日高点 ¥${high !== null ? high.toFixed(2) : '—'} 上方`);
  }

  // 3. 量比维持
  if (
    typeof ctx.current_volume_ratio === 'number' &&
    Number.isFinite(ctx.current_volume_ratio) &&
    ctx.current_volume_ratio > 2
  ) {
    const vr = round1(ctx.current_volume_ratio);
    out.push(`成交量是否持续, 量比维持 ${vr !== null ? vr.toFixed(1) : '—'} 以上`);
  }

  // 4. 支撑 / 阻力
  const hasResistance =
    typeof ctx.resistance_level === 'number' &&
    Number.isFinite(ctx.resistance_level) &&
    ctx.resistance_level > 0;
  const hasSupport =
    typeof ctx.support_level === 'number' &&
    Number.isFinite(ctx.support_level) &&
    ctx.support_level > 0;
  if (hasResistance && hasSupport) {
    const r = round2(ctx.resistance_level)!;
    const s = round2(ctx.support_level)!;
    out.push(`关键位: 阻力 ¥${r.toFixed(2)} / 支撑 ¥${s.toFixed(2)}`);
  } else if (hasResistance) {
    const r = round2(ctx.resistance_level)!;
    out.push(`关注阻力位 ¥${r.toFixed(2)} 能否突破`);
  } else if (hasSupport) {
    const s = round2(ctx.support_level)!;
    out.push(`关注支撑位 ¥${s.toFixed(2)} 是否守住`);
  }

  // 5. 技术指标背离
  const techEv = safeText(ctx.technical_evidence);
  const hasIndicatorMention = TECHNICAL_INDICATOR_KEYWORDS.some(kw => techEv.includes(kw));
  const significantTrend =
    typeof ctx.change_pct_20d === 'number' &&
    Number.isFinite(ctx.change_pct_20d) &&
    ctx.change_pct_20d >= 5;
  const highVolume =
    typeof ctx.current_volume_ratio === 'number' &&
    Number.isFinite(ctx.current_volume_ratio) &&
    ctx.current_volume_ratio > 2;
  if (hasIndicatorMention || (significantTrend && highVolume)) {
    out.push('MACD/KDJ 等指标是否出现顶背离信号');
  }

  return out.slice(0, 5);
}

// ===========================================================================
//  Section 3: 风险硬规则
// ===========================================================================

export interface RiskRulesContext {
  /** decision.action — 用于判断是否完全规避输出 (sell 类型无须风险硬规则, 已是卖出). */
  action: string;
  /** decision.risk_warnings 全文数组 — 检测 "ST" / "*ST" / "退市" 等关键字. */
  risk_warnings: string[];
  /** technical evidence 含 "阻力" / "套牢" / "高位" 关键字. */
  has_short_term_resistance: boolean;
  /** 是否情绪过热 — sentiment.score > 80 或 technical evidence 含 "超买". */
  is_overbought: boolean;
}

const ST_KEYWORDS: ReadonlyArray<string> = Object.freeze(['ST', '*ST', '退市', '警示']);

/** 默认硬规则 (任何 buy 类 signal 都出, 顺序固定). */
const DEFAULT_RISK_RULES: ReadonlyArray<string> = Object.freeze([
  '低开超 -3% 且无主线支撑不要进, 弱势难改',
  '竞价阶段量比 < 0.5 且低开 -2% 以上, 放弃当天操作',
]);

/** 最多输出条数 (红框 UI 不宜过长). */
const MAX_RISK_RULES = 3;

/**
 * 生成风险硬规则 (至多 3 条).
 *
 * 触发器组合 (按出现顺序加入, 截前 3):
 *   - 默认 2 条 (always): 低开 -3% / 竞价缩量
 *   - if has_short_term_resistance: "短线遇阻力位需减仓, 别恋战"
 *   - if is_overbought: "情绪过热, 警惕日内冲高回落"
 *   - if risk_warnings 含 ST/*ST/退市/警示: "已为风险股, 仓位严格控制 < 5%"
 *
 * ST 提示的优先级最高, 若命中且 array 已满, 仍替换最后一条.
 */
export function buildRiskRules(ctx: RiskRulesContext): string[] {
  if (!ctx) return DEFAULT_RISK_RULES.slice();

  const rules: string[] = [...DEFAULT_RISK_RULES];
  if (ctx.has_short_term_resistance === true) {
    rules.push('短线遇阻力位需减仓, 别恋战');
  }
  if (ctx.is_overbought === true) {
    rules.push('情绪过热, 警惕日内冲高回落');
  }

  const hasSTWarning =
    Array.isArray(ctx.risk_warnings) &&
    ctx.risk_warnings.some(w => {
      const s = safeText(w);
      return ST_KEYWORDS.some(kw => s.includes(kw));
    });
  if (hasSTWarning) {
    rules.push('已为风险股, 仓位严格控制 < 5%');
  }

  // 优先级处理: 若 ST 命中且数组超长, 用 ST 行替换最后一条普通规则
  if (rules.length > MAX_RISK_RULES) {
    if (hasSTWarning) {
      const stRule = '已为风险股, 仓位严格控制 < 5%';
      const truncated = rules.slice(0, MAX_RISK_RULES - 1);
      truncated.push(stRule);
      return truncated;
    }
    return rules.slice(0, MAX_RISK_RULES);
  }
  return rules;
}
