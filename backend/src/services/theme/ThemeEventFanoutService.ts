/**
 * ThemeEventFanoutService (卫星题材 fan-out → THEME_EVENT 信号) — 信号优先重构 批6c (§6.2-B)
 *
 * 卫星 20% (Satellite) 的信号生产者. `ThemeFermentationDetector` 是 soft-layer, 只写
 * theme_fermentation_phases 表 (每日 16:30 分类 5 阶段), **显式不写主信号表**. 本 service
 * 作为独立的 hard-signal 产出层, 读取当日已落库的 phase 行, 把 top_codes 扇出成个股信号
 * 写入 AIInvestmentSignal (source_type='theme_event'), 真正进主信号表供 §5 confidence /
 * EV gate / V3 展示消费.
 *
 * 编排 (§6.2 step-B):
 *   1. 读当日 theme_fermentation_phases 全行 (detector 已写完)
 *   2. per industry: decision 映射
 *        launch / outbreak → BUY, climax → SELL(减仓), recession / germinate → skip
 *   3. 解析 theme_id = <industry_slug>-<launch_date> (§2.3, 回溯 active streak 起点)
 *   4. fan-out top_codes (每题材上限 MAX_CODES_PER_THEME) → 每只个股一条 signal
 *   5. confidence: ConfidenceCalibrationService.calibrate(THEME_EVENT) — 冷启动 → 0
 *   6. 落 AIInvestmentSignal: action=BUY/SELL, theme_id, 卫星止损止盈 (-7% soft / +20% TP)
 *      幂等 findOrCreate by source_id = theme:<industry>:<trade_date>:<symbol>
 *
 * 触发: SchedulerService 每日 cron (THEME_EVENT_FANOUT), 在 THEME_FERMENTATION_DETECT 之后跑.
 *
 * §4.2 卫星硬边界 (单股 5% / 卫星总 20% / -7% soft / -15% hard / +20% TP / 21 日时间退出
 *   / 60 天滚动亏损 5% 冻结 / 3 月 alpha<0 永久停) — fan-out 只负责产生 BUY/SELL 意图信号,
 *   实际下单前的仓位/边界/EV gate 由下游执行层 (AutoExitService + PaperTrading EV gate) 裁决.
 */

import { Op } from 'sequelize';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../../models/AIInvestmentSignal';
import { ThemeFermentationPhase } from '../../models/ThemeFermentationPhase';
import { logger } from '../../utils/logger';
import {
  ConfidenceCalibrationService,
  confidenceCalibrationService,
  CalibrationMetrics,
} from '../calibration/ConfidenceCalibrationService';

/** detector 5 阶段 (与 ThemeFermentationDetector.FermentationPhase 同口径, 本层独立声明避免耦合). */
export type ThemePhase = 'germinate' | 'launch' | 'outbreak' | 'climax' | 'recession';

/** 阶段 → 是否 active (处于可持仓/减仓的题材生命周期内, 用于回溯 launch streak). */
const ACTIVE_PHASES: ReadonlySet<ThemePhase> = new Set<ThemePhase>([
  'launch',
  'outbreak',
  'climax',
]);

/** §6.2 decision 映射: launch/outbreak → BUY, climax → SELL(减仓), recession/germinate → skip. */
function mapPhaseToDecision(phase: ThemePhase): 'BUY' | 'SELL' | null {
  if (phase === 'launch' || phase === 'outbreak') return 'BUY';
  if (phase === 'climax') return 'SELL';
  return null; // germinate / recession → skip
}

/** industry_slug: 去空白, 保留原字符 (中文行业名直接入 theme_id, STRING(80) 容得下). */
function slugifyIndustry(industry: string): string {
  return (industry || '').trim().replace(/\s+/g, '-');
}

/** theme_id = <industry_slug>-<launch_date_compact> (§2.3), 例: 通信-20260615. */
export function buildThemeId(industry: string, launchDate: string): string {
  return `${slugifyIndustry(industry)}-${launchDate.slice(0, 10).replace(/-/g, '')}`;
}

/** 卫星止损止盈常量 (§4.2, 主动 -7% / 止盈 +20%; -15% 硬止损由 AutoExitService 无条件兜底). */
export const SATELLITE_SOFT_STOP_PCT = -7;
export const SATELLITE_TAKE_PROFIT_PCT = 20;
/** 单只题材股建议仓位 (§4.2 单股上限 5%). */
export const SATELLITE_SINGLE_SIZE_PCT = 5;
/** 每个题材最多扇出的个股数 (§4.2 目标持仓 3-4 只, 留 buffer 到 5). */
export const MAX_CODES_PER_THEME = 5;

export interface ThemeEventFanoutOptions {
  /** 交易日 YYYY-MM-DD (读 phase + 落 signal_date). 默认取中国今日. */
  tradeDate?: string;
  /** 覆盖每题材扇出上限. */
  maxCodesPerTheme?: number;
  /** 干跑: 只算不落库. */
  dryRun?: boolean;
}

export interface ThemeEventFanoutResult {
  trade_date: string;
  phases_scanned: number;
  themes_actionable: number;
  created: number;
  updated: number;
  skipped_phase: number;
  skipped_no_codes: number;
  dry_run: boolean;
}

/** 单只个股扇出中间产物. */
interface FanoutCandidate {
  industry: string;
  phase: ThemePhase;
  is_mainline: boolean;
  decision: 'BUY' | 'SELL';
  symbol: string;
  theme_id: string;
  composite_heat: number | null;
}

export class ThemeEventFanoutService {
  constructor(
    private readonly calibration: ConfidenceCalibrationService = confidenceCalibrationService
  ) {}

  /**
   * §6.2-A: 取最近一个有 phase 行的 trade_date (<= 今天). 若 phase 表全空返回今天.
   * 避免 cron 周末/节假日触发时对着空当天空转.
   */
  private async resolveLatestPhaseDate(): Promise<string> {
    const today = this.getChinaToday();
    try {
      const row: any = await ThemeFermentationPhase.findOne({
        attributes: ['trade_date'],
        where: { trade_date: { [Op.lte]: today } },
        order: [['trade_date', 'DESC']],
        raw: true,
      });
      if (row?.trade_date) return this.toDateStr(row.trade_date);
    } catch (e: any) {
      logger.warn(`[ThemeEventFanout] resolveLatestPhaseDate failed: ${e?.message || e}`);
    }
    return today;
  }

  private getChinaToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** YYYY-MM-DD 归一 (兼容 Date / string). */
  private toDateStr(v: any): string {
    if (typeof v === 'string') return v.slice(0, 10);
    try {
      return new Date(v).toISOString().slice(0, 10);
    } catch {
      return String(v);
    }
  }

  /**
   * 回溯该行业当前 active streak 的起点 (launch_date). 从 tradeDate 往前逐日看
   * theme_fermentation_phases, 连续 active(launch/outbreak/climax) 段的最早一天即 launch_date.
   * 若今日刚 launch 无历史 → launch_date = tradeDate. fail-open → tradeDate.
   */
  private async resolveLaunchDate(industry: string, tradeDate: string): Promise<string> {
    try {
      const rows: any[] = await ThemeFermentationPhase.findAll({
        attributes: ['trade_date', 'phase'],
        where: { industry },
        order: [['trade_date', 'DESC']],
        limit: 60,
        raw: true,
      });
      let launchDate = tradeDate;
      for (const r of rows) {
        const d = this.toDateStr(r.trade_date);
        if (d > tradeDate) continue; // 只看 <= tradeDate
        const p = String(r.phase || '') as ThemePhase;
        if (ACTIVE_PHASES.has(p)) {
          launchDate = d; // 仍在连续 active 段内, 继续往前推
        } else {
          break; // 遇到 germinate/recession → streak 断裂, 停
        }
      }
      return launchDate;
    } catch (e: any) {
      logger.warn(`[ThemeEventFanout] resolveLaunchDate failed industry=${industry}: ${e?.message || e}`);
      return tradeDate;
    }
  }

  /**
   * 主入口: 读当日 phase → fan-out top_codes → 落 THEME_EVENT 信号.
   */
  async runFanout(options: ThemeEventFanoutOptions = {}): Promise<ThemeEventFanoutResult> {
    // §6.2-A PR-O5: 未显式指定日期时, 挑"最近一个有 phase 行的交易日"而不是"今天"
    // (今天可能是周末/节假日/detector 尚未跑, phase 表当天为空 → fan-out 空转).
    const tradeDate = options.tradeDate ?? (await this.resolveLatestPhaseDate());
    const maxCodes = Number.isFinite(options.maxCodesPerTheme)
      ? Math.max(1, options.maxCodesPerTheme as number)
      : MAX_CODES_PER_THEME;

    const result: ThemeEventFanoutResult = {
      trade_date: tradeDate,
      phases_scanned: 0,
      themes_actionable: 0,
      created: 0,
      updated: 0,
      skipped_phase: 0,
      skipped_no_codes: 0,
      dry_run: !!options.dryRun,
    };

    // Step 1: 读当日 phase 行
    let phaseRows: any[] = [];
    try {
      phaseRows = await ThemeFermentationPhase.findAll({
        attributes: ['industry', 'phase', 'is_mainline', 'top_codes', 'composite_heat'],
        where: { trade_date: tradeDate },
        raw: true,
      });
    } catch (e: any) {
      logger.warn(`[ThemeEventFanout] load phases failed trade_date=${tradeDate}: ${e?.message || e}`);
      return result;
    }
    result.phases_scanned = phaseRows.length;
    if (phaseRows.length === 0) {
      logger.info(`[ThemeEventFanout] trade_date=${tradeDate} 无 phase 行, 无扇出`);
      return result;
    }

    // Step 2-4: 构建扇出候选
    const candidates: FanoutCandidate[] = [];
    for (const row of phaseRows) {
      const industry = String(row.industry || '');
      const phase = String(row.phase || '') as ThemePhase;
      const decision = mapPhaseToDecision(phase);
      if (!decision) {
        result.skipped_phase += 1;
        continue;
      }
      const topCodes: string[] = Array.isArray(row.top_codes)
        ? row.top_codes.map((x: any) => String(x)).filter(Boolean)
        : [];
      if (topCodes.length === 0) {
        result.skipped_no_codes += 1;
        continue;
      }
      result.themes_actionable += 1;
      const themeId = buildThemeId(industry, await this.resolveLaunchDate(industry, tradeDate));
      const isMainline = row.is_mainline === true;
      const compositeHeat =
        row.composite_heat == null ? null : Number(row.composite_heat);
      for (const symbol of topCodes.slice(0, maxCodes)) {
        candidates.push({
          industry,
          phase,
          is_mainline: isMainline,
          decision,
          symbol,
          theme_id: themeId,
          composite_heat: compositeHeat,
        });
      }
    }

    // Step 5: confidence (卫星整体 __all__, 冷启动 → 0)
    let confidenceMetrics: CalibrationMetrics | null = null;
    try {
      confidenceMetrics = await this.calibration.calibrate(
        AISignalSourceType.THEME_EVENT,
        '__all__',
        { asOfDate: tradeDate }
      );
    } catch (e: any) {
      logger.warn(`[ThemeEventFanout] confidence 计算失败 (fail-open): ${e?.message || e}`);
    }
    const confidence = confidenceMetrics?.confidence ?? 0;

    if (options.dryRun) {
      logger.info(
        `[ThemeEventFanout] DRY trade_date=${tradeDate} themes=${result.themes_actionable} ` +
          `candidates=${candidates.length} confidence=${confidence.toFixed(3)}`
      );
      return result;
    }

    // Step 6: 落库
    for (const c of candidates) {
      const { created, updated } = await this.persistSignal(c, { tradeDate, confidence });
      result.created += created;
      result.updated += updated;
    }

    logger.info(
      `[ThemeEventFanout] trade_date=${tradeDate} phases=${result.phases_scanned} ` +
        `themes=${result.themes_actionable} created=${result.created} updated=${result.updated} ` +
        `skip_phase=${result.skipped_phase} skip_nocodes=${result.skipped_no_codes} ` +
        `confidence=${confidence.toFixed(3)}`
    );
    return result;
  }

  /** 落单条 THEME_EVENT 个股信号 (幂等 by source_id = theme:<industry>:<trade_date>:<symbol>). */
  private async persistSignal(
    c: FanoutCandidate,
    ctx: { tradeDate: string; confidence: number }
  ): Promise<{ created: number; updated: number }> {
    const source_id = `theme:${c.industry}:${ctx.tradeDate}:${c.symbol}`;
    const decision = c.decision === 'BUY' ? AISignalDecision.BUY : AISignalDecision.SELL;
    const isBuy = c.decision === 'BUY';

    const payload: any = {
      source_type: AISignalSourceType.THEME_EVENT,
      source_id,
      symbol: c.symbol,
      signal_date: ctx.tradeDate,
      decision,
      normalized_decision: decision,
      // §2.2 Signal atom 新列
      action: c.decision,
      confidence: ctx.confidence,
      theme_id: c.theme_id,
      confidence_score: Math.round(ctx.confidence * 100),
      risk_level: 'high', // 卫星个股波动大
      // 卫星建仓意图: BUY 建议 5% 单股仓; SELL(减仓) 不建仓
      recommended_size_pct: isBuy ? SATELLITE_SINGLE_SIZE_PCT : undefined,
      // §4.2 主动止损 -7% / 止盈 +20% (仅 BUY 建仓时写; -15% 硬止损由 AutoExitService 无条件兜底)
      stop_loss_pct: isBuy ? SATELLITE_SOFT_STOP_PCT : undefined,
      take_profit_pct: isBuy ? SATELLITE_TAKE_PROFIT_PCT : undefined,
      // §2.2 进场方式: 题材股先观察 15 分钟再买 (个股开盘易被爆炒)
      entry_price_strategy: isBuy ? 'observe_15min' : undefined,
      rationale: `题材[${c.industry}] ${c.phase} 阶段${isBuy ? '启动/爆发 → 买入' : '高潮 → 减仓'}` +
        (c.is_mainline ? ' (主线)' : ''),
      detail: JSON.stringify({
        industry: c.industry,
        phase: c.phase,
        is_mainline: c.is_mainline,
        theme_id: c.theme_id,
        composite_heat: c.composite_heat,
      }),
      metadata: {
        theme_event: true,
        core_satellite_bucket: 'satellite',
        theme_id: c.theme_id,
        industry: c.industry,
        phase: c.phase,
        is_mainline: c.is_mainline,
        timing_tag: 'theme_phase',
      },
    };

    const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
      where: {
        source_type: AISignalSourceType.THEME_EVENT,
        source_id,
      },
      defaults: payload,
    });
    if (isCreated) return { created: 1, updated: 0 };

    // merge 更新, 保留下游写入的 paper_trading 字段
    const preservedKeys = ['paper_trading', 'paper_trading_by_portfolio'];
    const existingMeta = ((record as any).metadata || {}) as Record<string, any>;
    const mergedMeta: Record<string, any> = { ...existingMeta, ...payload.metadata };
    for (const key of preservedKeys) {
      if (existingMeta[key]) mergedMeta[key] = existingMeta[key];
    }
    await record.update({ ...payload, metadata: mergedMeta });
    return { created: 0, updated: 1 };
  }
}

export const themeEventFanoutService = new ThemeEventFanoutService();
