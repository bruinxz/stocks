/**
 * V3RecommendationController — 抖音风 v3 推荐卡片后端 (CA-1).
 *
 * 2 个端点 mount 在 `/api/today/v3-*`:
 *
 *   GET /api/today/v3-recommendations?limit=N&date=YYYY-MM-DD
 *     - 返回今日 (或指定日期) v3 推荐 top N (默认 3, max 10).
 *     - 数据源: AIInvestmentSignal where source_type='analysis_engine' & 当日 & decision IN (buy/strong_buy).
 *     - 拼接: 基础 (Stock) + 实时 KPI (RealtimeQuote / 最新 DailyBar) + 振幅 + 20d 累计涨跌 +
 *       20d sparkline + 4 维评分 (aggregateToV3Dimensions) + 3 高亮标签 (buildHighlightTags) +
 *       一句话推荐理由 + decision 原 payload (entry_zone / stop_loss / take_profit / ...).
 *     - 弹性扩展: N=3 但若 #4-5 confidence 与 #3 项 gap < 0.05 则扩到 5.
 *     - 同时返回 funnel stats (scanned / candidate / selected / as_of).
 *
 *   GET /api/today/v3-funnel?date=YYYY-MM-DD
 *     - 仅返漏斗统计, 给顶部条用. 轻量, 不拉个股明细.
 *
 * 失败兜底原则 (与 TodayCommandCenterService / TodaySignalsService 同款):
 *   - 单只 stock 拼接失败 (无 daily_bar / 无 RT 行情 / Stock 缺失) → 仅 logger.warn,
 *     该股 fallback 部分字段 null, 仍出现在返回数组中 (不阻塞整体响应).
 *   - 顶层 catch 仅防 framework 异常, service 内的 query 失败已 fail-OPEN.
 *
 * 注意:
 *   - 不破坏前端契约: 新增端点, 不动 /api/today/signals 等现有端点.
 *   - 不写库 / 不修改 AIInvestmentSignal / 不创建新表. 漏斗 stats 全部从 AIInvestmentSignal 反推.
 *   - 不接 TradingAgents / shadow / hard 短路 — 只是把 analysis_engine 既有 archive 翻成 v3 视图.
 */

import { Response } from 'express';
import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { logger } from '../../utils/logger';
import { AIInvestmentSignal, AISignalSourceType } from '../../models/AIInvestmentSignal';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import {
  aggregateToV3Dimensions,
  buildHighlightTags,
  pickV3ConfidenceTier,
  type V3DimensionScore,
} from '../../services/analysis-engine/v3CardHelpers';
import {
  buildScenarioPlaybook,
  type ScenarioPlaybookItem,
  type ScenarioPlaybookContext,
} from '../../services/analysis-engine/scenarioPlaybookBuilder';
import {
  buildTechnicalSummary,
  buildObservationPoints,
  buildRiskRules,
  type TechnicalSummaryContext,
  type ObservationPointsContext,
  type RiskRulesContext,
} from '../../services/analysis-engine/v3DetailBuilder';
// PR-M3 (2026-06-29) — confidence 反向修正 (PR-K hotfix)
// PR-O5 (2026-06-30) — 题材发酵 5 阶段 detector enrichSignal 透传
import {
  FERMENTATION_PHASE_LABELS,
  FERMENTATION_PHASE_ICONS,
  type FermentationPhase,
} from '../../services/ThemeFermentationDetector';

// ---------------------------------------------------------------------------
//  常量
// ---------------------------------------------------------------------------

/** 默认推荐条数 */
const DEFAULT_RECOMMEND_LIMIT = 3;

/** 最大推荐条数 (用户传 limit 超过此值会被 clamp) */
const MAX_RECOMMEND_LIMIT = 10;

/** 弹性扩展: 若 #4-5 项 confidence 与 #3 项 gap 小于此值, 则扩到 5 */
const ELASTIC_CONFIDENCE_GAP = 0.05;

/** Sparkline + 累计涨跌窗口 */
const SPARKLINE_DAYS = 20;

/**
 * "买入类" decision — funnel `selected` 计数 + recommendations 过滤口径都用这套.
 * 与 [[AISignalDecision]] 枚举对齐: BUY / STRONG_BUY (analysis_engine 把 'add' 也归到 BUY).
 */
const BUY_DECISIONS: ReadonlyArray<string> = Object.freeze(['buy', 'strong_buy']);

/**
 * 当日 candidate 候选信号来源 (funnel 中段). analysis_engine + quant_recommendation +
 * tradingagents 三种"AI 生成"的归一为 candidate; daily_screener 只是规则引擎不算.
 *
 * PR-O2 (2026-06-29): limit_up_board 涨停板战法 detector 写入的信号也算 candidate —
 * source_type='limit_up_board', metadata.timing_tag='overnight' + metadata.pattern=<战法>.
 * 让前端 /home 推荐卡显示 "🚀 一字板" / "📈 二板加速" 等 badge.
 *
 * PR-O3 (2026-06-30) — 新增 3 个真消费 detector source_type 接通 PR-M1/M2/M3 数据
 * (opening_rush_detector / intraday_price_volume_anomaly / last_hour_momentum).
 *
 * PR-O5 (2026-06-30) — 题材发酵 (theme_fermentation) 5 阶段 detector 写入信号.
 */
export const CANDIDATE_SOURCE_TYPES: ReadonlyArray<string> = Object.freeze([
  AISignalSourceType.ANALYSIS_ENGINE,
  AISignalSourceType.QUANT_RECOMMENDATION,
  AISignalSourceType.TRADING_AGENTS,
  // 批5: 主线转 ETF 因子轮动 + 卫星题材, 日内 detector source 已删除.
  AISignalSourceType.ETF_FACTOR_ROTATION, // 核心 §4.1 (批6 接入)
  AISignalSourceType.THEME_EVENT, // 卫星 §6.2 (批6 fan-out)
  AISignalSourceType.THEME_FERMENTATION, // 历史兼容
]);

/**
 * PR-O3 fan-in: V3 推荐查询的全部 source_type. 单独常量便于未来调整 funnel vs query 时不耦合.
 * 之前 V3 只查 ANALYSIS_ENGINE → 永远 0 行 (3 个 active user mode='off') → fallback
 * QUANT_RECOMMENDATION. 改 fan-in 后, OpeningRushDetector / IntradayPriceVolumeAnomalyDetector /
 * LastHourMomentumDetector / LimitUpBoardDetector / ThemeFermentationDetector 写入的信号
 * 也能在前端 V3 卡片显示.
 */
export const V3_FANIN_SOURCE_TYPES: ReadonlyArray<string> = Object.freeze([
  AISignalSourceType.ANALYSIS_ENGINE,
  AISignalSourceType.QUANT_RECOMMENDATION,
  AISignalSourceType.ETF_FACTOR_ROTATION, // 核心 ETF 排名 (批6 接入)
  AISignalSourceType.THEME_EVENT, // 卫星题材事件 (批6 fan-out)
  AISignalSourceType.THEME_FERMENTATION, // 历史兼容
]);

/**
 * PR-W (2026-06-30) — 信号分类: 区分 "推荐" vs "盘中异动观察".
 *
 * 用户实测 prod 截图发现: 全部信号都是 "intraday_price_volume_anomaly" 单点 detector,
 * 但前端 /home 都标 "推荐", 用户误以为系统强推这只票. 实际上 PVAnomaly 只是
 * "扫到量价异动" — 是不是真值得 buy 还要看其它维度 (基本面 / 资金面 / 板块).
 *
 * 真推荐 (signal_kind='recommendation'):
 *   - analysis_engine: 8 维 multi-dim 综合
 *   - quant_recommendation: 多因子排名 top N
 *   - opening_rush_detector: 隔夜信号 + auction 综合判断
 *   - last_hour_momentum: 9:30-10:00 r1 上涨预测尾盘
 *   - limit_up_board: 涨停板战法 20 pattern 系统化分类
 *   - theme_fermentation: 板块发酵 5 阶段判断
 *
 * 仅盘中观察 (signal_kind='watch'):
 *   - intraday_price_volume_anomaly: 单点异动信号, 用户应自己判断
 *
 * 前端应 2 个 section 分开展示: "今日推荐" + "盘中异动观察".
 */
const RECOMMENDATION_SOURCES = new Set<string>([
  String(AISignalSourceType.ANALYSIS_ENGINE),
  String(AISignalSourceType.QUANT_RECOMMENDATION),
  String(AISignalSourceType.ETF_FACTOR_ROTATION),
  String(AISignalSourceType.THEME_EVENT),
  String(AISignalSourceType.THEME_FERMENTATION),
]);

export function deriveSignalKind(
  sourceType: string | null | undefined
): 'recommendation' | 'watch' {
  if (!sourceType) return 'recommendation';
  return RECOMMENDATION_SOURCES.has(String(sourceType)) ? 'recommendation' : 'watch';
}

/**
 * 批7j/§7.1 — 核心-卫星桶归类. 用户主线 = 核心 70% (ETF 因子轮动) + 卫星 20% (题材/事件) + 现金 10%.
 * 前端据此把信号分区展示: 核心 ETF 走 HomeWorkspace 因子排名表, 卫星题材走 V3 推荐卡列表,
 * 现金桶不进推荐卡. 优先读 metadata.core_satellite_bucket (ETFRotationService='core' /
 * ThemeEventFanoutService='satellite' / CashAllocationService='cash' 写入), 缺失 → 按 source_type 兜底.
 */
export function deriveCoreSatellite(
  sourceType: string | null | undefined,
  metadata?: Record<string, unknown> | null
): 'core' | 'satellite' | 'cash' {
  const bucket = String(metadata?.core_satellite_bucket ?? '')
    .trim()
    .toLowerCase();
  if (bucket === 'core' || bucket === 'satellite' || bucket === 'cash') return bucket;
  const src = String(sourceType ?? '');
  if (src === String(AISignalSourceType.ETF_FACTOR_ROTATION)) return 'core';
  if (src === String(AISignalSourceType.CASH_MANAGEMENT)) return 'cash';
  // theme_event / theme_fermentation / 历史个股信号 → 卫星
  return 'satellite';
}

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

function todayInShanghai(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function clampLimit(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECOMMEND_LIMIT;
  return Math.min(Math.floor(n), MAX_RECOMMEND_LIMIT);
}

function parseDate(raw: any): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return todayInShanghai();
}

/**
 * PR-H (2026-06-29) — 推荐时机标签 5 个值, 与 backend
 * AIInvestmentSignalService.RecommendationTimingTag 对齐.
 *
 *   opening_rush     — 🌅 早盘抢 (9:25 集合竞价后, 建议 9:30-10:00 买入)
 *   afternoon_kick   — ☀️ 午后攻 (12:55, 建议 13:00-13:30 买入)
 *   closing_grab     — 🌆 尾盘埋 (14:30, 建议 14:30-14:55 买入)
 *   overnight        — 🌙 隔夜潜伏 (15:30 盘后, 建议 *次日* 9:30 开盘后买)
 *   intraday_anomaly — ⚡ 盘中异动 (实时触发, 30 分钟内买)
 *
 * 缺失 / 历史 row 没写 metadata.timing_tag → 默认归为 'overnight' (与生产
 * 既有 cron 32 15 * * 1-5 语义一致, 不破坏既有 UI 默认值).
 */
export const TIMING_TAG_VALUES = [
  'opening_rush',
  'afternoon_kick',
  'closing_grab',
  'overnight',
  'intraday_anomaly',
] as const;
export type TimingTag = (typeof TIMING_TAG_VALUES)[number];

export function normalizeTimingTagFromMetadata(metadata: any): TimingTag {
  const raw = String(metadata?.timing_tag || '')
    .trim()
    .toLowerCase();
  return (TIMING_TAG_VALUES as readonly string[]).includes(raw) ? (raw as TimingTag) : 'overnight';
}

export function parseTimingFilter(raw: any): TimingTag[] | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'all') return null;
  const parts = trimmed
    .split(',')
    .map(s => s.trim())
    .filter((s): s is TimingTag => (TIMING_TAG_VALUES as readonly string[]).includes(s));
  return parts.length > 0 ? parts : null;
}

/**
 * Batch CD (2026-06-25): shift ISO date YYYY-MM-DD by N days.
 * 给 V3 endpoint fallback 查询用 — 找最近 N 天的 signal.
 */
function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * 应用"弹性扩展": 默认 baseN, 但若 #(baseN) 与 #(baseN+1)... 的 confidence_score gap < threshold,
 * 持续往后扩到 maxN. 让"分数相近的并列项"不被硬截断.
 */
export function applyElasticLimit(
  rows: AIInvestmentSignal[],
  baseN: number,
  maxN: number,
  gap: number = ELASTIC_CONFIDENCE_GAP
): AIInvestmentSignal[] {
  if (rows.length <= baseN) return rows;
  const out = rows.slice(0, baseN);
  const lastConf = Number(out[out.length - 1]?.confidence_score ?? 0);
  for (let i = baseN; i < rows.length && out.length < maxN; i++) {
    const c = Number(rows[i]?.confidence_score ?? 0);
    if (!Number.isFinite(c)) break;
    if (lastConf - c > gap * 100) break; // confidence_score 是 0-100 标度
    out.push(rows[i]);
  }
  return out;
}

interface PerDimensionLike {
  analyzer_key: string;
  score: number;
  confidence: number;
  evidence?: Array<{ label: string; direction: string }>;
}

/**
 * 从 archive metadata.per_dimension_summary 或 detail.per_dimension 拿回 8 维 summary.
 * archive 时写了精简版 (analyzer_key+score+confidence), evidence 在 detail JSON 里 (无 evidence).
 * 标签生成需要 evidence label 关键词, 所以同时尝试解析 detail.per_dimension.
 */
export function extractPerDimension(signal: AIInvestmentSignal): PerDimensionLike[] {
  const out: PerDimensionLike[] = [];
  const metadataSummary = (signal.metadata as any)?.per_dimension_summary;
  if (Array.isArray(metadataSummary)) {
    for (const item of metadataSummary) {
      if (item && typeof item.analyzer_key === 'string') {
        out.push({
          analyzer_key: String(item.analyzer_key),
          score: Number(item.score) || 0,
          confidence: Number(item.confidence) || 0,
          evidence: [],
        });
      }
    }
  }
  // 从 detail JSON 拿 evidence (label / direction) 合并进去
  if (signal.detail) {
    try {
      const parsed = JSON.parse(String(signal.detail));
      const detailDims = parsed?.per_dimension;
      if (Array.isArray(detailDims)) {
        for (const d of detailDims) {
          if (!d || typeof d.analyzer_key !== 'string') continue;
          const existing = out.find(x => x.analyzer_key === d.analyzer_key);
          const evs = Array.isArray(d.evidence)
            ? d.evidence
                .filter((e: any) => e && typeof e.label === 'string')
                .map((e: any) => ({
                  label: String(e.label),
                  direction: String(e.direction || 'neutral'),
                }))
            : [];
          if (existing) {
            existing.evidence = evs;
          } else {
            out.push({
              analyzer_key: String(d.analyzer_key),
              score: Number(d.score) || 0,
              confidence: Number(d.confidence) || 0,
              evidence: evs,
            });
          }
        }
      }
    } catch {
      // detail 不是合法 JSON → ignore, summary 仍生效
    }
  }

  // Batch CD (2026-06-25): V3 fallback 到 quant_recommendation 时, metadata 没有
  // per_dimension_summary, 但有 factors[] (5 维 quant_recommendation 输出格式 -
  // trend / volume / quality / valuation / risk + 可选 industry / momentum 等).
  // 把这些 factors 转成 V3 4 维输入 (人气/逻辑/资金/结构), 让 V3 4 维卡片不空白.
  // 映射规则 (与 v3CardHelpers.aggregateToV3Dimensions 的 8→4 聚合精神一致):
  //   - 资金 (capital):  volume + momentum
  //   - 逻辑 (logic):    quality + valuation
  //   - 结构 (structure): trend + risk
  //   - 人气 (sentiment): industry + 缺省给 50 中性
  if (out.length === 0) {
    const factors = (signal.metadata as any)?.factors;
    if (Array.isArray(factors) && factors.length > 0) {
      const scoreMap: Record<string, number> = {};
      for (const f of factors) {
        if (f && typeof f.name === 'string' && Number.isFinite(Number(f.score))) {
          scoreMap[f.name] = Number(f.score);
        }
      }
      const avg = (keys: string[], fallback = 50): number => {
        const vals = keys.map(k => scoreMap[k]).filter(v => Number.isFinite(v));
        if (vals.length === 0) return fallback;
        return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
      };
      // 把 quant factor score (0-100) 映射成 analyzer score (-100 to +100)
      const to8 = (s: number): number => Math.round((s - 50) * 2);
      out.push(
        {
          analyzer_key: 'sentiment',
          score: to8(avg(['industry', 'concept_heat', 'east_money_qa'])),
          confidence: 0.6,
          evidence: [],
        },
        {
          analyzer_key: 'fundamental',
          score: to8(avg(['quality', 'valuation'])),
          confidence: 0.6,
          evidence: [],
        },
        {
          analyzer_key: 'capital',
          score: to8(avg(['volume', 'money_flow', 'momentum'])),
          confidence: 0.6,
          evidence: [],
        },
        {
          analyzer_key: 'technical',
          score: to8(avg(['trend', 'risk'])),
          confidence: 0.6,
          evidence: [],
        }
      );
    }
  }

  return out;
}

interface SparklinePoint {
  date: string;
  close: number;
}

/**
 * 算 20d 累计涨跌 + sparkline 点数组. bars 已按时间升序.
 * 返回 null 表示数据不够 (少于 2 个点).
 */
export function buildPriceWindow(
  bars: Array<{ time: Date; close: number }>
): { cumulative_change_pct: number; sparkline: SparklinePoint[] } | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const window = bars.slice(-SPARKLINE_DAYS);
  const first = Number(window[0]?.close);
  const last = Number(window[window.length - 1]?.close);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  const cumPct = ((last - first) / first) * 100;
  const sparkline: SparklinePoint[] = window.map(b => ({
    date: b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10),
    close: Number(b.close) || 0,
  }));
  return { cumulative_change_pct: Math.round(cumPct * 100) / 100, sparkline };
}

/**
 * 算今日振幅 (%) = (today.high - today.low) / prev_close × 100. 缺数据返 null.
 */
export function computeAmplitude(
  bars: Array<{ high?: number; low?: number; close?: number }>
): number | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const today = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const hi = Number(today?.high);
  const lo = Number(today?.low);
  const prevClose = Number(prev?.close);
  if (
    !Number.isFinite(hi) ||
    !Number.isFinite(lo) ||
    !Number.isFinite(prevClose) ||
    prevClose <= 0
  ) {
    return null;
  }
  return Math.round(((hi - lo) / prevClose) * 100 * 100) / 100;
}

/**
 * 算 20 日 ATR (Avg True Range, 元) — playbook 紧止损用.
 * True Range = max(high-low, |high-prev_close|, |low-prev_close|).
 * bars 已按时间升序. 少于 N+1 条 → null (无法算前收).
 */
export function computeATR20(
  bars: Array<{ high?: number; low?: number; close?: number }>,
  period = 20
): number | null {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  // 取最近 period 根 K + 前 1 根 (算 prev_close)
  const window = bars.slice(-(period + 1));
  let sumTR = 0;
  let n = 0;
  for (let i = 1; i < window.length; i++) {
    const hi = Number(window[i]?.high);
    const lo = Number(window[i]?.low);
    const prevClose = Number(window[i - 1]?.close);
    if (
      !Number.isFinite(hi) ||
      !Number.isFinite(lo) ||
      !Number.isFinite(prevClose) ||
      hi < lo ||
      prevClose <= 0
    ) {
      continue;
    }
    const tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
    sumTR += tr;
    n += 1;
  }
  if (n === 0) return null;
  return Math.round((sumTR / n) * 100) / 100;
}

/**
 * 从 60 日内 daily_bars 找近期最低 low — playbook low_mild 兜底 support_level.
 * (优先级: per_dimension.technical.evidence 含 "支撑" label → 此函数; 当前实现只取后者.)
 */
export function findRecentLow(bars: Array<{ low?: number }>, lookback = 60): number | null {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const window = bars.slice(-lookback);
  let min = Infinity;
  for (const b of window) {
    const lo = Number(b?.low);
    if (Number.isFinite(lo) && lo > 0 && lo < min) min = lo;
  }
  return Number.isFinite(min) ? Math.round(min * 100) / 100 : null;
}

/**
 * 从 per_dimension.technical.evidence 找含 "支撑" 字样的 evidence.metric_value
 * (analyzer 输出约定: evidence item 可能含 {label, detail, metric_value}).
 * 若 evidence 是 {label, direction} 子集 (V3RecommendationController.extractPerDimension
 * 当前返回的精简形态), 则尝试用正则从 label/detail 字符串提取数字; 否则返 null.
 */
export function extractSupportLevel(perDim: PerDimensionLike[]): number | null {
  const tech = perDim.find(d => d.analyzer_key === 'technical');
  if (!tech || !Array.isArray(tech.evidence)) return null;
  for (const ev of tech.evidence) {
    const text = `${ev?.label ?? ''}`;
    if (!text.includes('支撑')) continue;
    // 任何形态的数字: 整数或带小数
    const m = text.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
    }
  }
  return null;
}

/**
 * 把 per_dimension 全部 evidence label 拼成 evidence_text (playbook keyword 检测用).
 */
export function buildEvidenceText(perDim: PerDimensionLike[]): string {
  const parts: string[] = [];
  for (const d of perDim) {
    if (!Array.isArray(d.evidence)) continue;
    for (const ev of d.evidence) {
      if (ev && typeof ev.label === 'string') parts.push(ev.label);
    }
  }
  return parts.join(' ');
}

/**
 * 从 60 日内 daily_bars 找近期最高 high — observation_points 阻力位兜底.
 * (优先级: per_dimension.technical.evidence 含 "阻力"/"压力" label → 此函数兜底.)
 */
export function findRecentHigh(bars: Array<{ high?: number }>, lookback = 60): number | null {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const window = bars.slice(-lookback);
  let max = -Infinity;
  for (const b of window) {
    const hi = Number(b?.high);
    if (Number.isFinite(hi) && hi > 0 && hi > max) max = hi;
  }
  return Number.isFinite(max) ? Math.round(max * 100) / 100 : null;
}

/**
 * 从 per_dimension.technical.evidence 找含 "阻力"/"压力" 字样的数字 — observation 用.
 * 命名与 extractSupportLevel 对偶.
 */
export function extractResistanceLevel(perDim: PerDimensionLike[]): number | null {
  const tech = perDim.find(d => d.analyzer_key === 'technical');
  if (!tech || !Array.isArray(tech.evidence)) return null;
  for (const ev of tech.evidence) {
    const text = `${ev?.label ?? ''}`;
    if (!text.includes('阻力') && !text.includes('压力')) continue;
    const m = text.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
    }
  }
  return null;
}

/**
 * 拼 technical 维度的全部 evidence label — 给 observation_points 检测 MACD/KDJ
 * 与 risk_rules 检测 "阻力"/"高位" 用.
 */
export function buildTechnicalEvidenceText(perDim: PerDimensionLike[]): string {
  const tech = perDim.find(d => d.analyzer_key === 'technical');
  if (!tech || !Array.isArray(tech.evidence)) return '';
  return tech.evidence
    .filter(ev => ev && typeof ev.label === 'string')
    .map(ev => ev.label)
    .join(' ');
}

/** evidence 含 "阻力" / "套牢" / "高位" / "压力" / "压制" → 触发风险硬规则. */
const SHORT_TERM_RESISTANCE_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  '阻力',
  '套牢',
  '高位',
  '压力',
  '压制',
]);

/** evidence 含 "超买" → 触发情绪过热风险. */
const OVERBOUGHT_KEYWORDS: ReadonlyArray<string> = Object.freeze(['超买']);

/**
 * PR-S (2026-06-30) Bug B3 fix — 同股 dedup.
 *
 * 用户实测 /home 浙江东日 sh.600113 重复显示 4 次. 根因:
 *   - intraday_price_volume_anomaly detector 每 30min cron 跑一次, 全天 7+ 次都新写入
 *   - V3 endpoint 直接喂全部 AIInvestmentSignal 给前端
 *   → 同股 N 条全部展开 → 推荐卡 N 张重复
 *
 * 修复: 按 symbol 聚合, 同股保留 confidence_score 最高那条 (并列时保留 source_type 字典序靠前的,
 * 让 'analysis_engine' 等真 AI engine 信号优先于 detector heuristic 信号).
 *
 * 注: detector 端也修了 source_id 一日一行 (Bug B1), 此处是 V3 endpoint 的双保险 —
 * 即使历史数据有重复 row, 前端也只见一张卡.
 */
export function dedupBySymbol(rows: AIInvestmentSignal[]): AIInvestmentSignal[] {
  const bySymbol = new Map<string, AIInvestmentSignal>();
  for (const row of rows) {
    const sym = String(row.symbol);
    const existing = bySymbol.get(sym);
    if (!existing) {
      bySymbol.set(sym, row);
      continue;
    }
    const curConf = Number(row.confidence_score ?? 0);
    const exConf = Number(existing.confidence_score ?? 0);
    if (curConf > exConf) {
      bySymbol.set(sym, row);
      continue;
    }
    if (curConf === exConf) {
      // 同分: 优先 analysis_engine / quant_recommendation 等 AI engine, 弱化 detector heuristic.
      const curSrc = String(row.source_type ?? '');
      const exSrc = String(existing.source_type ?? '');
      if (curSrc < exSrc) {
        bySymbol.set(sym, row);
      }
    }
  }
  // 保持 confidence_score 降序 (与查询 ORDER BY 一致)
  return Array.from(bySymbol.values()).sort((a, b) => {
    const ca = Number(a.confidence_score ?? 0);
    const cb = Number(b.confidence_score ?? 0);
    if (cb !== ca) return cb - ca;
    return 0;
  });
}

// ---------------------------------------------------------------------------
//  Controller
// ---------------------------------------------------------------------------

class V3RecommendationController {
  /**
   * GET /api/today/v3-recommendations?limit=N&date=YYYY-MM-DD
   */
  async getRecommendations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const date = parseDate(req.query.date);
      const requested = clampLimit(req.query.limit);
      const baseN = Math.min(requested, DEFAULT_RECOMMEND_LIMIT);

      // PR-O3 (2026-06-30) fan-in: 同时查 V3_FANIN_SOURCE_TYPES (含 4 个新 detector source),
      // 让 OpeningRushDetector / IntradayPriceVolumeAnomalyDetector / LastHourMomentumDetector /
      // LimitUpBoard / ThemeFermentation 写入的信号能在 V3 卡片显示. 历史 fallback 行为保留:
      // 当天为空时回退到最近 7 天内最新一个有信号的日期 (兼容 daily_bars 滞后导致的 signal_date 漂移).
      let actualSourceUsed = 'fan_in';
      let actualDateUsed = date;

      // 拉 100 条候选 (fan-in 多 source 可能更多), 应用弹性扩展后再切 top N
      let candidateRows = await AIInvestmentSignal.findAll({
        where: {
          source_type: { [Op.in]: V3_FANIN_SOURCE_TYPES as string[] },
          signal_date: date,
          normalized_decision: { [Op.in]: BUY_DECISIONS as string[] },
        },
        order: [
          ['confidence_score', 'DESC'],
          ['created_at', 'DESC'],
        ],
        limit: 100,
      });

      if (candidateRows.length === 0) {
        // Fallback: 最近 7 天 cover 长假
        const fallbackRows = await AIInvestmentSignal.findAll({
          where: {
            source_type: { [Op.in]: V3_FANIN_SOURCE_TYPES as string[] },
            signal_date: {
              [Op.gte]: shiftDate(date, -7),
              [Op.lte]: date,
            },
            normalized_decision: { [Op.in]: BUY_DECISIONS as string[] },
          },
          order: [
            ['signal_date', 'DESC'],
            ['confidence_score', 'DESC'],
            ['created_at', 'DESC'],
          ],
          limit: 100,
        });

        if (fallbackRows.length > 0) {
          // 只取最新一天的 (与单天语义一致)
          actualDateUsed = String(fallbackRows[0].signal_date).slice(0, 10);
          candidateRows = fallbackRows.filter(
            r => String(r.signal_date).slice(0, 10) === actualDateUsed
          );
        }
      }

      // 推断 actualSourceUsed (展示用): 取 top1 的 source_type
      if (candidateRows.length > 0) {
        actualSourceUsed = String(candidateRows[0].source_type);
      }

      // PR-S Bug B3 (2026-06-30): 按 symbol dedup — 同股保留最高 confidence 一条.
      // 防 intraday_price_volume_anomaly 等 detector 每 30min cron 多次写入造成同股多卡重复.
      const totalBeforeDedup = candidateRows.length;
      candidateRows = dedupBySymbol(candidateRows);
      if (totalBeforeDedup !== candidateRows.length) {
        logger.info(
          `[V3] dedup ${totalBeforeDedup} → ${candidateRows.length} (by symbol, date=${actualDateUsed})`
        );
      }

      // 应用弹性扩展; 用户显式 limit > 3 则按 limit 截断 (不再弹性), 反之走 elastic 到 5.
      let selected: AIInvestmentSignal[];
      if (requested > DEFAULT_RECOMMEND_LIMIT) {
        selected = candidateRows.slice(0, requested);
      } else {
        const maxElastic = Math.min(5, MAX_RECOMMEND_LIMIT);
        selected = applyElasticLimit(candidateRows, baseN, maxElastic, ELASTIC_CONFIDENCE_GAP);
      }

      // PR-H — 按 ?timing=opening_rush,afternoon_kick,... 过滤. 'all' / 缺失 = 不过滤.
      // 过滤在 selected 之后做 (而非 query 时), 因 metadata.timing_tag 是 JSONB 字段, SQL
      // 过滤需要 ORM JSON ops 增加复杂度; selected 最多 5 行, JS 内过滤一次开销可忽略.
      const timingFilter = parseTimingFilter(req.query.timing);
      if (timingFilter && timingFilter.length > 0) {
        const allow = new Set<string>(timingFilter);
        selected = selected.filter(s =>
          allow.has(normalizeTimingTagFromMetadata((s as any).metadata))
        );
      }

      // PR-O5 (2026-06-30) — 题材发酵 5 阶段 enrichment.
      // 一次批量拉 theme_fermentation_phases 最新一天 (大概率 = actualDateUsed, 也可能 actualDateUsed-1d
      // 若 detector 16:30 还没跑完). 用 Map<industry, {phase, is_mainline}> 注入 enrichSignal 避免 N+1.
      // fail-OPEN: 拉表失败 → 空 map, 推荐卡 theme_phase 字段缺失, 前端 badge 自动隐藏.
      const themePhaseByIndustry = await this.loadThemePhaseMap(actualDateUsed).catch(err => {
        logger.warn(`v3-recommendations theme phase load failed: ${err?.message ?? err}`);
        return new Map<string, { phase: FermentationPhase; is_mainline: boolean }>();
      });

      const recommendations = await Promise.all(
        selected.map(signal =>
          this.enrichSignal(signal, themePhaseByIndustry).catch(err => {
            logger.warn(
              `v3-recommendations enrich failed for ${signal.symbol}: ${err?.message ?? err}`
            );
            return this.minimalSignalView(signal);
          })
        )
      );

      const funnel = await this.queryFunnel(actualDateUsed).catch(err => {
        logger.warn(`v3-recommendations funnel query failed: ${err?.message ?? err}`);
        return { scanned: 0, candidate: 0, selected: 0, as_of: actualDateUsed };
      });

      res.json({
        success: true,
        data: {
          as_of: actualDateUsed,
          requested_date: date,
          source_used: actualSourceUsed,
          fallback_applied: actualDateUsed !== date,
          recommendations,
          funnel,
        },
      });
    } catch (error: any) {
      logger.error('获取 v3 推荐失败:', error);
      res.status((error as any)?.statusCode || 500).json({
        success: false,
        message: error?.message || '获取 v3 推荐失败',
      });
    }
  }

  /**
   * GET /api/today/v3-funnel?date=YYYY-MM-DD
   */
  async getFunnelStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const date = parseDate(req.query.date);
      const data = await this.queryFunnel(date);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取 v3 漏斗失败:', error);
      res.status((error as any)?.statusCode || 500).json({
        success: false,
        message: error?.message || '获取 v3 漏斗失败',
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  internal
  // ---------------------------------------------------------------------------

  private async queryFunnel(date: string): Promise<{
    scanned: number;
    candidate: number;
    selected: number;
    as_of: string;
  }> {
    // scanned: 大致用 Stock 表里 type='stock' 总数 (上市状态), 与 Daily Screener universe 同口径.
    const scanned = await Stock.count({
      where: {
        is_listed: true,
        type: { [Op.in]: ['stock', null as any] }, // null 兼容老数据
      },
    }).catch(() => 0);

    const candidate = await AIInvestmentSignal.count({
      where: {
        signal_date: date,
        source_type: { [Op.in]: CANDIDATE_SOURCE_TYPES as string[] },
      },
    }).catch(() => 0);

    const selected = await AIInvestmentSignal.count({
      where: {
        signal_date: date,
        source_type: { [Op.in]: CANDIDATE_SOURCE_TYPES as string[] },
        normalized_decision: { [Op.in]: BUY_DECISIONS as string[] },
      },
    }).catch(() => 0);

    return { scanned, candidate, selected, as_of: date };
  }

  /**
   * PR-O5 (2026-06-30) — 批量拉 theme_fermentation_phases 最新一天的相位
   * (优先 preferredDate, 找不到 fallback 最近一天). 一次性 SQL, 返 Map<industry, {phase, is_mainline}>.
   *
   * fail-OPEN: 出错 → 空 map, 调用方继续走推荐. 上层 .catch 已兜底, 这里 try/catch 防底层
   * sequelize import / query 异常.
   */
  private async loadThemePhaseMap(
    preferredDate: string
  ): Promise<Map<string, { phase: FermentationPhase; is_mainline: boolean }>> {
    const out = new Map<string, { phase: FermentationPhase; is_mainline: boolean }>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sequelizeModule = require('../../config/database');
      const sequelize = sequelizeModule.default || sequelizeModule.sequelize;
      const sql = `
        WITH effective_date AS (
          SELECT MAX(trade_date) AS d
          FROM theme_fermentation_phases
          WHERE trade_date <= :preferred
        )
        SELECT tfp.industry, tfp.phase, tfp.is_mainline
        FROM theme_fermentation_phases tfp
        JOIN effective_date ed ON tfp.trade_date = ed.d
        WHERE ed.d IS NOT NULL;
      `;
      const [rows] = await sequelize.query(sql, { replacements: { preferred: preferredDate } });
      for (const r of (rows as any[]) || []) {
        if (!r?.industry || !r?.phase) continue;
        out.set(String(r.industry), {
          phase: String(r.phase) as FermentationPhase,
          is_mainline: Boolean(r.is_mainline),
        });
      }
    } catch (err: any) {
      logger.warn(`loadThemePhaseMap fallback empty: ${err?.message ?? err}`);
    }
    return out;
  }

  /**
   * 把单条 archive signal 翻成 v3 卡片视图. 任一子查询失败 fall-back 部分字段 null.
   */
  private async enrichSignal(
    signal: AIInvestmentSignal,
    themePhaseByIndustry?: Map<string, { phase: FermentationPhase; is_mainline: boolean }>
  ): Promise<Record<string, unknown>> {
    const symbol = String(signal.symbol);
    const stock = await Stock.findOne({ where: { symbol } }).catch(() => null);
    const stockId = stock?.id ?? null;

    // 拉 20d + 1 天 daily_bars (升序), 算 amplitude / sparkline / 累计涨跌
    let bars: DailyBar[] = [];
    if (stockId !== null) {
      bars = await DailyBar.findAll({
        where: { stock_id: stockId },
        order: [['time', 'DESC']],
        limit: SPARKLINE_DAYS + 5,
      })
        .then(rows => rows.slice().reverse())
        .catch(() => []);
    }

    const priceWindow = buildPriceWindow(bars.map(b => ({ time: b.time, close: Number(b.close) })));
    const amplitude = computeAmplitude(
      bars.map(b => ({
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      }))
    );

    // 实时行情 (preferred) → fallback 最新 daily_bar
    const rtRow: any = await RealtimeQuote.findOne({
      where: { symbol },
      order: [['quote_time', 'DESC']],
      raw: true,
    }).catch(() => null);

    const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
    const currentPrice =
      rtRow && Number.isFinite(Number(rtRow.current_price))
        ? Number(rtRow.current_price)
        : lastBar
        ? Number(lastBar.close)
        : null;
    const changePct =
      rtRow && Number.isFinite(Number(rtRow.change_percent))
        ? Number(rtRow.change_percent)
        : lastBar && lastBar.change_percent !== undefined
        ? Number(lastBar.change_percent)
        : null;
    const turnoverRate =
      lastBar && lastBar.turnover_rate !== undefined
        ? Number(lastBar.turnover_rate)
        : stock && stock.turnover_rate !== undefined
        ? Number(stock.turnover_rate)
        : null;

    // 4 维聚合
    const perDim = extractPerDimension(signal);
    const dimensions: V3DimensionScore[] = aggregateToV3Dimensions(perDim);
    const v3Tier = pickV3ConfidenceTier(dimensions);

    // 高亮标签
    const tags = buildHighlightTags(
      {
        circulating_market_cap: stock?.circulating_market_cap ?? null,
        total_market_cap: stock?.total_market_cap ?? null,
      },
      perDim,
      3
    );

    // 推荐理由: detail.key_reasons[0..1] 拼接, 缺则 rationale 字段
    let recommendReason = '';
    try {
      if (signal.detail) {
        const parsed = JSON.parse(String(signal.detail));
        const keyReasons = Array.isArray(parsed?.key_reasons) ? parsed.key_reasons : [];
        recommendReason = keyReasons.slice(0, 2).filter(Boolean).join(' / ');
      }
    } catch {
      // ignore
    }
    if (!recommendReason && signal.rationale)
      recommendReason = String(signal.rationale).slice(0, 120);

    const metadata: any = signal.metadata ?? {};
    const entryZone: [number, number] | null = Array.isArray(metadata?.entry_zone)
      ? (metadata.entry_zone as [number, number])
      : null;

    // ----- CA-2: 场景化 5 档 playbook -----
    // prev_close 从 daily_bars 倒数第二根 (今日的"前收") 或 last bar (若数据只有 1 条)
    const prevCloseForPlaybook =
      bars.length >= 2
        ? Number(bars[bars.length - 2]?.close)
        : lastBar
        ? Number(lastBar.close)
        : NaN;
    const supportLevel =
      extractSupportLevel(perDim) ??
      findRecentLow(
        bars.map(b => ({ low: Number(b.low) })),
        60
      );
    const atr20d = computeATR20(
      bars.map(b => ({ high: Number(b.high), low: Number(b.low), close: Number(b.close) })),
      20
    );
    const capitalDim = perDim.find(d => d.analyzer_key === 'capital');
    const capitalScore =
      capitalDim && Number.isFinite(Number(capitalDim.score)) ? Number(capitalDim.score) : null;
    const riskWarningsText = Array.isArray(metadata?.risk_warnings)
      ? metadata.risk_warnings.join(' ')
      : '';

    let playbook: ScenarioPlaybookItem[] | null = null;
    if (Number.isFinite(prevCloseForPlaybook) && prevCloseForPlaybook > 0) {
      const ctx: ScenarioPlaybookContext = {
        prev_close: prevCloseForPlaybook,
        entry_low: entryZone ? Number(entryZone[0]) : null,
        support_level: supportLevel,
        atr_20d: atr20d,
        action: String(signal.decision ?? ''),
        evidence_text: buildEvidenceText(perDim),
        capital_score: capitalScore,
        risk_warnings_text: riskWarningsText,
      };
      try {
        playbook = buildScenarioPlaybook(ctx);
      } catch (err: any) {
        logger.warn(
          `v3-recommendations playbook build failed for ${symbol}: ${err?.message ?? err}`
        );
        playbook = null;
      }
    }

    // ----- CA-3: 详情区结构化模板 — 技术面 / 观察点 / 风险硬规则 -----
    // amount_yi 从 last bar.turnover (元) → 亿; market_cap_yi 从 circulating → 亿
    const lastBarTurnover =
      lastBar && (lastBar as any).turnover !== undefined ? Number((lastBar as any).turnover) : null;
    const amountYi =
      typeof lastBarTurnover === 'number' &&
      Number.isFinite(lastBarTurnover) &&
      lastBarTurnover >= 0
        ? Math.round((lastBarTurnover / 1e8) * 100) / 100
        : null;
    const marketCapSource =
      stock?.circulating_market_cap != null && Number(stock.circulating_market_cap) > 0
        ? Number(stock.circulating_market_cap)
        : stock?.total_market_cap != null && Number(stock.total_market_cap) > 0
        ? Number(stock.total_market_cap)
        : null;
    const marketCapYi =
      marketCapSource != null && Number.isFinite(marketCapSource)
        ? Math.round((marketCapSource / 1e8) * 100) / 100
        : null;
    // volume_ratio = today.volume / avg(prev 5d volume) (倍数)
    let volumeRatio: number | null = null;
    if (bars.length >= 2) {
      const today = bars[bars.length - 1];
      const prevs = bars.slice(-6, -1); // 取倒数 2-6 共 5 根
      const todayVol = Number(today?.volume);
      if (Number.isFinite(todayVol) && todayVol >= 0 && prevs.length > 0) {
        const sums = prevs.map(b => Number(b?.volume)).filter(v => Number.isFinite(v) && v >= 0);
        if (sums.length > 0) {
          const avg = sums.reduce((a, b) => a + b, 0) / sums.length;
          if (avg > 0) volumeRatio = Math.round((todayVol / avg) * 100) / 100;
        }
      }
    }

    const technicalEvidenceText = buildTechnicalEvidenceText(perDim);
    const sentimentDim = perDim.find(d => d.analyzer_key === 'sentiment');
    const sentimentScore =
      sentimentDim && Number.isFinite(Number(sentimentDim.score))
        ? Number(sentimentDim.score)
        : null;
    const industryDim = perDim.find(d => d.analyzer_key === 'industry_regime');
    const industryScore =
      industryDim && Number.isFinite(Number(industryDim.score)) ? Number(industryDim.score) : null;
    const hasIndustryTheme =
      (industryScore !== null && industryScore > 50) ||
      (sentimentScore !== null && sentimentScore > 50);
    const todayHigh = lastBar ? Number((lastBar as any).high) : null;
    const resistanceLevel =
      extractResistanceLevel(perDim) ??
      findRecentHigh(
        bars.map(b => ({ high: Number(b.high) })),
        60
      );
    const hasShortTermResistance = SHORT_TERM_RESISTANCE_KEYWORDS.some(kw =>
      technicalEvidenceText.includes(kw)
    );
    const isOverbought =
      (sentimentScore !== null && sentimentScore > 80) ||
      OVERBOUGHT_KEYWORDS.some(kw => technicalEvidenceText.includes(kw));

    let technicalSummary: string | null = null;
    let observationPoints: string[] = [];
    let riskRules: string[] = [];
    try {
      const techCtx: TechnicalSummaryContext = {
        change_pct_today: changePct,
        turnover_rate: turnoverRate,
        volume_ratio: volumeRatio,
        amount_yi: amountYi,
        market_cap_yi: marketCapYi,
        amplitude_pct: amplitude,
        evidence_text: buildEvidenceText(perDim),
        change_pct_20d: priceWindow?.cumulative_change_pct ?? null,
      };
      technicalSummary = buildTechnicalSummary(techCtx);

      const obsCtx: ObservationPointsContext = {
        resistance_level: resistanceLevel,
        support_level: supportLevel,
        current_volume_ratio: volumeRatio,
        today_high: Number.isFinite(todayHigh as number) ? (todayHigh as number) : null,
        has_industry_theme: hasIndustryTheme,
        technical_evidence: technicalEvidenceText,
        change_pct_20d: priceWindow?.cumulative_change_pct ?? null,
      };
      observationPoints = buildObservationPoints(obsCtx);

      const riskCtx: RiskRulesContext = {
        action: String(signal.decision ?? ''),
        risk_warnings: Array.isArray(metadata?.risk_warnings) ? metadata.risk_warnings : [],
        has_short_term_resistance: hasShortTermResistance,
        is_overbought: isOverbought,
      };
      riskRules = buildRiskRules(riskCtx);
    } catch (err: any) {
      logger.warn(
        `v3-recommendations detail (CA-3) build failed for ${symbol}: ${err?.message ?? err}`
      );
      // 三段任一抛错都退化为基础值, 不阻塞返回
      if (technicalSummary === null) technicalSummary = null;
      if (!Array.isArray(observationPoints)) observationPoints = [];
      if (!Array.isArray(riskRules) || riskRules.length === 0) {
        riskRules = [
          '低开超 -3% 且无主线支撑不要进, 弱势难改',
          '竞价阶段量比 < 0.5 且低开 -2% 以上, 放弃当天操作',
        ];
      }
    }

    // PR-M3 (2026-06-29): confidence 反向修正 (PR-K hotfix).
    // PR-K 实证发现高 conf 推荐 win 30% < 低 conf win 40% (反向). 临时方案: 若该
    // source_type 近 30 日 win_rate < 50% 且样本 >= 10, 把 raw conf 取负 (100 - raw),
    // 让前端 / paper trading 按修正后 conf 排序, 反向之后高 conf 反而是真高质量.
    // 长远方案: 重写因子 / 校准 conf — PR-M4+ 计划.
    // fail-open: adjuster 内部 throw 仅 warn, 返 raw conf 不动 — 保守不"乱反".
    const confAdjustment: any = {
      confidence_score_raw: signal.confidence_score ?? null,
      confidence_score_adjusted: signal.confidence_score ?? null,
      adjustment_reason: 'no_data' as const,
      source_win_rate: null,
      source_sample_size: 0,
    };
    // 批5: SourceTypeWinRateAdjuster 已下线 — 保留 raw = adjusted 中性值 (不再反向修正).

    // PR-O5 (2026-06-30) — 题材发酵相位 enrichment.
    // theme_phase 缺失 → 字段 null, 前端 badge 自动隐藏 (向前兼容).
    let themePhase: FermentationPhase | null = null;
    let themePhaseLabel: string | null = null;
    let themePhaseIcon: string | null = null;
    let themeIsMainline = false;
    try {
      const ind = stock?.industry ? String(stock.industry) : null;
      if (ind && themePhaseByIndustry && themePhaseByIndustry.has(ind)) {
        const entry = themePhaseByIndustry.get(ind)!;
        themePhase = entry.phase;
        themePhaseLabel = FERMENTATION_PHASE_LABELS[entry.phase] ?? null;
        themePhaseIcon = FERMENTATION_PHASE_ICONS[entry.phase] ?? null;
        themeIsMainline = entry.is_mainline === true;
      }
    } catch (err: any) {
      logger.warn(
        `v3-recommendations theme phase enrich failed for ${symbol}: ${err?.message ?? err}`
      );
    }

    return {
      symbol,
      name: signal.name ?? stock?.name ?? null,
      industry: stock?.industry ?? null,
      circulating_market_cap: stock?.circulating_market_cap ?? null,
      total_market_cap: stock?.total_market_cap ?? null,
      current_price: currentPrice,
      change_pct: changePct,
      turnover_rate: turnoverRate,
      amplitude_pct: amplitude,
      cumulative_change_pct_20d: priceWindow?.cumulative_change_pct ?? null,
      sparkline: priceWindow?.sparkline ?? [],
      dimensions,
      confidence_tier: v3Tier,
      overall_confidence:
        typeof metadata?.overall_confidence === 'number' ? metadata.overall_confidence : null,
      highlight_tags: tags,
      recommend_reason: recommendReason || null,
      decision: {
        action: signal.decision,
        normalized_decision: signal.normalized_decision,
        // 默认 confidence_score 字段保留 raw 原值 (前端老路径兼容)
        confidence_score: signal.confidence_score ?? null,
        // PR-M3 — 新增字段, 前端可优先用 adjusted 排序
        confidence_score_raw: confAdjustment.confidence_score_raw,
        confidence_score_adjusted: confAdjustment.confidence_score_adjusted,
        confidence_adjustment_reason: confAdjustment.adjustment_reason,
        confidence_source_win_rate: confAdjustment.source_win_rate,
        confidence_source_sample_size: confAdjustment.source_sample_size,
        risk_level: signal.risk_level ?? null,
        entry_zone: metadata?.entry_zone ?? null,
        stop_loss: metadata?.stop_loss ?? null,
        take_profit: metadata?.take_profit ?? null,
        suggested_position_pct: metadata?.suggested_position_pct ?? null,
        position_action: metadata?.position_action ?? null,
        confidence_tier_engine: metadata?.confidence_tier ?? null,
        risk_warnings: Array.isArray(metadata?.risk_warnings) ? metadata.risk_warnings : [],
      },
      playbook,
      technical_summary: technicalSummary,
      observation_points: observationPoints,
      risk_rules: riskRules,
      signal_id: signal.id,
      signal_date: signal.signal_date,
      // PR-W (2026-06-30) — 信号创建时间 + 信号分类 (推荐 vs 观察) 透传.
      created_at: signal.created_at
        ? signal.created_at instanceof Date
          ? signal.created_at.toISOString()
          : String(signal.created_at)
        : null,
      signal_kind: deriveSignalKind(signal.source_type),
      // 批7j/§7.1 — 核心-卫星桶: 前端据此把核心 ETF 与卫星题材分区展示.
      core_satellite: deriveCoreSatellite(signal.source_type, metadata),
      // PR-H — 推荐时机标签透传 UI. 缺失 → 'overnight' (符合历史 cron 15:32 写入语义).
      timing_tag: normalizeTimingTagFromMetadata(metadata),
      // PR-O2 (2026-06-29) — 涨停板战法 pattern badge. 仅 source_type='limit_up_board' 写入,
      // 其它 source 默认 null. 前端 /home 推荐卡见到 limit_up_pattern 非空就额外加一个
      // "🚀 一字板" / "📈 二板加速" 等 badge.
      limit_up_pattern:
        typeof metadata?.pattern === 'string' && metadata?.source === 'limit_up_board_detector'
          ? String(metadata.pattern)
          : null,
      limit_up_pattern_label:
        typeof metadata?.pattern_label === 'string' &&
        metadata?.source === 'limit_up_board_detector'
          ? String(metadata.pattern_label)
          : null,
      limit_up_continuous_days:
        Number.isFinite(Number(metadata?.continuous_days)) &&
        metadata?.source === 'limit_up_board_detector'
          ? Number(metadata.continuous_days)
          : null,
      // PR-O5 (2026-06-30) — 题材发酵 5 阶段透传 (字段缺失 → 前端 badge 自动隐藏).
      theme_phase: themePhase,
      theme_phase_label: themePhaseLabel,
      theme_phase_icon: themePhaseIcon,
      theme_is_mainline: themeIsMainline,
    };
  }

  /**
   * enrich 失败兜底视图 — 至少返 symbol + decision + 不挂前端布局.
   */
  private minimalSignalView(signal: AIInvestmentSignal): Record<string, unknown> {
    return {
      symbol: String(signal.symbol),
      name: signal.name ?? null,
      industry: null,
      circulating_market_cap: null,
      total_market_cap: null,
      current_price: null,
      change_pct: null,
      turnover_rate: null,
      amplitude_pct: null,
      cumulative_change_pct_20d: null,
      sparkline: [],
      dimensions: aggregateToV3Dimensions([]),
      confidence_tier: 'low' as const,
      overall_confidence: null,
      highlight_tags: [],
      recommend_reason: signal.rationale ?? null,
      decision: {
        action: signal.decision,
        normalized_decision: signal.normalized_decision,
        confidence_score: signal.confidence_score ?? null,
        risk_level: signal.risk_level ?? null,
        entry_zone: null,
        stop_loss: null,
        take_profit: null,
        suggested_position_pct: null,
        position_action: null,
        confidence_tier_engine: null,
        risk_warnings: [],
      },
      playbook: null,
      technical_summary: null,
      observation_points: [],
      risk_rules: [
        '低开超 -3% 且无主线支撑不要进, 弱势难改',
        '竞价阶段量比 < 0.5 且低开 -2% 以上, 放弃当天操作',
      ],
      signal_id: signal.id,
      signal_date: signal.signal_date,
      // PR-W (2026-06-30) — minimal view 也透传 created_at + signal_kind.
      created_at: (signal as any).created_at
        ? (signal as any).created_at instanceof Date
          ? (signal as any).created_at.toISOString()
          : String((signal as any).created_at)
        : null,
      signal_kind: deriveSignalKind((signal as any).source_type),
      core_satellite: deriveCoreSatellite((signal as any).source_type, (signal as any).metadata),
      // PR-H — minimal view 也透传 timing_tag (enrichSignal 失败兜底).
      timing_tag: normalizeTimingTagFromMetadata((signal as any).metadata),
      // PR-O2 — minimal view 也透传 limit_up_pattern (enrich 失败时仍出 badge).
      limit_up_pattern: (() => {
        const m = (signal as any).metadata;
        return typeof m?.pattern === 'string' && m?.source === 'limit_up_board_detector'
          ? String(m.pattern)
          : null;
      })(),
      limit_up_pattern_label: (() => {
        const m = (signal as any).metadata;
        return typeof m?.pattern_label === 'string' && m?.source === 'limit_up_board_detector'
          ? String(m.pattern_label)
          : null;
      })(),
      limit_up_continuous_days: (() => {
        const m = (signal as any).metadata;
        return Number.isFinite(Number(m?.continuous_days)) &&
          m?.source === 'limit_up_board_detector'
          ? Number(m.continuous_days)
          : null;
      })(),
      // PR-O5 (2026-06-30) — minimal view 也写出 theme_phase null 字段, 防 UI 报 undefined.
      theme_phase: null,
      theme_phase_label: null,
      theme_phase_icon: null,
      theme_is_mainline: false,
      enrich_failed: true,
    };
  }
}

export const v3RecommendationController = new V3RecommendationController();
