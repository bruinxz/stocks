/**
 * US-069 [FE-030] SettingsWorkspace 策略 kill-switch UI — 纯函数 helper.
 *
 * 让操盘手在 SettingsWorkspace 的 "策略 kill-switch" tab 一目了然看到所有策略
 * 的启用状态, 并能 **单独 disable / enable** 每个策略. 与 [[setStrategyDryRun]]
 * (US-083 dry-run shortcut) 互补: dry-run 只让策略产信号不下单; kill-switch
 * 是更彻底的 "策略整体停摆", 走 PATCH /api/quant/strategies/:strategy_key
 * 设 `enabled: false`. 后端 strategyEngine 的 `resolveStrategyKeys()` 只取
 * `enabled=true` 的记录, 所以一旦 kill-switch off, 该策略的 daily pipeline /
 * 信号产出 / shadow run 全部停掉 — 真正的"红色拉闸".
 *
 * 数据形态:
 *   - source: GET /api/quant/strategies → labService.listQuantStrategies()
 *     返 `QuantStrategyItem[]` (含 strategy_key / name / display_name / category
 *     / risk_level / tags / enabled / default_params). 字段命名与后端
 *     QuantStrategyModel 表一致 (snake_case + display_order 已在后端排好序).
 *   - 操作: PATCH /api/quant/strategies/:strategy_key {enabled: bool} →
 *     setStrategyEnabled() (新增, 见 labService.ts).
 *
 * 设计原则 (与 [[strategy-kill-switch-monitor]] 后端自动巡检解耦):
 *   - **本 tab 只管"用户主动 kill"** — 与 KillSwitchService 的自动熔断
 *     (订单失败率 / 连败 / 异常订单数) 互不冲突. 后端自动熔断走 live_kill_switch_states
 *     表 + RiskAlert; 本 UI 走 quant_strategies.enabled 字段, 是策略级别的
 *     "明天还要不要扫描" 开关.
 *   - **draft/view 双状态 + 单 cell 调用 PATCH** — 不同于 push-channels
 *     的批量 diff 保存, 这里每个 Switch toggle 立刻 PATCH (单字段, 原子),
 *     避免用户改完 5 个策略点保存时一个 503 让所有改动回滚. 与
 *     [[setStrategyDryRun]] 同款"单 cell 即时落库"范式.
 *   - **risk_level 高的策略需要二次确认** — 让用户对 high-risk 策略多想
 *     一下, 但不强制 (用户可以选不弹). 用 buildKillSwitchConfirmConfig().
 *   - **统计 KPI 全走 helper** — 让 UI 渲染就是 view-model 摊平 +
 *     `kpi.enabledCount` / `kpi.disabledCount`, 不要在 JSX 里 reduce / filter.
 *
 * 纯函数, 不依赖 React / antd / fetch, 直接吃 QuantStrategyItem[] 返新
 * 数据/统计. 单测在 backend/tests/services/strategy-kill-switch-helpers.test.ts
 * (跨 monorepo import, 与 [[前端 pure helper 模板]] (factor-ai-weight /
 * shadow-run / overfit-metrics / analysis-engine-weight / etc.) 同款
 * ts-node --transpile-only 跑).
 */

import type { QuantStrategyItem } from '../../services/labService';

/** risk_level 与展示色 / 二次确认门槛对齐 — 与后端 QuantStrategyDefinition.risk_level 同集合. */
export type StrategyRiskLevel = 'low' | 'medium' | 'high';

/** UI 渲染单元: 一行策略 = `QuantStrategyItem` 加上规范化后的展示字段. */
export interface KillSwitchRowItem {
  strategy_key: string;
  /** 显示名 — 优先 display_name, 退到 name, 退到 strategy_key */
  display_name: string;
  category: string;
  risk_level: StrategyRiskLevel;
  enabled: boolean;
  tags: string[];
}

/** 矩阵 KPI 摘要 — 渲染顶部 Statistic 用. */
export interface KillSwitchKpi {
  total: number;
  enabledCount: number;
  disabledCount: number;
  /** high-risk 中 enabled 数量 — 提醒用户 "你已经启了 N 个高风险" */
  highRiskEnabled: number;
}

/** 二次确认 Modal 配置 — 仅当 risk_level=high && 要 disable 时返非空. */
export interface KillSwitchConfirmConfig {
  /** 是否需要弹确认框 — false 时调用方直接 PATCH 即可 */
  needsConfirm: boolean;
  /** Modal 标题 */
  title: string;
  /** Modal content */
  content: string;
  /** OK 按钮 label */
  okText: string;
  /** OK 按钮 danger? */
  danger: boolean;
}

/** risk_level 校验 + 默认 medium — 后端老数据 / registry 没填都兜底成 medium. */
export function normalizeRiskLevel(input: any): StrategyRiskLevel {
  if (input === 'low' || input === 'high') return input;
  return 'medium';
}

/** display_name 兜底 — 让 UI 永远有文字. */
export function pickDisplayName(item: Partial<QuantStrategyItem>): string {
  const name = String(item.display_name || '').trim();
  if (name) return name;
  const fallback = String(item.name || '').trim();
  if (fallback) return fallback;
  return String(item.strategy_key || '').trim() || '未知策略';
}

/** tags 数组规范化 — 单元测试需要稳定输出 (filter falsy, dedup keep order). */
export function normalizeTags(tags: any): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tags) {
    const s = String(t || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    result.push(s);
  }
  return result;
}

/**
 * 把后端原始 `QuantStrategyItem` 数组转成 `KillSwitchRowItem[]` (UI 数据源).
 *
 * 不依赖 input 顺序 — 后端已按 display_order ASC NULLS LAST 排好, helper 保留
 * 输入顺序; 测试可以传任意顺序验证字段映射正确.
 */
export function buildKillSwitchRows(
  items: QuantStrategyItem[] | null | undefined
): KillSwitchRowItem[] {
  if (!Array.isArray(items)) return [];
  const rows: KillSwitchRowItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const strategy_key = String(item.strategy_key || '').trim();
    if (!strategy_key) continue;
    rows.push({
      strategy_key,
      display_name: pickDisplayName(item),
      category: String(item.category || '').trim() || 'uncategorized',
      risk_level: normalizeRiskLevel(item.risk_level),
      // 与后端 `record?.enabled !== false` 同款语义:
      // undefined / null → 兜底为 true (新策略默认启用); 显式 false 才禁用.
      enabled: item.enabled !== false,
      tags: normalizeTags(item.tags),
    });
  }
  return rows;
}

/** KPI 聚合 — UI 顶部 Statistic 4 件套. */
export function buildKillSwitchKpi(rows: KillSwitchRowItem[]): KillSwitchKpi {
  const safeRows = Array.isArray(rows) ? rows : [];
  let enabledCount = 0;
  let highRiskEnabled = 0;
  for (const r of safeRows) {
    if (r.enabled) {
      enabledCount += 1;
      if (r.risk_level === 'high') highRiskEnabled += 1;
    }
  }
  return {
    total: safeRows.length,
    enabledCount,
    disabledCount: safeRows.length - enabledCount,
    highRiskEnabled,
  };
}

/**
 * 决定一个 toggle 操作是否需要弹二次确认.
 *
 * 规则:
 *   - 启用任何策略: 不需要确认 (打开是恢复正常运行, 风险较低);
 *   - 禁用 low/medium: 不需要确认 (软停, 影响有限);
 *   - 禁用 high: 弹一次确认 (高风险策略可能是利润大头, 防误点).
 *
 * 不在这里直接调 Modal — 让 UI 层用返回的 config 决定怎么弹 (antd Modal.confirm
 * 还是 inline Popconfirm), helper 仍保持纯函数 / 可单测.
 */
export function buildKillSwitchConfirmConfig(
  row: Pick<KillSwitchRowItem, 'risk_level' | 'display_name'>,
  nextEnabled: boolean
): KillSwitchConfirmConfig {
  // 启用 — 一律放行
  if (nextEnabled) {
    return {
      needsConfirm: false,
      title: `启用「${row.display_name}」`,
      content: '',
      okText: '启用',
      danger: false,
    };
  }
  // 禁用 high-risk — 二次确认
  if (row.risk_level === 'high') {
    return {
      needsConfirm: true,
      title: `禁用高风险策略「${row.display_name}」?`,
      content:
        '禁用后该策略的日度信号流水线会立即停摆, 已存仓位不会自动卖出 (走风控独立路径). ' +
        '高风险策略通常是利润大头, 请确认你确实想下线它. 任何时刻都可再启用.',
      okText: '禁用',
      danger: true,
    };
  }
  // 禁用 low / medium — 软停, 不弹
  return {
    needsConfirm: false,
    title: `禁用「${row.display_name}」`,
    content: '',
    okText: '禁用',
    danger: true,
  };
}

/**
 * 本地 optimistic update — Switch toggle 后立即在前端把 rows 改成新状态,
 * 等 PATCH 成功再 setRows(server_response). 失败回滚 (调用方 catch 中调
 * 本函数传入 prevEnabled 即可).
 */
export function applyEnabledPatch(
  rows: KillSwitchRowItem[],
  strategy_key: string,
  enabled: boolean
): KillSwitchRowItem[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => (r.strategy_key === strategy_key ? { ...r, enabled } : r));
}
