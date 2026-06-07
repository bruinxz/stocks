import { spawn } from 'child_process';
import path from 'path';
import { Op } from 'sequelize';
import { AnalystForecast } from '../models/AnalystForecast';
import { KOLOpinion } from '../models/KOLOpinion';
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

export interface AggregateOptions {
  /** 取近 N 天 (默认 90)。研报 / 新闻 / 概念 均按此窗口过滤。 */
  lookbackDays?: number;
  /** 最多返回 / 落库行数 (默认 10，AC: 5-10)。 */
  limit?: number;
  /** 跳过 saveOpinions 写库 (dry-run 模式)，默认 false。 */
  dryRun?: boolean;
  /** as-of date (YYYY-MM-DD); 默认今天本地。用于测试可控时间。 */
  asOfDate?: string;
}

export interface AggregateResult {
  stock_code: string;
  total_collected: number;
  by_source: Record<KOLSource, number>;
  opinions: KOLOpinionRecord[];
  persisted: boolean;
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

export interface KOLAggregatorDataSource {
  fetchNews(stockCode: string, limit: number): Promise<KOLNewsRow[]>;
  fetchHotConcepts(stockCode: string, limit: number): Promise<KOLHotConceptRow[]>;
  loadResearchReports(stockCode: string, sinceDate: string): Promise<KOLResearchRow[]>;
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
    this.pythonPath = opts.pythonPath || process.env.PYTHON_PATH || 'python3';
    this.timeoutMs = opts.timeoutMs || Number(process.env.KOL_AGGREGATOR_TIMEOUT_MS || 60_000);
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
 * 把候选 opinions 排序 (opinion_date desc, kol_source 优先级) 并裁到 limit。
 *
 * **去重规则** (composite key = stock_code|kol_name|opinion_date):
 *   - 同 KOL 同日多条 → "信息量更大" 的优先:
 *     1. sentiment_score 非 null 优先 (有明确观点 > 无观点的兜底);
 *     2. opinion_summary 长度更长的优先;
 *     3. 后出现的覆盖前出现的 (与 bulkCreate updateOnDuplicate 行为一致).
 *
 * **排序优先级**:
 *   1. opinion_date desc (最新优先);
 *   2. kol_source priority: research_report > east_money_news > xq_hot_concept
 *      (券商研报 > 媒体新闻 > 概念代理 — AC 期望"5-10 条最新", 优质内容靠前);
 *   3. kol_name 字典序 (稳定 tie-break, 同 quant strategies stable sort 范式).
 */
const SOURCE_PRIORITY: Record<KOLSource, number> = {
  research_report: 0,
  east_money_news: 1,
  xq_hot_concept: 2,
};

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
    // 2. source priority
    const ap = SOURCE_PRIORITY[a.kol_source] ?? 99;
    const bp = SOURCE_PRIORITY[b.kol_source] ?? 99;
    if (ap !== bp) return ap - bp;
    // 3. kol_name 稳定 tie-break
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
      // === 1. 并发拉 3 来源 (per-source fallback 到 [] - service 总是返回结果) ===
      const [researchRows, newsRows, conceptRows] = await Promise.all([
        this.safeFetchResearch(stockCode, sinceDate),
        this.safeFetchNews(stockCode, Math.max(20, limit * 4)),
        this.safeFetchHotConcepts(stockCode, 5),
      ]);

      // === 2. mapper ===
      const allOpinions: KOLOpinionRecord[] = [
        ...mapResearchToOpinions(stockCode, researchRows),
        ...mapNewsToOpinions(stockCode, newsRows, asOf),
        ...mapHotConceptsToOpinions(stockCode, conceptRows, asOf),
      ];

      // === 3. 过滤 lookback 窗口 (研报已按 sinceDate 过滤; 新闻 / 概念可能跨界) ===
      const windowed = allOpinions.filter(o => o.opinion_date >= sinceDate);

      // === 4. dedupe + sort + slice ===
      const finalOpinions = dedupeAndSort(windowed, limit);

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
          `concept=${bySource.xq_hot_concept}) persisted=${persisted}`
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
  };
  for (const r of records) {
    result[r.kol_source] = (result[r.kol_source] ?? 0) + 1;
  }
  return result;
}

export const kolAggregatorService = new KOLAggregatorService();
