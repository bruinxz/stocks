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
  DataSourceHealthCard,
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
  green: '#52c41a',
  yellow: '#faad14',
  red: '#f5222d',
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
