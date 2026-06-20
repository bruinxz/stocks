/**
 * RelatedCompanyExtractor — L6-AI / US-117 [ANN-009] 公告关联公司抽取
 *
 * 从已落库的 AnnouncementSummary 行 (`original_title` + `summary` + `entities` + `key_topics_json`)
 * 启发式抽取"该公告除主体公司外, 还提到/影响/牵连的其它上市公司股票代码",
 * 输出 AnnouncementEventRelation 的 bulkUpsert 候选行.
 *
 * **本 story 只新增 extractor + bulkUpsert 服务** — 真在线接入由后续 ANN-010
 * AnnouncementDedupeService (US-118) 在 dedupe pipeline 内调用 + 由
 * AnnouncementNLPService 在 syncDate 末尾 enqueue.
 *
 * 抽取策略 (优先级链, fail-OPEN 默认):
 *   1. **6 位代码硬命中** (置信度 1.0; source='extractor_heuristic')
 *      - 在 title / summary / entities[*].name 文本中扫 `\b\d{6}\b`
 *      - 通过 `inferMarketSegment` 验证 ∈ {main, star, chinext, bj} (剔除 'unknown' / ETF 5xx)
 *      - 命中即默认 relation_type='mentioned' (弱关联), 调用方按上下文升级到
 *        'subsidiary' / 'related_party' / 'peer'
 *   2. **entities JSONB 中的 stock_code 字段** (置信度 0.9; source='extractor_llm')
 *      - 远端 AI/TradingAgents 可能在 entities[*] 写 { stock_code: '600519', stock_name: '贵州茅台' }
 *      - 透传 stock_code + stock_name + role (映射到 relation_type)
 *   3. **关联交易 / 子公司关键词模糊匹配** (置信度 0.5; source='extractor_heuristic')
 *      - 命中 "子公司 X" / "全资子公司 X" / "控股子公司 X" / "战略合作 X" 但 X 不含代码
 *      - 仅当 entity 同时含 `holding_pct` 字段时落 'subsidiary'; 否则 'mentioned'
 *      - **本启发式默认输出 placeholder code = null, 由 caller 决定是否走名称→代码反查**
 *      - **本 story 不实现 name→code 反查** (依赖 Stock model 外部查询)
 *
 * **主体公司处理**:
 *   - 若公告主体 stock_code 命中, 也输出一行 relation_type='primary' (confidence=1.0)
 *   - 让前端按统一表查 "公告 N 关联了哪些股票" 时主体也在列, 无需 JOIN AnnouncementSummary
 *
 * **去重规则**:
 *   - 同一 (announcement_id, related_stock_code) 仅保留首次命中行 (后命中保留更高 confidence)
 *   - matched_text 记录命中片段 (前后 12 字符窗口); matched_position 记录 source 字段 (title/summary/entities)
 *
 * **识别率 AC** (≥ 80%):
 *   - 用 20 条人工标注的公告样本验证 — 见 related-company-extractor.test.ts
 *   - 标注集涵盖: 关联交易 / 资产重组 / 战略合作 / 子公司公告 / 担保公告
 *
 * **fail-OPEN**:
 *   - 异常 (字段 null / 非法 JSON) 不抛, 返 []
 *   - bulkUpsert 失败仅 log warning, 不阻塞 caller 的主流程
 *
 * **与 ANN-008 AnnouncementEventRelation model 边界**:
 *   - 本 service 只产 candidate rows + persist (bulkUpsert);
 *   - 真去重 (dedupe cluster) 由 ANN-010 AnnouncementDedupeService;
 *   - 关联性质升级 (mentioned → subsidiary / related_party) 由 caller 上下文决定.
 *
 * 实现笔记: 沿用 [[KOLAggregatorService]] 同款 DataSource DI + bulkCreate updateOnDuplicate
 * upsert; 沿用 [[AnnouncementNLPService]] extractEntities 同款 pure-function + 边界
 * fail-OPEN; 沿用 [[marketLimits]] inferMarketSegment 做 6 位代码 sanity.
 */

import { Op } from 'sequelize';
import { AnnouncementEventRelation } from '../../models/AnnouncementEventRelation';
import { AnnouncementSummary } from '../../models/AnnouncementSummary';
import { inferMarketSegment } from '../../quant/marketLimits';
import { logger } from '../../utils/logger';

// ---------- 公开类型 ---------------------------------------------------------

/** 抽取阶段输出 (待 bulkUpsert 的 candidate row, 不含 announcement_id). */
export interface RelatedCompanyCandidate {
  related_stock_code: string;
  related_stock_name: string | null;
  relation_type:
    | 'primary'
    | 'mentioned'
    | 'subsidiary'
    | 'related_party'
    | 'peer'
    | 'other';
  confidence: number;
  source: 'extractor_heuristic' | 'extractor_llm';
  detail: {
    matched_text?: string | null;
    matched_position?: 'title' | 'summary' | 'entities' | 'topic' | null;
    extractor_version?: string;
  };
}

/** AnnouncementSummary 行的最小投影 (extractor 只需的字段). */
export interface AnnouncementProjection {
  id: number;
  stock_code: string;
  original_title: string;
  summary: string | null;
  entities: Array<Record<string, unknown>>;
  key_topics_json: string[] | null;
}

// ---------- 内部常量 ---------------------------------------------------------

/** extractor 版本号 — detail.extractor_version 写入, 用于将来回放 / 兼容判断. */
const EXTRACTOR_VERSION = 'related_company_extractor_v1';

/** 单 announcement 最多输出 candidate 数 (含 primary) — 防超长公告爆表. */
const MAX_CANDIDATES_PER_ANNOUNCEMENT = 20;

/** 6 位代码全局正则 — 标题/摘要中 scan. */
const STOCK_CODE_REGEX = /\b(\d{6})\b/g;

/** 子公司类关键词 (模糊匹配, 仅在 entity 含 holding_pct 时升级 relation_type). */
const SUBSIDIARY_KEYWORDS = ['全资子公司', '控股子公司', '子公司', '控股孙公司'];

/** 关联方类关键词. */
const RELATED_PARTY_KEYWORDS = ['关联交易', '关联方', '担保', '资金占用', '资产置换'];

/** entities[*].role / change_type / source 提示词 → relation_type. */
function inferRelationTypeFromRole(role: string | undefined): RelatedCompanyCandidate['relation_type'] {
  if (!role) return 'mentioned';
  const r = String(role);
  if (SUBSIDIARY_KEYWORDS.some((kw) => r.includes(kw))) return 'subsidiary';
  if (RELATED_PARTY_KEYWORDS.some((kw) => r.includes(kw))) return 'related_party';
  return 'mentioned';
}

// ---------- pure functions: extract ------------------------------------------

/**
 * 验证候选 6 位代码是否落 A 股有效号段 (剔除 ETF / 基金 / 杂号).
 * 利用 inferMarketSegment 返 'unknown' 即过滤掉.
 */
export function isValidAStockCode(code: string | null | undefined): boolean {
  if (!code) return false;
  if (!/^\d{6}$/.test(String(code))) return false;
  return inferMarketSegment(code) !== 'unknown';
}

/**
 * 从一段文本中扫所有 6 位 A 股代码, 输出 (code, 命中起始位置) 列表.
 * 同代码多次命中保留首次出现位置.
 */
export function scanStockCodesInText(text: string | null | undefined): Array<{ code: string; idx: number }> {
  if (text === null || text === undefined) return [];
  const s = String(text);
  if (!s) return [];
  const seen = new Map<string, number>();
  const re = new RegExp(STOCK_CODE_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const code = m[1];
    if (!isValidAStockCode(code)) continue;
    if (!seen.has(code)) seen.set(code, m.index);
  }
  return Array.from(seen.entries()).map(([code, idx]) => ({ code, idx }));
}

/**
 * 抽取 entities JSONB 中显式带 stock_code 的实体 (远端 AI 写法).
 * 透传 stock_name + role → relation_type.
 */
function extractFromEntities(
  entities: Array<Record<string, unknown>> | null | undefined
): RelatedCompanyCandidate[] {
  if (!Array.isArray(entities) || entities.length === 0) return [];
  const out: RelatedCompanyCandidate[] = [];
  for (const e of entities) {
    if (!e || typeof e !== 'object') continue;
    const codeRaw = e.stock_code;
    if (typeof codeRaw !== 'string') continue;
    if (!isValidAStockCode(codeRaw)) continue;
    const code = codeRaw.trim();
    const name = typeof e.stock_name === 'string' ? (e.stock_name as string).trim() : null;
    const role = typeof e.role === 'string' ? (e.role as string) : undefined;
    out.push({
      related_stock_code: code,
      related_stock_name: name || null,
      relation_type: inferRelationTypeFromRole(role),
      confidence: 0.9,
      source: 'extractor_llm',
      detail: {
        matched_text: name || code,
        matched_position: 'entities',
        extractor_version: EXTRACTOR_VERSION,
      },
    });
  }
  return out;
}

/**
 * pure: 单条 announcement → candidate relations 数组.
 *
 * 输出顺序: primary (若主体命中) → entities → title hits → summary hits, 去重后按
 * 出现优先级链保留首次. 同 code 多源命中合并: confidence = max(各源 conf),
 * relation_type = 第一个非 'mentioned' 的命中 (e.g. 若 entities 标了 subsidiary,
 * title 默认 mentioned, 取 subsidiary).
 */
export function extractRelatedCompanies(
  ann: AnnouncementProjection | null | undefined
): RelatedCompanyCandidate[] {
  if (!ann || typeof ann !== 'object') return [];
  const title = String(ann.original_title || '');
  const summary = ann.summary ? String(ann.summary) : '';
  const primary = String(ann.stock_code || '').trim();

  const merged = new Map<string, RelatedCompanyCandidate>();

  function upsert(c: RelatedCompanyCandidate): void {
    if (merged.size >= MAX_CANDIDATES_PER_ANNOUNCEMENT && !merged.has(c.related_stock_code)) return;
    const existing = merged.get(c.related_stock_code);
    if (!existing) {
      merged.set(c.related_stock_code, c);
      return;
    }
    // 合并: 更高 confidence 胜出; relation_type 升级 (mentioned < specific)
    const better: RelatedCompanyCandidate = {
      ...existing,
      confidence: Math.max(existing.confidence, c.confidence),
      related_stock_name: existing.related_stock_name || c.related_stock_name,
      relation_type:
        existing.relation_type === 'mentioned' && c.relation_type !== 'mentioned'
          ? c.relation_type
          : existing.relation_type,
      source: existing.confidence >= c.confidence ? existing.source : c.source,
      detail: existing.confidence >= c.confidence ? existing.detail : c.detail,
    };
    merged.set(c.related_stock_code, better);
  }

  // 1. primary (若主体 code 合法, 总是落一行)
  if (isValidAStockCode(primary)) {
    upsert({
      related_stock_code: primary,
      related_stock_name: null,
      relation_type: 'primary',
      confidence: 1.0,
      source: 'extractor_heuristic',
      detail: {
        matched_text: primary,
        matched_position: 'title',
        extractor_version: EXTRACTOR_VERSION,
      },
    });
  }

  // 2. entities JSONB
  for (const c of extractFromEntities(ann.entities)) {
    upsert(c);
  }

  // 3. title 中的 6 位代码 (剔除 primary)
  for (const hit of scanStockCodesInText(title)) {
    if (hit.code === primary) continue;
    const winStart = Math.max(0, hit.idx - 12);
    const winEnd = Math.min(title.length, hit.idx + 6 + 12);
    const matched = title.slice(winStart, winEnd);
    upsert({
      related_stock_code: hit.code,
      related_stock_name: null,
      relation_type: inferRelationTypeFromText(matched),
      confidence: 1.0,
      source: 'extractor_heuristic',
      detail: {
        matched_text: matched,
        matched_position: 'title',
        extractor_version: EXTRACTOR_VERSION,
      },
    });
  }

  // 4. summary 中的 6 位代码 (剔除 primary; 同代码在 title 已落则 confidence 已 1.0, 不覆盖)
  for (const hit of scanStockCodesInText(summary)) {
    if (hit.code === primary) continue;
    const winStart = Math.max(0, hit.idx - 12);
    const winEnd = Math.min(summary.length, hit.idx + 6 + 12);
    const matched = summary.slice(winStart, winEnd);
    upsert({
      related_stock_code: hit.code,
      related_stock_name: null,
      relation_type: inferRelationTypeFromText(matched),
      confidence: 0.85,
      source: 'extractor_heuristic',
      detail: {
        matched_text: matched,
        matched_position: 'summary',
        extractor_version: EXTRACTOR_VERSION,
      },
    });
  }

  return Array.from(merged.values());
}

/** 根据命中文本上下文 (前后 12 字符窗口) 推断 relation_type. */
export function inferRelationTypeFromText(
  text: string | null | undefined
): RelatedCompanyCandidate['relation_type'] {
  if (!text) return 'mentioned';
  const t = String(text);
  if (SUBSIDIARY_KEYWORDS.some((kw) => t.includes(kw))) return 'subsidiary';
  if (RELATED_PARTY_KEYWORDS.some((kw) => t.includes(kw))) return 'related_party';
  return 'mentioned';
}

// ---------- DataSource DI ----------------------------------------------------

/** RelatedCompanyExtractor 持久化依赖 (单测可注入 fake; 默认走 Sequelize). */
export interface RelatedCompanyExtractorDataSource {
  /** 读: 按 id 范围拉公告投影 (extractor 输入). */
  listAnnouncementProjections(opts: {
    sinceDate?: string; // YYYY-MM-DD
    untilDate?: string;
    ids?: number[];
    limit?: number;
  }): Promise<AnnouncementProjection[]>;

  /** 写: bulkUpsert relation 行. */
  bulkUpsertRelations(
    announcementId: number,
    candidates: RelatedCompanyCandidate[],
    metadata?: Record<string, unknown>
  ): Promise<number>;
}

/** 生产 DataSource — 走 Sequelize model. */
export const PRODUCTION_RELATED_COMPANY_DATA_SOURCE: RelatedCompanyExtractorDataSource = {
  async listAnnouncementProjections(opts) {
    const where: Record<string, unknown> = {};
    if (Array.isArray(opts.ids) && opts.ids.length > 0) {
      where.id = { [Op.in]: opts.ids };
    } else {
      if (opts.sinceDate) where.announce_date = { [Op.gte]: opts.sinceDate };
      if (opts.untilDate)
        where.announce_date = {
          ...((where.announce_date as Record<string, unknown>) || {}),
          [Op.lte]: opts.untilDate,
        };
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    try {
      const rows = await AnnouncementSummary.findAll({
        where,
        attributes: ['id', 'stock_code', 'original_title', 'summary', 'entities', 'key_topics_json'],
        limit,
        order: [['id', 'DESC']],
      });
      return rows.map((r) => ({
        id: r.id,
        stock_code: r.stock_code,
        original_title: r.original_title,
        summary: r.summary,
        entities: Array.isArray(r.entities) ? r.entities : [],
        key_topics_json: Array.isArray(r.key_topics_json) ? r.key_topics_json : [],
      }));
    } catch (err) {
      logger.warn(
        `[RelatedCompanyExtractor] listAnnouncementProjections failed: ${(err as Error).message}`
      );
      return [];
    }
  },

  async bulkUpsertRelations(announcementId, candidates, metadata) {
    if (!Number.isFinite(announcementId) || candidates.length === 0) return 0;
    const meta = metadata || {};
    const rows = candidates.map((c) => ({
      announcement_id: announcementId,
      related_stock_code: c.related_stock_code,
      related_stock_name: c.related_stock_name,
      relation_type: c.relation_type,
      confidence: c.confidence,
      source: c.source,
      detail: c.detail || {},
      metadata: { ...meta, extractor_version: EXTRACTOR_VERSION },
      extracted_at: new Date(),
    }));
    try {
      await AnnouncementEventRelation.bulkCreate(
        rows as unknown as Array<Record<string, unknown>>,
        {
          updateOnDuplicate: [
            'related_stock_name',
            'relation_type',
            'confidence',
            'source',
            'detail',
            'metadata',
            'extracted_at',
            'updated_at',
          ],
        }
      );
      return rows.length;
    } catch (err) {
      logger.warn(
        `[RelatedCompanyExtractor] bulkUpsertRelations(ann=${announcementId}) failed: ${
          (err as Error).message
        } — fail-OPEN`
      );
      return 0;
    }
  },
};

// ---------- Service 类 -------------------------------------------------------

/** 批处理 / on-demand 接入入口. */
export class RelatedCompanyExtractor {
  constructor(
    private readonly dataSource: RelatedCompanyExtractorDataSource = PRODUCTION_RELATED_COMPANY_DATA_SOURCE
  ) {}

  /**
   * 单条公告 → candidate relations (不持久化, 便于 caller dry-run / log).
   * pure-wrapper 转发 extractRelatedCompanies, 同 fail-OPEN 边界.
   */
  extract(ann: AnnouncementProjection | null | undefined): RelatedCompanyCandidate[] {
    return extractRelatedCompanies(ann);
  }

  /**
   * 单条公告 → candidate + bulkUpsert.
   * persist=false 时仅返抽取结果, 不写库.
   */
  async extractAndPersist(
    ann: AnnouncementProjection,
    options: { persist?: boolean; metadata?: Record<string, unknown> } = {}
  ): Promise<{ candidates: RelatedCompanyCandidate[]; persisted: number }> {
    const candidates = this.extract(ann);
    if (!options.persist || candidates.length === 0) {
      return { candidates, persisted: 0 };
    }
    const persisted = await this.dataSource.bulkUpsertRelations(
      ann.id,
      candidates,
      options.metadata
    );
    return { candidates, persisted };
  }

  /**
   * 批量: 按 id / date 范围拉公告投影 → 逐条抽取 + bulkUpsert.
   * 每条 try/catch, 单条失败不阻塞批 (与 syncRange 同款 fail-OPEN).
   */
  async runBatch(opts: {
    sinceDate?: string;
    untilDate?: string;
    ids?: number[];
    limit?: number;
    persist?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<{ processed: number; persisted: number; candidates_total: number }> {
    const projections = await this.dataSource.listAnnouncementProjections({
      sinceDate: opts.sinceDate,
      untilDate: opts.untilDate,
      ids: opts.ids,
      limit: opts.limit,
    });

    let processed = 0;
    let persisted = 0;
    let candidatesTotal = 0;

    for (const ann of projections) {
      processed += 1;
      try {
        const { candidates, persisted: p } = await this.extractAndPersist(ann, {
          persist: opts.persist,
          metadata: opts.metadata,
        });
        persisted += p;
        candidatesTotal += candidates.length;
      } catch (err) {
        logger.warn(
          `[RelatedCompanyExtractor] runBatch ann=${ann.id} failed: ${
            (err as Error).message
          } — fail-OPEN`
        );
      }
    }

    return { processed, persisted, candidates_total: candidatesTotal };
  }
}
