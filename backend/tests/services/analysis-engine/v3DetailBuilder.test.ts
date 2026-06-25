/**
 * v3DetailBuilder 单元测试 (CA-3).
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/analysis-engine/v3DetailBuilder.test.ts
 *
 * 覆盖:
 *   - amplitudeDesc / turnoverDesc / volumeRatioDesc / amountDesc / marketCapDesc /
 *     trendDesc 各档完整覆盖 + null/NaN 兜底
 *   - formatChangePct (+/-/平开/NaN)
 *   - extractLogicDesc: 6 类 keyword 单独命中 + 多类命中 (取前 2) + 0 命中
 *   - buildTechnicalSummary: happy / null ctx / 部分字段 / 全 null 字段
 *   - buildObservationPoints: 5 条全触发 / 部分触发 / 全 null
 *   - buildRiskRules: 默认 / has_short_term_resistance / is_overbought / ST 触发 /
 *                     max 3 截断 / ST 命中时优先级替换
 *   - RISK_RULE_COLOR 常量
 */

import {
  amplitudeDesc,
  turnoverDesc,
  volumeRatioDesc,
  amountDesc,
  marketCapDesc,
  trendDesc,
  formatChangePct,
  extractLogicDesc,
  buildTechnicalSummary,
  buildObservationPoints,
  buildRiskRules,
  RISK_RULE_COLOR,
  type TechnicalSummaryContext,
  type ObservationPointsContext,
  type RiskRulesContext,
} from '../../../src/services/analysis-engine/v3DetailBuilder';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)}, got=${String(actual)}`);
}

function expectIncludes(name: string, haystack: string, needle: string): void {
  assert(name, haystack.includes(needle), `text="${haystack}", missing="${needle}"`);
}

function expectNotIncludes(name: string, haystack: string, needle: string): void {
  assert(name, !haystack.includes(needle), `text="${haystack}", unexpected="${needle}"`);
}

// ---------------------------------------------------------------------------
//  常量
// ---------------------------------------------------------------------------
console.log('\n## 常量');
expectEq('RISK_RULE_COLOR 红', RISK_RULE_COLOR, '#cf1322');

// ---------------------------------------------------------------------------
//  amplitudeDesc 5 档
// ---------------------------------------------------------------------------
console.log('\n## amplitudeDesc 档位');
expectEq('amp 0.5%', amplitudeDesc(0.5), '窄幅震荡');
expectEq('amp 1.99%', amplitudeDesc(1.99), '窄幅震荡');
expectEq('amp 2%', amplitudeDesc(2), '正常波动');
expectEq('amp 4.99%', amplitudeDesc(4.99), '正常波动');
expectEq('amp 5%', amplitudeDesc(5), '显著波动');
expectEq('amp 7.99%', amplitudeDesc(7.99), '显著波动');
expectEq('amp 8%', amplitudeDesc(8), '剧烈震荡');
expectEq('amp 15%', amplitudeDesc(15), '剧烈震荡');
expectEq('amp null', amplitudeDesc(null), '振幅未知');
expectEq('amp NaN', amplitudeDesc(NaN), '振幅未知');
expectEq('amp 负 (abs)', amplitudeDesc(-3), '正常波动');

// ---------------------------------------------------------------------------
//  turnoverDesc 5 档
// ---------------------------------------------------------------------------
console.log('\n## turnoverDesc 档位');
expectEq('to 0.5%', turnoverDesc(0.5), '极低');
expectEq('to 1%', turnoverDesc(1), '偏低');
expectEq('to 4.99%', turnoverDesc(4.99), '偏低');
expectEq('to 5%', turnoverDesc(5), '适中');
expectEq('to 14.99%', turnoverDesc(14.99), '适中');
expectEq('to 15%', turnoverDesc(15), '活跃');
expectEq('to 24.99%', turnoverDesc(24.99), '活跃');
expectEq('to 25%', turnoverDesc(25), '过热');
expectEq('to 50%', turnoverDesc(50), '过热');
expectEq('to null', turnoverDesc(null), '');
expectEq('to NaN', turnoverDesc(NaN), '');
expectEq('to 负', turnoverDesc(-1), '');

// ---------------------------------------------------------------------------
//  volumeRatioDesc 5 档
// ---------------------------------------------------------------------------
console.log('\n## volumeRatioDesc 档位');
expectEq('vr 0.5', volumeRatioDesc(0.5), '缩量');
expectEq('vr 0.79', volumeRatioDesc(0.79), '缩量');
expectEq('vr 0.8', volumeRatioDesc(0.8), '平量');
expectEq('vr 1.49', volumeRatioDesc(1.49), '平量');
expectEq('vr 1.5', volumeRatioDesc(1.5), '温和放量');
expectEq('vr 2.99', volumeRatioDesc(2.99), '温和放量');
expectEq('vr 3', volumeRatioDesc(3), '显著放量');
expectEq('vr 7.99', volumeRatioDesc(7.99), '显著放量');
expectEq('vr 8', volumeRatioDesc(8), '巨量');
expectEq('vr 13.85', volumeRatioDesc(13.85), '巨量');
expectEq('vr null', volumeRatioDesc(null), '');
expectEq('vr 负', volumeRatioDesc(-2), '');

// ---------------------------------------------------------------------------
//  amountDesc 4 档
// ---------------------------------------------------------------------------
console.log('\n## amountDesc 档位');
expectEq('amt 2', amountDesc(2), '成交清淡');
expectEq('amt 4.99', amountDesc(4.99), '成交清淡');
expectEq('amt 5', amountDesc(5), '正常成交');
expectEq('amt 19.99', amountDesc(19.99), '正常成交');
expectEq('amt 20', amountDesc(20), '大额成交');
expectEq('amt 41.3', amountDesc(41.3), '大额成交');
expectEq('amt 50', amountDesc(50), '巨量成交');
expectEq('amt 200', amountDesc(200), '巨量成交');
expectEq('amt null', amountDesc(null), '');

// ---------------------------------------------------------------------------
//  marketCapDesc 4 档
// ---------------------------------------------------------------------------
console.log('\n## marketCapDesc 档位');
expectEq('mc 50 (亿)', marketCapDesc(50), '小盘');
expectEq('mc 99', marketCapDesc(99), '小盘');
expectEq('mc 100', marketCapDesc(100), '中盘');
expectEq('mc 499', marketCapDesc(499), '中盘');
expectEq('mc 500', marketCapDesc(500), '大盘');
expectEq('mc 999', marketCapDesc(999), '大盘');
expectEq('mc 1000', marketCapDesc(1000), '超大盘');
expectEq('mc 3204', marketCapDesc(3204), '超大盘');
expectEq('mc null', marketCapDesc(null), '');
expectEq('mc 0', marketCapDesc(0), '');

// ---------------------------------------------------------------------------
//  trendDesc 5 档
// ---------------------------------------------------------------------------
console.log('\n## trendDesc 档位 (近 20 日)');
expectEq('trend +15%', trendDesc(15), '强势上涨');
expectEq('trend +10%', trendDesc(10), '强势上涨');
expectEq('trend +9.99%', trendDesc(9.99), '温和走强');
expectEq('trend +2%', trendDesc(2), '温和走强');
expectEq('trend 0%', trendDesc(0), '横盘震荡');
expectEq('trend +1.99%', trendDesc(1.99), '横盘震荡');
expectEq('trend -1.99%', trendDesc(-1.99), '横盘震荡');
expectEq('trend -2%', trendDesc(-2), '中期调整');
expectEq('trend -6.4%', trendDesc(-6.4), '中期调整');
expectEq('trend -9.99%', trendDesc(-9.99), '中期调整');
expectEq('trend -10%', trendDesc(-10), '深度回调');
expectEq('trend -25%', trendDesc(-25), '深度回调');
expectEq('trend null', trendDesc(null), '');
expectEq('trend NaN', trendDesc(NaN), '');

// ---------------------------------------------------------------------------
//  formatChangePct
// ---------------------------------------------------------------------------
console.log('\n## formatChangePct');
expectEq('cp +1.37%', formatChangePct(1.37), '+1.37%');
expectEq('cp -2.5%', formatChangePct(-2.5), '-2.50%');
expectEq('cp 0', formatChangePct(0), '平开');
expectEq('cp 0.04 (< 0.05) 平开', formatChangePct(0.04), '平开');
expectEq('cp null', formatChangePct(null), '涨跌未知');
expectEq('cp NaN', formatChangePct(NaN), '涨跌未知');

// ---------------------------------------------------------------------------
//  extractLogicDesc 6 类 keyword
// ---------------------------------------------------------------------------
console.log('\n## extractLogicDesc keyword 命中');
expectEq('题材', extractLogicDesc('XX 涉及 AI 题材'), '题材活跃');
expectEq('概念', extractLogicDesc('鸿蒙概念股'), '题材活跃');
expectEq('热点', extractLogicDesc('热点票面'), '题材活跃');
expectEq('突破', extractLogicDesc('突破 60 日均线'), '技术突破');
expectEq('新高', extractLogicDesc('创历史新高'), '技术突破');
expectEq('形态', extractLogicDesc('双底形态'), '技术突破');
expectEq('放量', extractLogicDesc('放量上攻 5 日均线'), '放量上攻');
expectEq('量能', extractLogicDesc('量能持续放大'), '放量上攻');
expectEq('北向', extractLogicDesc('北向资金净流入 1 亿'), '资金流入');
expectEq('主力', extractLogicDesc('主力净买入 2 亿'), '资金流入');
expectEq('资金', extractLogicDesc('资金加速净流入'), '资金流入');
expectEq('业绩', extractLogicDesc('业绩预增 100%'), '业绩驱动');
expectEq('财报', extractLogicDesc('Q3 财报超预期'), '业绩驱动');
expectEq('盈利', extractLogicDesc('盈利能力强'), '业绩驱动');
expectEq('行业', extractLogicDesc('医药行业景气'), '板块共振');
expectEq('板块', extractLogicDesc('军工板块异动'), '板块共振');

console.log('\n## extractLogicDesc 多类命中 (取前 2)');
expectEq(
  '题材 + 突破',
  extractLogicDesc('AI 题材 + 突破年线'),
  '题材活跃 · 技术突破'
);
expectEq(
  '题材 + 放量 + 资金 (优先级保留前 2 → 题材 + 突破前面无, 取题材+放量)',
  extractLogicDesc('热点题材 放量净流入'),
  '题材活跃 · 放量上攻'
);
expectEq(
  '5 类同时 (按优先级取前 2)',
  extractLogicDesc('题材 突破 放量 北向 业绩'),
  '题材活跃 · 技术突破'
);

console.log('\n## extractLogicDesc 0 命中 + 空字符串');
expectEq('空字符串', extractLogicDesc(''), '技术形态');
expectEq('null', extractLogicDesc(null as unknown as string), '技术形态');
expectEq('全无关', extractLogicDesc('这只票还行, 没啥说的'), '技术形态');

// ---------------------------------------------------------------------------
//  buildTechnicalSummary happy + 截图实际样本
// ---------------------------------------------------------------------------
console.log('\n## buildTechnicalSummary happy (截图样本)');
const screenshotCtx: TechnicalSummaryContext = {
  change_pct_today: 1.37,
  turnover_rate: 13.9,
  volume_ratio: 13.85,
  amount_yi: 41.3,
  market_cap_yi: 3204,
  amplitude_pct: 1.5,
  evidence_text: '关联题材活跃 北向资金流入',
  change_pct_20d: -6.4,
};
const summary = buildTechnicalSummary(screenshotCtx);
expectIncludes('summary 含 +1.37%', summary, '+1.37%');
expectIncludes('summary 含 窄幅震荡', summary, '窄幅震荡');
expectIncludes('summary 含 换手率 13.9% 适中', summary, '换手率 13.9% 适中');
expectIncludes('summary 含 量比 13.85 巨量', summary, '量比 13.85 巨量');
expectIncludes('summary 含 成交额 41.3 亿', summary, '成交额 41.3 亿');
expectIncludes('summary 含 大额成交', summary, '大额成交');
expectIncludes('summary 含 市值 3204 亿', summary, '市值 3204 亿');
expectIncludes('summary 含 超大盘', summary, '超大盘');
expectIncludes('summary 含 上涨逻辑', summary, '上涨逻辑');
expectIncludes('summary 含 题材活跃', summary, '题材活跃');
expectIncludes('summary 含 近 20 日 -6.4%', summary, '近 20 日 -6.4%');
expectIncludes('summary 含 中期调整', summary, '中期调整');

console.log('\n## buildTechnicalSummary 部分字段缺失');
const partialCtx: TechnicalSummaryContext = {
  change_pct_today: 2.5,
  turnover_rate: null,
  volume_ratio: null,
  amount_yi: null,
  market_cap_yi: null,
  amplitude_pct: 3.2,
  evidence_text: '突破前高',
  change_pct_20d: null,
};
const partial = buildTechnicalSummary(partialCtx);
expectIncludes('partial 含 +2.50%', partial, '+2.50%');
expectIncludes('partial 含 正常波动', partial, '正常波动');
expectNotIncludes('partial 不含 换手率', partial, '换手率');
expectNotIncludes('partial 不含 量比', partial, '量比');
expectNotIncludes('partial 不含 成交额', partial, '成交额');
expectNotIncludes('partial 不含 市值', partial, '市值');
expectIncludes('partial 含 技术突破', partial, '技术突破');
expectNotIncludes('partial 不含 近 20 日', partial, '近 20 日');

console.log('\n## buildTechnicalSummary 全 null 字段');
const allNullCtx: TechnicalSummaryContext = {
  change_pct_today: null,
  turnover_rate: null,
  volume_ratio: null,
  amount_yi: null,
  market_cap_yi: null,
  amplitude_pct: null,
  evidence_text: '',
  change_pct_20d: null,
};
const allNull = buildTechnicalSummary(allNullCtx);
expectIncludes('allNull 仍出 上涨逻辑 技术形态', allNull, '上涨逻辑: 技术形态');

console.log('\n## buildTechnicalSummary ctx 全 null/undefined');
const nullSummary = buildTechnicalSummary(null as unknown as TechnicalSummaryContext);
expectIncludes('null ctx 默认 兜底', nullSummary, '数据加载中');

// ---------------------------------------------------------------------------
//  buildObservationPoints
// ---------------------------------------------------------------------------
console.log('\n## buildObservationPoints 5 条全触发');
const obsFullCtx: ObservationPointsContext = {
  resistance_level: 180.5,
  support_level: 160.2,
  current_volume_ratio: 13.8,
  today_high: 172.0,
  has_industry_theme: true,
  technical_evidence: 'MACD 金叉',
  change_pct_20d: 8,
};
const obs = buildObservationPoints(obsFullCtx);
expectEq('obs 5 条', obs.length, 5);
expectEq('obs[0] 题材', obs[0], '题材轮动情况, 板块内有无跟风个股');
expectIncludes('obs[1] 今日高点', obs[1], '今日高点 ¥172.00');
expectIncludes('obs[2] 量比维持', obs[2], '量比维持 13.8 以上');
expectIncludes('obs[3] 阻力 / 支撑', obs[3], '阻力 ¥180.50');
expectIncludes('obs[3] 支撑 ¥160.20', obs[3], '支撑 ¥160.20');
expectIncludes('obs[4] MACD/KDJ', obs[4], 'MACD/KDJ');

console.log('\n## buildObservationPoints 部分触发 (无题材/无指标)');
const obsPartialCtx: ObservationPointsContext = {
  resistance_level: null,
  support_level: 100,
  current_volume_ratio: 1.5,
  today_high: 50.5,
  has_industry_theme: false,
  technical_evidence: '',
  change_pct_20d: 0,
};
const obsPartial = buildObservationPoints(obsPartialCtx);
expectEq('obsPartial 2 条 (high + support)', obsPartial.length, 2);
expectIncludes('obsPartial[0] 今日高点 50.50', obsPartial[0], '50.50');
expectIncludes('obsPartial[1] 支撑位 100.00', obsPartial[1], '支撑位 ¥100.00');

console.log('\n## buildObservationPoints 全 null');
const obsNullCtx: ObservationPointsContext = {
  resistance_level: null,
  support_level: null,
  current_volume_ratio: null,
  today_high: null,
  has_industry_theme: false,
  technical_evidence: '',
  change_pct_20d: null,
};
expectEq('obsNull 0 条', buildObservationPoints(obsNullCtx).length, 0);
expectEq('obs ctx undefined → 0 条', buildObservationPoints(null as unknown as ObservationPointsContext).length, 0);

console.log('\n## buildObservationPoints 只有阻力');
const obsResOnlyCtx: ObservationPointsContext = {
  resistance_level: 200,
  support_level: null,
  current_volume_ratio: null,
  today_high: null,
  has_industry_theme: false,
  technical_evidence: '',
  change_pct_20d: null,
};
const obsResOnly = buildObservationPoints(obsResOnlyCtx);
expectEq('obsResOnly 1 条', obsResOnly.length, 1);
expectIncludes('obsResOnly[0] 阻力位 200.00 突破', obsResOnly[0], '阻力位 ¥200.00');

console.log('\n## buildObservationPoints 技术指标 mention 触发背离');
const obsIndCtx: ObservationPointsContext = {
  resistance_level: null,
  support_level: null,
  current_volume_ratio: 1.0, // 不到 2, 不触发量比 line
  today_high: null,
  has_industry_theme: false,
  technical_evidence: 'KDJ 顶背离风险',
  change_pct_20d: 0,
};
const obsInd = buildObservationPoints(obsIndCtx);
expectEq('obsInd 1 条 (指标背离)', obsInd.length, 1);
expectIncludes('obsInd[0] MACD/KDJ', obsInd[0], 'MACD/KDJ');

// ---------------------------------------------------------------------------
//  buildRiskRules
// ---------------------------------------------------------------------------
console.log('\n## buildRiskRules 默认 2 条');
const defaultRiskCtx: RiskRulesContext = {
  action: 'buy',
  risk_warnings: [],
  has_short_term_resistance: false,
  is_overbought: false,
};
const defaultRisk = buildRiskRules(defaultRiskCtx);
expectEq('default 2 条', defaultRisk.length, 2);
expectIncludes('default[0] 低开 -3%', defaultRisk[0], '低开超 -3%');
expectIncludes('default[1] 竞价缩量', defaultRisk[1], '竞价阶段量比 < 0.5');

console.log('\n## buildRiskRules has_short_term_resistance 触发');
const stResCtx: RiskRulesContext = {
  action: 'buy',
  risk_warnings: [],
  has_short_term_resistance: true,
  is_overbought: false,
};
const stRes = buildRiskRules(stResCtx);
expectEq('stRes 3 条', stRes.length, 3);
expectIncludes('stRes[2] 短线遇阻力', stRes[2], '短线遇阻力位需减仓');

console.log('\n## buildRiskRules is_overbought 触发');
const obCtx: RiskRulesContext = {
  action: 'buy',
  risk_warnings: [],
  has_short_term_resistance: false,
  is_overbought: true,
};
const ob = buildRiskRules(obCtx);
expectEq('ob 3 条', ob.length, 3);
expectIncludes('ob[2] 情绪过热', ob[2], '情绪过热');

console.log('\n## buildRiskRules ST 触发 + 优先级替换');
const stCtx: RiskRulesContext = {
  action: 'buy',
  risk_warnings: ['ST 已被特别处理'],
  has_short_term_resistance: true,
  is_overbought: true,
};
const stRules = buildRiskRules(stCtx);
expectEq('st max 3 条', stRules.length, 3);
expectIncludes('st 含 低开 -3%', stRules[0], '低开超 -3%');
expectIncludes('st 含 竞价', stRules[1], '竞价');
expectIncludes('st 替换尾部 风险股 < 5%', stRules[2], '已为风险股, 仓位严格控制 < 5%');
expectNotIncludes('st 不含 情绪过热 (因为被 ST 替换尾部)', stRules.join('|'), '情绪过热');

console.log('\n## buildRiskRules ST 单独 (不超 3 条)');
const stSoloCtx: RiskRulesContext = {
  action: 'buy',
  risk_warnings: ['*ST 退市风险警示'],
  has_short_term_resistance: false,
  is_overbought: false,
};
const stSolo = buildRiskRules(stSoloCtx);
expectEq('stSolo 3 条', stSolo.length, 3);
expectIncludes('stSolo[2] 风险股', stSolo[2], '已为风险股');

console.log('\n## buildRiskRules 各种 ST 关键字');
expectIncludes(
  '退市',
  buildRiskRules({ ...defaultRiskCtx, risk_warnings: ['濒临退市'] }).join('|'),
  '已为风险股'
);
expectIncludes(
  '警示',
  buildRiskRules({ ...defaultRiskCtx, risk_warnings: ['退市警示'] }).join('|'),
  '已为风险股'
);

console.log('\n## buildRiskRules ctx null fallback');
const nullRules = buildRiskRules(null as unknown as RiskRulesContext);
expectEq('null ctx → 默认 2 条', nullRules.length, 2);

// ---------------------------------------------------------------------------
//  END
// ---------------------------------------------------------------------------
console.log('\n## SUMMARY');
console.log(`passed=${passed}, failed=${failed}`);
if (failed > 0) {
  console.error('\nSome assertions failed.');
  process.exit(1);
}
process.exit(0);
