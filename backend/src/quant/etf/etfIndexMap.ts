/**
 * ETF → 跟踪指数映射 (信号优先重构 批5-b, §4.1 ETF 因子轮动)
 *
 * 用途:
 *   §4.1 因子计算的第一步是"ETF → 成分股展开". 展开有两条路径:
 *     1. 主路径: 用 `index_components` (ETF 跟踪的指数成分 + 权重). 需要知道
 *        ETF 跟踪的是哪个指数 (index_code, 纯 6 位, 见 IndexComponent.ts).
 *     2. Fallback: 若无 index_components 数据, 用 `fund_top_holdings`
 *        (基金前十大重仓, 按 fund_code = ETF 6 位代码直接查, 无需本映射).
 *
 * 因此本映射**只服务主路径**, 且只收录**高置信**的 ETF→指数对应关系
 * (宽基 + 少数确定的风格指数). 未收录的 ETF 一律走 fund_top_holdings fallback
 * (按 ETF 自身代码查, 天然正确). 遵 §0.1 正确性优先: 宁可 fallback, 不写错映射.
 *
 * 维护规则:
 *   - key = ETF 6 位代码 (与 constants/etfIndustry.ts 白名单口径一致, 无前后缀).
 *   - value = 跟踪指数 6 位代码 (与 index_components.index_code 口径一致, 无后缀).
 *   - 新增映射前必须核实该 ETF 确实跟踪该指数 (基金合同 / 招募说明书),
 *     且 index_components 确有该指数成分数据. 不确定 → 不加, 走 fallback.
 */

/**
 * 高置信 ETF → 跟踪指数映射 (纯 6 位代码).
 *
 * 宽基 ETF 跟踪指数明确, 全部收录. 风格/行业/主题 ETF 跟踪的是各类 CSI/CNI
 * 细分指数, 对应关系易错且 index_components 未必覆盖, 除个别确定项外一律留空
 * 交给 fund_top_holdings fallback.
 */
export const ETF_TRACKED_INDEX: Readonly<Record<string, string>> = Object.freeze({
  // ===== 宽基 (跟踪指数明确) =====
  '510300': '000300', // 沪深300ETF → 沪深300
  '510500': '000905', // 中证500ETF → 中证500
  '510050': '000016', // 上证50ETF  → 上证50
  '588000': '000688', // 科创50ETF  → 科创50
  '159949': '399673', // 创业板50ETF → 创业板50
  // ===== 风格 (高置信) =====
  '510880': '000015', // 红利ETF华泰柏瑞 → 上证红利
});

/**
 * 取 ETF 跟踪的指数代码 (纯 6 位). 无高置信映射时返回 null,
 * 调用方应据此改走 fund_top_holdings fallback.
 */
export function getTrackedIndexCode(etfCode: string): string | null {
  if (!etfCode) return null;
  return ETF_TRACKED_INDEX[etfCode] ?? null;
}
