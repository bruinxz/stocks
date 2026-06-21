/**
 * US-048 FactorWorkspace ETF 资金流 Tab (FE-009) — 纯函数 helper.
 *
 * 拆出来的目的: 让 backend ts-node 单测可以 import 而不引入 React/antd 依赖.
 * 与 [[factorAIWeightHelpers]] / [[factorComboTemplateHelpers]] /
 * [[policyNewsHelpers]] 同款 "frontend helper / backend ts-node 跑测试" 范式.
 */

/** /api/data/etf-flow 返 data[i] 形状 (与 backend ETFFlowSyncService FlowEntry 对齐). */
export interface ETFFlowEntry {
  trade_date: string;
  etf_code: string;
  etf_name: string;
  underlying_industry: string;
  net_inflow: number | null;
  aum: number | null;
  nav: number | null;
  share_count: number | null;
  secondary_turnover: number | null;
  close_price: number | null;
}

/** 单只 ETF 在所选窗口的累计聚合视图 — 用于顶部 inflow / outflow 排行. */
export interface ETFAggregateRow {
  etf_code: string;
  etf_name: string;
  underlying_industry: string;
  cumulative_inflow: number;
  latest_aum: number | null;
  latest_nav: number | null;
  days: number;
}

/**
 * 把 per-row 明细聚合成 per-ETF 累计净流入 + 最新 AUM/NAV.
 *
 * 输入约定: 后端按 trade_date DESC 返, 所以 "第一次遇到 etf_code" 的 AUM/NAV
 * 即最新一日. 不做二次排序避免拖慢大输入.
 *
 * 跳过条件: etf_code 为空 / null / 整 row 为 null. 不抛 — UI 应当稳定渲染.
 * net_inflow 为 null/NaN/Infinity 时不加入累加 (但 days +1 — 表示这一天有 row).
 */
export function aggregateETFFlow(
  rows: ReadonlyArray<ETFFlowEntry> | null | undefined
): ETFAggregateRow[] {
  if (!Array.isArray(rows)) return [];
  const map = new Map<string, ETFAggregateRow>();
  for (const r of rows) {
    if (!r || !r.etf_code) continue;
    let agg = map.get(r.etf_code);
    if (!agg) {
      agg = {
        etf_code: r.etf_code,
        etf_name: r.etf_name || r.etf_code,
        underlying_industry: r.underlying_industry || '其它',
        cumulative_inflow: 0,
        latest_aum: null,
        latest_nav: null,
        days: 0,
      };
      map.set(r.etf_code, agg);
    }
    if (r.net_inflow != null && Number.isFinite(r.net_inflow)) {
      agg.cumulative_inflow += r.net_inflow;
    }
    agg.days += 1;
    if (agg.latest_aum == null && r.aum != null) agg.latest_aum = r.aum;
    if (agg.latest_nav == null && r.nav != null) agg.latest_nav = r.nav;
  }
  return Array.from(map.values());
}

/** 1 亿 = 1e8 元 — 千万级以上才显示 "亿", 否则 "万". */
export function fmtETFMoney(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  if (abs >= 1e8) return `${(val / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(val / 1e4).toFixed(1)} 万`;
  return val.toFixed(0);
}

/** 净流入颜色: 正=红 (申购热), 负=绿 (赎回), 零/null=灰. A 股配色. */
export function inflowColor(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '#999';
  return val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#666';
}
