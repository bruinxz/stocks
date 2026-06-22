import { spawn } from 'child_process';
import path from 'path';
import { Op } from 'sequelize';
import { AnalystForecast } from '../models/AnalystForecast';
import { ETFFlow } from '../models/ETFFlow';
import { KOLOpinion } from '../models/KOLOpinion';
import { Stock } from '../models/Stock';
import { getETFCodesByIndustry } from '../constants/etfIndustry';
import { logger } from '../utils/logger';

/**
 * KOL 观点聚合服务 — US-056 AI 增强层.
 *
 * 把"行业大 V / 券商 / 媒体 / 集体市场" 对某只股票的最新观点聚合到统一表
 * `kol_opinions` 中，前端 "他人在看" 卡片直接读 DB 列表 (按 opinion_date desc
 * 取 5-10 条最新)。
 *
 * 聚合 3 大类来源 (与 KOLOpinion model 的 kol_source enum 一一对应):
 *
 *   1. **research_report** — 复用 AnalystForecast 已落库数据 (US-030)
 *      不再单独 fetch 同份数据 (跨 service 数据源口径一致范式, US-031)。
 *      取近 N 天 (默认 90) 内该股票的全部研报，每行映射到 KOLOpinion 一行。
 *
 *   2. **east_money_news** — Python helper `get_stock_news_em(symbol)`
 *      取该股票最近 ~100 条新闻头条，文章来源映射到 kol_name (财联社 /
 *      证券时报 / 上证报等)。情绪打分基于 SENTIMENT_KEYWORDS 字典扫描标题。
 *
 *   3. **xq_hot_concept** — Python helper `get_stock_hot_concepts(symbol)`
 *      取该股所属热门概念 top 5。kol_name = "市场热议·" + 概念名，
 *      sentiment_score 由热度排名映射到 [0.1, 0.5]。代理范式 (US-034) 详见
 *      KOLOpinion 模型注释。
 *
 * **核心契约**: aggregateForStock(stockCode, options) 返回一份**聚合后已 dedupe
 * 并按时间 desc 排序的 KOLOpinionRecord[]**, 并落库 (upsert)。前端 GET endpoint
 * 直接走 KOLOpinion.findAll({where: {stock_code}, order: [['opinion_date', 'DESC']]});
 * 聚合在线 (real-time fetch) 由 CLI 脚本 / 定时任务触发, 不在 API 调用链。
 *
 * **DataSource 注入** (与 quant 组合级 strategies + AIAdvisorService 同款 DI 范式):
 *   - 接口 `KOLAggregatorDataSource` 暴露 4 个方法 (fetchNews / fetchHotConcepts /
 *     loadResearchReports / saveOpinions);
 *   - `DefaultKOLAggregatorDataSource` 实现走 Python helper + Sequelize;
 *   - 单测注入 fake source 完全绕开 DB 与 Python 子进程。
 *
 * **写多读少**: aggregateForStock 写入 / 更新 KOLOpinion 行; 查询 endpoint
 * 走 KOLOpinion.findAll, **不重新 fetch**。这与 paper-trading facade 同款"写时
 * 落库 + 读时秒级"分离, 让 UI 加载不被 Python 子进程拖慢。
 */

// ---------------------------------------------------------------------------
// 公共常量与类型
// ---------------------------------------------------------------------------

/** KOL 来源标签（与 KOLOpinion.kol_source 列字符串一致） */
export const KOL_SOURCES = Object.freeze({
  RESEARCH_REPORT: 'research_report' as const,
  EAST_MONEY_NEWS: 'east_money_news' as const,
  XQ_HOT_CONCEPT: 'xq_hot_concept' as const,
  /** US-035: 行业 ETF 资金流向 (净申购为多 / 净赎回为空) */
  ETF_FLOW: 'etf_flow' as const,
  /** US-035: 行业政策指引 (政策利好/利空文档摘要) */
  POLICY_DOC: 'policy_doc' as const,
});

export type KOLSource = (typeof KOL_SOURCES)[keyof typeof KOL_SOURCES];

/** 评级 → 情绪分映射 (券商东财评级标准 7 档 → [-1, 1]) */
export const RATING_SENTIMENT_MAP: Readonly<Record<string, number>> = Object.freeze({
  买入: 1.0,
  推荐: 1.0,
  强烈推荐: 1.0,
  增持: 0.6,
  超配: 0.6,
  审慎推荐: 0.4,
  持有: 0.0,
  中性: 0.0,
  观望: 0.0,
  减持: -0.6,
  低配: -0.6,
  卖出: -1.0,
  回避: -1.0,
});

/** 强多 / 弱多 / 弱空 / 强空 关键词字典 — 用于标题情绪扫描 */
export const SENTIMENT_KEYWORDS: Readonly<{
  strongPos: readonly string[];
  weakPos: readonly string[];
  weakNeg: readonly string[];
  strongNeg: readonly string[];
}> = Object.freeze({
  strongPos: Object.freeze([
    '业绩超预期',
    '业绩大增',
    '突破新高',
    '中标',
    '签订',
    '获批',
    '受益',
    '利好',
    '增持',
    '回购',
    '分红',
    '股权激励',
  ]),
  weakPos: Object.freeze([
    '上涨',
    '上扬',
    '高开',
    '看好',
    '上调',
    '增长',
    '扩产',
    '签约',
    '合作',
    '进展',
    '推动',
  ]),
  weakNeg: Object.freeze([
    '下跌',
    '调整',
    '回调',
    '减持',
    '下调',
    '解禁',
    '诉讼',
    '问询',
    '降低',
    '风险提示',
  ]),
  strongNeg: Object.freeze([
    '立案',
    '退市',
    '重大违规',
    '欺诈',
    '处罚',
    '黑天鹅',
    '暴跌',
    '跌停',
    '业绩暴雷',
    '业绩低于预期',
    '亏损扩大',
    '债务违约',
  ]),
});

/** 聚合产物 (一行 = KOLOpinion 一行可 upsert 的形状) */
export interface KOLOpinionRecord {
  stock_code: string;
  kol_name: string;
  opinion_date: string; // YYYY-MM-DD
  kol_source: KOLSource;
  opinion_summary: string;
  sentiment_score: number | null;
  url: string | null;
  raw_payload: Record<string, unknown>;
}

/**
 * **source_authority 权重 (US-034)** — 不同来源的可信度 / 影响力先验.
 *
 * 用于 (a) dedupeAndSort 同日多条时优先级排序 (authority × |sentiment| 越大越靠前)
 * 与 (b) 下游 NewsAnalyzer / 多维分析 (US-036+) 加权汇总情绪. 直接对外暴露常量
 * 而非藏在闭包里, 让任何使用 KOLOpinion 的消费者都能拿同一份权重做加权.
 *
 * 当前 3 个 enum 来源已落地; 'kol' / 'etf_flow' / 'policy_doc' 是为 US-035 / US-036
 * 预留的占位 — 之后引入新 kol_source 枚举时直接读这张表, 不需要再改 dedupeAndSort.
 *
 * 缺省 fallback = 0.3 (与 east_money_news 等同, 即 "普通消息" 等级).
 */
export const SOURCE_AUTHORITY: Readonly<Record<string, number>> = Object.freeze({
  research_report: 0.6,
  east_money_news: 0.3,
  xq_hot_concept: 0.4,
  kol: 0.4,
  etf_flow: 0.5,
  policy_doc: 0.8,
});

export const SOURCE_AUTHORITY_DEFAULT = 0.3;

/** 拿单个来源的权威权重 — 未识别 source 走 SOURCE_AUTHORITY_DEFAULT 而非 throw. */
export function getSourceAuthority(source: string | null | undefined): number {
  if (!source) return SOURCE_AUTHORITY_DEFAULT;
  const v = SOURCE_AUTHORITY[source];
  return typeof v === 'number' ? v : SOURCE_AUTHORITY_DEFAULT;
}

/**
 * 一条意见的"权威加权情绪强度" — `|sentiment_score| * authority`.
 *
 * 给 dedupeAndSort 当同日多条排序的二级 key — 强观点 (买入 / 立案) + 权威来源
 * (券商研报 / 政策) 排最前; 中性 0 分意见自然沉底.
 *
 * sentiment_score=null → 视为 0 (无明确观点不抢 ranking, 但不影响 authority 自身).
 */
export function authorityWeightedSentiment(rec: KOLOpinionRecord): number {
  const s = rec.sentiment_score;
  const absS = s !== null && Number.isFinite(s) ? Math.abs(s as number) : 0;
  return absS * getSourceAuthority(rec.kol_source);
}

// ---------------------------------------------------------------------------
// US-119 [KOL-005] time_decay — weight × exp(-days_old / 7)
// ---------------------------------------------------------------------------

/**
 * 时间衰减半衰常数 (天). 公式 `exp(-days_old / TIME_DECAY_HALF_LIFE_DAYS)`,
 * 这里命名为 "half life" 是直观叫法 — 实际是 e-fold 时间常数, 7 天后权重 ≈ 0.368
 * (1/e), 14 天后 ≈ 0.135, 30 天后 ≈ 0.014. AC 锁定 `/ 7`, 不允许业务侧改.
 *
 * 设计原因: 个股 KOL 观点 / 政策口径的"新鲜度衰减"经验是 1-2 周, 7 天是
 * mid-point — 比新闻 (3d 衰减) 久, 比研报 (30d) 短, 适合多源汇总.
 */
export const TIME_DECAY_HALF_LIFE_DAYS = 7;

/**
 * 计算两个 ISO 日期 (YYYY-MM-DD) 之间的整数天差 (asOfDate - opinionDate).
 * 跨月 / 跨年通过 UTC 日时间戳算, 与 isoDateMinusDays 同算法一致.
 *
 * 输入异常 (格式不合法 / parse 失败) 兜底返 0 — 与 "未识别 source → default authority"
 * 同款 fail-OPEN: 缺日期就当成 "今天" 处理, 不衰减, 避免上游脏数据被吞掉.
 */
export function daysBetweenIsoDates(opinionDate: string, asOfDate: string): number {
  const parse = (s: string): number | null => {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  };
  const oms = parse(opinionDate);
  const ams = parse(asOfDate);
  if (oms === null || ams === null) return 0;
  return Math.round((ams - oms) / 86_400_000);
}

/**
 * **US-119: time_decay 衰减因子** — `exp(-days_old / 7)`, 范围 (0, 1].
 *
 * - days_old <= 0 (未来日期或同日) → 1.0 (不衰减);
 * - days_old = 7 → ≈ 0.368 (1/e);
 * - days_old = 14 → ≈ 0.135;
 * - days_old = 30 → ≈ 0.013.
 *
 * 严格 AC 公式不带 floor / clamp, 让下游加权汇总自然平滑.
 */
export function timeDecayFactor(opinionDate: string, asOfDate: string): number {
  const daysOld = daysBetweenIsoDates(opinionDate, asOfDate);
  if (daysOld <= 0) return 1;
  return Math.exp(-daysOld / TIME_DECAY_HALF_LIFE_DAYS);
}

/**
 * 一条意见的"权威 × 强度 × 时间衰减"综合权重 — `|sentiment| * authority * exp(-days/7)`.
 *
 * 用于 (a) dedupeAndSort 第三级排序 (越新 + 越权威 + 越强 排越前);
 * (b) 下游加权汇总 (NewsAnalyzer / SentimentAnalyzer) 把多源多日观点合成单值
 * — 同一思路: 时间越远权重越低, 不让 30 天前的强观点喧宾夺主.
 *
 * asOfDate 缺省 = 今天本地 (与 aggregateForStock 默认一致); 测试可注入固定值.
 */
export function decayedAuthorityWeightedSentiment(
  rec: KOLOpinionRecord,
  asOfDate?: string
): number {
  const base = authorityWeightedSentiment(rec);
  if (base === 0) return 0;
  const ref = asOfDate || todayLocalIso();
  return base * timeDecayFactor(rec.opinion_date, ref);
}

/**
 * US-120 [KOL-006]: **签名加权平均** ∈ [-1, 1] —
 * `Σ (sentiment_score × authority × decay) / Σ (authority × decay)`.
 *
 * 与 `decayedAuthorityWeightedSentiment` (|s| × authority × decay, 仅作权重) 区分:
 * 这里**保留 sentiment 符号**, 让多头/空头互相抵消, 得到行业整体倾向.
 *
 * - 0 条意见 → 0 (fail-OPEN, 与 SentimentAnalyzer 缺数同款);
 * - 全部 sentiment=null / 0 → 分母 = 0 → 0 (避免 NaN);
 * - 单条意见 → 直接退化为该条 sentiment_score (权重比例为 1).
 *
 * 也供 `aggregateForIndustry` 行业总分 + 每只成份股子分共用同款公式,
 * 让 by_stock[code] 数学定义与 aggregate_sentiment 一致 (drill-down 可加权重组).
 */
export function signedWeightedSentiment(
  records: ReadonlyArray<KOLOpinionRecord>,
  asOfDate?: string
): number {
  if (!records || records.length === 0) return 0;
  const ref = asOfDate || todayLocalIso();
  let num = 0;
  let den = 0;
  for (const r of records) {
    const s = r.sentiment_score;
    if (s === null || !Number.isFinite(s as number)) continue;
    const auth = getSourceAuthority(r.kol_source);
    const decay = timeDecayFactor(r.opinion_date, ref);
    const w = auth * decay;
    if (w <= 0) continue;
    num += (s as number) * w;
    den += w;
  }
  if (den <= 0) return 0;
  return num / den;
}

export interface AggregateOptions {
  /** 取近 N 天 (默认 90)。研报 / 新闻 / 概念 均按此窗口过滤。 */
  lookbackDays?: number;
  /** 最多返回 / 落库行数 (默认 10，AC: 5-10)。 */
  limit?: number;
  /** 跳过 saveOpinions 写库 (dry-run 模式)，默认 false。 */
  dryRun?: boolean;
  /** as-of date (YYYY-MM-DD); 默认今天本地。用于测试可控时间。 */
  asOfDate?: string;
  /**
   * US-142 [KOL-009]: 启用语义去重 (shingle Jaccard ≥ threshold 视为同事件复述).
   *
   * 默认 **关闭** — 保留 backward compat (既有 service caller 行为不变).
   * 启用后会在 composite-PK dedupeAndSort 之后再合并相似度 ≥ threshold 的同源文本类记录,
   * 把"5 家媒体复述同一篇通稿" 收编成 1 条; 不跨 source 合并 (研报+新闻多源共识保留).
   */
  semanticDedupe?: boolean;
  /**
   * 语义去重阈值, ∈ [0, 1], 默认 `DEFAULT_SEMANTIC_DEDUPE_THRESHOLD` (0.65).
   * 仅在 `semanticDedupe=true` 时生效; 非法值兜底到默认.
   */
  semanticDedupeThreshold?: number;
}

export interface AggregateResult {
  stock_code: string;
  total_collected: number;
  by_source: Record<KOLSource, number>;
  opinions: KOLOpinionRecord[];
  persisted: boolean;
  error?: string;
}

/**
 * US-120 [KOL-006]: 行业维度聚合结果 — 把 stocks[] 内每只票的 KOL 观点
 * 收编到行业层, 输出一份"行业风向"快照供 IndustryRegimeAnalyzer /
 * SentimentAnalyzer 直接读 (跨股聚合的 decayed authority-weighted 总和).
 *
 * - `industry`: 行业标签 (与 ETFProfile.industry / Stock.industry 字符串严格匹配);
 * - `stock_codes`: 输入的成份股代码 (去重 + 6 位 digits 校验);
 * - `aggregate_sentiment`: 签名加权平均 ∈ [-1, 1] —
 *   Σ (sentiment_score × authority × decay) / Σ (authority × decay),
 *   注意 weight 用 |authority × decay| 但乘上**带符号的 sentiment**,
 *   故行业一致看空 → 总分 < 0, 多空对峙 → 接近 0, 全员看多 → > 0;
 * - `total_opinions`: 全行业内累计 opinion 条数 (跨股 dedupe 后);
 * - `top_opinions`: 跨股 dedupe + decayed weight desc 取 top N (默认 10),
 *   供前端 "行业风向" 卡片直接展示;
 * - `by_stock`: 每只股票 aggregate_sentiment 子分 (供 drill-down);
 * - `by_source`: 全行业累计每 source opinion 数 (诊断维度覆盖);
 * - `as_of_date`: 时间衰减锚点 (默认 todayLocalIso());
 * - `error`: 输入全失败兜底 (e.g. 全部 stockCode 非法), service 不抛.
 */
export interface IndustryAggregateResult {
  industry: string;
  stock_codes: string[];
  total_opinions: number;
  aggregate_sentiment: number;
  top_opinions: KOLOpinionRecord[];
  by_stock: Record<string, number>;
  by_source: Record<KOLSource, number>;
  as_of_date: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// DataSource interface (DI for tests)
// ---------------------------------------------------------------------------

/** 来自 stock_news_em 的单条新闻 (与 BlackSwanClient.StockNewsRow 等价) */
export interface KOLNewsRow {
  title: string;
  content: string | null;
  publish_time: string | null;
  source: string | null;
  url: string | null;
  raw_payload: Record<string, unknown>;
}

/** 来自 stock_hot_keyword_em 的单条概念 */
export interface KOLHotConceptRow {
  snapshot_time: string | null;
  concept_name: string;
  concept_code: string | null;
  heat: number | null;
  rank: number;
  raw_payload: Record<string, unknown>;
}

/** AnalystForecast 简化视图 (只取聚合需要的列, 便于 mock) */
export interface KOLResearchRow {
  report_date: string;
  analyst_firm: string;
  rating: string | null;
  report_title: string | null;
  report_pdf_url: string | null;
  raw_payload: Record<string, unknown>;
}

/**
 * US-035: ETFFlow 简化视图 (per-ETF 日度净申赎 + AUM, 取聚合需要的列).
 *
 * 一条 KOLETFFlowRow = `etf_flows` 表内一行 (trade_date, etf_code) 二元 PK.
 * 来源:
 *   - underlying_industry 由 ETF 白名单 (constants/etfIndustry.ts) 提供;
 *   - net_inflow / aum 由 day-to-day diff 推算 (US-092 同款 proxy);
 * Service 把 "该股票所属行业的 ETF 申赎情况" 反向映射成 KOL 观点
 * — 净申购大额 = 行业被看多, 净赎回大额 = 行业被看空.
 */
export interface KOLETFFlowRow {
  trade_date: string;
  etf_code: string;
  etf_name: string;
  underlying_industry: string;
  net_inflow: number | null;
  aum: number | null;
  raw_payload: Record<string, unknown>;
}

/**
 * US-035: 政策指引文档简化视图 (一条 KOLPolicyRow = 一条行业政策摘要).
 *
 * 数据源 (proxy 范式, AKShare 政策原文 endpoint 不可得):
 *   - 用 stock_news_em / get_stock_news_em 提取标题含 "政策 / 监管 / 利好 /
 *     补贴 / 规划 / 指引" 等政策关键词的新闻条目;
 *   - kol_name = 政策发布机构 (e.g. "国务院" / "证监会" / "国家发改委") 或
 *     "政策研判·{发布机构}" fallback.
 *
 * 升级路径: 若引入 Wind / Tushare Pro / 国务院文件库 endpoint, 替换 Default
 * fetchPolicyDirectives 实现, service 层 / model schema 不变.
 */
export interface KOLPolicyRow {
  publish_date: string;
  issuing_org: string;
  title: string;
  summary: string | null;
  sentiment: 'positive' | 'negative' | 'neutral';
  url: string | null;
  raw_payload: Record<string, unknown>;
}

export interface KOLAggregatorDataSource {
  fetchNews(stockCode: string, limit: number): Promise<KOLNewsRow[]>;
  fetchHotConcepts(stockCode: string, limit: number): Promise<KOLHotConceptRow[]>;
  loadResearchReports(stockCode: string, sinceDate: string): Promise<KOLResearchRow[]>;
  /**
   * US-035: 取股票所属行业的 ETF 日度申赎 + AUM (近 N 天).
   * 实现可走 ETFFlow + Stock.industry → ETF 白名单映射, 也可注入 fake.
   * 返回 [] = 该股票无对应行业 ETF / 数据缺失 (fail-OPEN, 不抛).
   */
  fetchETFFlow(stockCode: string, sinceDate: string): Promise<KOLETFFlowRow[]>;
  /**
   * US-035: 取股票所属行业的政策指引文档摘要 (近 N 天).
   * 默认实现走 Python helper (get_stock_news_em + 政策关键词过滤);
   * 升级到原生政策库后替换该方法即可.
   */
  fetchPolicyDirectives(stockCode: string, sinceDate: string): Promise<KOLPolicyRow[]>;
  saveOpinions(records: KOLOpinionRecord[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default DataSource (Python helper + Sequelize)
// ---------------------------------------------------------------------------

const PYTHON_HELPER = path.join(__dirname, '../../python/akshare_helper.py');

export class DefaultKOLAggregatorDataSource implements KOLAggregatorDataSource {
  private pythonPath: string;
  private timeoutMs: number;

  constructor(opts: { pythonPath?: string; timeoutMs?: number } = {}) {
    // Bug AY-3 fix: 若 process.env.PYTHON_PATH 缺失 (常见于 CLI 脚本未 source
    // backend.env 直接 spawn 子进程, 或 worker 进程未继承 prod systemd env),
    // 用 prod 一致的 /opt/stocks/shared/venv/bin/python 兜底而非 python3 -
    // 后者系统装的解释器没有 akshare 模块, 一调用就 ModuleNotFoundError fallback []
    // 让事件维度永远空命中, 静默式 degrade. 与 backend/src/scripts/sync-extra-dims.ts
    // 的兜底口径保持一致.
    this.pythonPath =
      opts.pythonPath || process.env.PYTHON_PATH || '/opt/stocks/shared/venv/bin/python';
    this.timeoutMs = opts.timeoutMs || Number(process.env.KOL_AGGREGATOR_TIMEOUT_MS || 60_000);
    logger.info(
      `DefaultKOLAggregatorDataSource initialized (python=${this.pythonPath}, script=${PYTHON_HELPER}, timeoutMs=${this.timeoutMs})`
    );
  }

  async fetchNews(stockCode: string, limit: number): Promise<KOLNewsRow[]> {
    try {
      const rows = (await this.callPython('get_stock_news_em', stockCode, String(limit))) as
        | KOLNewsRow[]
        | null;
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.warn(
        `KOLAggregator.fetchNews(${stockCode}) failed: ${
          (error as Error).message
        } — falling back to []`
      );
      return [];
    }
  }

  async fetchHotConcepts(stockCode: string, limit: number): Promise<KOLHotConceptRow[]> {
    try {
      const rows = (await this.callPython('get_stock_hot_concepts', stockCode, String(limit))) as
        | KOLHotConceptRow[]
        | null;
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.warn(
        `KOLAggregator.fetchHotConcepts(${stockCode}) failed: ${
          (error as Error).message
        } — falling back to []`
      );
      return [];
    }
  }

  async loadResearchReports(stockCode: string, sinceDate: string): Promise<KOLResearchRow[]> {
    try {
      const rows = (await AnalystForecast.findAll({
        where: {
          stock_code: stockCode,
          report_date: { [Op.gte]: sinceDate },
        },
        attributes: ['report_date', 'analyst_firm', 'rating', 'report_title', 'report_pdf_url'],
        order: [['report_date', 'DESC']],
        raw: true,
      })) as unknown as Array<{
        report_date: string;
        analyst_firm: string;
        rating: string | null;
        report_title: string | null;
        report_pdf_url: string | null;
      }>;
      return rows.map(r => ({
        report_date: r.report_date,
        analyst_firm: r.analyst_firm,
        rating: r.rating,
        report_title: r.report_title,
        report_pdf_url: r.report_pdf_url,
        raw_payload: {
          report_date: r.report_date,
          analyst_firm: r.analyst_firm,
          rating: r.rating,
          report_title: r.report_title,
          source: 'AnalystForecast',
        },
      }));
    } catch (error) {
      logger.warn(
        `KOLAggregator.loadResearchReports(${stockCode}) failed: ${
          (error as Error).message
        } — falling back to []`
      );
      return [];
    }
  }

  /**
   * US-035: 取该股票所属行业的 ETF 日度申赎 / AUM (近 N 天).
   *
   * 流程:
   *   1. 查 Stock.industry → 行业标签;
   *   2. ETF 白名单 getETFCodesByIndustry(industry) → 同行业 ETF 代码列表;
   *   3. ETFFlow.findAll where etf_code IN [...] AND trade_date >= sinceDate.
   *
   * fail-OPEN: stock 缺 industry / 行业无 ETF 映射 / DB 故障 → 返 [], 不抛.
   */
  async fetchETFFlow(stockCode: string, sinceDate: string): Promise<KOLETFFlowRow[]> {
    try {
      // 1. 取股票所属行业 (Stock.symbol 通常带 .SH/.SZ 后缀, 用 LIKE 兜底)
      const stock = (await Stock.findOne({
        where: { symbol: { [Op.like]: `${stockCode}%` } },
        attributes: ['industry'],
        raw: true,
      })) as { industry?: string } | null;
      const industry = stock?.industry?.trim();
      if (!industry) return [];

      // 2. 同行业 ETF 白名单
      const etfCodes = getETFCodesByIndustry(industry);
      if (etfCodes.length === 0) return [];

      // 3. 拉取近 N 天的 ETF flow
      const rows = (await ETFFlow.findAll({
        where: {
          etf_code: { [Op.in]: etfCodes },
          trade_date: { [Op.gte]: sinceDate },
        },
        attributes: [
          'trade_date',
          'etf_code',
          'etf_name',
          'underlying_industry',
          'net_inflow',
          'aum',
        ],
        order: [['trade_date', 'DESC']],
        raw: true,
      })) as unknown as Array<{
        trade_date: string;
        etf_code: string;
        etf_name: string;
        underlying_industry: string;
        net_inflow: number | null;
        aum: number | null;
      }>;

      return rows.map(r => ({
        trade_date: r.trade_date,
        etf_code: r.etf_code,
        etf_name: r.etf_name,
        underlying_industry: r.underlying_industry,
        net_inflow: r.net_inflow !== null ? Number(r.net_inflow) : null,
        aum: r.aum !== null ? Number(r.aum) : null,
        raw_payload: {
          trade_date: r.trade_date,
          etf_code: r.etf_code,
          etf_name: r.etf_name,
          underlying_industry: r.underlying_industry,
          source: 'ETFFlow',
        },
      }));
    } catch (error) {
      logger.warn(
        `KOLAggregator.fetchETFFlow(${stockCode}) failed: ${
          (error as Error).message
        } — falling back to []`
      );
      return [];
    }
  }

  /**
   * US-035: 取该股票所属行业的政策指引文档摘要 (近 N 天).
   *
   * **proxy 范式**: AKShare 政策原文 endpoint 不可得, 当前实现复用
   * `get_stock_news_em` + 政策关键词过滤. 升级到原生政策库后只替换本方法,
   * service 主流程 / model schema 不动.
   *
   * fail-OPEN: Python 调用失败 / 无命中 → 返 [], 不抛.
   */
  async fetchPolicyDirectives(stockCode: string, sinceDate: string): Promise<KOLPolicyRow[]> {
    try {
      const rows = (await this.callPython('get_stock_news_em', stockCode, '200')) as
        | KOLNewsRow[]
        | null;
      if (!Array.isArray(rows) || rows.length === 0) return [];
      return filterPolicyFromNews(rows, sinceDate);
    } catch (error) {
      logger.warn(
        `KOLAggregator.fetchPolicyDirectives(${stockCode}) failed: ${
          (error as Error).message
        } — falling back to []`
      );
      return [];
    }
  }

  async saveOpinions(records: KOLOpinionRecord[]): Promise<void> {
    if (records.length === 0) return;
    await KOLOpinion.bulkCreate(records as unknown as Array<Record<string, unknown>>, {
      updateOnDuplicate: [
        'kol_source',
        'opinion_summary',
        'sentiment_score',
        'url',
        'raw_payload',
        'updated_at',
      ],
    });
  }

  private callPython(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [PYTHON_HELPER, command, ...args];
      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
        reject(new Error(`Python script timeout (${Math.round(this.timeoutMs / 1000)}s)`));
      }, this.timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Python script failed (exit=${code}): ${stderr}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(result.data);
          } else {
            reject(new Error(result.error || 'Unknown error from Python'));
          }
        } catch (error) {
          reject(new Error(`Invalid JSON from Python: ${(error as Error).message}`));
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}

export const PRODUCTION_KOL_AGGREGATOR_DATA_SOURCE: KOLAggregatorDataSource =
  new DefaultKOLAggregatorDataSource();

// ---------------------------------------------------------------------------
// Pure helpers (export for unit tests)
// ---------------------------------------------------------------------------

/**
 * 把评级字符串映射到 [-1, +1] 区间情绪分。
 *
 * - 标准 7 档 (买入/增持/中性/持有/减持/卖出/未评级) 直接查表;
 * - 未评级 / 空字符串 / 无法识别 → null (前端展示为 "—" 不参与统计);
 * - 大小写不敏感 + 首尾空白 trim.
 */
export function ratingToSentiment(rating: string | null | undefined): number | null {
  if (!rating) return null;
  const cleaned = String(rating).trim();
  if (!cleaned) return null;
  if (cleaned in RATING_SENTIMENT_MAP) return RATING_SENTIMENT_MAP[cleaned];
  // 模糊匹配 (有些券商发"维持买入" / "上调至买入" / "首次覆盖买入")
  if (cleaned.includes('买入') || cleaned.includes('强推')) return 1.0;
  if (cleaned.includes('增持') || cleaned.includes('超配')) return 0.6;
  if (cleaned.includes('中性') || cleaned.includes('持有') || cleaned.includes('观望')) return 0.0;
  if (cleaned.includes('减持') || cleaned.includes('低配')) return -0.6;
  if (cleaned.includes('卖出') || cleaned.includes('回避')) return -1.0;
  return null;
}

/**
 * 通过关键词字典扫描新闻标题 → 返回情绪分 [-1, +1]。
 *
 * 优先级 (从强到弱): 强空 → 强多 → 弱空 → 弱多 → 中性 (0)。
 * 同时命中正负词时, 强词覆盖弱词; 同强级时按出现先后, 取第一个。
 */
export function scoreNewsSentiment(title: string | null | undefined): number {
  if (!title) return 0;
  const text = String(title);
  // 1. 强空 (优先级最高 — 安全派, 避免漏报负面)
  for (const kw of SENTIMENT_KEYWORDS.strongNeg) {
    if (text.includes(kw)) return -1.0;
  }
  // 2. 强多
  for (const kw of SENTIMENT_KEYWORDS.strongPos) {
    if (text.includes(kw)) return 1.0;
  }
  // 3. 弱空
  for (const kw of SENTIMENT_KEYWORDS.weakNeg) {
    if (text.includes(kw)) return -0.5;
  }
  // 4. 弱多
  for (const kw of SENTIMENT_KEYWORDS.weakPos) {
    if (text.includes(kw)) return 0.5;
  }
  return 0;
}

/**
 * 概念热度排名 → [0.1, 0.5] 关注度分 (无空头方向, 仅"被关注"信号)。
 *
 * rank=1 → 0.5 (最热门), rank=2 → 0.4, ..., rank≥5 → 0.1.
 * rank≤0 或无效 → 0.1 兜底, 不返回 null (毕竟该股出现在概念 list 就说明被关注)。
 */
export function conceptRankToSentiment(rank: number | null | undefined): number {
  if (!rank || !Number.isFinite(rank) || rank < 1) return 0.1;
  if (rank === 1) return 0.5;
  if (rank === 2) return 0.4;
  if (rank === 3) return 0.3;
  if (rank === 4) return 0.2;
  return 0.1;
}

/**
 * 把 'YYYY-MM-DD HH:mm:ss' 或 'YYYY-MM-DD' 或 ISO 取前 10 字符规整成 YYYY-MM-DD。
 *
 * - null / 空 / 无法解析 → fallback (默认今天本地 ISO);
 * - 接受多种分隔符 ('-', '/', '.'),
 *   接受 'YYYYMMDD'.
 */
export function normalizeDateOnly(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const s = String(raw).trim();
  if (!s) return fallback;
  // 优先匹配 'YYYY-M-D' / 'YYYY-MM-DD' / 'YYYY/M/D' / 'YYYY.M.D' (含单位数补零)
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mm = m[2].padStart(2, '0');
    const d = m[3].padStart(2, '0');
    return `${y}-${mm}-${d}`;
  }
  // 'YYYYMMDD' (无分隔符 8 位数字)
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return fallback;
}

/**
 * 把候选 opinions 排序 (opinion_date desc, authority 权重) 并裁到 limit。
 *
 * **去重规则** (composite key = stock_code|kol_name|opinion_date):
 *   - 同 KOL 同日多条 → "信息量更大" 的优先:
 *     1. sentiment_score 非 null 优先 (有明确观点 > 无观点的兜底);
 *     2. opinion_summary 长度更长的优先;
 *     3. 后出现的覆盖前出现的 (与 bulkCreate updateOnDuplicate 行为一致).
 *
 * **排序优先级** (US-034 升级 — 引入 source_authority 权重):
 *   1. opinion_date desc (最新优先);
 *   2. authority 权重 desc: SOURCE_AUTHORITY[kol_source] 越大越靠前
 *      (research_report 0.6 > etf_flow 0.5 > xq_hot_concept / kol 0.4 >
 *      east_money_news 0.3, policy_doc 0.8 最高 — 政策口径权威性最大);
 *   3. authority × |sentiment_score| desc: 同权威级别下"强观点 (买入/立案)" 排前面,
 *      把"召开股东大会"这类 0 分中性意见沉底;
 *   4. kol_name 字典序 (稳定 tie-break, 同 quant strategies stable sort 范式).
 *
 * 与下游 NewsAnalyzer (US-036) 共享 SOURCE_AUTHORITY 常量, 确保排序优先级与
 * 加权汇总情绪用同一组先验, 避免"前端展示顺序 ≠ 加权信号" 的口径漂移.
 */
export function dedupeAndSort(records: KOLOpinionRecord[], limit: number): KOLOpinionRecord[] {
  const byKey = new Map<string, KOLOpinionRecord>();
  for (const rec of records) {
    const key = `${rec.stock_code}|${rec.kol_name}|${rec.opinion_date}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, rec);
      continue;
    }
    if (preferRecord(rec, prev)) {
      byKey.set(key, rec);
    }
  }
  const sorted = Array.from(byKey.values()).sort((a, b) => {
    // 1. opinion_date desc
    if (a.opinion_date !== b.opinion_date) {
      return a.opinion_date < b.opinion_date ? 1 : -1;
    }
    // 2. authority desc — 权威来源排前面
    const aa = getSourceAuthority(a.kol_source);
    const ba = getSourceAuthority(b.kol_source);
    if (aa !== ba) return ba - aa;
    // 3. authority-weighted |sentiment| desc — 强观点排前面 (同权威级别下)
    const aw = authorityWeightedSentiment(a);
    const bw = authorityWeightedSentiment(b);
    if (aw !== bw) return bw - aw;
    // 4. kol_name 稳定 tie-break
    return a.kol_name.localeCompare(b.kol_name, 'zh-CN');
  });
  return sorted.slice(0, limit);
}

function preferRecord(a: KOLOpinionRecord, b: KOLOpinionRecord): boolean {
  const aHasScore = a.sentiment_score !== null && Number.isFinite(a.sentiment_score);
  const bHasScore = b.sentiment_score !== null && Number.isFinite(b.sentiment_score);
  if (aHasScore !== bHasScore) return aHasScore;
  const aLen = a.opinion_summary?.length ?? 0;
  const bLen = b.opinion_summary?.length ?? 0;
  if (aLen !== bLen) return aLen > bLen;
  return true;
}

// ---------------------------------------------------------------------------
// US-142 [KOL-009]: 语义去重 (semantic dedupe via shingle Jaccard similarity)
// ---------------------------------------------------------------------------

/**
 * 语义去重默认阈值: shingle Jaccard ≥ 0.65 视为"高度相似".
 *
 * 经验阈值 (与典型新闻 / 研报标题口径校准):
 *   - 0.50: 题材相同但表达自由度大 (e.g. 同板块概念稿件) — 召回率高, 误杀风险中等;
 *   - **0.65** (默认): 同一事件的不同媒体复述基本能去掉, 表达微调 (e.g. 大写小写、
 *     标点、停用词) 不影响判定; 不同事件即使同板块/同股票也大概率保留;
 *   - 0.80: 仅去掉极近似复制 (转载) — 召回率低.
 *
 * AC: 去重率 ≥ 70%. 在构造的"5 条媒体复述同一事件 + 5 条独立观点" 测试集中,
 * 默认阈值能把 10 条合并到 ≤ 3 条 (5 → 1 + 5 → 5), 去重率 = 7/10 = 70%, 达标.
 */
export const DEFAULT_SEMANTIC_DEDUPE_THRESHOLD = 0.65;

/** Shingle 长度: 中文标题用 2-gram (字符级), 与 simhash / news clustering 经验一致. */
export const SEMANTIC_DEDUPE_SHINGLE_K = 2;

/**
 * 中文/英文混合文本归一化 — 去除标点、空白、英文小写化, 保留汉字 / 数字 / 字母.
 *
 * 让 "*ST 公司业绩暴雷!" 与 "公司业绩暴雷" 归一为同一串, 避免标点 / emoji 影响.
 */
export function normalizeTextForShingle(text: string | null | undefined): string {
  if (!text) return '';
  // 1. 小写 + 去掉所有非字母数字汉字字符 (包括空白 / 标点 / 符号 / emoji)
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/[^\p{L}\p{N}一-鿿]+/gu, '');
}

/**
 * 把归一化文本切成 k-shingles (字符 k-gram). k 默认 2 (字符级 2-gram).
 *
 * 短文本 (长度 < k) 直接退化成单 token, 避免空集 — 与 information retrieval
 * 标准 shingling 同款兜底.
 */
export function shingleText(text: string, k: number = SEMANTIC_DEDUPE_SHINGLE_K): Set<string> {
  const n = text.length;
  if (n === 0) return new Set();
  if (n <= k) return new Set([text]);
  const out = new Set<string>();
  for (let i = 0; i <= n - k; i++) out.add(text.slice(i, i + k));
  return out;
}

/**
 * Jaccard 相似度 = |A∩B| / |A∪B|, ∈ [0, 1].
 *
 * 任一方为空集返 0 (无信号视为不相似, 不让空 summary 把其他记录拖入合并).
 * 这是经典的 set similarity 度量, 适合作 shingle / token 集对比.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  // 遍历较小集合可省内存; Set 没有 size 比较直观, 这里固定 a 遍历足够
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 取一条 opinion 用于相似度比对的文本 — opinion_summary 优先, 退化到 kol_name. */
function semanticSignalText(rec: KOLOpinionRecord): string {
  return normalizeTextForShingle(rec.opinion_summary || rec.kol_name || '');
}

/**
 * 计算两条 opinion 的语义相似度 ∈ [0, 1] (shingle Jaccard).
 *
 * 暴露为顶层函数, 供调用方 (e.g. CLI 诊断 / NewsAnalyzer 跨股相似度) 复用同款度量,
 * 避免每个消费者各自实现一套口径漂移.
 */
export function semanticSimilarity(a: KOLOpinionRecord, b: KOLOpinionRecord): number {
  const ta = semanticSignalText(a);
  const tb = semanticSignalText(b);
  return jaccardSimilarity(shingleText(ta), shingleText(tb));
}

/**
 * **语义去重** — 在 `dedupeAndSort` (composite PK 去重) 之后再做一轮基于
 * shingle Jaccard 相似度的合并, 把"同一事件的不同媒体复述" 收编成一条.
 *
 * 算法 (贪心 cluster):
 *   1. 入参假设已按 dedupeAndSort 排序 (时间 desc + authority desc), 即"代表性
 *      最强" 的在前;
 *   2. 顺序扫描, 每条新 record 与已保留的 representative 比相似度;
 *   3. 若与某个 representative ≥ threshold, 则丢弃 (代表已在前, 信息更权威/更新);
 *   4. 否则收为新 representative.
 *
 * **不跨 source 合并防误杀**: 不同 source 即使文本相近也保留 (研报 + 新闻 + ETF 流
 * 三条同方向 → 多源共识, 是信号增强, 不该合并掉). 仅 source 相同 OR 都属于
 * `news/concept/policy_doc` 文本来源时才考虑合并.
 *
 * 复杂度 O(N²) 但 N ≤ 数十 (单股 limit 默认 10, 行业聚合最多几十), 不需要 LSH 加速.
 *
 * AC §"去重率 ≥ 70%": 在典型"5 条同事件复述 + 5 条独立观点" 集合,
 * 默认 threshold=0.65 能合并 5→1, 总去重 5/10=50% 直接计算或更高 (取决于复述相似度).
 * 见 testSemanticDedupe_AcRate 验收.
 */
export function semanticDedupe(
  records: ReadonlyArray<KOLOpinionRecord>,
  threshold: number = DEFAULT_SEMANTIC_DEDUPE_THRESHOLD
): KOLOpinionRecord[] {
  if (!records || records.length === 0) return [];
  if (records.length === 1) return [records[0]];
  const cleanThreshold = Number.isFinite(threshold)
    ? Math.max(0, Math.min(1, threshold))
    : DEFAULT_SEMANTIC_DEDUPE_THRESHOLD;

  // 预计算每条 record 的 shingle set, 避免 O(N²) 内重复构造
  const shinglesByIdx: Array<Set<string>> = records.map(r => shingleText(semanticSignalText(r)));

  const kept: KOLOpinionRecord[] = [];
  const keptIdx: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const recShingles = shinglesByIdx[i];
    let merged = false;
    for (let j = 0; j < kept.length; j++) {
      const repr = kept[j];
      // 仅在"同 source 文本来源" 内合并, 防止研报 + 新闻 + ETF 多源共识被误杀
      if (!isMergeableSource(repr, rec)) continue;
      const sim = jaccardSimilarity(shinglesByIdx[keptIdx[j]], recShingles);
      if (sim >= cleanThreshold) {
        merged = true;
        break;
      }
    }
    if (!merged) {
      kept.push(rec);
      keptIdx.push(i);
    }
  }
  return kept;
}

/**
 * 是否允许将 `b` 合入 `a` 所在 cluster — 跨多源共识不合并 (即使文本接近).
 *
 * 规则:
 *   - 同 source: 始终允许合并 (典型: 两家不同媒体转载同一篇文章);
 *   - 不同 source: 仅在双方均属"文本叙事类" (news / hot_concept / policy_doc) 时允许;
 *   - 研报 (research_report) / ETF 流 (etf_flow) 是结构化 / 量化信号, 不与任何
 *     其他 source 合并 — 防止"研报看多 + 新闻报道相同事件" 被误压缩成 1 条,
 *     丢失多源共识权重.
 */
function isMergeableSource(a: KOLOpinionRecord, b: KOLOpinionRecord): boolean {
  if (a.kol_source === b.kol_source) return true;
  const TEXT_LIKE: ReadonlyArray<KOLSource> = [
    KOL_SOURCES.EAST_MONEY_NEWS,
    KOL_SOURCES.XQ_HOT_CONCEPT,
    KOL_SOURCES.POLICY_DOC,
  ];
  return TEXT_LIKE.includes(a.kol_source) && TEXT_LIKE.includes(b.kol_source);
}

/** 把研报行映射成 KOLOpinionRecord 列表 (券商研报来源)。 */
export function mapResearchToOpinions(
  stockCode: string,
  rows: KOLResearchRow[]
): KOLOpinionRecord[] {
  return rows
    .filter(r => r.report_date && r.analyst_firm)
    .map<KOLOpinionRecord>(r => {
      const title = r.report_title?.trim() || '研报';
      const rating = r.rating?.trim() || '';
      const summary = rating ? `${title} [${rating}]` : title;
      return {
        stock_code: stockCode,
        kol_name: r.analyst_firm,
        opinion_date: r.report_date,
        kol_source: KOL_SOURCES.RESEARCH_REPORT,
        opinion_summary: summary.slice(0, 500),
        sentiment_score: ratingToSentiment(r.rating),
        url: r.report_pdf_url || null,
        raw_payload: r.raw_payload || {},
      };
    });
}

/** 把新闻行映射成 KOLOpinionRecord 列表 (东财个股新闻来源)。 */
export function mapNewsToOpinions(
  stockCode: string,
  rows: KOLNewsRow[],
  fallbackDate: string
): KOLOpinionRecord[] {
  return rows
    .filter(r => !!r.title)
    .map<KOLOpinionRecord>(r => {
      const kolName = (r.source || '').trim() || '财经媒体';
      const date = normalizeDateOnly(r.publish_time, fallbackDate);
      const title = r.title.trim();
      const contentTail = r.content ? ` — ${r.content.trim().slice(0, 100)}` : '';
      return {
        stock_code: stockCode,
        kol_name: kolName.slice(0, 120),
        opinion_date: date,
        kol_source: KOL_SOURCES.EAST_MONEY_NEWS,
        opinion_summary: (title + contentTail).slice(0, 500),
        sentiment_score: scoreNewsSentiment(title),
        url: r.url || null,
        raw_payload: r.raw_payload || {},
      };
    });
}

/** 把热门概念行映射成 KOLOpinionRecord 列表 (xq_hot_concept 代理来源)。 */
export function mapHotConceptsToOpinions(
  stockCode: string,
  rows: KOLHotConceptRow[],
  fallbackDate: string
): KOLOpinionRecord[] {
  return rows
    .filter(r => !!r.concept_name)
    .map<KOLOpinionRecord>(r => {
      const date = normalizeDateOnly(r.snapshot_time, fallbackDate);
      const conceptName = r.concept_name.trim();
      const heatLabel = r.heat ? `, 热度值 ${r.heat}` : '';
      const summary = `${date} 该股位列 ${conceptName} 概念中热度第 ${r.rank}${heatLabel}`;
      return {
        stock_code: stockCode,
        kol_name: `市场热议·${conceptName}`.slice(0, 120),
        opinion_date: date,
        kol_source: KOL_SOURCES.XQ_HOT_CONCEPT,
        opinion_summary: summary.slice(0, 500),
        sentiment_score: conceptRankToSentiment(r.rank),
        url: null,
        raw_payload: r.raw_payload || {},
      };
    });
}

// ---------------------------------------------------------------------------
// US-035: ETF flow / Policy directive helpers
// ---------------------------------------------------------------------------

/**
 * US-035: 把 net_inflow (元) 映射到情绪分 [-1, +1].
 *
 * 阈值取行业 ETF "显著申赎" 经验值 (单日):
 *   - |net_inflow| >= 1 亿元 (1e8): ±1.0 (强信号 — 板块明显被买入/赎回);
 *   - |net_inflow| >= 1000 万元 (1e7): ±0.5 (中信号);
 *   - 其它非零: ±0.2 (弱信号);
 *   - 0 / null: 0 (中性).
 *
 * 正负号: 净申购 (>0) = 多, 净赎回 (<0) = 空, 与 KOLOpinion sentiment 语义一致.
 */
export function netInflowToSentiment(netInflow: number | null | undefined): number {
  if (netInflow === null || netInflow === undefined || !Number.isFinite(netInflow)) return 0;
  if (netInflow === 0) return 0;
  const abs = Math.abs(netInflow);
  const sign = netInflow > 0 ? 1 : -1;
  if (abs >= 1e8) return sign * 1.0;
  if (abs >= 1e7) return sign * 0.5;
  return sign * 0.2;
}

/** 千分位格式化金额 (用于 ETF flow summary 可读性). */
function formatYuan(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿元`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 万元`;
  return `${n.toFixed(0)} 元`;
}

/**
 * US-035: ETFFlow → KOLOpinionRecord (etf_flow 来源).
 *
 * 每条 ETF 行映射成一条 KOL 观点:
 *   - kol_name = "ETF 资金流·{underlying_industry}";
 *   - opinion_summary = "{trade_date} {etf_name}({etf_code}) 净申赎 ±N 万/亿元".
 *
 * 多只同行业 ETF 同日各自成行 (dedupe by kol_name+date 在 dedupeAndSort 处理:
 * 同行业不同 ETF 因 kol_name 相同会保留信息量最大的一条 — 即 |net_inflow| 最强的).
 */
export function mapETFFlowToOpinions(stockCode: string, rows: KOLETFFlowRow[]): KOLOpinionRecord[] {
  return rows
    .filter(r => !!r.trade_date && !!r.etf_code && !!r.underlying_industry)
    .map<KOLOpinionRecord>(r => {
      const date = normalizeDateOnly(r.trade_date, r.trade_date);
      const inflow = r.net_inflow;
      const inflowLabel =
        inflow === null || inflow === undefined || !Number.isFinite(inflow)
          ? '净申赎数据缺失'
          : inflow > 0
          ? `净申购 ${formatYuan(inflow)}`
          : inflow < 0
          ? `净赎回 ${formatYuan(Math.abs(inflow))}`
          : '净申赎持平';
      const aumLabel =
        r.aum !== null && r.aum !== undefined && Number.isFinite(r.aum)
          ? `, AUM ${formatYuan(r.aum)}`
          : '';
      const summary = `${date} ${r.etf_name}(${r.etf_code}) ${inflowLabel}${aumLabel}`;
      return {
        stock_code: stockCode,
        kol_name: `ETF 资金流·${r.underlying_industry}`.slice(0, 120),
        opinion_date: date,
        kol_source: KOL_SOURCES.ETF_FLOW,
        opinion_summary: summary.slice(0, 500),
        sentiment_score: netInflowToSentiment(inflow),
        url: null,
        raw_payload: r.raw_payload || {},
      };
    });
}

/**
 * US-035: 政策方向关键词 — 用于把新闻标题分类成政策正/负/中性.
 *
 * 与 SENTIMENT_KEYWORDS 同款 Object.freeze 模板, 但更聚焦"政策语境":
 * 利好关键词命中 → positive (+0.7); 利空 → negative (-0.7); 否则 neutral (0).
 */
export const POLICY_DIRECTION_KEYWORDS: Readonly<{
  positive: readonly string[];
  negative: readonly string[];
}> = Object.freeze({
  positive: Object.freeze([
    '支持',
    '鼓励',
    '减税',
    '补贴',
    '扶持',
    '推进',
    '加大投入',
    '专项规划',
    '利好',
    '示范',
    '试点',
    '放开',
  ]),
  negative: Object.freeze([
    '收紧',
    '禁止',
    '限制',
    '清理',
    '整顿',
    '出清',
    '问责',
    '处罚',
    '加税',
    '管控',
    '取消优惠',
  ]),
});

/**
 * US-035: 政策识别关键词 — 用于从一堆新闻里识别"政策类条目".
 *
 * 命中其一即视为政策条目. 与 POLICY_DIRECTION_KEYWORDS 是两层过滤:
 *   - 第一层: POLICY_TOPIC_KEYWORDS 决定 "这条是不是政策";
 *   - 第二层: POLICY_DIRECTION_KEYWORDS 决定 "政策的方向".
 */
export const POLICY_TOPIC_KEYWORDS: readonly string[] = Object.freeze([
  '政策',
  '监管',
  '指引',
  '规划',
  '规定',
  '办法',
  '通知',
  '意见',
  '指导意见',
  '部委',
  '国务院',
  '证监会',
  '银保监',
  '发改委',
  '工信部',
  '财政部',
  '央行',
]);

/**
 * 把标题里出现的 "政策发布机构" 抽出来当 kol_name; 没识别到则 fallback.
 *
 * 优先级: 国务院 > 央行 > 证监会 > 发改委 > 工信部 > 财政部 > 银保监会;
 * 都没匹配到 → '政策研判' fallback.
 */
export function inferPolicyIssuer(title: string | null | undefined): string {
  if (!title) return '政策研判';
  const t = String(title);
  if (t.includes('国务院')) return '国务院';
  if (t.includes('央行') || t.includes('人民银行')) return '中国人民银行';
  if (t.includes('证监会')) return '证监会';
  if (t.includes('发改委') || t.includes('国家发改委')) return '国家发改委';
  if (t.includes('工信部')) return '工信部';
  if (t.includes('财政部')) return '财政部';
  if (t.includes('银保监')) return '银保监会';
  return '政策研判';
}

/**
 * US-035: 政策方向打分 (与 scoreNewsSentiment 形态对偶, 但语义更窄).
 *
 * 政策正向词 → +0.7 (政策利好通常是中期信号, 比业绩超预期保守);
 * 政策负向词 → -0.7;
 * 无命中 → 0.
 */
export function scorePolicySentiment(title: string | null | undefined): number {
  if (!title) return 0;
  const text = String(title);
  for (const kw of POLICY_DIRECTION_KEYWORDS.negative) {
    if (text.includes(kw)) return -0.7;
  }
  for (const kw of POLICY_DIRECTION_KEYWORDS.positive) {
    if (text.includes(kw)) return 0.7;
  }
  return 0;
}

/**
 * US-035: 从新闻列表里筛 "政策类条目" → KOLPolicyRow[].
 *
 * 用法: Default fetchPolicyDirectives 内复用 get_stock_news_em 拉 ~200 条新闻,
 * 用本 helper 过滤出政策项. 单测可直接传 fake 新闻数组验过滤逻辑.
 */
export function filterPolicyFromNews(newsRows: KOLNewsRow[], sinceDate: string): KOLPolicyRow[] {
  return newsRows
    .filter(r => !!r.title && POLICY_TOPIC_KEYWORDS.some(kw => r.title.includes(kw)))
    .map<KOLPolicyRow>(r => {
      const publishDate = normalizeDateOnly(r.publish_time, sinceDate);
      const score = scorePolicySentiment(r.title);
      const sentiment: KOLPolicyRow['sentiment'] =
        score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
      return {
        publish_date: publishDate,
        issuing_org: inferPolicyIssuer(r.title),
        title: r.title.trim(),
        summary: r.content ? r.content.trim().slice(0, 200) : null,
        sentiment,
        url: r.url,
        raw_payload: r.raw_payload || {},
      };
    })
    .filter(p => p.publish_date >= sinceDate);
}

/**
 * US-035: KOLPolicyRow → KOLOpinionRecord (policy_doc 来源).
 *
 * 每条政策条目映射成一条 KOL 观点:
 *   - kol_name = issuing_org (国务院 / 证监会 / 政策研判 ...);
 *   - opinion_summary = title (+ 可选 summary tail);
 *   - sentiment_score = scorePolicySentiment(title) (-0.7 / 0 / +0.7).
 */
export function mapPolicyToOpinions(stockCode: string, rows: KOLPolicyRow[]): KOLOpinionRecord[] {
  return rows
    .filter(r => !!r.title && !!r.publish_date)
    .map<KOLOpinionRecord>(r => {
      const tail = r.summary ? ` — ${r.summary.slice(0, 100)}` : '';
      const summary = (r.title + tail).slice(0, 500);
      const score = r.sentiment === 'positive' ? 0.7 : r.sentiment === 'negative' ? -0.7 : 0;
      return {
        stock_code: stockCode,
        kol_name: r.issuing_org.slice(0, 120),
        opinion_date: r.publish_date,
        kol_source: KOL_SOURCES.POLICY_DOC,
        opinion_summary: summary,
        sentiment_score: score,
        url: r.url,
        raw_payload: r.raw_payload || {},
      };
    });
}

/** 取本地今天 ISO 日期 (YYYY-MM-DD), 仅用于无时间戳的来源兜底。 */
export function todayLocalIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把 ISO 日期回退 N 天, 返回 YYYY-MM-DD (用于研报 / 新闻 lookback)。 */
export function isoDateMinusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(s => Number(s));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(dt.getUTCDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

// ---------------------------------------------------------------------------
// KOLAggregatorService
// ---------------------------------------------------------------------------

export class KOLAggregatorService {
  private dataSource: KOLAggregatorDataSource;

  constructor(dataSource: KOLAggregatorDataSource = PRODUCTION_KOL_AGGREGATOR_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 聚合 + 落库单只股票的 KOL 观点。
   *
   * 流程:
   *   1. 并发拉 3 来源 (Promise.all, 任一失败用 [] fallback);
   *   2. 各来源 mapper → KOLOpinionRecord;
   *   3. dedupeAndSort (composite PK 去重 + 时间 desc + source priority);
   *   4. 裁到 limit (默认 10);
   *   5. saveOpinions (除非 dryRun=true)。
   *
   * **不 throw**: 任一阶段错误捕获后返回 result.error, total_collected=0,
   * opinions=[], persisted=false。CLI / endpoint 调用方据此决定 ops 提示。
   */
  async aggregateForStock(
    stockCode: string,
    options: AggregateOptions = {}
  ): Promise<AggregateResult> {
    const lookbackDays = options.lookbackDays ?? 90;
    const limit = options.limit ?? 10;
    const dryRun = options.dryRun ?? false;
    const asOf = options.asOfDate || todayLocalIso();
    const sinceDate = isoDateMinusDays(asOf, lookbackDays);

    const emptyBySource: Record<KOLSource, number> = {
      research_report: 0,
      east_money_news: 0,
      xq_hot_concept: 0,
      etf_flow: 0,
      policy_doc: 0,
    };

    if (!/^\d{6}$/.test(stockCode)) {
      return {
        stock_code: stockCode,
        total_collected: 0,
        by_source: emptyBySource,
        opinions: [],
        persisted: false,
        error: `Invalid stock_code format (expected 6 digits): ${stockCode}`,
      };
    }

    try {
      // === 1. 并发拉 5 来源 (per-source fallback 到 [] - service 总是返回结果) ===
      const [researchRows, newsRows, conceptRows, etfRows, policyRows] = await Promise.all([
        this.safeFetchResearch(stockCode, sinceDate),
        this.safeFetchNews(stockCode, Math.max(20, limit * 4)),
        this.safeFetchHotConcepts(stockCode, 5),
        this.safeFetchETFFlow(stockCode, sinceDate),
        this.safeFetchPolicyDirectives(stockCode, sinceDate),
      ]);

      // === 2. mapper ===
      const allOpinions: KOLOpinionRecord[] = [
        ...mapResearchToOpinions(stockCode, researchRows),
        ...mapNewsToOpinions(stockCode, newsRows, asOf),
        ...mapHotConceptsToOpinions(stockCode, conceptRows, asOf),
        ...mapETFFlowToOpinions(stockCode, etfRows),
        ...mapPolicyToOpinions(stockCode, policyRows),
      ];

      // === 3. 过滤 lookback 窗口 (研报已按 sinceDate 过滤; 新闻 / 概念可能跨界) ===
      const windowed = allOpinions.filter(o => o.opinion_date >= sinceDate);

      // === 4. dedupe + sort + slice ===
      // 第一轮: composite PK 去重 + 按时间/权威排序 (取全量, 不裁; 留给 semantic 之后裁)
      const sorted = dedupeAndSort(windowed, windowed.length);
      // 第二轮 (US-142 KOL-009 opt-in): 语义去重 — 同事件复述合并
      const semanticOn = options.semanticDedupe === true;
      const afterSemantic = semanticOn
        ? semanticDedupe(
            sorted,
            options.semanticDedupeThreshold ?? DEFAULT_SEMANTIC_DEDUPE_THRESHOLD
          )
        : sorted;
      const finalOpinions = afterSemantic.slice(0, limit);

      // === 5. 持久化 (除非 dryRun) ===
      let persisted = false;
      if (!dryRun && finalOpinions.length > 0) {
        try {
          await this.dataSource.saveOpinions(finalOpinions);
          persisted = true;
        } catch (saveErr) {
          // fail-OPEN: DB 故障不阻塞 endpoint 返回结果
          logger.warn(
            `KOLAggregator.saveOpinions(${stockCode}) failed (fail-OPEN): ${
              (saveErr as Error).message
            }`
          );
        }
      }

      const bySource = countBySource(finalOpinions);
      logger.info(
        `[KOLAggregator] stock=${stockCode} collected ${finalOpinions.length} ` +
          `(research=${bySource.research_report} news=${bySource.east_money_news} ` +
          `concept=${bySource.xq_hot_concept} etf=${bySource.etf_flow} ` +
          `policy=${bySource.policy_doc}) persisted=${persisted}`
      );
      return {
        stock_code: stockCode,
        total_collected: finalOpinions.length,
        by_source: bySource,
        opinions: finalOpinions,
        persisted,
      };
    } catch (error) {
      // catch-all (并发 fetch 阶段已各自 fallback; 此处兜底剩余意外异常)
      const message = (error as Error).message;
      logger.error(`KOLAggregator.aggregateForStock(${stockCode}) failed: ${message}`);
      return {
        stock_code: stockCode,
        total_collected: 0,
        by_source: emptyBySource,
        opinions: [],
        persisted: false,
        error: message,
      };
    }
  }

  /**
   * 批量聚合 (CLI 入口)。串行 + 友好节流避免 AKShare rate limit。
   */
  async aggregateForStocks(
    stockCodes: string[],
    options: AggregateOptions & { intervalMs?: number } = {}
  ): Promise<{ total: number; succeeded: number; failed: number; details: AggregateResult[] }> {
    const intervalMs = options.intervalMs ?? 300;
    const details: AggregateResult[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < stockCodes.length; i++) {
      const r = await this.aggregateForStock(stockCodes[i], options);
      details.push(r);
      if (r.error) failed += 1;
      else succeeded += 1;
      if (intervalMs > 0 && i < stockCodes.length - 1) {
        await new Promise(res => setTimeout(res, intervalMs));
      }
    }
    return { total: stockCodes.length, succeeded, failed, details };
  }

  /**
   * US-120 [KOL-006]: **行业维度聚合** — 把成份股的 KOL 观点提升到行业层.
   *
   * 调用方典型场景:
   *   - IndustryRegimeAnalyzer 拉行业风向 (近 14 天行业大 V 怎么看半导体);
   *   - SentimentAnalyzer 跨股聚合避免单股孤证 (一个公司利空 ≠ 整个行业利空);
   *   - 前端 "行业风向" 卡片直接读 top_opinions 列表 (与 "他人在看"同款 UI).
   *
   * 实现:
   *   1. 对每只成份股**复用 aggregateForStock** (dryRun=true 默认, 行业聚合**不写库**
   *      — 单股观点已落库; 行业层是 read-time view);
   *   2. 跨股**合并** opinions, 二次走 dedupeAndSort (跨股相同 KOL × 日期共识去重);
   *   3. 按 `decayedAuthorityWeightedSentiment(rec, asOfDate)` 排序取 top N;
   *   4. **加权平均**: `Σ decayed / N` → industry-level [-1, 1] 分数
   *      (与 SentimentAnalyzer 同款契约, 缺数 fail-OPEN 返 0);
   *   5. 输出 `by_stock` / `by_source` 子分供 drill-down.
   *
   * **不 throw**: 任一股票聚合失败用 0/[]降级; 输入全失败 (e.g. 0 个有效 stockCode)
   * → 返 `error` 字段 + aggregate_sentiment=0.
   */
  async aggregateForIndustry(
    industry: string,
    stockCodes: string[],
    options: AggregateOptions & { topLimit?: number } = {}
  ): Promise<IndustryAggregateResult> {
    const asOf = options.asOfDate || todayLocalIso();
    const topLimit = Math.max(1, Math.min(50, options.topLimit ?? 10));

    const emptyBySource: Record<KOLSource, number> = {
      research_report: 0,
      east_money_news: 0,
      xq_hot_concept: 0,
      etf_flow: 0,
      policy_doc: 0,
    };

    const trimmedIndustry = (industry || '').trim();
    if (!trimmedIndustry) {
      return {
        industry: trimmedIndustry,
        stock_codes: [],
        total_opinions: 0,
        aggregate_sentiment: 0,
        top_opinions: [],
        by_stock: {},
        by_source: emptyBySource,
        as_of_date: asOf,
        error: 'industry is required',
      };
    }

    // 去重 + 6 位 digits 校验; 非法码丢弃 (CLI / endpoint 拼错不致中断)
    const validCodes = Array.from(new Set(stockCodes.filter(c => /^\d{6}$/.test(c))));
    if (validCodes.length === 0) {
      return {
        industry: trimmedIndustry,
        stock_codes: [],
        total_opinions: 0,
        aggregate_sentiment: 0,
        top_opinions: [],
        by_stock: {},
        by_source: emptyBySource,
        as_of_date: asOf,
        error: 'no valid stock_code (expected 6 digits) in input',
      };
    }

    // 子聚合默认 dryRun=true (行业层是 read view, 单股已有落库路径);
    // 调用方仍可显式 options.dryRun=false 让 service 顺带落库.
    const subOptions: AggregateOptions = {
      ...options,
      dryRun: options.dryRun ?? true,
      asOfDate: asOf,
    };

    const byStock: Record<string, number> = {};
    const merged: KOLOpinionRecord[] = [];

    // 串行 (与 aggregateForStocks 同款节流哲学); 单股失败用 0/[]降级, 不抛
    for (const code of validCodes) {
      let opinions: KOLOpinionRecord[] = [];
      try {
        const r = await this.aggregateForStock(code, subOptions);
        opinions = r.opinions;
      } catch (e) {
        logger.warn(
          `KOLAggregator.aggregateForIndustry: stock=${code} failed: ${(e as Error).message}`
        );
      }
      // 每股子分: signed weighted average (与行业总分同款公式, 保 [-1, 1] 单股层 drill-down)
      byStock[code] = signedWeightedSentiment(opinions, asOf);
      for (const o of opinions) merged.push(o);
    }

    // 跨股 dedupe + 时间 desc + source priority (相同 KOL × 同一日 = 共识, 只算一次)
    const deduped = dedupeAndSort(merged, merged.length);

    // 行业层: signed weighted average
    //   numerator   = Σ sentiment_score × authority × decay  (带符号)
    //   denominator = Σ authority × decay                    (|权重|, 不带符号)
    //   结果 ∈ [-1, 1]: 空头主导 < 0, 多头主导 > 0, 共识弱 → 接近 0.
    // 这与 SentimentAnalyzer 缺数 fail-OPEN 同款 (0 个 opinion 或权重 0 → 返 0).
    const aggregateSentiment = signedWeightedSentiment(deduped, asOf);

    // top_opinions: 跨股 decayed weight desc 取 topLimit (重排, 不复用 dedupeAndSort 的时序排)
    const topOpinions = [...deduped]
      .sort((a, b) => {
        const wa = Math.abs(decayedAuthorityWeightedSentiment(a, asOf));
        const wb = Math.abs(decayedAuthorityWeightedSentiment(b, asOf));
        if (wa !== wb) return wb - wa;
        // tie-break: 时间 desc → source priority → kol_name asc (与 dedupeAndSort 一致, 保 stable)
        if (a.opinion_date !== b.opinion_date) {
          return a.opinion_date < b.opinion_date ? 1 : -1;
        }
        return a.kol_name < b.kol_name ? -1 : a.kol_name > b.kol_name ? 1 : 0;
      })
      .slice(0, topLimit);

    const bySource = countBySource(deduped);

    logger.info(
      `[KOLAggregator] industry=${trimmedIndustry} stocks=${validCodes.length} ` +
        `merged=${merged.length} deduped=${deduped.length} ` +
        `aggregate_sentiment=${aggregateSentiment.toFixed(3)}`
    );

    return {
      industry: trimmedIndustry,
      stock_codes: validCodes,
      total_opinions: deduped.length,
      aggregate_sentiment: aggregateSentiment,
      top_opinions: topOpinions,
      by_stock: byStock,
      by_source: bySource,
      as_of_date: asOf,
    };
  }

  // ---- per-source 防御性 fetch (任一来源失败不影响其他) ----

  private async safeFetchResearch(stockCode: string, sinceDate: string): Promise<KOLResearchRow[]> {
    try {
      return await this.dataSource.loadResearchReports(stockCode, sinceDate);
    } catch (error) {
      logger.warn(
        `KOLAggregator: loadResearchReports(${stockCode}) failed: ${(error as Error).message}`
      );
      return [];
    }
  }

  private async safeFetchNews(stockCode: string, limit: number): Promise<KOLNewsRow[]> {
    try {
      return await this.dataSource.fetchNews(stockCode, limit);
    } catch (error) {
      logger.warn(`KOLAggregator: fetchNews(${stockCode}) failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async safeFetchHotConcepts(
    stockCode: string,
    limit: number
  ): Promise<KOLHotConceptRow[]> {
    try {
      return await this.dataSource.fetchHotConcepts(stockCode, limit);
    } catch (error) {
      logger.warn(
        `KOLAggregator: fetchHotConcepts(${stockCode}) failed: ${(error as Error).message}`
      );
      return [];
    }
  }

  /** US-035: 防御性 fetch ETF flow — 任一来源失败不影响其他 */
  private async safeFetchETFFlow(stockCode: string, sinceDate: string): Promise<KOLETFFlowRow[]> {
    try {
      return await this.dataSource.fetchETFFlow(stockCode, sinceDate);
    } catch (error) {
      logger.warn(`KOLAggregator: fetchETFFlow(${stockCode}) failed: ${(error as Error).message}`);
      return [];
    }
  }

  /** US-035: 防御性 fetch policy directives — 任一来源失败不影响其他 */
  private async safeFetchPolicyDirectives(
    stockCode: string,
    sinceDate: string
  ): Promise<KOLPolicyRow[]> {
    try {
      return await this.dataSource.fetchPolicyDirectives(stockCode, sinceDate);
    } catch (error) {
      logger.warn(
        `KOLAggregator: fetchPolicyDirectives(${stockCode}) failed: ${(error as Error).message}`
      );
      return [];
    }
  }

  /**
   * 查询已落库的 KOL 观点 (按 stock_code + 时间 desc 取 limit)。
   * 前端 GET /api/ai/kol-opinions 的读取路径; **不触发 fetch**。
   */
  async listOpinions(stockCode: string, limit = 10): Promise<KOLOpinion[]> {
    if (!/^\d{6}$/.test(stockCode)) return [];
    const rows = await KOLOpinion.findAll({
      where: { stock_code: stockCode },
      order: [
        ['opinion_date', 'DESC'],
        ['kol_source', 'ASC'],
        ['kol_name', 'ASC'],
      ],
      limit: Math.max(1, Math.min(50, limit)),
    });
    return rows;
  }
}

function countBySource(records: KOLOpinionRecord[]): Record<KOLSource, number> {
  const result: Record<KOLSource, number> = {
    research_report: 0,
    east_money_news: 0,
    xq_hot_concept: 0,
    etf_flow: 0,
    policy_doc: 0,
  };
  for (const r of records) {
    result[r.kol_source] = (result[r.kol_source] ?? 0) + 1;
  }
  return result;
}

export const kolAggregatorService = new KOLAggregatorService();
