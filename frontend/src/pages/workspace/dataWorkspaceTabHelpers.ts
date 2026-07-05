/**
 * US-060 [FE-021] DataWorkspace 加厚 6 tab — 纯函数 helper.
 *
 * 把 DataWorkspace.tsx 的 KPI / 标题 / 副标题 / 颜色 / 操作建议 在 6 个 tab
 * 之间的差异抽到独立 module, 让每个 tab 都有 "真内容" — 切 tab 后 kpiSlot
 * 不再永远显示同一组 "数据源 / 严重滞后 / 轻微滞后", 而是按 tab 上下文
 * 切换 (e.g. '行情同步' tab 显示当日已同步多少个数据源 / 失败几个; '健康
 * 监控' tab 显示 4 级 level 计数 + 引用交易日; '系统日志' tab 显示告警级
 * 别数; '调度任务' / '个股趋势' / '数据健康' 各自维度).
 *
 * 同款思路: [[前端 pure helper 模板]] (US-049 / US-051 / US-052 / US-054 /
 * US-055 / US-057 / US-058 / US-059 / [[industryConcentrationKpiHelpers]]).
 *
 * 设计原则:
 *   - 任何 tab 的 view model 全部由同一份 `DataHealthStatusResponse | null`
 *     派生, 不引第二个 endpoint — 现阶段只有 /api/data/health-status 是稳定
 *     真值源, 其它 cron metrics 落在 legacy 页内独立 endpoint, helper 层
 *     不拉, 派生 KPI 用 health-status 就够 "6 tab 真内容".
 *   - null/缺数据全返 `loading=true` 视图模型, component 直接渲染 '—' /
 *     Spin 占位; helper 永不抛.
 *   - 阈值常量 export, 单测守 sanity.
 *   - 颜色与 [[DataHealthDashboard]] LEVEL_META 同色 (red=#f5222d /
 *     yellow=#faad14 / green=#52c41a / unknown=#bfbfbf), 用户跨 tab 认色
 *     不需要再学一遍.
 *   - WorkspaceLayout kpiSlot 高度固定 96px (workspace CLAUDE.md 第 31 行),
 *     每个 tab 最多塞 3-4 个 Statistic, 不超过 5 个.
 *
 * 纯函数, 不依赖 React/antd/fetch, 单测在
 * backend/tests/services/data-workspace-tab-helpers.test.ts.
 */

import type {
  DataHealthLevel,
  DataHealthStatusResponse,
  DataSourceCategory,
  DataSourceHealthBundle,
  DataSourceHealthCard,
  DataSourceProvider,
  DataSourceRoutingEntry,
} from '../../services/dataHealthService';

/** 6 个 tab 的稳定 key, 与 DataWorkspace.tsx 内 `tabs` 数组完全一致 — 修改前先核对. */
export const DATA_WORKSPACE_TAB_KEYS = [
  'health',
  'stocks',
  'sync',
  'tasks',
  'logs',
  'monitoring',
] as const;
export type DataWorkspaceTabKey = (typeof DATA_WORKSPACE_TAB_KEYS)[number];

/** 与 [[DataHealthDashboard]] LEVEL_META 同色 — 用户跨 tab 认色一致. */
export const DATA_HEALTH_COLOR: Readonly<Record<DataHealthLevel, string>> = Object.freeze({
  green: '#16a34a',
  yellow: '#faad14',
  red: '#dc2626',
  unknown: '#bfbfbf',
});

/** 数据健康 tab 标题文案. */
export const DATA_HEALTH_TAB_HEADLINE = '数据源健康度';

/** 行情同步 tab — "今日新鲜" 阈值 (lag_trading_days <= 0). */
export const SYNC_FRESH_MAX_LAG = 0;
/** 行情同步 tab — "落后但可控" 上限 (lag_trading_days ∈ (0, 3]). */
export const SYNC_STALE_MAX_LAG = 3;

/** 个股趋势 tab — A 股市场上市公司基数 (粗略, 用作 "本地覆盖率" 分母提示). */
export const STOCKS_UNIVERSE_HINT = 5500;

/** 系统日志 tab — 同步 source.error 字符串数即为 "异常源数". */

/** 一条 KPI 的渲染入参 — 颜色可选 (没有就走 antd 默认中性灰). */
export interface DataWorkspaceTabKpi {
  /** Statistic 标题. */
  title: string;
  /** Statistic 值; 数字或字符串均可. */
  value: number | string;
  /** Statistic suffix (可选, e.g. '个' / '%' / '条'). */
  suffix?: string;
  /** Statistic valueStyle.color (可选). */
  color?: string;
  /** Tooltip 上下文 (可选, 当前 component 不一定用). */
  tooltip?: string;
}

/** Header 右上角的 tag (可选, e.g. '⚠ 3 个数据源严重滞后' / '系统运行正常'). */
export interface DataWorkspaceHeaderTag {
  text: string;
  /** antd Tag color — green/red/orange/blue/default. */
  color: 'green' | 'red' | 'orange' | 'blue' | 'default';
}

/** Tab 上方的 "概览条" 一行说明 + KPI list. */
export interface DataWorkspaceTabViewModel {
  /** Tab key (回写, 让 component 一处 destructure). */
  tabKey: DataWorkspaceTabKey;
  /** 概览条主标题 ('数据健康' / '行情同步' ...). */
  headline: string;
  /** 概览条副标题 — 一句话说明这个 tab 干嘛. */
  subtitle: string;
  /** 顶部 KPI strip (替换 DataWorkspace 默认的固定 KPI). */
  kpis: DataWorkspaceTabKpi[];
  /** 右上角状态 Tag (可选). */
  tag: DataWorkspaceHeaderTag | null;
  /** 数据尚未加载 → true. component 仍可渲染 headline/subtitle, 但 KPI 渲 '—'. */
  loading: boolean;
}

/** 任何 tab 在 health 数据未加载时的占位 KPI list. */
function buildLoadingKpis(): DataWorkspaceTabKpi[] {
  return [{ title: '加载中', value: '—' }];
}

/**
 * 统计某个数据源类别 (daily/periodic/event) 下的卡片数 + 红黄绿计数.
 *
 * 用于 health / sync tab 的 "按类别分桶" KPI.
 */
export interface DataCategoryBucket {
  total: number;
  red: number;
  yellow: number;
  green: number;
  unknown: number;
}

/** zero bucket — 任意类别缺数据全 0. */
export function emptyBucket(): DataCategoryBucket {
  return { total: 0, red: 0, yellow: 0, green: 0, unknown: 0 };
}

/** 把 cards 按 category 分桶 — pure, 单测可直接断言. */
export function bucketCardsByCategory(
  cards: DataSourceHealthCard[]
): Record<DataSourceCategory, DataCategoryBucket> {
  const out: Record<DataSourceCategory, DataCategoryBucket> = {
    daily: emptyBucket(),
    periodic: emptyBucket(),
    event: emptyBucket(),
  };
  if (!Array.isArray(cards)) return out;
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    const cat = card.category;
    if (cat !== 'daily' && cat !== 'periodic' && cat !== 'event') continue;
    const bucket = out[cat];
    bucket.total += 1;
    const level: DataHealthLevel = card.level ?? 'unknown';
    if (level === 'red') bucket.red += 1;
    else if (level === 'yellow') bucket.yellow += 1;
    else if (level === 'green') bucket.green += 1;
    else bucket.unknown += 1;
  }
  return out;
}

/** 同步异常数 — card.error 非空 (数据源查询异常) 视为同步链路异常. */
export function countSyncErrors(cards: DataSourceHealthCard[]): number {
  if (!Array.isArray(cards)) return 0;
  return cards.filter(c => c && typeof c.error === 'string' && c.error.length > 0).length;
}

/** "今日新鲜" — lag_trading_days <= 0 视为已抓到今日数据 (节假日返 null 视为未知). */
export function countFreshToday(cards: DataSourceHealthCard[]): number {
  if (!Array.isArray(cards)) return 0;
  return cards.filter(
    c =>
      c &&
      c.category === 'daily' &&
      typeof c.lag_trading_days === 'number' &&
      Number.isFinite(c.lag_trading_days) &&
      c.lag_trading_days <= SYNC_FRESH_MAX_LAG
  ).length;
}

/** 总记录条数 — 累加 record_count, NaN/负值/缺失视为 0. */
export function sumRecordCount(cards: DataSourceHealthCard[]): number {
  if (!Array.isArray(cards)) return 0;
  let sum = 0;
  for (const c of cards) {
    if (!c) continue;
    const n = c.record_count;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) sum += n;
  }
  return sum;
}

/** 决定 health tab 头部 tag (整体健康状态). */
export function classifyOverallTag(
  summary: Record<DataHealthLevel, number> | null | undefined,
  totalCards: number
): DataWorkspaceHeaderTag {
  if (!summary || totalCards === 0) {
    return { text: '尚未注册任何数据源', color: 'default' };
  }
  const red = summary.red ?? 0;
  const yellow = summary.yellow ?? 0;
  const unknown = summary.unknown ?? 0;
  if (red > 0) return { text: `${red} 个数据源严重滞后`, color: 'red' };
  if (yellow > 0) return { text: `${yellow} 个数据源轻微滞后`, color: 'orange' };
  if (unknown > 0) return { text: `${unknown} 个数据源状态未知`, color: 'default' };
  return { text: '全部数据源正常', color: 'green' };
}

/** 决定 sync tab 头部 tag (依据 daily 类别). */
export function classifySyncTag(
  dailyBucket: DataCategoryBucket,
  syncErrors: number
): DataWorkspaceHeaderTag {
  if (dailyBucket.total === 0) return { text: '尚无日级数据源', color: 'default' };
  if (syncErrors > 0) return { text: `${syncErrors} 个同步链路异常`, color: 'red' };
  if (dailyBucket.red > 0) return { text: `${dailyBucket.red} 个日级源严重滞后`, color: 'red' };
  if (dailyBucket.yellow > 0)
    return { text: `${dailyBucket.yellow} 个日级源轻微滞后`, color: 'orange' };
  return { text: '日级同步正常', color: 'green' };
}

/** 决定 logs / monitoring tab 头部 tag (强调异常源数 + 未知态). */
export function classifyLogsTag(syncErrors: number, unknownCount: number): DataWorkspaceHeaderTag {
  if (syncErrors > 0) return { text: `${syncErrors} 条异常待排查`, color: 'red' };
  if (unknownCount > 0) return { text: `${unknownCount} 个数据源状态未知`, color: 'orange' };
  return { text: '系统日志无异常', color: 'green' };
}

/**
 * 主入口: (tabKey, healthResponse) → tab view model.
 *
 * - healthResponse=null → loading=true 占位
 * - tabKey 未知 → 默认 health tab (与 DataWorkspace defaultActiveKey 一致)
 *
 * 永不抛, 永远返合法 view model. component 直接 destructure 渲染.
 */
export function buildDataWorkspaceTabViewModel(
  tabKey: DataWorkspaceTabKey | string,
  healthResponse: DataHealthStatusResponse | null | undefined
): DataWorkspaceTabViewModel {
  const key = (DATA_WORKSPACE_TAB_KEYS as readonly string[]).includes(tabKey)
    ? (tabKey as DataWorkspaceTabKey)
    : 'health';

  if (!healthResponse) {
    return {
      tabKey: key,
      headline: TAB_HEADLINE[key],
      subtitle: TAB_SUBTITLE[key],
      kpis: buildLoadingKpis(),
      tag: null,
      loading: true,
    };
  }
  const cards = Array.isArray(healthResponse.cards) ? healthResponse.cards : [];
  const summary = healthResponse.summary || { green: 0, yellow: 0, red: 0, unknown: 0 };
  const buckets = bucketCardsByCategory(cards);
  const syncErrors = countSyncErrors(cards);
  const refDate = healthResponse.reference_trade_date ?? '—';

  switch (key) {
    case 'health': {
      return {
        tabKey: key,
        headline: TAB_HEADLINE.health,
        subtitle: TAB_SUBTITLE.health,
        kpis: [
          { title: '参考交易日', value: refDate },
          {
            title: '健康',
            value: summary.green ?? 0,
            suffix: '个',
            color: DATA_HEALTH_COLOR.green,
          },
          {
            title: '轻微滞后',
            value: summary.yellow ?? 0,
            suffix: '个',
            color: DATA_HEALTH_COLOR.yellow,
          },
          {
            title: '严重滞后',
            value: summary.red ?? 0,
            suffix: '个',
            color: DATA_HEALTH_COLOR.red,
          },
          {
            title: '未知',
            value: summary.unknown ?? 0,
            suffix: '个',
            color: DATA_HEALTH_COLOR.unknown,
          },
        ],
        tag: classifyOverallTag(summary, cards.length),
        loading: false,
      };
    }
    case 'stocks': {
      const recordTotal = sumRecordCount(cards);
      return {
        tabKey: key,
        headline: TAB_HEADLINE.stocks,
        subtitle: TAB_SUBTITLE.stocks,
        kpis: [
          {
            title: '本地数据源',
            value: cards.length,
            suffix: '个',
          },
          {
            title: '日级源',
            value: buckets.daily.total,
            suffix: '个',
            color: buckets.daily.red > 0 ? DATA_HEALTH_COLOR.red : undefined,
          },
          {
            title: '累计记录',
            value: recordTotal,
            suffix: '条',
            tooltip: '所有数据源 record_count 之和',
          },
          {
            title: '宇宙规模 (估)',
            value: STOCKS_UNIVERSE_HINT,
            suffix: '只',
            tooltip: 'A 股全市场上市公司基数, 用作 "本地数据覆盖率" 分母提示',
          },
        ],
        tag:
          buckets.daily.red > 0
            ? { text: '日级数据严重滞后, 个股趋势可能失真', color: 'red' }
            : { text: '个股数据正常', color: 'green' },
        loading: false,
      };
    }
    case 'sync': {
      const fresh = countFreshToday(cards);
      return {
        tabKey: key,
        headline: TAB_HEADLINE.sync,
        subtitle: TAB_SUBTITLE.sync,
        kpis: [
          { title: '参考交易日', value: refDate },
          {
            title: '日级源',
            value: buckets.daily.total,
            suffix: '个',
          },
          {
            title: '今日新鲜',
            value: fresh,
            suffix: '个',
            color: fresh > 0 ? DATA_HEALTH_COLOR.green : DATA_HEALTH_COLOR.yellow,
            tooltip: `lag_trading_days ≤ ${SYNC_FRESH_MAX_LAG} 视为已抓到今日`,
          },
          {
            title: '同步异常',
            value: syncErrors,
            suffix: '个',
            color: syncErrors > 0 ? DATA_HEALTH_COLOR.red : DATA_HEALTH_COLOR.green,
          },
        ],
        tag: classifySyncTag(buckets.daily, syncErrors),
        loading: false,
      };
    }
    case 'tasks': {
      return {
        tabKey: key,
        headline: TAB_HEADLINE.tasks,
        subtitle: TAB_SUBTITLE.tasks,
        kpis: [
          {
            title: '已注册数据源',
            value: cards.length,
            suffix: '个',
            tooltip: '与 ScheduledTask cron 一一对应',
          },
          {
            title: '日级',
            value: buckets.daily.total,
            suffix: '个',
          },
          {
            title: '周期披露',
            value: buckets.periodic.total,
            suffix: '个',
          },
          {
            title: '事件流',
            value: buckets.event.total,
            suffix: '个',
          },
        ],
        tag:
          syncErrors > 0
            ? { text: `${syncErrors} 个任务最近一次同步失败`, color: 'red' }
            : { text: '调度任务运行正常', color: 'green' },
        loading: false,
      };
    }
    case 'logs': {
      const yellowOrRed = (summary.red ?? 0) + (summary.yellow ?? 0);
      return {
        tabKey: key,
        headline: TAB_HEADLINE.logs,
        subtitle: TAB_SUBTITLE.logs,
        kpis: [
          {
            title: '同步异常',
            value: syncErrors,
            suffix: '条',
            color: syncErrors > 0 ? DATA_HEALTH_COLOR.red : DATA_HEALTH_COLOR.green,
          },
          {
            title: '滞后告警',
            value: yellowOrRed,
            suffix: '条',
            color: yellowOrRed > 0 ? DATA_HEALTH_COLOR.yellow : DATA_HEALTH_COLOR.green,
            tooltip: '红色 + 黄色数据源数 (滞后 ≥ 1 个交易日)',
          },
          {
            title: '状态未知',
            value: summary.unknown ?? 0,
            suffix: '条',
            color: (summary.unknown ?? 0) > 0 ? DATA_HEALTH_COLOR.unknown : undefined,
          },
        ],
        tag: classifyLogsTag(syncErrors, summary.unknown ?? 0),
        loading: false,
      };
    }
    case 'monitoring': {
      const yellowOrRed = (summary.red ?? 0) + (summary.yellow ?? 0);
      return {
        tabKey: key,
        headline: TAB_HEADLINE.monitoring,
        subtitle: TAB_SUBTITLE.monitoring,
        kpis: [
          { title: '参考交易日', value: refDate },
          {
            title: '总数据源',
            value: cards.length,
            suffix: '个',
          },
          {
            title: '不健康',
            value: yellowOrRed + (summary.unknown ?? 0),
            suffix: '个',
            color:
              yellowOrRed + (summary.unknown ?? 0) > 0
                ? DATA_HEALTH_COLOR.red
                : DATA_HEALTH_COLOR.green,
            tooltip: '红 + 黄 + 未知 之和',
          },
          {
            title: '健康率',
            value:
              cards.length === 0 ? '—' : Math.round(((summary.green ?? 0) / cards.length) * 100),
            suffix: cards.length === 0 ? undefined : '%',
            color:
              cards.length === 0 || (summary.green ?? 0) === cards.length
                ? DATA_HEALTH_COLOR.green
                : DATA_HEALTH_COLOR.yellow,
          },
        ],
        tag: classifyLogsTag(syncErrors, summary.unknown ?? 0),
        loading: false,
      };
    }
    /* istanbul ignore next: key 已 normalize 到 6 个合法值之一 */
    default:
      return {
        tabKey: 'health',
        headline: TAB_HEADLINE.health,
        subtitle: TAB_SUBTITLE.health,
        kpis: buildLoadingKpis(),
        tag: null,
        loading: true,
      };
  }
}

/** 每个 tab 的主标题 — 让概览条不依赖外部传 (component 也能直接用). */
export const TAB_HEADLINE: Readonly<Record<DataWorkspaceTabKey, string>> = Object.freeze({
  health: '数据源健康度',
  stocks: '个股趋势浏览器',
  sync: '行情同步状态',
  tasks: '调度任务概览',
  logs: '系统日志巡检',
  monitoring: '运行健康监控',
});

/** 每个 tab 的副标题 — 一句话说明这个 tab 主要让用户做什么. */
export const TAB_SUBTITLE: Readonly<Record<DataWorkspaceTabKey, string>> = Object.freeze({
  health: '4 级红黄绿评级 + 按类别分桶, 顶部聚合告警, 卡片可一键触发补抓.',
  stocks: '按代码 / 名称搜个股, 右侧 K 线 + 量比 / 北向 / 龙虎榜数据快查.',
  sync: '日级 / 周期 / 事件 三类源同步状态; 日级源 lag ≤ 0 视为已抓今日.',
  tasks: 'SchedulerService cron 注册中心; 与左侧数据源一一对应, 失败可重跑.',
  logs: '近 1h / 近 24h 同步异常 + 滞后告警条目; 颜色编码与健康度看板一致.',
  monitoring: '健康率 / 不健康源 / 状态未知三件套; Prometheus 告警拉同款.',
});

// ============================================================================
// US-061 [FE-022] SLA dashboard helpers
// ----------------------------------------------------------------------------
// 时效 SLA 可视化 — 每类数据源 (daily/periodic/event) 有自己的 lag 阈值,
// 把 healthResponse 的 cards 派生成 "按类别 SLA 达成率" 视图模型, 给
// SlaDashboardCard 直接渲染. 形态对偶 [[evaluateShadowRunReadiness]]
// (US-051) — N 维度 → 各自 classify → 合并到 K 档 + ready=bool + blockers.
//
// 阈值依据 backend/src/services/DataHealthStatusService.ts 的 red/yellow/green
// 切分: lag <= 0 green / 1-3 yellow / >3 red. 不同类别都用同套阈值, 但 SLA
// "可接受 lag" 上限按类别区分: daily=1 个交易日 (T+1), periodic=15 (季报周期),
// event=3 (公告/KOL). 超过即 SLA 违约.
// ============================================================================

/** 每类数据源的 SLA "可接受 lag 上限" (交易日). 超过即 SLA breach (违约). */
export const SLA_TARGET_LAG_DAYS: Readonly<Record<DataSourceCategory, number>> = Object.freeze({
  daily: 1,
  periodic: 15,
  event: 3,
});

/** 类别中文标签 (与 DataHealthDashboard.CATEGORY_LABEL 同源). */
export const SLA_CATEGORY_LABEL: Readonly<Record<DataSourceCategory, string>> = Object.freeze({
  daily: '日级行情',
  periodic: '周期披露',
  event: '事件流',
});

/** SLA 达成率 → "档位" 的阈值 (百分比). 与 [[evaluateShadowRunReadiness]] 同思想. */
export const SLA_ATTAIN_HEALTHY_MIN = 95;
export const SLA_ATTAIN_DEGRADED_MIN = 80;

/** 单个类别的 SLA 摘要. */
export interface SlaCategorySummary {
  category: DataSourceCategory;
  label: string;
  /** 该类总源数 (含 unknown/缺数据). */
  total: number;
  /** lag <= target (含 null 视为未知不计入达标也不计入违约). */
  on_time: number;
  /** lag > target → SLA 违约. */
  breached: number;
  /** lag = null/unknown → 未知, 既不算达标也不算违约. */
  unknown: number;
  /** 该类的 target lag (交易日). */
  target_lag_days: number;
  /** on_time / (total - unknown), 全 unknown 返 null. 百分比 0-100 整数. */
  attainment_pct: number | null;
  /** 三档: healthy >= HEALTHY_MIN / degraded >= DEGRADED_MIN / critical < DEGRADED_MIN / unknown 全无数据. */
  level: 'healthy' | 'degraded' | 'critical' | 'unknown';
}

/** SLA dashboard 整体视图模型 — 给 SlaDashboardCard 一次性 destructure. */
export interface SlaDashboardViewModel {
  /** 三类摘要 (顺序固定 daily → periodic → event). */
  categories: SlaCategorySummary[];
  /** 全部源数 (含 unknown). */
  total_sources: number;
  /** 全部 on_time 数 (跨类别累加). */
  total_on_time: number;
  /** 全部 breached 数 (跨类别累加). */
  total_breached: number;
  /** 跨类别整体达成率 (排除 unknown). 全 unknown 返 null. */
  overall_attainment_pct: number | null;
  /** 整体档位: 取最差类别 level. */
  overall_level: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** ready=true 当所有类别都 >= HEALTHY_MIN 且 breached === 0. */
  ready: boolean;
  /** ready=false 的原因列表 (UL 直接渲染). */
  blockers: string[];
  /** 参考交易日 (回写, 给 caller subtitle 用). */
  reference_trade_date: string | null;
  /** healthResponse 缺数据 → loading=true. */
  loading: boolean;
}

/** 判断单个 card 是否达成 SLA — pure. */
export function isCardOnTime(
  card: DataSourceHealthCard | null | undefined,
  targetLag: number
): 'on_time' | 'breached' | 'unknown' {
  if (!card || typeof card !== 'object') return 'unknown';
  const lag = card.lag_trading_days;
  if (typeof lag !== 'number' || !Number.isFinite(lag)) return 'unknown';
  if (lag <= targetLag) return 'on_time';
  return 'breached';
}

/** 计算单类别 SLA 摘要 — pure. */
export function buildSlaCategorySummary(
  category: DataSourceCategory,
  cards: DataSourceHealthCard[]
): SlaCategorySummary {
  const target = SLA_TARGET_LAG_DAYS[category];
  const label = SLA_CATEGORY_LABEL[category];
  let total = 0;
  let on_time = 0;
  let breached = 0;
  let unknown = 0;
  if (Array.isArray(cards)) {
    for (const c of cards) {
      if (!c || c.category !== category) continue;
      total += 1;
      const status = isCardOnTime(c, target);
      if (status === 'on_time') on_time += 1;
      else if (status === 'breached') breached += 1;
      else unknown += 1;
    }
  }
  const denom = total - unknown;
  const attainment_pct = denom > 0 ? Math.round((on_time / denom) * 100) : null;
  let level: SlaCategorySummary['level'];
  if (total === 0 || attainment_pct === null) level = 'unknown';
  else if (attainment_pct >= SLA_ATTAIN_HEALTHY_MIN) level = 'healthy';
  else if (attainment_pct >= SLA_ATTAIN_DEGRADED_MIN) level = 'degraded';
  else level = 'critical';
  return {
    category,
    label,
    total,
    on_time,
    breached,
    unknown,
    target_lag_days: target,
    attainment_pct,
    level,
  };
}

/** 取整体档位 = 三类最差 (critical > degraded > unknown > healthy 排序; healthy 最好). */
export function worstSlaLevel(levels: SlaCategorySummary['level'][]): SlaCategorySummary['level'] {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('degraded')) return 'degraded';
  if (levels.includes('unknown')) return 'unknown';
  return 'healthy';
}

/** SLA 档位 → antd Tag color / Statistic valueStyle.color. */
export const SLA_LEVEL_COLOR: Readonly<Record<SlaCategorySummary['level'], string>> = Object.freeze(
  {
    healthy: DATA_HEALTH_COLOR.green,
    degraded: DATA_HEALTH_COLOR.yellow,
    critical: DATA_HEALTH_COLOR.red,
    unknown: DATA_HEALTH_COLOR.unknown,
  }
);

/** SLA 档位 → 中文标签 (Tag text). */
export const SLA_LEVEL_LABEL: Readonly<Record<SlaCategorySummary['level'], string>> = Object.freeze(
  {
    healthy: 'SLA 达标',
    degraded: 'SLA 轻微违约',
    critical: 'SLA 严重违约',
    unknown: '数据不足',
  }
);

/**
 * 主入口: healthResponse → SLA dashboard 视图模型.
 *
 * - healthResponse=null/undefined → loading=true 占位 (三类全 unknown)
 * - 跨类别整体达成率 = sum(on_time) / sum(total - unknown), 全 unknown 返 null
 * - ready=true 当 (a) 所有类别 attainment >= HEALTHY_MIN 且 (b) 跨类别 breached === 0
 *
 * Pure, 永不抛, useMemo 安全.
 */
export function buildSlaDashboardViewModel(
  healthResponse: DataHealthStatusResponse | null | undefined
): SlaDashboardViewModel {
  if (!healthResponse) {
    const placeholders: SlaCategorySummary[] = (['daily', 'periodic', 'event'] as const).map(c =>
      buildSlaCategorySummary(c, [])
    );
    return {
      categories: placeholders,
      total_sources: 0,
      total_on_time: 0,
      total_breached: 0,
      overall_attainment_pct: null,
      overall_level: 'unknown',
      ready: false,
      blockers: ['尚未加载数据健康状态'],
      reference_trade_date: null,
      loading: true,
    };
  }
  const cards = Array.isArray(healthResponse.cards) ? healthResponse.cards : [];
  const categories: SlaCategorySummary[] = (['daily', 'periodic', 'event'] as const).map(c =>
    buildSlaCategorySummary(c, cards)
  );
  const total_sources = categories.reduce((s, c) => s + c.total, 0);
  const total_on_time = categories.reduce((s, c) => s + c.on_time, 0);
  const total_breached = categories.reduce((s, c) => s + c.breached, 0);
  const total_unknown = categories.reduce((s, c) => s + c.unknown, 0);
  const overall_denom = total_sources - total_unknown;
  const overall_attainment_pct =
    overall_denom > 0 ? Math.round((total_on_time / overall_denom) * 100) : null;
  const overall_level = worstSlaLevel(categories.map(c => c.level));
  const blockers: string[] = [];
  for (const c of categories) {
    if (c.total === 0) {
      blockers.push(`${c.label} 类无任何数据源注册`);
      continue;
    }
    if (c.attainment_pct === null) {
      blockers.push(`${c.label} 全部数据源 lag 未知`);
    } else if (c.attainment_pct < SLA_ATTAIN_HEALTHY_MIN) {
      blockers.push(
        `${c.label} SLA 达成率 ${c.attainment_pct}% < ${SLA_ATTAIN_HEALTHY_MIN}% (目标 lag ≤ ${c.target_lag_days} 交易日)`
      );
    }
    if (c.breached > 0) {
      blockers.push(`${c.label} 有 ${c.breached} 个源 lag > ${c.target_lag_days} 交易日, SLA 违约`);
    }
  }
  const ready =
    total_breached === 0 &&
    categories.every(c => c.attainment_pct !== null && c.attainment_pct >= SLA_ATTAIN_HEALTHY_MIN);
  return {
    categories,
    total_sources,
    total_on_time,
    total_breached,
    overall_attainment_pct,
    overall_level,
    ready,
    blockers,
    reference_trade_date: healthResponse.reference_trade_date ?? null,
    loading: false,
  };
}

// ============================================================================
// US-062 [FE-023] DataWorkspace 数据缺失独立告警 helpers
// ----------------------------------------------------------------------------
// 数据缺失 (data missing) 与 SLA 违约 (US-061) 是两个独立维度: SLA 是"晚了
// 几天", 数据缺失是"压根没拿到 / 链路抛错 / 状态完全未知". 两者会有交集
// (lag=null 的源 SLA unknown + 数据缺失 unknown), 但 UI 要分开告警 —
// SLA 看板看"达成率%", 数据缺失告警看"具体哪些源没数据 + 为啥 + 影响什么
// 业务". 这条卡片让 ops 一眼看到 "今天 northbound 链路挂了" 而不需要去看
// SLA 百分比反推. category 字段固定为 'data' 与 US-077 RiskAlert
// 三大 category (position/market/individual) 平级 + 独立; 任何下游
// (告警中心 / 待办 tab / 飞书 push) 通过 category==='data' 直接过滤本类.
//
// 形态对偶 [[buildSlaDashboardViewModel]] (US-061) — N 维度 → 各自 classify
// → 合并到 K 档 + ready=bool + blockers, 但本卡片输出 list 而非 category 矩阵.
// ============================================================================

/** 数据缺失告警的 category 字段固定值 — 与 US-077 RiskAlert.category 平级. */
export const DATA_MISSING_ALERT_CATEGORY = 'data' as const;

/** 数据缺失告警三档严重度 — critical=链路挂, warning=滞后≥SLA, info=状态未知. */
export type DataMissingAlertSeverity = 'critical' | 'warning' | 'info';

/** 单条数据缺失告警 (一条对应一个 source). */
export interface DataMissingAlert {
  /** 固定 'data' — 与 RiskAlert.category 平级, 让告警中心可按 category 过滤. */
  category: typeof DATA_MISSING_ALERT_CATEGORY;
  /** 数据源 key (e.g. 'northbound' / 'dragon_tiger'). */
  source_key: string;
  /** 数据源中文名 (display_name). */
  display_name: string;
  /** 源类别 (daily/periodic/event). */
  source_category: DataSourceCategory;
  /** 严重度 — 决定 Tag 颜色与排序权重. */
  severity: DataMissingAlertSeverity;
  /** 简短原因文案 (1-2 句, 给 ops 直接看). */
  reason: string;
  /** lag_trading_days (回写, null=未知). */
  lag_trading_days: number | null;
  /** 最近一次同步时间 (ISO string 或 null). */
  last_sync_at: string | null;
  /** 当前累计记录数 (回写, 0 表示从未抓到). */
  record_count: number;
  /** 触发该告警的具体类型 (sync_error / severe_lag / unknown / no_record). */
  trigger: 'sync_error' | 'severe_lag' | 'unknown' | 'no_record';
}

/** 数据缺失告警的视图模型 — 给 DataMissingAlertsCard 一次性 destructure. */
export interface DataMissingAlertsViewModel {
  /** 告警列表 (按严重度倒序 + key 字母序稳定). */
  alerts: DataMissingAlert[];
  /** critical 数. */
  critical: number;
  /** warning 数. */
  warning: number;
  /** info 数. */
  info: number;
  /** 总告警数 (= critical + warning + info). */
  total: number;
  /** healthResponse 未加载 → true. */
  loading: boolean;
  /** 参考交易日 (回写, 给 caller 副标题用). */
  reference_trade_date: string | null;
}

/** "严重滞后" 阈值 — lag > 此值算 severe (与 DataHealthDashboard red 阈值一致). */
export const DATA_MISSING_SEVERE_LAG = 3;

/** 严重度排序权重 — 数字越大越靠前. */
const SEVERITY_ORDER: Readonly<Record<DataMissingAlertSeverity, number>> = Object.freeze({
  critical: 3,
  warning: 2,
  info: 1,
});

/** 严重度 → antd Tag color (与 SLA / health 配色家族保持一致). */
export const DATA_MISSING_SEVERITY_COLOR: Readonly<Record<DataMissingAlertSeverity, string>> =
  Object.freeze({
    critical: DATA_HEALTH_COLOR.red,
    warning: DATA_HEALTH_COLOR.yellow,
    info: DATA_HEALTH_COLOR.unknown,
  });

/** 严重度 → 中文标签 (Tag text). */
export const DATA_MISSING_SEVERITY_LABEL: Readonly<Record<DataMissingAlertSeverity, string>> =
  Object.freeze({
    critical: '链路中断',
    warning: '严重滞后',
    info: '状态未知',
  });

/**
 * 单条 card → DataMissingAlert | null (无缺失返 null).
 *
 * 触发条件 (按优先级):
 *   1. error 非空字符串 → critical / 'sync_error'
 *   2. lag_trading_days > DATA_MISSING_SEVERE_LAG → warning / 'severe_lag'
 *   3. level==='unknown' 且 lag_trading_days===null → info / 'unknown'
 *   4. record_count===0 且 category∈{daily,event} → info / 'no_record'
 *
 * Pure, 接受 null/undefined 兜底返 null.
 */
export function classifyDataMissingAlert(
  card: DataSourceHealthCard | null | undefined
): DataMissingAlert | null {
  if (!card || typeof card !== 'object') return null;
  const sourceCategory = card.category;
  if (sourceCategory !== 'daily' && sourceCategory !== 'periodic' && sourceCategory !== 'event') {
    return null;
  }
  const display_name = card.display_name || card.key || '未命名数据源';
  const lag =
    typeof card.lag_trading_days === 'number' && Number.isFinite(card.lag_trading_days)
      ? card.lag_trading_days
      : null;
  const recordCount =
    typeof card.record_count === 'number' &&
    Number.isFinite(card.record_count) &&
    card.record_count > 0
      ? card.record_count
      : 0;
  const last_sync_at =
    typeof card.last_sync_at === 'string' && card.last_sync_at.length > 0
      ? card.last_sync_at
      : null;

  // 1. sync 链路异常 (最严重, error 非空就 critical)
  if (typeof card.error === 'string' && card.error.length > 0) {
    return {
      category: DATA_MISSING_ALERT_CATEGORY,
      source_key: card.key,
      display_name,
      source_category: sourceCategory,
      severity: 'critical',
      reason: `同步链路报错: ${card.error.slice(0, 80)}`,
      lag_trading_days: lag,
      last_sync_at,
      record_count: recordCount,
      trigger: 'sync_error',
    };
  }

  // 2. 严重滞后 (lag > 3 trading days)
  if (lag !== null && lag > DATA_MISSING_SEVERE_LAG) {
    return {
      category: DATA_MISSING_ALERT_CATEGORY,
      source_key: card.key,
      display_name,
      source_category: sourceCategory,
      severity: 'warning',
      reason: `数据落后 ${lag} 个交易日 (> ${DATA_MISSING_SEVERE_LAG} 天阈值)`,
      lag_trading_days: lag,
      last_sync_at,
      record_count: recordCount,
      trigger: 'severe_lag',
    };
  }

  // 3. 状态未知 (lag=null + level unknown)
  if (card.level === 'unknown' && lag === null) {
    return {
      category: DATA_MISSING_ALERT_CATEGORY,
      source_key: card.key,
      display_name,
      source_category: sourceCategory,
      severity: 'info',
      reason: '状态未知 — 没有最近一次同步数据可参考',
      lag_trading_days: lag,
      last_sync_at,
      record_count: recordCount,
      trigger: 'unknown',
    };
  }

  // 4. 零记录 (daily/event 类源理应有数据, periodic 季报型可能本身没几条)
  if (recordCount === 0 && (sourceCategory === 'daily' || sourceCategory === 'event')) {
    return {
      category: DATA_MISSING_ALERT_CATEGORY,
      source_key: card.key,
      display_name,
      source_category: sourceCategory,
      severity: 'info',
      reason: '累计记录为 0 — 该数据源从未抓到任何数据',
      lag_trading_days: lag,
      last_sync_at,
      record_count: 0,
      trigger: 'no_record',
    };
  }

  return null;
}

/**
 * 主入口: healthResponse → 数据缺失告警视图模型.
 *
 * - healthResponse=null/undefined → loading=true 占位空列表
 * - alerts 按 (severity desc, source_key asc) 稳定排序 — React key 稳定 + UI 可预期
 * - 永不抛, 永远返合法 vm. component 直接 destructure 渲染.
 */
export function buildDataMissingAlertsViewModel(
  healthResponse: DataHealthStatusResponse | null | undefined
): DataMissingAlertsViewModel {
  if (!healthResponse) {
    return {
      alerts: [],
      critical: 0,
      warning: 0,
      info: 0,
      total: 0,
      loading: true,
      reference_trade_date: null,
    };
  }
  const cards = Array.isArray(healthResponse.cards) ? healthResponse.cards : [];
  const alerts: DataMissingAlert[] = [];
  for (const c of cards) {
    const a = classifyDataMissingAlert(c);
    if (a) alerts.push(a);
  }
  alerts.sort((x, y) => {
    const so = SEVERITY_ORDER[y.severity] - SEVERITY_ORDER[x.severity];
    if (so !== 0) return so;
    return x.source_key.localeCompare(y.source_key);
  });
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const a of alerts) {
    if (a.severity === 'critical') critical += 1;
    else if (a.severity === 'warning') warning += 1;
    else info += 1;
  }
  return {
    alerts,
    critical,
    warning,
    info,
    total: alerts.length,
    loading: false,
    reference_trade_date: healthResponse.reference_trade_date ?? null,
  };
}

// ============================================================================
// US-063 [FE-024] DataWorkspace 一键补抓 helpers
// ----------------------------------------------------------------------------
// 既有 [[DataHealthDashboard]] 每张数据源卡片自带 "手动触发同步" 按钮 (走
// POST /api/data/sync/:source), 但 ops 一旦看到 SLA 看板红了 / 数据缺失告警
// 多条, 需要逐张卡片点击补抓 — 卡片越多, 误操作 / 漏点的概率越高.
// 本 helper 派生 "一键补抓" 入口的视图模型: 从 healthResponse 选出全部
// 可一键补抓 (sync_source ∈ DAILY_SYNC_SOURCES) 且 (lag > 0 / error 非空 /
// record=0) 的目标, 按严重度排序, 给 UI 一次性显示 + 一键串行触发.
//
// 与 [[DataHealthDashboard]] 的 DAILY_SYNC_KEYS 必须保持一致 — 哪些 source
// 支持 web 端一键触发由后端 DataController.triggerSync `dailyRoutes` 决定;
// 周期性 / per-stock 源 (财报 / 分析师 / 公告) 后端会返 400 让 ops 走 CLI,
// 本 helper 直接在前端就过滤掉, 不让用户点完才发现 400.
//
// 形态对偶 [[buildDataMissingAlertsViewModel]] (US-062) — 同样从 cards 派生
// list, 但筛选条件 = "可补抓 + 真的需要补抓", 不含 'unknown' 状态 (链路状
// 态未知时点补抓没意义, 应先排查为什么 last_sync_at 是 null).
// ============================================================================

/**
 * 后端 DataController.triggerSync `dailyRoutes` 接受的 sync_source 集合.
 * 与 frontend DataHealthDashboard 内 DAILY_SYNC_KEYS 一致, 单测守同步.
 * 新增 daily 源时三处同步更新:
 *   1. backend/src/api/controllers/DataController.ts dailyRoutes
 *   2. frontend/src/components/data/DataHealthDashboard.tsx DAILY_SYNC_KEYS
 *   3. 本常量
 */
export const BULK_BACKFILL_DAILY_SOURCES: ReadonlySet<string> = Object.freeze(
  new Set<string>(['northbound', 'dragon_tiger', 'limit_up', 'industry_flow', 'market_sentiment'])
);

/** 一键补抓的优先级 — critical=链路报错, warning=lag>SLA, info=零记录, low=正常但 lag>0. */
export type BulkBackfillReason = 'sync_error' | 'severe_lag' | 'no_record' | 'mild_lag';

/** 一条补抓目标 (回写够 UI 用). */
export interface BulkBackfillTarget {
  /** sync_source — POST /api/data/sync/:source 用. */
  sync_source: string;
  /** 数据源中文名 (display_name). */
  display_name: string;
  /** 数据源 key (与 card.key 一致, React key 用). */
  source_key: string;
  /** 类别 (daily/event/periodic). */
  source_category: DataSourceCategory;
  /** lag_trading_days (回写, null=未知). */
  lag_trading_days: number | null;
  /** 触发原因 (决定排序权重). */
  reason: BulkBackfillReason;
  /** UI 显示用的简短原因文案. */
  reason_text: string;
}

/** 一键补抓视图模型 — 给 BulkBackfillButton 一次性 destructure. */
export interface BulkBackfillPlan {
  /** 排序后的目标列表 (按严重度倒序 + source_key asc). */
  targets: BulkBackfillTarget[];
  /** 各原因的目标数. */
  counts: Readonly<Record<BulkBackfillReason, number>>;
  /** 总目标数 (=可一键补抓且需要补抓的数据源数). */
  total: number;
  /** 已注册的 daily 类源总数 (分母, 用于 "X/Y 需要补抓" 文案). */
  daily_sources_total: number;
  /** 不可用原因 (loading / 全部正常 / 全部不可一键补抓) — UI 用作 disabled 提示. */
  disabled_reason: string | null;
}

/** 优先级权重 — 数字越大越靠前. */
const BULK_BACKFILL_REASON_ORDER: Readonly<Record<BulkBackfillReason, number>> = Object.freeze({
  sync_error: 4,
  severe_lag: 3,
  no_record: 2,
  mild_lag: 1,
});

/** 单条 card → BulkBackfillTarget | null. 不满足 (不可一键补抓 / 无需补抓) 返 null. */
export function classifyBulkBackfillTarget(
  card: DataSourceHealthCard | null | undefined
): BulkBackfillTarget | null {
  if (!card || typeof card !== 'object') return null;
  if (!BULK_BACKFILL_DAILY_SOURCES.has(card.sync_source)) return null;
  const sourceCategory = card.category;
  if (sourceCategory !== 'daily' && sourceCategory !== 'event' && sourceCategory !== 'periodic') {
    return null;
  }
  const lag =
    typeof card.lag_trading_days === 'number' && Number.isFinite(card.lag_trading_days)
      ? card.lag_trading_days
      : null;
  const recordCount =
    typeof card.record_count === 'number' &&
    Number.isFinite(card.record_count) &&
    card.record_count > 0
      ? card.record_count
      : 0;
  const display_name = card.display_name || card.sync_source || card.key || '未命名数据源';
  // 优先级链 — 与 [[classifyDataMissingAlert]] 同款 (sync_error > severe_lag > no_record > mild_lag).
  if (typeof card.error === 'string' && card.error.length > 0) {
    return {
      sync_source: card.sync_source,
      display_name,
      source_key: card.key,
      source_category: sourceCategory,
      lag_trading_days: lag,
      reason: 'sync_error',
      reason_text: `链路报错: ${card.error.slice(0, 60)}`,
    };
  }
  if (lag !== null && lag > DATA_MISSING_SEVERE_LAG) {
    return {
      sync_source: card.sync_source,
      display_name,
      source_key: card.key,
      source_category: sourceCategory,
      lag_trading_days: lag,
      reason: 'severe_lag',
      reason_text: `落后 ${lag} 个交易日 (> ${DATA_MISSING_SEVERE_LAG} 天阈值)`,
    };
  }
  if (recordCount === 0) {
    return {
      sync_source: card.sync_source,
      display_name,
      source_key: card.key,
      source_category: sourceCategory,
      lag_trading_days: lag,
      reason: 'no_record',
      reason_text: '累计记录为 0 — 从未抓到任何数据',
    };
  }
  if (lag !== null && lag > 0) {
    return {
      sync_source: card.sync_source,
      display_name,
      source_key: card.key,
      source_category: sourceCategory,
      lag_trading_days: lag,
      reason: 'mild_lag',
      reason_text: `落后 ${lag} 个交易日`,
    };
  }
  return null;
}

/**
 * 主入口: healthResponse → BulkBackfillPlan.
 *
 * - healthResponse=null/undefined → 全 0 plan + disabled_reason='loading'
 * - cards 全 green/lag=0 → 全 0 plan + disabled_reason='无需补抓'
 * - 无任何 daily 源注册 → disabled_reason='无可一键补抓的数据源'
 * - 排序: (reason desc by weight, source_key asc) 稳定
 *
 * Pure, 永不抛, useMemo 安全.
 */
export function buildBulkBackfillPlan(
  healthResponse: DataHealthStatusResponse | null | undefined
): BulkBackfillPlan {
  const emptyCounts: Record<BulkBackfillReason, number> = {
    sync_error: 0,
    severe_lag: 0,
    no_record: 0,
    mild_lag: 0,
  };
  if (!healthResponse) {
    return {
      targets: [],
      counts: Object.freeze({ ...emptyCounts }),
      total: 0,
      daily_sources_total: 0,
      disabled_reason: '数据健康状态加载中…',
    };
  }
  const cards = Array.isArray(healthResponse.cards) ? healthResponse.cards : [];
  let daily_sources_total = 0;
  const targets: BulkBackfillTarget[] = [];
  for (const c of cards) {
    if (!c || typeof c !== 'object') continue;
    if (BULK_BACKFILL_DAILY_SOURCES.has(c.sync_source)) daily_sources_total += 1;
    const t = classifyBulkBackfillTarget(c);
    if (t) targets.push(t);
  }
  targets.sort((x, y) => {
    const ro = BULK_BACKFILL_REASON_ORDER[y.reason] - BULK_BACKFILL_REASON_ORDER[x.reason];
    if (ro !== 0) return ro;
    return x.source_key.localeCompare(y.source_key);
  });
  const counts: Record<BulkBackfillReason, number> = { ...emptyCounts };
  for (const t of targets) counts[t.reason] += 1;
  let disabled_reason: string | null = null;
  if (daily_sources_total === 0) {
    disabled_reason = '当前无任何可一键补抓的数据源 (周期性 / per-stock 源请走运维 CLI)';
  } else if (targets.length === 0) {
    disabled_reason = '所有可补抓的数据源均健康, 无需补抓';
  }
  return {
    targets,
    counts: Object.freeze(counts),
    total: targets.length,
    daily_sources_total,
    disabled_reason,
  };
}

/** 单次补抓结果 (caller 串行调用 triggerDataSync 后填回). */
export interface BulkBackfillResult {
  sync_source: string;
  display_name: string;
  ok: boolean;
  /** ok=true 时为后端返的 result; ok=false 时为 error string. */
  message?: string;
}

/** 一次批量补抓的汇总 — 给 UI 渲染 "完成 N / 成功 X / 失败 Y" 摘要. */
export interface BulkBackfillSummary {
  total: number;
  success: number;
  failed: number;
  /** 是否全部成功 (success === total 且 total > 0). */
  all_ok: boolean;
  /** 失败的 sync_source 列表 (按出现顺序, 给 ops 直接看). */
  failed_sources: string[];
}

/**
 * 汇总一批补抓结果 — Pure, 不依赖外部. 在 BulkBackfillButton 串行 await 完
 * triggerDataSync 后调.
 */
export function summarizeBulkBackfillResults(
  results: ReadonlyArray<BulkBackfillResult | null | undefined>
): BulkBackfillSummary {
  const list = Array.isArray(results) ? results : [];
  let success = 0;
  let failed = 0;
  const failed_sources: string[] = [];
  let total = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    total += 1;
    if (r.ok) success += 1;
    else {
      failed += 1;
      if (typeof r.sync_source === 'string' && r.sync_source.length > 0) {
        failed_sources.push(r.sync_source);
      }
    }
  }
  return {
    total,
    success,
    failed,
    all_ok: total > 0 && success === total,
    failed_sources,
  };
}

// ============================================================================
// US-064 [FE-025] DataWorkspace 数据源切换 — provider 主备状态可视化
// ----------------------------------------------------------------------------
// 数据健康 tab 顶部已有 4 张卡片 (SLA / 数据缺失 / 一键补抓 / DataHealthDashboard),
// 全部基于 /api/data/health-status (cards 列表 — 业务源维度). 但 cards 维度
// 看不到 "主备数据源" — 每个能力 (history_k / stock_list / fundamental_factor
// 等) 后端 DataSourceHealthService.getRankedProviders 都会按 route_score 排序
// 出主 / 备 / 兜底链路 (rank=1/2/3...). 本卡片暴露这套路由计划:
//   - 顶部 KPI: 已注册 provider 数 / 健康数 / 主链路覆盖率
//   - 中间 features 矩阵: 8 个核心 feature 每个一行, 主用源 + 备用源 + 状态 Tag
//   - 底部 providers 列表: 每个 provider 的健康分 / 状态 / latency / 最近错误
//
// 形态对偶 [[buildSlaDashboardViewModel]] / [[buildDataMissingAlertsViewModel]]
// — 同样从 healthBundle 派生 + ready/blockers 模式. 与 US-061 / US-062 共享
// "纯函数 helper + selfFetch 兜底 + Tag color 与配色家族一致" 模板.
//
// 与 [[DataUpdateStatus]] (legacy 长页) 的差异: 那页是 ops 维护视角 (一次性
// 看全部 health / quality / factors / quant_readiness), 本卡片是 trader 视
// 角"主备源是否在切换 / 我是否要换源", 只看 routing 不看 quality / factor
// coverage. 两条 endpoint 都用同一份 /api/market/data-sources/health, 不重
// 复请求 (component 内 useEffect 自己拉一次).
// ============================================================================

/** 本卡片展示的核心能力 (feature) 顺序 — 与 backend getRoutingPlans 默认参数对齐. */
export const DATA_SOURCE_FOCUS_FEATURES: readonly string[] = Object.freeze([
  'history_k',
  'stock_list',
  'stock_basic',
  'fundamental_factor',
  'money_flow',
  'valuation',
  'realtime_quote',
  'intraday_bar',
]);

/** feature key → 中文标签. */
export const DATA_SOURCE_FEATURE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  history_k: '历史 K 线',
  stock_list: '股票列表',
  stock_basic: '基础资料',
  fundamental_factor: '基本面因子',
  money_flow: '资金流向',
  valuation: '估值口径',
  realtime_quote: '实时行情',
  intraday_bar: '分钟级行情',
  trade_calendar: '交易日历',
  index_constituents: '指数成分',
  health_probe: '健康探测',
});

/** provider.status → DataMissing/SLA 配色家族同色. */
export const DATA_SOURCE_STATUS_COLOR: Readonly<Record<string, string>> = Object.freeze({
  healthy: DATA_HEALTH_COLOR.green,
  degraded: DATA_HEALTH_COLOR.yellow,
  unhealthy: DATA_HEALTH_COLOR.red,
  disabled: DATA_HEALTH_COLOR.unknown,
  unknown: DATA_HEALTH_COLOR.unknown,
});

/** provider.status → 中文标签. */
export const DATA_SOURCE_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  healthy: '健康',
  degraded: '降级',
  unhealthy: '异常',
  disabled: '未启用',
  unknown: '未知',
});

/** provider.status → antd Tag color name. */
export const DATA_SOURCE_STATUS_TAG_COLOR: Readonly<
  Record<string, 'green' | 'orange' | 'red' | 'default' | 'blue'>
> = Object.freeze({
  healthy: 'green',
  degraded: 'orange',
  unhealthy: 'red',
  disabled: 'default',
  unknown: 'default',
});

/** 主链路覆盖率档位阈值 (% — 几个 focus feature 已有 rank=1 healthy 主源). */
export const PRIMARY_COVERAGE_HEALTHY_MIN = 80;
export const PRIMARY_COVERAGE_DEGRADED_MIN = 50;

/** provider 单条精简视图 (顶部 chart + 底部列表共享). */
export interface ProviderSummary {
  /** provider_name 唯一 key (e.g. 'akshare' / 'tushare'). */
  provider_name: string;
  /** 中文显示名. */
  provider_label: string;
  /** 状态 (healthy / degraded / unhealthy / disabled / unknown). */
  status: string;
  /** 健康分 0-100. */
  health_score: number;
  /** 是否启用 (env / config). */
  is_enabled: boolean;
  /** 优先级 (越小越优先, backend DEFAULT_DATA_PROVIDERS). */
  priority: number;
  /** 最近一次延迟 (ms), null 表示从未探测. */
  last_latency_ms: number | null;
  /** 最近一次错误 (前 80 字). */
  last_error: string | null;
  /** 最近一次成功时间 ISO. */
  last_success_at: string | null;
  /** 最近一次失败时间 ISO. */
  last_failure_at: string | null;
  /** 连续失败次数. */
  consecutive_failures: number;
  /** 累计成功次数. */
  success_count: number;
  /** 累计失败次数. */
  failure_count: number;
}

/** 单个 feature 的主/备路由摘要 (供矩阵行渲染). */
export interface FeatureRoutingSummary {
  /** feature key (history_k / stock_list ...). */
  feature: string;
  /** 中文标签. */
  feature_label: string;
  /** 主用 provider (rank=1), null 表示无可用主链路 (全 unhealthy/disabled). */
  primary: DataSourceRoutingEntry | null;
  /** 备用 providers (rank>=2 enabled). 截前 3 个避免 UI 撑爆. */
  backups: DataSourceRoutingEntry[];
  /** 总路由条数 (含 disabled, 仅作排错提示). */
  total_routes: number;
  /** 主链路是否健康 (primary?.status === 'healthy'). */
  primary_healthy: boolean;
  /** 是否有任何 enabled fallback (备用源至少 1 个 enabled). */
  has_backup: boolean;
}

/** 整体卡片视图模型 — 给 DataSourceSwitchCard 一次性 destructure. */
export interface DataSourceSwitchViewModel {
  /** 8 个 focus feature 的路由摘要 (顺序固定, 与 DATA_SOURCE_FOCUS_FEATURES 一致). */
  features: FeatureRoutingSummary[];
  /** 全 provider 列表 (按 priority asc + provider_name asc 稳定排序). */
  providers: ProviderSummary[];
  /** 已注册 provider 总数. */
  total_providers: number;
  /** 启用 provider 数. */
  enabled_providers: number;
  /** healthy 状态 provider 数. */
  healthy_providers: number;
  /** degraded 状态 provider 数. */
  degraded_providers: number;
  /** unhealthy 状态 provider 数. */
  unhealthy_providers: number;
  /** 平均健康分 (启用 provider 均值, 0-100). 无启用源返 0. */
  avg_health_score: number;
  /** 主链路覆盖率 (% — focus features 中 primary_healthy=true 占比), null=无 feature. */
  primary_coverage_pct: number | null;
  /** 主链路覆盖率档位. */
  primary_coverage_level: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** ready=true 当 primary_coverage_level==='healthy' 且 unhealthy_providers===0. */
  ready: boolean;
  /** ready=false 的原因列表 (UL 直接渲染). */
  blockers: string[];
  /** healthBundle 缺数据 → loading=true. */
  loading: boolean;
}

/** 把 DataSourceProvider → 精简 ProviderSummary — pure. */
export function summarizeProvider(provider: DataSourceProvider): ProviderSummary {
  const status =
    typeof provider.status === 'string' && provider.status.length > 0 ? provider.status : 'unknown';
  const lat =
    typeof provider.last_latency_ms === 'number' && Number.isFinite(provider.last_latency_ms)
      ? provider.last_latency_ms
      : null;
  const errStr =
    typeof provider.last_error === 'string' && provider.last_error.length > 0
      ? provider.last_error.slice(0, 80)
      : null;
  const healthScore =
    typeof provider.health_score === 'number' && Number.isFinite(provider.health_score)
      ? Math.max(0, Math.min(100, Math.round(provider.health_score)))
      : 0;
  return {
    provider_name: provider.provider_name,
    provider_label: provider.provider_label || provider.provider_name,
    status,
    health_score: healthScore,
    is_enabled: Boolean(provider.is_enabled),
    priority:
      typeof provider.priority === 'number' && Number.isFinite(provider.priority)
        ? provider.priority
        : 999,
    last_latency_ms: lat,
    last_error: errStr,
    last_success_at: provider.last_success_at ?? null,
    last_failure_at: provider.last_failure_at ?? null,
    consecutive_failures:
      typeof provider.consecutive_failures === 'number' &&
      Number.isFinite(provider.consecutive_failures)
        ? provider.consecutive_failures
        : 0,
    success_count:
      typeof provider.success_count === 'number' && Number.isFinite(provider.success_count)
        ? provider.success_count
        : 0,
    failure_count:
      typeof provider.failure_count === 'number' && Number.isFinite(provider.failure_count)
        ? provider.failure_count
        : 0,
  };
}

/**
 * 把单个 feature 的 routing entries → FeatureRoutingSummary.
 *
 * routes 已按 backend route_score 降序排好 (rank=1 主用); 本 helper 只做:
 *   - 过滤 disabled (主备视图不展示, 列表里再现身)
 *   - 选主用 = enabled 且 supported 中 rank 最小者 (= 第一个)
 *   - 备用 = 剩余 enabled, 截前 3 个
 *
 * routes=空数组 → primary=null + has_backup=false (无可用主链路).
 */
export function buildFeatureRoutingSummary(
  feature: string,
  routes: DataSourceRoutingEntry[] | undefined
): FeatureRoutingSummary {
  const label = DATA_SOURCE_FEATURE_LABEL[feature] || feature;
  if (!Array.isArray(routes) || routes.length === 0) {
    return {
      feature,
      feature_label: label,
      primary: null,
      backups: [],
      total_routes: 0,
      primary_healthy: false,
      has_backup: false,
    };
  }
  const enabled = routes.filter(r => r && r.is_enabled);
  const primary = enabled[0] ?? null;
  const backups = enabled.slice(1, 4);
  return {
    feature,
    feature_label: label,
    primary,
    backups,
    total_routes: routes.length,
    primary_healthy: Boolean(primary && primary.status === 'healthy'),
    has_backup: enabled.length > 1,
  };
}

/**
 * 主入口: healthBundle → DataSourceSwitchViewModel.
 *
 * - healthBundle=null/undefined → loading=true 占位
 * - providers 按 (priority asc, provider_name asc) 排序保稳定
 * - primary_coverage = focus features 中 primary_healthy 占比
 * - primary_coverage_level: healthy >= 80% / degraded >= 50% / critical < 50% / unknown (无 feature)
 * - ready = primary_coverage_level==='healthy' 且 unhealthy_providers===0
 * - blockers: 列出 primary 缺失或 unhealthy 的 feature + unhealthy provider 列表
 *
 * Pure, 永不抛, useMemo 安全.
 */
export function buildDataSourceSwitchViewModel(
  healthBundle: DataSourceHealthBundle | null | undefined
): DataSourceSwitchViewModel {
  if (!healthBundle) {
    return {
      features: DATA_SOURCE_FOCUS_FEATURES.map(f => buildFeatureRoutingSummary(f, [])),
      providers: [],
      total_providers: 0,
      enabled_providers: 0,
      healthy_providers: 0,
      degraded_providers: 0,
      unhealthy_providers: 0,
      avg_health_score: 0,
      primary_coverage_pct: null,
      primary_coverage_level: 'unknown',
      ready: false,
      blockers: ['尚未加载数据源健康状态'],
      loading: true,
    };
  }
  const providersRaw = Array.isArray(healthBundle.providers) ? healthBundle.providers : [];
  const routingPlans = healthBundle.routing_plans || {};

  // 1. 8 个 focus feature 的路由摘要
  const features = DATA_SOURCE_FOCUS_FEATURES.map(f =>
    buildFeatureRoutingSummary(f, routingPlans[f])
  );

  // 2. provider 精简列表 (priority asc + name asc)
  const providers = providersRaw
    .filter(p => p && typeof p === 'object' && typeof p.provider_name === 'string')
    .map(summarizeProvider)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.provider_name.localeCompare(b.provider_name);
    });

  // 3. 汇总计数
  const total_providers = providers.length;
  const enabled_providers = providers.filter(p => p.is_enabled).length;
  const healthy_providers = providers.filter(p => p.status === 'healthy').length;
  const degraded_providers = providers.filter(p => p.status === 'degraded').length;
  const unhealthy_providers = providers.filter(p => p.status === 'unhealthy').length;
  const enabledList = providers.filter(p => p.is_enabled);
  const avg_health_score =
    enabledList.length > 0
      ? Math.round(enabledList.reduce((s, p) => s + p.health_score, 0) / enabledList.length)
      : 0;

  // 4. 主链路覆盖率
  const coverable = features.length;
  const covered = features.filter(f => f.primary_healthy).length;
  const primary_coverage_pct = coverable > 0 ? Math.round((covered / coverable) * 100) : null;
  let primary_coverage_level: DataSourceSwitchViewModel['primary_coverage_level'];
  if (primary_coverage_pct === null) primary_coverage_level = 'unknown';
  else if (primary_coverage_pct >= PRIMARY_COVERAGE_HEALTHY_MIN) primary_coverage_level = 'healthy';
  else if (primary_coverage_pct >= PRIMARY_COVERAGE_DEGRADED_MIN)
    primary_coverage_level = 'degraded';
  else primary_coverage_level = 'critical';

  // 5. blockers — 让 ops 一眼看到要处理什么
  const blockers: string[] = [];
  for (const f of features) {
    if (!f.primary) {
      blockers.push(`${f.feature_label} 无可用主链路 (全部 ${f.total_routes} 个 provider 已禁用)`);
    } else if (!f.primary_healthy) {
      const lab = DATA_SOURCE_STATUS_LABEL[f.primary.status] || f.primary.status || 'unknown';
      blockers.push(
        `${f.feature_label} 主用源 ${f.primary.provider_label} 状态 ${lab}${
          !f.has_backup ? ' (无备用)' : ''
        }`
      );
    }
  }
  for (const p of providers) {
    if (p.status === 'unhealthy') {
      blockers.push(
        `${p.provider_label} 状态异常${
          p.consecutive_failures > 0 ? ` (连续失败 ${p.consecutive_failures} 次)` : ''
        }`
      );
    }
  }

  const ready = primary_coverage_level === 'healthy' && unhealthy_providers === 0;

  return {
    features,
    providers,
    total_providers,
    enabled_providers,
    healthy_providers,
    degraded_providers,
    unhealthy_providers,
    avg_health_score,
    primary_coverage_pct,
    primary_coverage_level,
    ready,
    blockers,
    loading: false,
  };
}
