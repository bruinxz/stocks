/**
 * AIDiaryCronRunner — L8-Postmortem / US-091 [PM-020] AI_DIARY_GENERATE cron 主入口
 *
 * 工作日 18:00 (盘后 + DAILY_ATTRIBUTION_GENERATE 17:00 之后) 给所有 active user
 * 生成 ≤ 500 字 AI 投资日记并 upsert 到 `ai_diary_entries` 表 (单 user 一天一行,
 * status='ok' / 'skipped' / 'failed' 全部落库做留痕).
 *
 * 设计遵循 [[DailyAttributionCronRunner]] (US-083 PM-006) "cron 批量驱动 + 持久化层"
 * 模板 6 件套, 让 PM 系列 cron (本 PM-020 / 未来 PM-022 WEEKLY_ERROR_PATTERN /
 * PM-024 IMPROVEMENT_SUGGESTION_*) 全部共享同一形态:
 *
 *   (1) cron-side DataSource interface 与 service-side AIDiaryDataSource 分两个 —
 *       前者负责"枚举所有 active user", 后者负责"取单 user 的 context + upsert".
 *       职责清晰; 单测 fake 不互相污染.
 *   (2) PRODUCTION_AI_DIARY_CRON_DATA_SOURCE singleton lazy-require User model
 *   (3) 单测注入 fake DataSource 完整覆盖 happy / skipped / failed / dry_run /
 *       persist 失败 fail-OPEN, 完全脱离 DB
 *   (4) per-user try/catch — 单 user generateForUser 兜底转 failed, continue batch
 *   (5) explicit user_ids 优先 / 空时 listActiveUsers 兜底 — ops 可只 replay 某用户
 *   (6) dry_run=true 透传给 service (service 仍跑算数, upsert 内部按 dry_run skip)
 *
 * 与 AIDiaryService 的边界:
 *   - AIDiaryService.generateForUser(user_id, opts) 是单 user 日记生成入口
 *     (本身已 fail-OPEN, 永不 throw — 见 services/postmortem/CLAUDE.md fail-OPEN
 *     留痕分级表)
 *   - 本 runner 是 cron 批量驱动 + per-user 兜底, 把 service 返值聚合成 ok/skipped/
 *     failed/persisted 统计返 SchedulerService 写 execution_log
 *
 * 关键不变量:
 *   - dry_run=true 时**不**注入真 LLMSource (cron 跑灰度时不应触发 LLM 计费 + 不写)
 *   - 单 user service 内部 throw 已被 service 顶层 fail-OPEN 兜底, 但本 runner 仍
 *     套一层 per-user try/catch 防 ts-fake / 程序错误漏网
 *   - cron 默认 llm_source=null → service 走 heuristic 路径 (零外网链路); ops 想启
 *     LLM 改 ScheduledTask.parameters.enable_llm=true
 */

import { logger } from '../../utils/logger';
import {
  AI_DIARY_STATUS,
  AIDiaryDataSource,
  AIDiaryLLMSource,
  AIDiaryStatus,
  GenerateDiaryResult,
  generateForUser,
  PRODUCTION_AI_DIARY_DATA_SOURCE,
  PRODUCTION_AI_DIARY_LLM_SOURCE,
} from './AIDiaryService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认 cron 触发的 cron_run_id 前缀 (落 metadata.cron_run_id 便于 ops grep) */
export const AI_DIARY_CRON_RUN_ID_PREFIX = 'ai_diary_cron_';

/** dry_run 默认值 — cron 默认实际写入, 与 DAILY_ATTRIBUTION_GENERATE 对齐 */
export const DEFAULT_AI_DIARY_CRON_DRY_RUN = false;

/** 默认是否启 LLM — cron 默认走 heuristic 零外网链路, ops 显式启 LLM 才调远端 */
export const DEFAULT_AI_DIARY_CRON_ENABLE_LLM = false;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条 cron 触发的 user 处理结果 (供 SchedulerService 写 execution_log) */
export interface AIDiaryCronUserResult {
  user_id: number;
  status: AIDiaryStatus;
  reason: string | null;
  /** service throw 时的错误信息, 不含 stack */
  error?: string;
  /** 是否真正写入了 ai_diary_entries (dry_run / persist failed → false) */
  persisted: boolean;
}

/** 整批 cron 运行聚合结果 */
export interface AIDiaryCronRunSummary {
  total_users: number;
  ok_count: number;
  skipped_count: number;
  failed_count: number;
  /** 真正落库 (status=ok|skipped + persisted=true) 的笔数 */
  persisted_count: number;
  date: string;
  dry_run: boolean;
  enable_llm: boolean;
  /** 本批 cron_run_id, 落 metadata.cron_run_id (Ops 可 grep 同次跑的全部日记) */
  cron_run_id: string;
  /** 单 user 明细 (调用方按需写 execution_log.result_summary) */
  per_user: AIDiaryCronUserResult[];
}

/** cron 入口 options — 透传给 AIDiaryService.generateForUser + 控制 dry_run / 范围 */
export interface RunAIDiaryGenerateOptions {
  /** 'YYYY-MM-DD'; 默认今日 (Asia/Shanghai) — 透传给 generateForUser */
  date?: string;
  /** 显式 list user_id; 空 / undefined 时枚举所有 is_active=true */
  user_ids?: number[];
  /** dry_run=true 时透传给 service + 不注入真 LLMSource */
  dry_run?: boolean;
  /**
   * 是否启 LLM — true 注入 PRODUCTION LLMSource (axios POST trading_agents);
   * 默认 false (cron 跑零外网走 heuristic, 与 PM-006 cron 默认 ai_summary_source='off'
   * 同思想)
   */
  enable_llm?: boolean;
  /**
   * 单测 / 灰度时可注入 fake cron-side DataSource, 默认走 PRODUCTION lazy-require.
   */
  cron_data_source?: AIDiaryCronDataSource;
  /**
   * 单测 / 灰度时可注入 fake service-side DataSource (透传给 generateForUser).
   */
  service_data_source?: AIDiaryDataSource;
  /**
   * 单测 / 灰度时可注入 fake LLMSource (透传给 generateForUser); 显式注入时优先级
   * 高于 enable_llm 开关
   */
  llm_source?: AIDiaryLLMSource | null;
  /**
   * 显式 cron_run_id — 默认 `${PREFIX}${date}_${nowMs}`. ops 可显式传同一 id 让
   * 重试覆盖原 metadata.cron_run_id (与 sequelize upsert 配合达到 idempotent).
   */
  cron_run_id?: string;
}

/** Cron-side DataSource — 独立于 AIDiaryService 的 service-side DataSource */
export interface AIDiaryCronDataSource {
  /** 枚举待生成日记的 user_id; cron 默认 is_active=true 全部 */
  listActiveUsers(): Promise<Array<{ id: number }>>;
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require 让单测进程不需要 sequelize 起 DB
// ---------------------------------------------------------------------------

export function createProductionAIDiaryCronDataSource(): AIDiaryCronDataSource {
  return {
    async listActiveUsers() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { User } = require('../../models/User');
        const rows = await User.findAll({
          where: { is_active: true },
          attributes: ['id'],
          raw: true,
        });
        return (rows as Array<{ id: number }>).map(r => ({ id: Number(r.id) }));
      } catch (err) {
        logger.warn(
          `[ai-diary-cron] listActiveUsers failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
  };
}

const PRODUCTION_AI_DIARY_CRON_DATA_SOURCE: AIDiaryCronDataSource =
  createProductionAIDiaryCronDataSource();

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** 归一化日期到 'YYYY-MM-DD'; 与 normalizeAttributionDate 同款 (Asia/Shanghai UTC). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function normalizeDiaryCronDate(d: unknown): string {
  if (typeof d === 'string' && DATE_RE.test(d)) return d;
  if (typeof d === 'string' && d.length >= 10 && DATE_RE.test(d.slice(0, 10))) {
    return d.slice(0, 10);
  }
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 构造本批默认 cron_run_id — 形如 `ai_diary_cron_2026-06-20_1718856000000`.
 * 同一次 cron 跑里多用户共享同一 cron_run_id, ops grep metadata 一目了然.
 */
export function buildDefaultCronRunId(date: string): string {
  return `${AI_DIARY_CRON_RUN_ID_PREFIX}${date}_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * Cron 入口 — 枚举所有 active user, 逐个 generateForUser.
 *
 * fail-OPEN 双层:
 *   1. service 内部已 fail-OPEN (result.status='failed' / persisted=false) — caller
 *      直接消费 result 计数
 *   2. service throw (极端程序错误, e.g. fake/import 失败) → per-user try/catch
 *      兜底转 status='failed' reason='service_threw' + persisted=false
 *
 * dry_run=true 时**不**注入真 LLMSource — service 内部仍跑 (heuristic) 但 service
 * upsertDiaryEntry 路径取决于 caller 注入的 data_source 实现; 生产 PRODUCTION
 * dataSource.upsertDiaryEntry 不读 dry_run 标志 (UpsertRow 自带 metadata.dry_run
 * 由 caller 通过 cron_run_id 区分). 真正"零副作用 cron preview" 通过 explicit
 * cron_data_source.listActiveUsers 返 [] 实现.
 */
export async function runAIDiaryGenerate(
  options: RunAIDiaryGenerateOptions = {}
): Promise<AIDiaryCronRunSummary> {
  const cronSource = options.cron_data_source || PRODUCTION_AI_DIARY_CRON_DATA_SOURCE;
  const serviceSource = options.service_data_source || PRODUCTION_AI_DIARY_DATA_SOURCE;
  const date = normalizeDiaryCronDate(options.date);
  const dryRun = options.dry_run === true;
  const enableLlm = options.enable_llm === true;
  const cronRunId =
    typeof options.cron_run_id === 'string' && options.cron_run_id.length > 0
      ? options.cron_run_id
      : buildDefaultCronRunId(date);

  // LLM 注入优先级: 显式 llm_source > enable_llm + 非 dry_run > null (heuristic)
  // dry_run 时永不注入真 LLMSource (灰度不应触发 LLM 计费); explicit fake llm_source
  // 仍透传供单测验证 dry_run+llm_source 组合.
  let llmSource: AIDiaryLLMSource | null;
  if (options.llm_source !== undefined) {
    llmSource = options.llm_source;
  } else if (enableLlm && !dryRun) {
    llmSource = PRODUCTION_AI_DIARY_LLM_SOURCE;
  } else {
    llmSource = null;
  }

  // 枚举 user 范围 — 显式 list 优先, 否则枚举 active
  let targets: Array<{ id: number }> = [];
  if (Array.isArray(options.user_ids) && options.user_ids.length > 0) {
    targets = options.user_ids
      .filter(id => Number.isFinite(id) && Number(id) > 0)
      .map(id => ({ id: Number(id) }));
  } else {
    try {
      targets = await cronSource.listActiveUsers();
    } catch (err) {
      logger.warn(
        `[ai-diary-cron] listActiveUsers threw (treat as empty): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      targets = [];
    }
  }

  const summary: AIDiaryCronRunSummary = {
    total_users: targets.length,
    ok_count: 0,
    skipped_count: 0,
    failed_count: 0,
    persisted_count: 0,
    date,
    dry_run: dryRun,
    enable_llm: enableLlm,
    cron_run_id: cronRunId,
    per_user: [],
  };

  for (const target of targets) {
    const userId = target.id;
    let result: GenerateDiaryResult;
    let serviceError: string | undefined;
    try {
      result = await generateForUser(userId, {
        date,
        data_source: serviceSource,
        llm_source: llmSource,
        cron_run_id: cronRunId,
      });
    } catch (err) {
      // service 自身已 fail-OPEN 不该 throw — 兜底转 failed
      logger.warn(
        `[ai-diary-cron] generateForUser user=${userId} date=${date} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      serviceError = err instanceof Error ? err.message : String(err);
      result = {
        status: AI_DIARY_STATUS.FAILED,
        text: '',
        source: 'heuristic',
        reason: 'service_threw',
        evidence: {},
        persisted: false,
      };
    }

    if (result.status === AI_DIARY_STATUS.OK) summary.ok_count += 1;
    else if (result.status === AI_DIARY_STATUS.SKIPPED) summary.skipped_count += 1;
    else summary.failed_count += 1;
    if (result.persisted) summary.persisted_count += 1;

    summary.per_user.push({
      user_id: userId,
      status: result.status,
      reason: result.reason,
      error: serviceError,
      persisted: result.persisted,
    });
  }

  return summary;
}

// 测试 / 调试用 — 暴露 PRODUCTION singleton 让外部 wiring 测试可拿到默认实例
export const __PRODUCTION_AI_DIARY_CRON_DATA_SOURCE_FOR_TEST = PRODUCTION_AI_DIARY_CRON_DATA_SOURCE;
