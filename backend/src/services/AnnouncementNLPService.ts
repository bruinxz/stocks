import axios from 'axios';
import { Op } from 'sequelize';
import { AnnouncementSummary } from '../models/AnnouncementSummary';
import {
  AnnouncementClient,
  AnnouncementReportRow,
  AnnouncementSymbol,
  announcementClient,
} from '../data/sources/AnnouncementClient';
import { logger } from '../utils/logger';
import { TRADING_AGENTS_BASE_URL } from '../config/externalServices';

// audit L-19: 集中常量, 不再硬编码 IP.
const TRADING_AGENTS_URL = TRADING_AGENTS_BASE_URL;

/**
 * AnnouncementNLPService — US-059 AI 公告 NLP 关键信息提取.
 *
 * 把 AKShare 当日全市场公告列表 (~1000-3000 行) 用 AI (TradingAgents 或 OpenAI 兼容
 * API) 抽取摘要 + 情绪 + 涉及金额 / 业务主题, 落库到 `announcement_summaries` 表.
 *
 * **核心契约**:
 *   - `summarize(title, options)` → 单条公告的 NLP 结果 (pure, 无 DB);
 *   - `syncDate(date, options)` → 拉当日全部 + 逐条 NLP + bulkCreate upsert;
 *   - `listByStock(stock_code, days)` → 读端 (前端 GET endpoint 直接调).
 *
 * **6 项 checklist** (US-055 AI feature 范式同款):
 *   1. **DataSource DI** — `AnnouncementNLPDataSource` 接口暴露 4 个方法
 *      (fetchAnnouncements / summarizeOne / saveSummaries / loadByStock);
 *      `Default<X>DataSource` 走 Python helper + TradingAgents + Sequelize;
 *      生产 `PRODUCTION_ANNOUNCEMENT_NLP_DATA_SOURCE` singleton; 单测注入 fake.
 *   2. **pure helpers 全 export** — heuristicSummarize / heuristicSentiment /
 *      extractAmounts / extractTopics / normalizeSentiment / buildNLPResult.
 *   3. **plain-object 返回类型** `AnnouncementNLPRecord` 兼容 persist=true/false.
 *   4. **status='partial' / 'failed' 仍 persist** —— AI 调用失败仍落 original_title
 *      让 UI 看到, 用户可手动查看 PDF.
 *   5. **fail-OPEN on saveSummaries** — DB 故障不抛, warn + persisted=false.
 *   6. **双重防御 try/catch** —— DataSource 层 catch + service 层再 catch.
 *
 * **AI vs 启发式 fallback 分工**:
 *   - 默认走启发式 (`extract_with_ai=false`): 用关键词字典 + 正则即可, 不走远端 AI,
 *     避免几千条公告每条都 30s+ 调用拖时. 启发式覆盖率约 70%, 时延 < 1ms / 条.
 *   - 显式 `extract_with_ai=true` 时调远端 TradingAgents (适合用户主动触发单条
 *     "详细解读"); 远端 throw 时 fallback 到启发式 + status='partial'.
 *
 * **金额抽取启发式** (extractAmounts):
 *   - 正则 `/(\d+(?:\.\d+)?)\s*(亿元|万元|元|股|万股)/g` 扫标题;
 *   - 单位归一化保留原文 (UI 显示 "1.2 亿元" 而非 "120000000 元");
 *   - 同一标题最多取 3 个金额 (公告标题不会塞 10 个数字, 防误匹配电话号).
 *
 * **主题抽取启发式** (extractTopics):
 *   - 字典扫描 25+ 行业 / 业务主题关键词 (新能源 / 光伏 / 海外订单 / 重大合同 ...);
 *   - 同一标题去重后最多 5 个 topic; 命中数 = 0 时返回 [];
 *   - 字典在 `TOPIC_KEYWORDS` 内供测试可见, 未来扩展只改字典.
 *
 * **情绪判定启发式** (heuristicSentiment):
 *   - 复用 KOLAggregatorService.SENTIMENT_KEYWORDS 字典 (4 强度 × 12+ 词);
 *   - 优先级: 强空 > 强多 > 弱空 > 弱多 > 中性;
 *   - 与公告语境匹配的常见关键词 (减持 / 立案 / 业绩超预期 / 中标) 已覆盖.
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 情绪枚举 (与 AC 字段 `sentiment` 取值一致, model 列 STRING 10) */
export const SENTIMENT_VALUES = Object.freeze(['正面', '中性', '负面'] as const);
export type SentimentValue = (typeof SENTIMENT_VALUES)[number];

/** NLP 引擎标签 (写入 model.nlp_engine 列) */
export const NLP_ENGINES = Object.freeze({
  TRADING_AGENTS: 'trading_agents' as const,
  HEURISTIC: 'heuristic_fallback' as const,
  OPENAI: 'openai' as const,
});

/**
 * US-025 ANN-001: priority 枚举 (与 AnnouncementSummary.priority 列一致).
 * computePriority (US-029 ANN-005) 输出落到这 4 档:
 *   - critical → ANN-007 (US-031) 5min 飞书 push 强制入队;
 *   - high     → 前端 "今日重要" 优先展示;
 *   - medium   → 普通流;
 *   - low      → 默认 (含历史回填行).
 * 顺序 fix 让 sortPriorityDesc / 比较函数有稳定基准.
 */
export const ANNOUNCEMENT_PRIORITY_VALUES = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
] as const);
export type AnnouncementPriority = (typeof ANNOUNCEMENT_PRIORITY_VALUES)[number];

/**
 * US-025 ANN-001: event_type 枚举 (与 AnnouncementSummary.event_type 列一致).
 * classifyEventType (US-026 ANN-002) 输出落到这 7 档 (再加 NULL=未分类);
 * '其它' 表示 "已尝试分类但不属于前 6 类", 与 NULL ("没跑过 ANN-002") 语义不同.
 */
export const ANNOUNCEMENT_EVENT_TYPES = Object.freeze([
  '业绩',
  '重组',
  '减持',
  '担保',
  '处罚',
  '解禁',
  '其它',
] as const);
export type AnnouncementEventType = (typeof ANNOUNCEMENT_EVENT_TYPES)[number];

/**
 * US-025 ANN-001: entity 实体 shape (extractEntities US-027 输出元素).
 * name / role 必填; holding_pct 仅 role='股东'/'高管' 时填; 其它字段自由扩展.
 */
export interface AnnouncementEntity {
  name: string;
  role: string;
  holding_pct?: number;
  [k: string]: unknown;
}

/**
 * 情绪关键词字典 (与 KOLAggregatorService 同款 4 强度划分; 单文件保留方便公告语境调优).
 * 优先级: 强空 > 强多 > 弱空 > 弱多 > 中性.
 */
export const ANN_SENTIMENT_KEYWORDS: Readonly<{
  strongPos: readonly string[];
  weakPos: readonly string[];
  weakNeg: readonly string[];
  strongNeg: readonly string[];
}> = Object.freeze({
  strongPos: Object.freeze([
    '业绩超预期',
    '业绩大增',
    '业绩预增',
    '突破新高',
    '中标',
    '签订',
    '签订重大合同',
    '获批',
    '受益',
    '利好',
    '增持',
    '回购',
    '股份回购',
    '分红',
    '送转',
    '股权激励',
    '高送转',
    '业绩快报',
  ]),
  weakPos: Object.freeze([
    '上调',
    '增长',
    '扩产',
    '签约',
    '合作',
    '战略合作',
    '进展',
    '推动',
    '设立子公司',
    '收购',
    '并购',
    '中标公告',
  ]),
  weakNeg: Object.freeze([
    '减持',
    '股东减持',
    '下调',
    '解禁',
    '诉讼',
    '问询',
    '问询函',
    '风险提示',
    '业绩预减',
    '业绩下滑',
    '担保',
    '提供担保',
    '关联交易',
    '质押',
    '股权质押',
  ]),
  strongNeg: Object.freeze([
    '立案',
    '立案调查',
    '退市',
    '退市风险',
    '重大违规',
    '欺诈',
    '处罚',
    '行政处罚',
    '黑天鹅',
    '业绩暴雷',
    '业绩低于预期',
    '亏损扩大',
    '债务违约',
    '逾期',
    'ST',
    '*ST',
    '暂停上市',
    '终止上市',
  ]),
});

/**
 * 业务/行业主题关键词字典 (扫描公告标题).
 * 命中后作为 key_topics_json 数组写入; 同一标题去重后最多 5 个.
 */
export const TOPIC_KEYWORDS: readonly string[] = Object.freeze([
  '新能源',
  '光伏',
  '储能',
  '风电',
  '氢能',
  '锂电',
  '半导体',
  '芯片',
  '人工智能',
  'AI',
  '数据中心',
  '机器人',
  '生物医药',
  '医疗器械',
  '创新药',
  '军工',
  '航空',
  '汽车',
  '智能驾驶',
  '消费电子',
  '海外订单',
  '海外业务',
  '重大合同',
  '业绩预告',
  '业绩快报',
  '一季报',
  '半年报',
  '三季报',
  '年报',
  '分红',
  '回购',
  '股权激励',
  '并购重组',
  '资产重组',
  '员工持股',
  '可转债',
  '定增',
  '配股',
  '解禁',
]);

/** 金额正则 (中文单位) */
const AMOUNT_REGEX = /(\d+(?:\.\d+)?)\s*(亿元|万元|元|万股|股)/g;

/** 单条公告启发式抽取最多金额数 (公告标题中 3 个已超过常规需求) */
const MAX_AMOUNTS_PER_TITLE = 3;

/** 单条公告启发式抽取最多 topic 数 */
const MAX_TOPICS_PER_TITLE = 5;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单条公告 NLP 抽取的结果 (pure, 与 AnnouncementSummary 列对应) */
export interface AnnouncementNLPRecord {
  announce_date: string;
  stock_code: string;
  stock_name: string | null;
  original_title: string;
  announcement_type: string | null;
  url: string | null;
  summary: string | null;
  sentiment: SentimentValue | null;
  key_amounts_json: Array<{ label: string; amount: number; unit: string }>;
  key_topics_json: string[];
  /**
   * US-025 ANN-001: 事件类型 — classifyEventType (US-026) 输出, NULL = 未分类.
   * 本 story 默认 null, 由 ANN-002 实现填充.
   */
  event_type: AnnouncementEventType | null;
  /**
   * US-025 ANN-001: 优先级 — computePriority (US-029) 输出, 默认 'low'.
   * 本 story 默认 'low', 由 ANN-005 实现填充.
   */
  priority: AnnouncementPriority;
  /**
   * US-025 ANN-001: 实体抽取 — extractEntities (US-027) 输出, 默认 [].
   * 本 story 默认 [], 由 ANN-003 实现填充.
   */
  entities: AnnouncementEntity[];
  status: 'completed' | 'partial' | 'failed' | 'pending';
  nlp_engine: string | null;
  error: string | null;
  raw_payload: Record<string, unknown>;
  /** True iff actually written to DB (false = dry_run / persist failed). */
  persisted: boolean;
}

/** AI 远端返回的结构 (TradingAgents /api/nlp-summary 占位, 实际接口待对接) */
export interface RemoteNLPPayload {
  status?: string;
  data?: {
    summary?: string;
    sentiment?: string; // '正面' / '中性' / '负面' / 'positive' / 'negative' / 'neutral'
    key_amounts?: Array<{ label?: string; amount?: number; unit?: string }>;
    key_topics?: string[];
    /** US-025 ANN-001: 占位让远端 AI 与本地 ANN-002~005 实现可互替, 当前默认 null. */
    event_type?: string;
    priority?: string;
    entities?: Array<Record<string, unknown>>;
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface SummarizeOptions {
  /** 走 AI 远端调用 (默认 false 仅启发式; AI 远端慢且贵, 批量时不开启) */
  extract_with_ai?: boolean;
}

export interface SyncDateOptions {
  /** 东财预过滤类型 (默认 '全部') */
  symbol?: AnnouncementSymbol;
  /** 是否调 AI 远端 (默认 false = 全部走启发式) */
  extract_with_ai?: boolean;
  /** dry_run 跳过 DB 写入 */
  dry_run?: boolean;
}

export interface SyncDateResult {
  announce_date: string;
  symbol: AnnouncementSymbol;
  fetched: number;
  upserted: number;
  by_sentiment: Record<string, number>;
  by_status: Record<string, number>;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions extends SyncDateOptions {
  /** 单日已有任意一条 announcement_summaries 时跳过整日 (默认 true) */
  skipExisting?: boolean;
  /** 日间间隔 ms (默认 5000, AKShare 限流防护) */
  intervalMs?: number;
}

export interface SyncRangeResult {
  start: string;
  end: string;
  symbol: AnnouncementSymbol;
  total_days: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncDateResult[];
}

// ---------------------------------------------------------------------------
// DataSource 注入接口
// ---------------------------------------------------------------------------

export interface AnnouncementNLPDataSource {
  fetchAnnouncements(date: string, symbol: AnnouncementSymbol): Promise<AnnouncementReportRow[]>;
  /** 远端 AI 调用; 失败时返回 status=FAILED + error, 不抛 */
  callRemoteSummarize(
    title: string,
    context?: { stock_code?: string; announcement_type?: string }
  ): Promise<RemoteNLPPayload>;
  saveSummaries(records: AnnouncementNLPRecord[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default production DataSource
// ---------------------------------------------------------------------------

export class DefaultAnnouncementNLPDataSource implements AnnouncementNLPDataSource {
  private client: AnnouncementClient;

  constructor(client: AnnouncementClient = announcementClient) {
    this.client = client;
  }

  async fetchAnnouncements(
    date: string,
    symbol: AnnouncementSymbol
  ): Promise<AnnouncementReportRow[]> {
    return this.client.fetchAnnouncements(date, symbol);
  }

  async callRemoteSummarize(
    title: string,
    context: { stock_code?: string; announcement_type?: string } = {}
  ): Promise<RemoteNLPPayload> {
    try {
      const response = await axios.post(
        `${TRADING_AGENTS_URL}/api/nlp-summary`,
        {
          title,
          stock_code: context.stock_code,
          announcement_type: context.announcement_type,
        },
        { timeout: 30_000 }
      );
      return response.data;
    } catch (error: any) {
      const message = error?.response?.data?.detail || error?.message || String(error);
      logger.warn(
        `AnnouncementNLP.callRemoteSummarize failed for "${title.slice(0, 30)}...": ${message}`
      );
      return { status: 'FAILED', data: { error: message } };
    }
  }

  async saveSummaries(records: AnnouncementNLPRecord[]): Promise<void> {
    if (records.length === 0) return;
    await AnnouncementSummary.bulkCreate(
      records.map(r => ({
        announce_date: r.announce_date,
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        original_title: r.original_title,
        announcement_type: r.announcement_type,
        url: r.url,
        summary: r.summary,
        sentiment: r.sentiment,
        key_amounts_json: r.key_amounts_json,
        key_topics_json: r.key_topics_json,
        // US-025 ANN-001: 三新列必须随 bulkCreate 一起写, 否则 partial upsert 把已有行的
        // event_type / priority / entities 漂回默认值 (low / [] / null).
        event_type: r.event_type,
        priority: r.priority,
        entities: r.entities,
        status: r.status,
        nlp_engine: r.nlp_engine,
        error: r.error,
        raw_payload: r.raw_payload,
      })) as unknown as Array<Record<string, unknown>>,
      {
        updateOnDuplicate: [
          'stock_name',
          'announcement_type',
          'url',
          'summary',
          'sentiment',
          'key_amounts_json',
          'key_topics_json',
          // US-025 ANN-001: 三新列加入 updateOnDuplicate 让 ANN-002~005 re-sync 能覆盖旧值.
          'event_type',
          'priority',
          'entities',
          'status',
          'nlp_engine',
          'error',
          'raw_payload',
          'updated_at',
        ],
      }
    );
  }
}

export const PRODUCTION_ANNOUNCEMENT_NLP_DATA_SOURCE: AnnouncementNLPDataSource =
  new DefaultAnnouncementNLPDataSource();

// ---------------------------------------------------------------------------
// Pure helpers (export for unit tests — no DB / no axios)
// ---------------------------------------------------------------------------

/**
 * 启发式情绪判定 — 标题关键词扫描, 与 KOLAggregatorService.scoreNewsSentiment 同款 4 档优先级.
 * - 强空 > 强多 > 弱空 > 弱多 > 中性;
 * - 空 / 未匹配 → 中性.
 */
export function heuristicSentiment(title: string | null | undefined): SentimentValue {
  if (!title) return '中性';
  const text = String(title);

  // 1. 强空 — 优先级最高 (安全派, 避免漏报负面)
  for (const kw of ANN_SENTIMENT_KEYWORDS.strongNeg) {
    if (text.includes(kw)) return '负面';
  }
  // 2. 强多
  for (const kw of ANN_SENTIMENT_KEYWORDS.strongPos) {
    if (text.includes(kw)) return '正面';
  }
  // 3. 弱空
  for (const kw of ANN_SENTIMENT_KEYWORDS.weakNeg) {
    if (text.includes(kw)) return '负面';
  }
  // 4. 弱多
  for (const kw of ANN_SENTIMENT_KEYWORDS.weakPos) {
    if (text.includes(kw)) return '正面';
  }
  return '中性';
}

/**
 * 启发式金额抽取 — 正则扫描标题中的"数字+单位"组合.
 * - 同一标题最多 MAX_AMOUNTS_PER_TITLE 个 (公告标题不会塞 10 个数字);
 * - 单位保留原文 (UI 展示 "1.2 亿元" 比 "120000000 元" 友好);
 * - label 字段是该金额前的 6 字符上下文 (e.g. "募集资金 1.2 亿元" → label="募集资金").
 */
export function extractAmounts(
  title: string | null | undefined
): Array<{ label: string; amount: number; unit: string }> {
  if (!title) return [];
  const text = String(title);
  const out: Array<{ label: string; amount: number; unit: string }> = [];
  const regex = new RegExp(AMOUNT_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = match[2];
    // 取金额前最多 6 个字符作为 label 上下文
    const startIdx = match.index;
    const labelStart = Math.max(0, startIdx - 6);
    const labelRaw = text.slice(labelStart, startIdx).trim();
    // label 截掉非中文/英文字母的前缀 (e.g. "金额" / "募集资金" 等业务词)
    const label = labelRaw.replace(/^[^一-龥A-Za-z]+/, '') || '金额';
    out.push({ label, amount, unit });
    if (out.length >= MAX_AMOUNTS_PER_TITLE) break;
  }
  return out;
}

/**
 * 启发式主题抽取 — 字典扫描标题中的行业 / 业务关键词.
 * - 命中去重 (同一 keyword 不重复);
 * - 同一标题最多 MAX_TOPICS_PER_TITLE 个;
 * - 命中数 = 0 时返回 [].
 */
export function extractTopics(title: string | null | undefined): string[] {
  if (!title) return [];
  const text = String(title);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const kw of TOPIC_KEYWORDS) {
    if (text.includes(kw) && !seen.has(kw)) {
      seen.add(kw);
      out.push(kw);
      if (out.length >= MAX_TOPICS_PER_TITLE) break;
    }
  }
  return out;
}

/**
 * 启发式摘要生成 — 标题截断 + 情绪标注前缀.
 * AC: "summary" 中文一句话摘要. 启发式模式下用标题 + 情绪前缀替代真实 NLP.
 * - title ≤ 50 字符: "[情绪] 原标题";
 * - title > 50: "[情绪] 原标题前 50 字符...".
 * - 真实 AI 摘要由 callRemoteSummarize 提供, 启发式仅作 fallback.
 */
export function heuristicSummarize(
  title: string | null | undefined,
  sentiment: SentimentValue
): string | null {
  if (!title) return null;
  const text = String(title).trim();
  if (!text) return null;
  const prefix = `[${sentiment}]`;
  const MAX = 50;
  if (text.length <= MAX) return `${prefix} ${text}`;
  return `${prefix} ${text.slice(0, MAX)}...`;
}

/**
 * 规范化情绪字符串 — 远端 AI 可能返回 '正面' / 'positive' / 'POSITIVE' 多种形式.
 * - 中文 '正面' / '中性' / '负面' 直接返回;
 * - 英文 / 大小写不敏感映射;
 * - 未识别 → '中性' (安全默认, 与启发式 fallback 一致).
 */
export function normalizeSentiment(raw: unknown): SentimentValue {
  if (!raw) return '中性';
  const text = String(raw).trim().toLowerCase();
  if (!text) return '中性';
  if (text.includes('正面') || text.includes('positive') || text.includes('bullish')) {
    return '正面';
  }
  if (text.includes('负面') || text.includes('negative') || text.includes('bearish')) {
    return '负面';
  }
  if (text.includes('中性') || text.includes('neutral')) return '中性';
  return '中性';
}

/**
 * US-025 ANN-001: 规范化 priority — 任何 raw 输入兜底成枚举值.
 * - 严格大小写匹配 ANNOUNCEMENT_PRIORITY_VALUES 后返回;
 * - 中文别名: '关键'/'紧急'→critical, '高'→high, '中'→medium, '低'→low;
 * - 未识别 → 'low' (与历史行默认一致, 不让模糊输入提升到 critical 触发飞书 push).
 *
 * ANN-005 (US-029) 真正实现 computePriority 后会直接返回枚举值,
 * 但 RemoteNLPPayload.priority 可能是远端 AI 自由文本, 必须经过本归一.
 */
export function normalizePriority(raw: unknown): AnnouncementPriority {
  if (raw === null || raw === undefined) return 'low';
  const text = String(raw).trim().toLowerCase();
  if (!text) return 'low';
  if ((ANNOUNCEMENT_PRIORITY_VALUES as readonly string[]).includes(text)) {
    return text as AnnouncementPriority;
  }
  if (text.includes('critical') || text.includes('关键') || text.includes('紧急')) {
    return 'critical';
  }
  if (text.includes('high') || text === '高') return 'high';
  if (text.includes('medium') || text === '中') return 'medium';
  if (text.includes('low') || text === '低') return 'low';
  return 'low';
}

/**
 * US-025 ANN-001: 规范化 event_type — 任何 raw 输入兜底成枚举值或 null.
 * - 严格匹配 ANNOUNCEMENT_EVENT_TYPES 后返回;
 * - 英文别名 (earnings/restructure/reduction/...) 容错;
 * - 未识别字符串 → '其它' (区别于 null = 未跑过分类);
 * - null / undefined / 空串 → null.
 *
 * ANN-002 (US-026) classifyEventType 直接返回枚举, 但远端 AI / 历史脚本仍走本归一.
 */
export function normalizeEventType(raw: unknown): AnnouncementEventType | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if ((ANNOUNCEMENT_EVENT_TYPES as readonly string[]).includes(text)) {
    return text as AnnouncementEventType;
  }
  const lower = text.toLowerCase();
  if (lower.includes('earning') || text.includes('业绩')) return '业绩';
  if (lower.includes('restructur') || text.includes('重组') || text.includes('并购')) return '重组';
  if (lower.includes('reduction') || lower.includes('reduce') || text.includes('减持')) {
    return '减持';
  }
  if (lower.includes('guarantee') || text.includes('担保')) return '担保';
  if (
    lower.includes('penalt') ||
    lower.includes('punish') ||
    text.includes('处罚') ||
    text.includes('违规')
  ) {
    return '处罚';
  }
  if (lower.includes('unlock') || lower.includes('lockup') || text.includes('解禁')) return '解禁';
  return '其它';
}

/**
 * US-025 ANN-001: 规范化 entities — 任何 raw 输入兜底成 AnnouncementEntity[].
 * - 非 array → [];
 * - 元素必须含 string name + string role (缺一即 drop, 不报错);
 * - holding_pct 仅当数字且 finite 时保留;
 * - 其它字段透传 (extractEntities US-027 后续可能扩 'change_type' 等).
 *
 * ANN-003 (US-027) extractEntities 直接返回合法 shape, 但远端 AI / migration 兜底走本归一.
 */
export function normalizeEntities(raw: unknown): AnnouncementEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: AnnouncementEntity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const role = typeof rec.role === 'string' ? rec.role.trim() : '';
    if (!name || !role) continue;
    const entity: AnnouncementEntity = { name, role };
    if (typeof rec.holding_pct === 'number' && Number.isFinite(rec.holding_pct)) {
      entity.holding_pct = rec.holding_pct;
    }
    for (const k of Object.keys(rec)) {
      if (k === 'name' || k === 'role' || k === 'holding_pct') continue;
      entity[k] = rec[k];
    }
    out.push(entity);
  }
  return out;
}

/**
 * 从远端 AI payload 构建 NLPRecord; payload 为 null / 失败时由 caller 走启发式 fallback.
 * pure transform, 不写库.
 */
export function buildNLPResultFromPayload(
  payload: RemoteNLPPayload,
  row: AnnouncementReportRow
): AnnouncementNLPRecord {
  const statusRaw = String(payload?.status || '').toUpperCase();
  const data = payload?.data;

  if (statusRaw === 'FAILED' || !data) {
    const err = data?.error || 'AI 远端调用失败';
    // 走启发式 fallback
    const fallbackSentiment = heuristicSentiment(row.original_title);
    return {
      announce_date: row.announce_date,
      stock_code: row.stock_code,
      stock_name: row.stock_name,
      original_title: row.original_title,
      announcement_type: row.announcement_type,
      url: row.url,
      summary: heuristicSummarize(row.original_title, fallbackSentiment),
      sentiment: fallbackSentiment,
      key_amounts_json: extractAmounts(row.original_title),
      key_topics_json: extractTopics(row.original_title),
      // US-025 ANN-001: 启发式 fallback 时本 story 默认占位, ANN-002~005 实现后会真填.
      event_type: null,
      priority: 'low',
      entities: [],
      status: 'partial',
      nlp_engine: NLP_ENGINES.HEURISTIC,
      error: typeof err === 'string' ? err : '远端 AI 异常 — 已走启发式 fallback',
      raw_payload: row.raw_payload,
      persisted: false,
    };
  }

  // 成功: 优先用 AI 字段, 缺失字段用启发式补
  const sentiment = normalizeSentiment(data.sentiment);
  const summary =
    typeof data.summary === 'string' && data.summary.trim().length > 0
      ? data.summary.trim()
      : heuristicSummarize(row.original_title, sentiment);
  const keyAmounts = Array.isArray(data.key_amounts)
    ? data.key_amounts
        .filter(a => a && typeof a.amount === 'number' && Number.isFinite(a.amount))
        .map(a => ({
          label: typeof a.label === 'string' ? a.label : '金额',
          amount: Number(a.amount),
          unit: typeof a.unit === 'string' ? a.unit : '元',
        }))
        .slice(0, MAX_AMOUNTS_PER_TITLE)
    : extractAmounts(row.original_title);
  const keyTopics = Array.isArray(data.key_topics)
    ? data.key_topics
        .filter(t => typeof t === 'string' && t.trim().length > 0)
        .slice(0, MAX_TOPICS_PER_TITLE)
    : extractTopics(row.original_title);

  return {
    announce_date: row.announce_date,
    stock_code: row.stock_code,
    stock_name: row.stock_name,
    original_title: row.original_title,
    announcement_type: row.announcement_type,
    url: row.url,
    summary,
    sentiment,
    key_amounts_json: keyAmounts,
    key_topics_json: keyTopics,
    // US-025 ANN-001: 透传远端 AI 输出 (经归一); 缺失则 ANN-002~005 实现后由 caller 二次填充.
    event_type: normalizeEventType(data.event_type),
    priority: normalizePriority(data.priority),
    entities: normalizeEntities(data.entities),
    status: 'completed',
    nlp_engine: NLP_ENGINES.TRADING_AGENTS,
    error: null,
    raw_payload: row.raw_payload,
    persisted: false,
  };
}

/**
 * 纯启发式 NLPRecord 构造 (不调远端 AI). 批量同步默认走此路径 (快 + 免费).
 */
export function buildHeuristicNLPResult(row: AnnouncementReportRow): AnnouncementNLPRecord {
  const sentiment = heuristicSentiment(row.original_title);
  return {
    announce_date: row.announce_date,
    stock_code: row.stock_code,
    stock_name: row.stock_name,
    original_title: row.original_title,
    announcement_type: row.announcement_type,
    url: row.url,
    summary: heuristicSummarize(row.original_title, sentiment),
    sentiment,
    key_amounts_json: extractAmounts(row.original_title),
    key_topics_json: extractTopics(row.original_title),
    // US-025 ANN-001: 启发式默认占位 — ANN-002 / 003 / 005 (pure helper) 落地后,
    // 本 builder 会引入对应函数填充, 但 schema 必须现在就有字段保留位以免 saveSummaries 缺列报错.
    event_type: null,
    priority: 'low',
    entities: [],
    status: 'completed',
    nlp_engine: NLP_ENGINES.HEURISTIC,
    error: null,
    raw_payload: row.raw_payload,
    persisted: false,
  };
}

// ---------------------------------------------------------------------------
// AnnouncementNLPService — main entry
// ---------------------------------------------------------------------------

export class AnnouncementNLPService {
  private readonly dataSource: AnnouncementNLPDataSource;

  constructor(dataSource: AnnouncementNLPDataSource = PRODUCTION_ANNOUNCEMENT_NLP_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 单条公告 NLP — 优先 AI, 失败/未启用时走启发式.
   *
   * UI 主动触发 ("详细解读" 按钮) 时设 `extract_with_ai=true`;
   * 批量 syncDate 默认 false 全走启发式.
   */
  async summarize(
    row: AnnouncementReportRow,
    options: SummarizeOptions = {}
  ): Promise<AnnouncementNLPRecord> {
    if (options.extract_with_ai !== true) {
      return buildHeuristicNLPResult(row);
    }
    // AI 路径 — 失败时 buildNLPResultFromPayload 内部 fallback 启发式
    let payload: RemoteNLPPayload;
    try {
      payload = await this.dataSource.callRemoteSummarize(row.original_title, {
        stock_code: row.stock_code,
        announcement_type: row.announcement_type ?? undefined,
      });
    } catch (err: any) {
      // 双重防御: DataSource 内已 catch, service 层再保险
      logger.warn(
        `AnnouncementNLPService.summarize unexpected throw for "${row.original_title.slice(
          0,
          30
        )}...": ${err.message}`
      );
      payload = { status: 'FAILED', data: { error: err.message } };
    }
    return buildNLPResultFromPayload(payload, row);
  }

  /**
   * 同步指定日期的全市场公告 (含 NLP 抽取 + 落库).
   * - extract_with_ai=true 时每条调 AI (慢 + 贵, 仅 1-2 只重点股使用);
   * - extract_with_ai=false (默认): 全走启发式, 几千条 < 1s.
   */
  async syncDate(date: string, options: SyncDateOptions = {}): Promise<SyncDateResult> {
    const symbol = options.symbol ?? '全部';
    const useAI = options.extract_with_ai === true;
    try {
      const rows = await this.dataSource.fetchAnnouncements(date, symbol);
      if (rows.length === 0) {
        logger.warn(`AnnouncementNLP: no announcements returned for ${date} (symbol=${symbol})`);
        return {
          announce_date: date,
          symbol,
          fetched: 0,
          upserted: 0,
          by_sentiment: {},
          by_status: {},
          skipped: false,
        };
      }

      // 逐条 NLP (启发式快 → 并发不必要; AI 路径串行避免远端限流)
      const records: AnnouncementNLPRecord[] = [];
      for (const row of rows) {
        const rec = await this.summarize(row, { extract_with_ai: useAI });
        records.push(rec);
      }

      // 聚合统计 (便于 ops dashboard)
      const bySentiment: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const r of records) {
        const s = r.sentiment || 'null';
        bySentiment[s] = (bySentiment[s] || 0) + 1;
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      }

      if (options.dry_run !== true) {
        try {
          await this.dataSource.saveSummaries(records);
          records.forEach(r => {
            r.persisted = true;
          });
        } catch (err: any) {
          // fail-OPEN: DB 故障不阻塞返回 (与 US-055 同款)
          logger.error(`AnnouncementNLP.saveSummaries failed: ${err.message}`);
          return {
            announce_date: date,
            symbol,
            fetched: rows.length,
            upserted: 0,
            by_sentiment: bySentiment,
            by_status: byStatus,
            skipped: false,
            error: `save_failed: ${err.message}`,
          };
        }
      }

      logger.info(
        `AnnouncementNLP: ${records.length} rows upserted for ${date} (symbol=${symbol}, ai=${useAI})`
      );
      return {
        announce_date: date,
        symbol,
        fetched: rows.length,
        upserted: options.dry_run === true ? 0 : records.length,
        by_sentiment: bySentiment,
        by_status: byStatus,
        skipped: false,
      };
    } catch (err: any) {
      // 双重防御外层 catch
      logger.error(`AnnouncementNLP.syncDate(${date}) failed: ${err.message}`);
      return {
        announce_date: date,
        symbol,
        fetched: 0,
        upserted: 0,
        by_sentiment: {},
        by_status: {},
        skipped: false,
        error: err.message,
      };
    }
  }

  /**
   * 按日期闭区间遍历 syncDate (与 SnowballHotKeywordSyncService 同款).
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const symbol = options.symbol ?? '全部';
    const skipExisting = options.skipExisting ?? true;
    const intervalMs = Math.max(0, options.intervalMs ?? 5000);

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`AnnouncementNLP syncRange: start ${start} after end ${end}`);
    }

    const details: SyncDateResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let totalDays = 0;

    for (
      let cursor = new Date(startDate);
      cursor <= endDate;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      totalDays += 1;
      const iso = cursor.toISOString().slice(0, 10);

      if (skipExisting) {
        const existing = await AnnouncementSummary.count({ where: { announce_date: iso } });
        if (existing > 0) {
          logger.info(`AnnouncementNLP: skip ${iso} (${existing} rows already present)`);
          details.push({
            announce_date: iso,
            symbol,
            fetched: 0,
            upserted: 0,
            by_sentiment: {},
            by_status: {},
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }

      const result = await this.syncDate(iso, options);
      details.push(result);
      if (result.error) failed += 1;
      else succeeded += 1;

      if (intervalMs > 0 && cursor < endDate) {
        await sleep(intervalMs);
      }
    }

    return {
      start,
      end,
      symbol,
      total_days: totalDays,
      succeeded,
      skipped,
      failed,
      details,
    };
  }

  /**
   * 读端 — 按股票代码查最近 N 天公告.
   * GET /api/announcements?stock_code=000001&days=30 直接调.
   */
  async listByStock(stockCode: string, days = 30, limit = 200): Promise<AnnouncementSummary[]> {
    const code = String(stockCode || '').trim();
    if (!code) return [];

    const daysCap = Math.max(1, Math.min(365, Math.floor(days)));
    const limitCap = Math.max(1, Math.min(1000, Math.floor(limit)));

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - daysCap);
    const sinceIso = since.toISOString().slice(0, 10);

    return AnnouncementSummary.findAll({
      where: {
        stock_code: code,
        announce_date: { [Op.gte]: sinceIso },
      },
      order: [
        ['announce_date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: limitCap,
    });
  }

  /**
   * 读端 — 按日期查全市场公告 (UI: 公告流 / 全市场扫描).
   */
  async listByDate(
    date: string,
    sentiment?: SentimentValue,
    limit = 200
  ): Promise<AnnouncementSummary[]> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const limitCap = Math.max(1, Math.min(1000, Math.floor(limit)));
    const where: Record<string, unknown> = { announce_date: date };
    if (sentiment && SENTIMENT_VALUES.includes(sentiment)) {
      where.sentiment = sentiment;
    }
    return AnnouncementSummary.findAll({
      where,
      order: [
        ['stock_code', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: limitCap,
    });
  }
}

// ---------------------------------------------------------------------------
// 公共导出 helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD → Date (UTC); 失败抛 RangeError. */
export function parseIsoDate(d: string): Date {
  const dt = new Date(`${d}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime())) {
    throw new RangeError(`Invalid ISO date: ${d}`);
  }
  return dt;
}

/** Promise sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 生产 singleton */
export const announcementNLPService = new AnnouncementNLPService();
