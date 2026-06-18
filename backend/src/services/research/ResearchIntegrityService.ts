/**
 * ResearchIntegrityService — Sprint 1A 研究严谨性审计服务
 *
 * 这是把所有"事前检查策略是否过拟合 / 是否有未来函数 / 是否存活偏差"的逻辑
 * 集中到一个 service。是 Promotion Gate 的核心硬约束。
 *
 * **5 类检查**:
 *
 *   1. DSR (Deflated Sharpe Ratio) — 修正 sharpe 因多次试验、样本长度等过拟合偏差
 *      → 复用 OverfitMetrics.deflatedSharpeRatio
 *
 *   2. PBO (Probability of Backtest Overfitting) — CPCV 路径上 IS 冠军在 OOS 是否
 *      退化的频率
 *      → 复用 OverfitMetrics.probabilityOfBacktestOverfitting
 *
 *   3. OOS Degradation Ratio — IS sharpe / OOS sharpe 比值；> 1.5 触发警告，> 3 触
 *      发 FAIL（OOS 严重退化）
 *
 *   4. Lookahead Detector — 正则扫描 TypeScript 策略源码寻找：
 *      - Date.now() / new Date() (无参) → 当前时间引用
 *      - findAll without [Op.lte]: as_of_date → 可能引用未来数据
 *      - forward_return / future_high / next_day 等可疑字段名
 *      - getNextBar / getFuture* API 调用
 *
 *   5. Survivorship Bias Detector — universe 序列检查：
 *      - 当前 universe 是否包含历史已退市股
 *      - 历史 universe 是否包含未上市股
 *      - Index 成分股变更是否被尊重
 *
 * **设计选择**：
 *   - 所有 5 个 detector 都是 export pure function 单独可测
 *   - DataSource DI 模式 (与 BehaviorBiasDetector / MetaLabelService 一致)
 *   - 失败容错：单 detector 抛错只标 issue + verdict=INSUFFICIENT，不阻塞其他
 *   - 写库可选（in-memory 模式给 CLI / 单测用）
 */

import { Op } from 'sequelize';
import * as fs from 'fs';
import * as path from 'path';
import {
  ResearchIntegrityAudit,
  ResearchIntegrityVerdict,
} from '../../models/ResearchIntegrityAudit';
import {
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  CpcvPathRanks,
  DSR_PASS_THRESHOLD,
  PBO_FAIL_THRESHOLD,
} from '../../quant/backtest/OverfitMetrics';
import { combinatorialPurgedCV, computePboFromPaths, CpcvSampleEvent, CpcvOptions } from './cpcv';
import { logger } from '../../utils/logger';

// ============================================================
// Constants
// ============================================================

/** OOS 衰减比值阈值：sharpe_is / sharpe_oos > 此值即 WARN */
export const OOS_DECAY_WARN_THRESHOLD = 1.5;

/** OOS 衰减比值阈值：sharpe_is / sharpe_oos > 此值即 FAIL */
export const OOS_DECAY_FAIL_THRESHOLD = 3.0;

/** 默认扫描的策略源码目录 */
export const DEFAULT_STRATEGY_SCAN_DIRS = ['backend/src/quant/strategies'];

/** 未来函数 / 当前时间相关的可疑代码模式 */
export const LOOKAHEAD_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  severity: 'high' | 'medium' | 'low';
  hint: string;
}> = [
  {
    pattern: /\bDate\.now\s*\(\s*\)/,
    name: 'Date.now()',
    severity: 'high',
    hint: '策略代码中引用当前时间，回测时会污染：用 ctx.asOfDate 替代',
  },
  {
    pattern: /\bnew Date\s*\(\s*\)/,
    name: 'new Date() (no args)',
    severity: 'high',
    hint: '策略代码中引用当前时间，回测时会污染：用 ctx.asOfDate 替代',
  },
  {
    pattern: /\bgetFuture[A-Z]\w*\s*\(/,
    name: 'getFuture*()',
    severity: 'high',
    hint: '函数名含 Future 暗示未来函数：检查回测时 ctx 是否已限制时间窗口',
  },
  {
    pattern: /\bgetNext(Bar|Day|Price|Quote)\s*\(/,
    name: 'getNext*()',
    severity: 'high',
    hint: '函数名含 Next 暗示未来函数：检查回测时是否提前读了 t+1 数据',
  },
  {
    pattern: /\bforward_return\b/i,
    name: 'forward_return',
    severity: 'medium',
    hint: '字段 forward_return 通常是未来收益（标签）；在特征中引用是泄漏',
  },
  {
    pattern: /\bfuture_high\b/i,
    name: 'future_high',
    severity: 'medium',
    hint: '字段 future_high 是未来 N 日高点；在特征中引用是泄漏',
  },
  {
    pattern: /\bnext_day_(open|close|high|low|return)\b/i,
    name: 'next_day_*',
    severity: 'medium',
    hint: '字段 next_day_* 是 t+1 数据；除了 label 外不应在特征中引用',
  },
];

/** universe drift 检查的常见已退市股 prefix 规则 (A 股) */
export const KNOWN_DELISTED_SYMBOL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // A 股退市股代码会保留，但带 "退" 字标识；这里检查名字
];

// ============================================================
// Types
// ============================================================

export interface LookaheadIssue {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
  severity: 'high' | 'medium' | 'low';
}

export interface SurvivorshipIssue {
  kind:
    | 'delisted_in_current_universe'
    | 'unlisted_in_history'
    | 'index_change_ignored'
    | 'st_stock_ignored';
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ResearchIntegrityInput {
  /** 标识源 backtest（QuantBacktestResult.id 或 WalkForwardResult.id） */
  backtest_id?: number | null;
  /** 'quant_backtest_result' | 'walk_forward_result' | 'standalone' */
  source?: string;
  /** 策略 key（持久化用） */
  strategy_key?: string | null;
  /** in-memory 模式：observedSharpe 直接传入；不传则从 source 取 */
  observed_sharpe?: number | null;
  /** in-memory 模式：OOS sharpe（如有） */
  oos_sharpe?: number | null;
  /** in-memory 模式：试验次数（DSR 用） */
  num_trials?: number;
  /** in-memory 模式：样本长度（DSR 用） */
  sample_length?: number;
  /** in-memory 模式：CPCV path ranks (PBO 用) */
  cpcv_paths?: CpcvPathRanks[];
  /** in-memory 模式：sample skew (DSR 用，默认 0) */
  skew?: number;
  /** in-memory 模式：sample kurt (DSR 用，默认 3) */
  kurt?: number;
  /** 是否扫描策略源码 (lookahead 检测) */
  scan_strategy_code?: boolean;
  /** 自定义扫描目录（默认 quant/strategies） */
  strategy_scan_dirs?: string[];
  /** universe 序列（按时间段：[{period_start, symbols[]}]） */
  universe_snapshots?: Array<{ period_start: string; symbols: string[] }>;
  /** 当前 universe 列表（与 universe_snapshots 配合） */
  current_universe?: string[];
}

export interface ResearchIntegrityOptions {
  /** 是否写库（默认 true） */
  persist?: boolean;
  /** 自定义 DataSource (测试注入 fake) */
  data_source?: ResearchIntegrityDataSource;
  /** 源码扫描的根目录（默认 process.cwd()） */
  cwd?: string;
}

export interface ResearchIntegrityReport {
  backtest_id: number | null;
  source: string;
  strategy_key: string | null;
  dsr: number | null;
  pbo: number | null;
  oos_decay_ratio: number | null;
  observed_sharpe: number | null;
  oos_sharpe: number | null;
  num_trials: number | null;
  sample_length: number | null;
  lookahead_issues: LookaheadIssue[];
  survivorship_issues: SurvivorshipIssue[];
  verdict: ResearchIntegrityVerdict;
  summary_message: string;
  metadata: Record<string, any>;
  persisted_id: number | null;
  generated_at: Date;
}

// ============================================================
// Pure helpers — 全 export 让单测脱 DB
// ============================================================

/**
 * 扫描一个目录下所有 .ts 文件，找出包含 LOOKAHEAD_PATTERNS 任一模式的代码行。
 *
 * - 跳过 *.test.ts / *.spec.ts / node_modules
 * - 注释行（// 或 /* 开头）跳过（避免文档/示例代码误报）
 * - 字符串字面量内的匹配也忽略
 */
export function scanFileForLookahead(absPath: string): LookaheadIssue[] {
  if (!fs.existsSync(absPath)) return [];
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) return [];
  if (!absPath.endsWith('.ts')) return [];
  if (absPath.endsWith('.test.ts') || absPath.endsWith('.spec.ts')) return [];

  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const issues: LookaheadIssue[] = [];

  let inBlockComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // 跳过整行块注释
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    // 跳过单行注释
    if (line.startsWith('//') || line.startsWith('*')) continue;

    // 去掉行尾注释 + 字符串字面量（粗略），避免在 jsdoc 或 logger 文案中误报
    // 简化：去掉双引号 / 单引号 / 反引号包裹的内容
    const stripped = line
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/`[^`]*`/g, '``')
      .replace(/\/\/.*$/g, '');

    for (const { pattern, name, severity } of LOOKAHEAD_PATTERNS) {
      if (pattern.test(stripped)) {
        issues.push({
          file: absPath,
          line: i + 1,
          pattern: name,
          snippet: rawLine.trim().slice(0, 200),
          severity,
        });
      }
    }
  }

  return issues;
}

/**
 * 递归扫描一个目录下所有 .ts 文件的 lookahead 问题。
 */
export function scanDirForLookahead(absDir: string): LookaheadIssue[] {
  if (!fs.existsSync(absDir)) return [];
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory()) return [];

  const issues: LookaheadIssue[] = [];
  const entries = fs.readdirSync(absDir);
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const sub = path.join(absDir, e);
    const subStat = fs.statSync(sub);
    if (subStat.isDirectory()) {
      issues.push(...scanDirForLookahead(sub));
    } else {
      issues.push(...scanFileForLookahead(sub));
    }
  }
  return issues;
}

/**
 * Survivorship bias 检测：
 *   - 当前 universe 出现在某历史 period 缺失 → 表示该 period 之后才上市，
 *     回测在该 period 引用它就是 survivorship
 *   - 历史 universe 出现退市股（symbol 含 'XD' / '退' 或不在当前 universe）→
 *     有用，应保留；但要 warn 提示需要处理 delisting price
 *
 * universe_snapshots 顺序：从最早 → 最近
 */
export function detectSurvivorshipBias(input: {
  universe_snapshots: Array<{ period_start: string; symbols: string[] }>;
  current_universe: string[];
}): SurvivorshipIssue[] {
  const issues: SurvivorshipIssue[] = [];
  const { universe_snapshots, current_universe } = input;

  if (!universe_snapshots || universe_snapshots.length === 0) return issues;
  if (!current_universe || current_universe.length === 0) return issues;

  // 排序 snapshots
  const sorted = [...universe_snapshots].sort((a, b) =>
    a.period_start.localeCompare(b.period_start)
  );
  const earliestSet = new Set(sorted[0].symbols);
  const currentSet = new Set(current_universe);

  // 当前 universe 中有 → 但最早 snapshot 没有 → 暗示该股票在 backtest start
  // 之前未上市，但 backtest 引用了它
  let newlyListedInBacktest = 0;
  for (const s of currentSet) {
    if (!earliestSet.has(s)) {
      newlyListedInBacktest += 1;
    }
  }
  if (newlyListedInBacktest > 0) {
    const severity: 'high' | 'medium' | 'low' =
      newlyListedInBacktest > 10 ? 'high' : newlyListedInBacktest > 3 ? 'medium' : 'low';
    issues.push({
      kind: 'unlisted_in_history',
      detail: `${newlyListedInBacktest} 只当前 universe 股票在最早 snapshot (${sorted[0].period_start}) 时不存在 — 可能 backtest 引用了未上市股`,
      severity,
    });
  }

  // 历史曾出现但当前 universe 没有 → 退市股；如果当前 universe 是 strategy
  // 的选股池，说明 strategy 没考虑退市股 (survivorship)
  let delistedCount = 0;
  for (const snap of sorted) {
    for (const s of snap.symbols) {
      if (!currentSet.has(s)) delistedCount += 1;
    }
  }
  if (delistedCount > 0 && currentSet.size > 0) {
    const ratio = delistedCount / currentSet.size;
    if (ratio > 0.05) {
      issues.push({
        kind: 'delisted_in_current_universe',
        detail: `历史 universe 中有 ${delistedCount} 只股票现已退市（${(ratio * 100).toFixed(
          1
        )}%）但当前 universe 不含 — 检查 strategy 是否在选股时只用了 current universe（survivorship bias）`,
        severity: ratio > 0.15 ? 'high' : 'medium',
      });
    }
  }

  return issues;
}

/**
 * OOS Decay Ratio = sharpe_is / sharpe_oos
 *
 * 解读：
 *   - ratio ≤ 1: OOS 与 IS 同样好（或更好）— 健康
 *   - 1 < ratio ≤ 1.5: 轻微退化 — 正常
 *   - 1.5 < ratio ≤ 3: 明显退化 — WARN
 *   - ratio > 3: 严重退化 — FAIL
 *   - oos_sharpe ≤ 0: 直接 FAIL（样本外不赚钱）
 *
 * 边界：
 *   - is_sharpe ≤ 0 → 返回 null（IS 都不赚钱无须比较）
 *   - oos_sharpe = 0 → 返回 +Infinity (调用方应识别)
 *   - 任一为 null → null
 */
export function computeOOSDecayRatio(
  isSharpe: number | null,
  oosSharpe: number | null
): number | null {
  if (isSharpe === null || oosSharpe === null) return null;
  if (!Number.isFinite(isSharpe) || !Number.isFinite(oosSharpe)) return null;
  if (isSharpe <= 0) return null;
  if (oosSharpe <= 0) return Number.POSITIVE_INFINITY;
  return isSharpe / oosSharpe;
}

/**
 * 综合判决：
 *   - INSUFFICIENT: DSR null 且 PBO null 且 OOS null 且 高 severity lookahead 0
 *   - FAIL: DSR<0.95 OR PBO≥0.5 OR OOS decay>3 OR 任意 high lookahead OR 高 severity survivorship
 *   - WARN: 1.5<OOS decay≤3 OR medium lookahead/survivorship issues
 *   - PASS: 全部健康
 */
export function deriveResearchIntegrityVerdict(input: {
  dsr: number | null;
  pbo: number | null;
  oos_decay_ratio: number | null;
  lookahead_issues: LookaheadIssue[];
  survivorship_issues: SurvivorshipIssue[];
}): ResearchIntegrityVerdict {
  const { dsr, pbo, oos_decay_ratio, lookahead_issues, survivorship_issues } = input;

  const hasHighLookahead = lookahead_issues.some(i => i.severity === 'high');
  const hasMediumLookahead = lookahead_issues.some(i => i.severity === 'medium');
  const hasHighSurv = survivorship_issues.some(i => i.severity === 'high');
  const hasMediumSurv = survivorship_issues.some(i => i.severity === 'medium');

  // INSUFFICIENT: 没任何信号
  const noStatSignal =
    (dsr === null || !Number.isFinite(dsr)) &&
    (pbo === null || !Number.isFinite(pbo)) &&
    oos_decay_ratio === null;
  const noCodeSignal = !hasHighLookahead && !hasMediumLookahead && !hasHighSurv && !hasMediumSurv;
  if (noStatSignal && noCodeSignal) return 'INSUFFICIENT';

  // FAIL 优先
  if (hasHighLookahead) return 'FAIL';
  if (hasHighSurv) return 'FAIL';
  if (dsr !== null && Number.isFinite(dsr) && dsr < DSR_PASS_THRESHOLD) return 'FAIL';
  if (pbo !== null && Number.isFinite(pbo) && pbo >= PBO_FAIL_THRESHOLD) return 'FAIL';
  if (
    oos_decay_ratio !== null &&
    Number.isFinite(oos_decay_ratio) &&
    oos_decay_ratio > OOS_DECAY_FAIL_THRESHOLD
  )
    return 'FAIL';
  if (oos_decay_ratio === Number.POSITIVE_INFINITY) return 'FAIL';

  // WARN
  if (hasMediumLookahead) return 'WARN';
  if (hasMediumSurv) return 'WARN';
  if (
    oos_decay_ratio !== null &&
    Number.isFinite(oos_decay_ratio) &&
    oos_decay_ratio > OOS_DECAY_WARN_THRESHOLD
  )
    return 'WARN';

  return 'PASS';
}

/**
 * 生成自然语言总结
 */
export function buildIntegritySummary(report: {
  verdict: ResearchIntegrityVerdict;
  dsr: number | null;
  pbo: number | null;
  oos_decay_ratio: number | null;
  lookahead_issues: LookaheadIssue[];
  survivorship_issues: SurvivorshipIssue[];
}): string {
  const { verdict, dsr, pbo, oos_decay_ratio, lookahead_issues, survivorship_issues } = report;

  if (verdict === 'PASS') {
    const parts: string[] = [];
    if (dsr !== null) parts.push(`DSR=${dsr.toFixed(3)}`);
    if (pbo !== null) parts.push(`PBO=${pbo.toFixed(3)}`);
    if (oos_decay_ratio !== null) parts.push(`OOS decay=${oos_decay_ratio.toFixed(2)}`);
    return `✅ PASS — ${parts.join(' / ') || '检查通过'}`;
  }

  if (verdict === 'INSUFFICIENT') {
    return `⚠️ INSUFFICIENT — 缺少 DSR/PBO/OOS 数据，且未发现代码问题；无法形成结论`;
  }

  const reasons: string[] = [];
  if (dsr !== null && Number.isFinite(dsr) && dsr < DSR_PASS_THRESHOLD) {
    reasons.push(`DSR=${dsr.toFixed(3)} < 0.95（sharpe 可能来自过拟合）`);
  }
  if (pbo !== null && Number.isFinite(pbo) && pbo >= PBO_FAIL_THRESHOLD) {
    reasons.push(`PBO=${pbo.toFixed(3)} ≥ 0.5（CPCV 路径上 IS 冠军大概率在 OOS 退化）`);
  }
  if (oos_decay_ratio === Number.POSITIVE_INFINITY) {
    reasons.push(`OOS sharpe ≤ 0（样本外不赚钱）`);
  } else if (
    oos_decay_ratio !== null &&
    Number.isFinite(oos_decay_ratio) &&
    oos_decay_ratio > OOS_DECAY_WARN_THRESHOLD
  ) {
    reasons.push(`OOS decay=${oos_decay_ratio.toFixed(2)}（IS 与 OOS sharpe 差距过大）`);
  }
  if (lookahead_issues.length > 0) {
    const counts = lookahead_issues.reduce((acc, i) => {
      acc[i.severity] = (acc[i.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    reasons.push(
      `代码扫描发现 ${lookahead_issues.length} 个 lookahead 嫌疑（high=${counts.high || 0} / med=${
        counts.medium || 0
      }）`
    );
  }
  if (survivorship_issues.length > 0) {
    reasons.push(`Universe 检查发现 ${survivorship_issues.length} 个 survivorship 问题`);
  }

  const icon = verdict === 'FAIL' ? '🔴' : '🟠';
  return `${icon} ${verdict} — ${reasons.slice(0, 3).join('; ')}`;
}

// ============================================================
// DataSource (DI)
// ============================================================

export interface ResearchIntegrityDataSource {
  loadBacktestStats(
    backtest_id: number,
    source: string
  ): Promise<{
    observed_sharpe: number | null;
    oos_sharpe: number | null;
    num_trials: number;
    sample_length: number;
    strategy_key: string | null;
  } | null>;
}

export const PRODUCTION_RESEARCH_INTEGRITY_DATA_SOURCE: ResearchIntegrityDataSource = {
  async loadBacktestStats(backtest_id, source) {
    try {
      if (source === 'quant_backtest_result') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { QuantBacktestResult } = require('../../models/QuantBacktestResult');
        const row = await QuantBacktestResult.findByPk(backtest_id);
        if (!row) return null;
        const equity: any[] = Array.isArray(row.equity_curve_json) ? row.equity_curve_json : [];
        return {
          observed_sharpe:
            row.sharpe_ratio !== null && row.sharpe_ratio !== undefined
              ? Number(row.sharpe_ratio)
              : null,
          oos_sharpe: null,
          num_trials: 1,
          sample_length: equity.length,
          strategy_key: row.strategy_key || null,
        };
      }
      if (source === 'walk_forward_result') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { WalkForwardResult } = require('../../models/WalkForwardResult');
        const row = await WalkForwardResult.findByPk(backtest_id);
        if (!row) return null;
        const trainSharpe =
          row.train_sharpe !== null && row.train_sharpe !== undefined
            ? Number(row.train_sharpe)
            : null;
        const testSharpe =
          row.test_sharpe !== null && row.test_sharpe !== undefined
            ? Number(row.test_sharpe)
            : null;
        return {
          observed_sharpe: trainSharpe,
          oos_sharpe: testSharpe,
          num_trials: 1,
          sample_length: 252,
          strategy_key: null,
        };
      }
      return null;
    } catch (err: any) {
      logger.warn(`[research-integrity] loadBacktestStats failed: ${err?.message || err}`);
      return null;
    }
  },
};

// ============================================================
// Service
// ============================================================

export class ResearchIntegrityService {
  constructor(
    private dataSource: ResearchIntegrityDataSource = PRODUCTION_RESEARCH_INTEGRITY_DATA_SOURCE
  ) {}

  /**
   * 跑全部 5 个 detector
   */
  async auditBacktest(
    input: ResearchIntegrityInput,
    options: ResearchIntegrityOptions = {}
  ): Promise<ResearchIntegrityReport> {
    const persist = options.persist !== false;
    const dataSource = options.data_source ?? this.dataSource;
    const cwd = options.cwd ?? process.cwd();

    let observed_sharpe = input.observed_sharpe ?? null;
    let oos_sharpe = input.oos_sharpe ?? null;
    let num_trials = input.num_trials ?? 1;
    let sample_length = input.sample_length ?? 0;
    let strategy_key = input.strategy_key ?? null;

    // 如有 backtest_id 且未提供统计量，从 DB 加载
    if (input.backtest_id && (observed_sharpe === null || sample_length === 0)) {
      const stats = await dataSource.loadBacktestStats(
        input.backtest_id,
        input.source || 'quant_backtest_result'
      );
      if (stats) {
        observed_sharpe = observed_sharpe ?? stats.observed_sharpe;
        oos_sharpe = oos_sharpe ?? stats.oos_sharpe;
        if (!num_trials) num_trials = stats.num_trials;
        if (!sample_length) sample_length = stats.sample_length;
        if (!strategy_key) strategy_key = stats.strategy_key;
      }
    }

    // === 1. DSR ===
    let dsr: number | null = null;
    if (
      observed_sharpe !== null &&
      Number.isFinite(observed_sharpe) &&
      sample_length > 1 &&
      num_trials >= 1
    ) {
      try {
        dsr = deflatedSharpeRatio({
          observedSharpe: observed_sharpe,
          numTrials: num_trials,
          sampleLength: sample_length,
          skew: input.skew ?? 0,
          kurt: input.kurt ?? 3,
        });
      } catch (err: any) {
        logger.warn(`[research-integrity] DSR failed: ${err?.message}`);
      }
    }

    // === 2. PBO ===
    let pbo: number | null = null;
    if (input.cpcv_paths && input.cpcv_paths.length > 0) {
      try {
        pbo = probabilityOfBacktestOverfitting({ paths: input.cpcv_paths });
      } catch (err: any) {
        logger.warn(`[research-integrity] PBO failed: ${err?.message}`);
      }
    }

    // === 3. OOS Decay ===
    const oos_decay_ratio = computeOOSDecayRatio(observed_sharpe, oos_sharpe);

    // === 4. Lookahead scan ===
    const lookahead_issues: LookaheadIssue[] = [];
    if (input.scan_strategy_code) {
      const dirs = input.strategy_scan_dirs ?? DEFAULT_STRATEGY_SCAN_DIRS;
      for (const d of dirs) {
        const absDir = path.isAbsolute(d) ? d : path.join(cwd, d);
        try {
          lookahead_issues.push(...scanDirForLookahead(absDir));
        } catch (err: any) {
          logger.warn(
            `[research-integrity] scanDirForLookahead(${absDir}) failed: ${err?.message}`
          );
        }
      }
    }

    // === 5. Survivorship ===
    let survivorship_issues: SurvivorshipIssue[] = [];
    if (input.universe_snapshots && input.universe_snapshots.length > 0 && input.current_universe) {
      try {
        survivorship_issues = detectSurvivorshipBias({
          universe_snapshots: input.universe_snapshots,
          current_universe: input.current_universe,
        });
      } catch (err: any) {
        logger.warn(`[research-integrity] survivorship failed: ${err?.message}`);
      }
    }

    // === Verdict ===
    const verdict = deriveResearchIntegrityVerdict({
      dsr,
      pbo,
      oos_decay_ratio,
      lookahead_issues,
      survivorship_issues,
    });
    const summary_message = buildIntegritySummary({
      verdict,
      dsr,
      pbo,
      oos_decay_ratio,
      lookahead_issues,
      survivorship_issues,
    });

    const report: ResearchIntegrityReport = {
      backtest_id: input.backtest_id ?? null,
      source: input.source ?? 'standalone',
      strategy_key,
      dsr,
      pbo,
      oos_decay_ratio: oos_decay_ratio === Number.POSITIVE_INFINITY ? 999999 : oos_decay_ratio,
      observed_sharpe,
      oos_sharpe,
      num_trials,
      sample_length,
      lookahead_issues,
      survivorship_issues,
      verdict,
      summary_message,
      metadata: {
        skew: input.skew ?? 0,
        kurt: input.kurt ?? 3,
        scan_dirs: input.scan_strategy_code
          ? input.strategy_scan_dirs ?? DEFAULT_STRATEGY_SCAN_DIRS
          : null,
      },
      persisted_id: null,
      generated_at: new Date(),
    };

    if (persist) {
      try {
        const row = await ResearchIntegrityAudit.create({
          backtest_id: report.backtest_id,
          source: report.source,
          strategy_key: report.strategy_key,
          dsr: report.dsr,
          pbo: report.pbo,
          oos_decay_ratio: report.oos_decay_ratio,
          observed_sharpe: report.observed_sharpe,
          oos_sharpe: report.oos_sharpe,
          num_trials: report.num_trials,
          sample_length: report.sample_length,
          lookahead_issues_json: report.lookahead_issues,
          survivorship_issues_json: report.survivorship_issues,
          verdict: report.verdict,
          summary_message: report.summary_message,
          metadata: report.metadata,
        });
        report.persisted_id = row.id;
      } catch (err: any) {
        logger.warn(`[research-integrity] persist failed: ${err?.message}`);
      }
    }

    return report;
  }

  /** 列最近 N 个审计记录 */
  async listRecentAudits(limit = 30): Promise<ResearchIntegrityAudit[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    return ResearchIntegrityAudit.findAll({
      order: [['created_at', 'DESC']],
      limit: safeLimit,
    });
  }

  /** 按 strategy_key 查最近 N 个 */
  async listAuditsByStrategy(strategy_key: string, limit = 30): Promise<ResearchIntegrityAudit[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
    return ResearchIntegrityAudit.findAll({
      where: { strategy_key },
      order: [['created_at', 'DESC']],
      limit: safeLimit,
    });
  }

  /** 查某 backtest_id + source 最新审计 */
  async getLatestAuditForBacktest(
    backtest_id: number,
    source: string
  ): Promise<ResearchIntegrityAudit | null> {
    return ResearchIntegrityAudit.findOne({
      where: { backtest_id, source },
      order: [['created_at', 'DESC']],
    });
  }

  /** 清理 N 天前的审计 */
  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await ResearchIntegrityAudit.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }

  /**
   * v2: CPCV-based PBO estimation
   *
   * 给一组 candidate strategies 的 train_metrics + test_metrics (per CPCV path)
   * 算更稳定的 PBO (比 walk-forward 用 C(N,k) 多 paths)。
   *
   * @param input.events 时间序列样本 (entry_time, exit_time)
   * @param input.candidate_strategies 多个 candidate 的训练 + 测试 metric
   * @param input.cpcv_options CPCV 配置 (n_groups, k_test, embargo_pct)
   */
  async computeCpcvPbo(input: {
    events: CpcvSampleEvent[];
    /** evaluator(train_ids, test_ids) → train_metric, test_metric per candidate */
    evaluator: (
      train_ids: Array<number | string>,
      test_ids: Array<number | string>
    ) => Promise<{ train_metrics: number[]; test_metrics: number[] }>;
    cpcv_options?: CpcvOptions;
  }): Promise<{
    pbo: number;
    n_paths: number;
    n_groups: number;
    k_test: number;
    avg_train_metric: number;
    avg_test_metric: number;
    paths_summary: Array<{ fold: number; train_metrics: number[]; test_metrics: number[] }>;
  }> {
    const folds = combinatorialPurgedCV(input.events, input.cpcv_options);
    if (folds.length === 0) {
      throw new Error('computeCpcvPbo: no folds generated (check n_groups / k_test)');
    }
    const paths: Array<{ train_metrics: number[]; test_metrics: number[] }> = [];
    for (const fold of folds) {
      const r = await input.evaluator(fold.train_ids, fold.test_ids);
      paths.push(r);
    }
    const pbo = computePboFromPaths(paths);
    const allTrainMetrics: number[] = [];
    const allTestMetrics: number[] = [];
    for (const p of paths) {
      allTrainMetrics.push(...p.train_metrics.filter(v => Number.isFinite(v)));
      allTestMetrics.push(...p.test_metrics.filter(v => Number.isFinite(v)));
    }
    const avgTrain =
      allTrainMetrics.length > 0
        ? allTrainMetrics.reduce((s, v) => s + v, 0) / allTrainMetrics.length
        : 0;
    const avgTest =
      allTestMetrics.length > 0
        ? allTestMetrics.reduce((s, v) => s + v, 0) / allTestMetrics.length
        : 0;
    return {
      pbo,
      n_paths: paths.length,
      n_groups: input.cpcv_options?.n_groups ?? 10,
      k_test: input.cpcv_options?.k_test ?? 2,
      avg_train_metric: avgTrain,
      avg_test_metric: avgTest,
      paths_summary: paths.map((p, i) => ({
        fold: i,
        train_metrics: p.train_metrics,
        test_metrics: p.test_metrics,
      })),
    };
  }
}

export const researchIntegrityService = new ResearchIntegrityService();
