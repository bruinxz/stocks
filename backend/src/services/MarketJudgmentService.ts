/**
 * MarketJudgmentService — US-040 / FE-001 「今日大盘判断」开盘前一张卡片。
 *
 * 卡片 3 段（AC: 昨夜外盘 + regime + 仓位建议）：
 *   1. 昨夜外盘   — 恒生 / 纳指 / 标普 / 道指 4 个海外指数收盘涨跌（新浪 int_*）
 *   2. 大盘 regime — 取自 MarketEnvironmentService snapshot.market_regime（沪深300 基准）
 *   3. 仓位建议   — regime → 默认建议仓位 (bull 85% / rebound 65% / range 55% / unknown 45% /
 *                  bear 25% / stress 10%), 再用 ATR_14d_pct 调整 (高波动 -5%, 极高波动 -10%)
 *   4. brief      — 一句中文小结 "外盘普涨/普跌 X% + 大盘 <regime_label> + 建议 <pct>"
 *
 * 数据源契约（DataSource DI）：
 *   - loadMarketEnvironment    走 marketEnvironmentService.getEnvironmentForStock(BENCHMARK_SYMBOL)
 *   - fetchOvernightForeign    走新浪 hq.sinajs.cn list=int_hangseng,... 单独 parser (与
 *                              RealtimeIndexService 13+ 字段 A 股 schema 不兼容, 海外 4 字段)
 *
 * fail-OPEN 三层 (与 US-018 / US-019 / US-031 同款):
 *   1. fetchOvernightForeign throw → components.overnight_foreign.error = msg, 返 []
 *      → status='partial' 卡片 regime+仓位建议仍可显示;
 *   2. loadMarketEnvironment throw 或 null → components.regime.error = msg, regime='unknown'
 *      → suggested_position_pct fallback 表里的 unknown 行 (0.45);
 *   3. 顶层 try/catch 兜底 — main entry 绝不抛, 让 controller 返 200 + status='failed'.
 *
 * AC ≤ 150 字 (US-043 同款约束) 由 buildBrief 保证, 超长截断 + '…' (与 US-030
 * buildStructuredSummary 同款 MAX_STRUCTURED_SUMMARY_LEN=100 模式).
 *
 * 与既有 services 关系:
 *   - 复用 MarketEnvironmentService (US-099+ 已稳定, 不重写 regime 算法);
 *   - **不复用** RealtimeIndexService — 海外指数走 int_* 新浪源 4 字段 schema, 与 A 股 13+
 *     字段 schema 强不一致, 强行扩 RealtimeIndexService 会让 IndexRealtime 大半字段变 nullable
 *     污染既有 A 股 caller. 此处独立轻量 parser 即可.
 *   - 与 MarketBriefService (US-073) 是邻居但不重复 — MarketBriefService 喂"昨日北向 +
 *     涨停数" 4 维数据让 AI 给一句话观点 (LLM 兜底); 本 service 是结构化 regime + 仓位 +
 *     外盘的纯规则卡片 (无 LLM, 启动延迟低, 离线可用). UI 上两张卡可以并列, 不互斥.
 */

import axios from 'axios';
import iconv from 'iconv-lite';
import moment from 'moment-timezone';
import { logger } from '../utils/logger';
import { marketEnvironmentService, MarketEnvironmentSnapshot } from './MarketEnvironmentService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 大盘基准 (沪深 300, 与 MarketBriefService 同). */
export const BENCHMARK_SYMBOL = 'sh.000300';

/**
 * 默认建议仓位表 — by regime. 来自 docs/trader-system / risk_config baseline,
 * 与 US-068 SettingsWorkspace AI 引擎 8 dim slider 默认值同源 (后续可让用户覆写,
 * 本 v1 写死). 严格 0 ≤ pct ≤ 1, JSON.stringify 后 0.85 不会丢精度.
 */
export const SUGGESTED_POSITION_BY_REGIME: Readonly<
  Record<MarketEnvironmentSnapshot['market_regime'], number>
> = Object.freeze({
  bull: 0.85,
  rebound: 0.65,
  range: 0.55,
  unknown: 0.45,
  bear: 0.25,
  stress: 0.1,
});

/** ATR 高波动 / 极高波动阈值 (pct), 命中后建议仓位下调. */
export const HIGH_ATR_PCT = 3.0;
export const EXTREME_ATR_PCT = 5.0;
export const HIGH_ATR_DOWNSHIFT = 0.05;
export const EXTREME_ATR_DOWNSHIFT = 0.1;

/**
 * 昨夜外盘 sina 海外指数 symbol 顺序: 恒指 / 纳指 / 标普 / 道指.
 * 顺序锁定 → UI 不会出现 "今天恒指排第三、明天排第一" 这种漂移.
 */
export const OVERNIGHT_FOREIGN_SYMBOLS: readonly string[] = Object.freeze([
  'int_hangseng',
  'int_nasdaq',
  'int_sp500',
  'int_dji',
]);

/** brief 最大字符长度 — AC '≤150 字' 一致约束, 留 buffer 100. */
export const MAX_BRIEF_LEN = 100;

/** 新浪海外指数接口 timeout ms (与 RealtimeIndexService 同). */
export const SINA_OVERSEAS_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MarketJudgmentOptions {
  /** 覆盖 as-of YYYY-MM-DD, 缺省今天 (Asia/Shanghai). */
  trade_date?: string;
  /** 跳过外盘抓取 (单测 / 离线加速). */
  skip_overnight_foreign?: boolean;
  /** 强制 unknown regime (单测断言降级路径). */
  skip_regime?: boolean;
}

export interface OvernightForeignQuote {
  /** sina 原始 symbol (int_hangseng / int_nasdaq / int_sp500 / int_dji) */
  symbol: string;
  /** 中文名 (恒生指数 / 纳斯达克 / 标普指数 / 道琼斯) */
  name: string;
  /** 收盘价 */
  current: number;
  /** 涨跌点 */
  change: number;
  /** 涨跌幅 % */
  change_pct: number;
}

export interface OvernightForeignSummary {
  count: number;
  positive: number;
  negative: number;
  /** 平均涨跌幅 % — 简单算术平均 (4 个权重相同). */
  avg_change_pct: number;
}

export interface MarketJudgmentComponentError {
  error: string | null;
}

export interface MarketJudgmentComponents {
  regime: MarketJudgmentComponentError;
  overnight_foreign: MarketJudgmentComponentError;
}

export interface MarketJudgmentResult {
  trade_date: string;
  regime: MarketEnvironmentSnapshot['market_regime'];
  regime_label: string;
  benchmark_code: string;
  benchmark_return_20d_pct: number | null;
  benchmark_atr_14d_pct: number | null;
  suggested_position_pct: number;
  suggested_position_label: string;
  /** 仓位调整原因 (e.g. 'bull regime 基础 85%; ATR 5.2% 极高波动 -10%'). */
  suggested_position_reason: string;
  overnight_foreign: OvernightForeignQuote[];
  overnight_summary: OvernightForeignSummary;
  brief: string;
  status: 'ok' | 'partial' | 'failed';
  message: string;
  components: MarketJudgmentComponents;
}

export interface MarketJudgmentDataSource {
  loadMarketEnvironment(asOf?: string): Promise<MarketEnvironmentSnapshot | null>;
  fetchOvernightForeign(symbols: readonly string[]): Promise<OvernightForeignQuote[]>;
}

// ---------------------------------------------------------------------------
// pure helpers — 全 export 单测
// ---------------------------------------------------------------------------

/** 取今天 (Asia/Shanghai) YYYY-MM-DD; 给 trade_date 兜底 / 单测可注入. */
export function normalizeTodayIso(input?: string): string {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

/**
 * 把 regime + ATR 算出最终建议仓位 (0..1).
 *
 * 决策表 (优先级链, 单个 if-return, 不写 weighted sum 防 debug 困难):
 *   1. 取 base = SUGGESTED_POSITION_BY_REGIME[regime] (fallback unknown=0.45)
 *   2. ATR_14d_pct ≥ EXTREME → base -= 0.10
 *   3. ATR_14d_pct ≥ HIGH    → base -= 0.05
 *   4. clamp [0, 1]
 *
 * ATR null/undefined/非有限数 → 不调整, 用 base 原值.
 */
export function pickSuggestedPositionPct(
  regime: MarketEnvironmentSnapshot['market_regime'] | undefined,
  atr14dPct?: number | null
): number {
  const safeRegime = regime && regime in SUGGESTED_POSITION_BY_REGIME ? regime : 'unknown';
  let base = SUGGESTED_POSITION_BY_REGIME[safeRegime];
  if (typeof atr14dPct === 'number' && Number.isFinite(atr14dPct)) {
    if (atr14dPct >= EXTREME_ATR_PCT) base -= EXTREME_ATR_DOWNSHIFT;
    else if (atr14dPct >= HIGH_ATR_PCT) base -= HIGH_ATR_DOWNSHIFT;
  }
  if (base < 0) base = 0;
  if (base > 1) base = 1;
  // 浮点四舍五入到 0.01 防 0.65 - 0.05 = 0.6000000000001 类
  return Math.round(base * 100) / 100;
}

/**
 * pct → '重仓' / '中等' / '谨慎' / '空仓'.
 * UI tag color: pct≥0.7 红 / 0.4-0.7 蓝 / 0.1-0.4 橙 / <0.1 灰.
 */
export function buildSuggestedPositionLabel(pct: number): string {
  if (!Number.isFinite(pct)) return '未知';
  if (pct >= 0.7) return '重仓';
  if (pct >= 0.4) return '中等';
  if (pct >= 0.1) return '谨慎';
  return '空仓观望';
}

/**
 * 拼建议仓位的人话原因, 单测断言用 substring 守关键短语而非整句相等.
 */
export function buildSuggestedPositionReason(
  regime: MarketEnvironmentSnapshot['market_regime'] | undefined,
  regimeLabel: string,
  basePct: number,
  finalPct: number,
  atr14dPct?: number | null
): string {
  const parts: string[] = [];
  const safeRegime = regime && regime in SUGGESTED_POSITION_BY_REGIME ? regime : 'unknown';
  const baseShown = SUGGESTED_POSITION_BY_REGIME[safeRegime];
  parts.push(`${regimeLabel} 基础 ${(baseShown * 100).toFixed(0)}%`);
  if (typeof atr14dPct === 'number' && Number.isFinite(atr14dPct)) {
    if (atr14dPct >= EXTREME_ATR_PCT) {
      parts.push(
        `ATR ${atr14dPct.toFixed(1)}% 极高波动 -${(EXTREME_ATR_DOWNSHIFT * 100).toFixed(0)}%`
      );
    } else if (atr14dPct >= HIGH_ATR_PCT) {
      parts.push(`ATR ${atr14dPct.toFixed(1)}% 高波动 -${(HIGH_ATR_DOWNSHIFT * 100).toFixed(0)}%`);
    }
  }
  parts.push(`最终建议 ${(finalPct * 100).toFixed(0)}%`);
  // basePct 仅作 debug 注释参数, 不写到 reason 文案
  void basePct;
  return parts.join('; ');
}

/** 汇总外盘列表为 +/- 计数 + 算术平均. 空数组 → 全 0. */
export function summarizeOvernightForeign(
  quotes: OvernightForeignQuote[]
): OvernightForeignSummary {
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return { count: 0, positive: 0, negative: 0, avg_change_pct: 0 };
  }
  let positive = 0;
  let negative = 0;
  let sum = 0;
  for (const q of quotes) {
    if (typeof q.change_pct !== 'number' || !Number.isFinite(q.change_pct)) continue;
    if (q.change_pct > 0) positive += 1;
    else if (q.change_pct < 0) negative += 1;
    sum += q.change_pct;
  }
  const avg = quotes.length > 0 ? sum / quotes.length : 0;
  return {
    count: quotes.length,
    positive,
    negative,
    avg_change_pct: Math.round(avg * 100) / 100,
  };
}

/**
 * 拼一句中文 brief (≤MAX_BRIEF_LEN). 超长截断 + '…'.
 *
 * 形如:
 *   '昨夜外盘普涨 +0.42%; 大盘趋势强势; 建议中等仓位 65%'
 *   '昨夜外盘普跌 -1.20%; 大盘下行弱势; 建议谨慎仓位 25%'
 *   '昨夜外盘分化; 大盘震荡均衡; 建议中等仓位 55%'
 *   '昨夜外盘数据缺失; 大盘未知环境; 建议中等仓位 45%' (status=partial)
 */
export function buildBrief(input: {
  regimeLabel: string;
  overnight: OvernightForeignSummary;
  overnightAvailable: boolean;
  suggestedPositionPct: number;
  suggestedPositionLabel: string;
}): string {
  const {
    regimeLabel,
    overnight,
    overnightAvailable,
    suggestedPositionPct,
    suggestedPositionLabel,
  } = input;
  const parts: string[] = [];

  if (!overnightAvailable || overnight.count === 0) {
    parts.push('昨夜外盘数据缺失');
  } else if (overnight.positive === overnight.count && overnight.count > 0) {
    parts.push(`昨夜外盘普涨 ${formatSignedPct(overnight.avg_change_pct)}`);
  } else if (overnight.negative === overnight.count && overnight.count > 0) {
    parts.push(`昨夜外盘普跌 ${formatSignedPct(overnight.avg_change_pct)}`);
  } else if (overnight.positive > overnight.negative) {
    parts.push(`昨夜外盘多数上涨 (均值 ${formatSignedPct(overnight.avg_change_pct)})`);
  } else if (overnight.negative > overnight.positive) {
    parts.push(`昨夜外盘多数下跌 (均值 ${formatSignedPct(overnight.avg_change_pct)})`);
  } else {
    parts.push(`昨夜外盘分化 (均值 ${formatSignedPct(overnight.avg_change_pct)})`);
  }

  parts.push(`大盘${regimeLabel}`);
  parts.push(`建议${suggestedPositionLabel} ${(suggestedPositionPct * 100).toFixed(0)}%`);

  const text = parts.join('; ');
  if (text.length <= MAX_BRIEF_LEN) return text;
  return text.slice(0, MAX_BRIEF_LEN - 1) + '…';
}

function formatSignedPct(value: number): string {
  if (!Number.isFinite(value)) return '0.00%';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * 把"两个组件 error" 折叠成 status: 都 ok=ok / 一个错=partial / 都错=failed.
 * 与 MarketBriefService 同思想.
 */
export function resolveStatus(
  components: MarketJudgmentComponents
): MarketJudgmentResult['status'] {
  const regimeOk = components.regime.error === null;
  const foreignOk = components.overnight_foreign.error === null;
  if (regimeOk && foreignOk) return 'ok';
  if (!regimeOk && !foreignOk) return 'failed';
  return 'partial';
}

/**
 * 把新浪海外指数单行 raw response parse 成 OvernightForeignQuote. 形如:
 *   var hq_str_int_hangseng="恒生指数,23924.81,-387.35,-1.59";
 * 字段顺序: 名称, 收盘价, 涨跌点, 涨跌幅(%).
 *
 * 任何字段非法 → 返 null (caller 丢弃, 不抛).
 */
export function parseSinaOverseasLine(
  line: string,
  fallbackSymbol?: string
): OvernightForeignQuote | null {
  const m = line.match(/hq_str_(\w+)\s*=\s*"([^"]*)"/);
  if (!m) return null;
  const symbol = m[1] || fallbackSymbol;
  if (!symbol) return null;
  const fields = m[2].split(',');
  if (fields.length < 4) return null;
  const name = (fields[0] || '').trim();
  const current = Number(fields[1]);
  const change = Number(fields[2]);
  const changePct = Number(fields[3]);
  if (!name) return null;
  if (!Number.isFinite(current) || !Number.isFinite(change) || !Number.isFinite(changePct)) {
    return null;
  }
  return {
    symbol,
    name,
    current,
    change,
    change_pct: changePct,
  };
}

// ---------------------------------------------------------------------------
// production DataSource
// ---------------------------------------------------------------------------

/**
 * 生产 DataSource — 沿用 marketEnvironmentService 单例 + 自带 sina 海外 fetcher.
 *
 * 与 MarketBriefService.PRODUCTION_MARKET_BRIEF_DATA_SOURCE 同款 lazy 写法,
 * 单测注入 fake source 完全脱 DB / 网络.
 */
export function createProductionMarketJudgmentDataSource(): MarketJudgmentDataSource {
  return {
    async loadMarketEnvironment(asOf?: string): Promise<MarketEnvironmentSnapshot | null> {
      try {
        const snap = await marketEnvironmentService.getEnvironmentForStock(BENCHMARK_SYMBOL, {
          as_of: asOf,
          use_cache: true,
        });
        return snap;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[MarketJudgment] loadMarketEnvironment failed: ${msg}`);
        throw err;
      }
    },

    async fetchOvernightForeign(symbols: readonly string[]): Promise<OvernightForeignQuote[]> {
      if (!symbols.length) return [];
      const url = `https://hq.sinajs.cn/list=${symbols.join(',')}`;
      const resp = await axios.get(url, {
        timeout: SINA_OVERSEAS_TIMEOUT_MS,
        headers: { Referer: 'https://finance.sina.com.cn' },
        responseType: 'arraybuffer',
      });
      const text = iconv.decode(Buffer.from(resp.data), 'gbk');
      const lines = text.split('\n').filter(l => l.includes('hq_str_'));
      const quotes: OvernightForeignQuote[] = [];
      for (const line of lines) {
        const q = parseSinaOverseasLine(line);
        if (q) quotes.push(q);
      }
      // 保序 — 按 symbols 顺序输出, 缺失的跳过
      const indexed = new Map(quotes.map(q => [q.symbol, q]));
      const ordered: OvernightForeignQuote[] = [];
      for (const s of symbols) {
        const hit = indexed.get(s);
        if (hit) ordered.push(hit);
      }
      return ordered;
    },
  };
}

export const PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE: MarketJudgmentDataSource =
  createProductionMarketJudgmentDataSource();

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

/**
 * 主入口: 拿 regime + ATR + 外盘 → 拼 MarketJudgmentResult.
 *
 * fail-OPEN 顶层: 任何子分支抛错都被 catch 转 error → 反映到 components.<x>.error +
 *                  最终 status; 主入口绝不再抛.
 */
export async function evaluateMarketJudgment(
  source: MarketJudgmentDataSource,
  options: MarketJudgmentOptions = {}
): Promise<MarketJudgmentResult> {
  const tradeDate = normalizeTodayIso(options.trade_date);
  const components: MarketJudgmentComponents = {
    regime: { error: null },
    overnight_foreign: { error: null },
  };

  // ---- regime ----
  let snap: MarketEnvironmentSnapshot | null = null;
  if (!options.skip_regime) {
    try {
      snap = await source.loadMarketEnvironment(options.trade_date);
      if (!snap) {
        components.regime.error = '无市场环境数据';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      components.regime.error = `regime 数据获取失败: ${msg}`;
    }
  } else {
    components.regime.error = 'skip_regime=true';
  }

  const regime: MarketEnvironmentSnapshot['market_regime'] = snap?.market_regime ?? 'unknown';
  const regimeLabel = snap?.market_regime_label ?? '未知环境';
  const atr14dPct = snap?.benchmark_atr_14d_pct ?? null;
  const return20d = snap?.benchmark_return_20d_pct ?? null;

  // ---- overnight foreign ----
  let foreign: OvernightForeignQuote[] = [];
  if (!options.skip_overnight_foreign) {
    try {
      foreign = await source.fetchOvernightForeign(OVERNIGHT_FOREIGN_SYMBOLS);
      if (foreign.length === 0) {
        components.overnight_foreign.error = '外盘行情未返回数据';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      components.overnight_foreign.error = `外盘抓取失败: ${msg}`;
      foreign = [];
    }
  } else {
    components.overnight_foreign.error = 'skip_overnight_foreign=true';
  }

  const overnightSummary = summarizeOvernightForeign(foreign);

  // ---- suggested position ----
  const basePct = SUGGESTED_POSITION_BY_REGIME[regime] ?? SUGGESTED_POSITION_BY_REGIME.unknown;
  const suggestedPositionPct = pickSuggestedPositionPct(regime, atr14dPct);
  const suggestedPositionLabel = buildSuggestedPositionLabel(suggestedPositionPct);
  const suggestedPositionReason = buildSuggestedPositionReason(
    regime,
    regimeLabel,
    basePct,
    suggestedPositionPct,
    atr14dPct
  );

  // ---- brief ----
  const brief = buildBrief({
    regimeLabel,
    overnight: overnightSummary,
    overnightAvailable: components.overnight_foreign.error === null && foreign.length > 0,
    suggestedPositionPct,
    suggestedPositionLabel,
  });

  // ---- status + message ----
  const status = resolveStatus(components);
  const messageMap: Record<MarketJudgmentResult['status'], string> = {
    ok: '今日大盘判断生成成功',
    partial: '部分数据缺失（外盘 或 regime）, 仍可参考剩余维度',
    failed: '外盘与 regime 数据全缺, 请检查数据源',
  };

  return {
    trade_date: tradeDate,
    regime,
    regime_label: regimeLabel,
    benchmark_code: BENCHMARK_SYMBOL,
    benchmark_return_20d_pct: return20d,
    benchmark_atr_14d_pct: atr14dPct,
    suggested_position_pct: suggestedPositionPct,
    suggested_position_label: suggestedPositionLabel,
    suggested_position_reason: suggestedPositionReason,
    overnight_foreign: foreign,
    overnight_summary: overnightSummary,
    brief,
    status,
    message: messageMap[status],
    components,
  };
}

// ---------------------------------------------------------------------------
// service singleton
// ---------------------------------------------------------------------------

class MarketJudgmentService {
  /**
   * 主入口, 外层 try/catch 兜底 — controller 永远拿到 200 OK 而非 500.
   * 任何意外异常 (e.g. helper bug) 都转 status='failed' + components 全置 error.
   */
  async getTodayJudgment(options: MarketJudgmentOptions = {}): Promise<MarketJudgmentResult> {
    try {
      return await evaluateMarketJudgment(PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE, options);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MarketJudgment] top-level catch: ${msg}`);
      return {
        trade_date: normalizeTodayIso(options.trade_date),
        regime: 'unknown',
        regime_label: '未知环境',
        benchmark_code: BENCHMARK_SYMBOL,
        benchmark_return_20d_pct: null,
        benchmark_atr_14d_pct: null,
        suggested_position_pct: SUGGESTED_POSITION_BY_REGIME.unknown,
        suggested_position_label: buildSuggestedPositionLabel(SUGGESTED_POSITION_BY_REGIME.unknown),
        suggested_position_reason: `top-level catch: ${msg}`,
        overnight_foreign: [],
        overnight_summary: { count: 0, positive: 0, negative: 0, avg_change_pct: 0 },
        brief: `数据全缺; 大盘未知环境; 建议谨慎仓位 ${(
          SUGGESTED_POSITION_BY_REGIME.unknown * 100
        ).toFixed(0)}%`,
        status: 'failed',
        message: `今日大盘判断异常: ${msg}`,
        components: {
          regime: { error: msg },
          overnight_foreign: { error: msg },
        },
      };
    }
  }
}

export const marketJudgmentService = new MarketJudgmentService();
