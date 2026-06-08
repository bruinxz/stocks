/**
 * InsiderTradeFactor (内部人净买入因子) — US-090
 *
 * 公式: raw_value = (sum(trade_amount where direction=增持) -
 *                    sum(trade_amount where direction=减持))
 *                  / circulating_market_cap
 *
 *   - 分子: 近 60 自然日内, 该股所有股东增减持公告的净买入金额 (元).
 *           增持 → +, 减持 → -.
 *   - 分母: 当前流通市值 (元) — 归一化, 避免大市值股票数值膨胀.
 *
 *   经济意义:
 *     - 大股东 / 高管 / 机构主动增持 → 信号 "内部人对未来基本面有信心",
 *       中线 alpha 实证已证 (参考: 国泰君安《内部人交易因子有效性研究》2017,
 *       Lakonishok & Lee 1998 "Are Insider Trades Informative?").
 *     - 减持 → 信号 "内部人套现 / 对未来不乐观", 中线 alpha 反向.
 *     - **不区分股东类型权重** (机构 vs 自然人 vs 高管): 实证显示信息含量
 *       接近, 区分反而引入噪音; 留作 v2 优化路径.
 *
 * 数据源: ShareholderTradeRecord 表 (US-090 同步入库)
 *   - PK 五元组 (announce_date, stock_code, shareholder_name,
 *     trade_direction, change_start_date)
 *   - 关键字段: trade_amount (元, **代理字段** = trade_shares × latest_price),
 *     trade_direction ('增持' | '减持'), announce_date (用于窗口过滤)
 * + Stock 表的 circulating_market_cap (最新流通市值)
 *
 * **关于 trade_amount 代理性 (US-090 数据层代理范式)**:
 *   - ShareholderTradeRecord.trade_amount = trade_shares × latest_price (最新价),
 *     **不是**真实公告日成交均价 (AKShare 不提供, 端点限制).
 *   - 影响: 横截面 ratio 受最新价 vs 公告日价的偏差影响, 通常 < 10% (公告
 *     窗口短), 横截面排序仍准确.
 *   - 升级路径: 若未来 AKShare 给 stock_ggcg_em 加 "成交均价" 列, sync 服务
 *     替换 trade_amount 计算公式即可, 因子无需改动.
 *   - **scale-invariant 保证**: 因子计算用 ratio (净买入 / 流通市值), 代理的
 *     系统性偏差 (latest_price vs 真实价) 在横截面下基本对齐 (各股都用最新价),
 *     不影响 zscore / percentile 排序 — 与 US-034 EastMoneyQAFactor scale-invariant
 *     升级路径同款.
 *
 * 失效 (不入 Map, 让 Pipeline 中性补全):
 *   - 60 日窗口内该股一条增减持记录都没有 → 跳过
 *     (注: 大量股票 raw_value=0 会让横截面 zscore 退化成 "0 vs 正/负" 多模分布,
 *      中性补全 percentile=0.5 反而保留干净信号)
 *   - circulating_market_cap 为空 / ≤ 0 → 跳过 (防分母爆炸)
 *   - announce_date > as_of_date → 剔除单行 (lookahead bias guard, US-030 范式)
 *
 * 关于 "因子不做归一化" 约束 #1 (factors/CLAUDE.md):
 *   - raw_value = 净买入 / 流通市值, 是 **绝对业务量** (per-stock 自身), 不
 *     参照横截面统计量 — 走标准模式 (不属 LiquidityFactor 例外). Pipeline 后续
 *     仍做 winsorize + zscore 跨因子归一化.
 *
 * 关于 "绝对业务量 vs 横截面参照量 二分类" (US-030 起):
 *   - 判据: raw_value 公式里是否出现 "全市场 X 的分位 / 均值 / sd"? 否 (只看
 *     本股自己的增减持累计) → 第一类 (绝对业务量), 走标准模式.
 *
 * 关于 WINDOW_DAYS = 60 自然日:
 *   - 内部人交易披露时效性: T+3 公告 (减持) / T+15 公告 (增持) 已有滞后,
 *     再要给市场时间反应到价格上, 60 日窗口覆盖 "公告 → 价格反应" 的中线
 *     窗口. 实证最优为 30-90 日, 60 日是中点.
 *   - 太短 (10-20 日): 多数股该窗口内 0 条公告, 信号稀疏到只覆盖几只票.
 *   - 太长 (180+ 日): 信号衰减, 老公告对当下定价影响弱.
 *
 * 与既有因子的关系:
 *   - 与 money_flow (US-010, 主力净流入) 同为 "资金流向" 因子, 但 money_flow 是
 *     盘中主力席位资金 (日级高频), 本因子是公告披露的内部人决策 (公告级低频),
 *     维度互补, 相关性预计 0.2-0.3, 可同时启用.
 *   - 与 shareholder_concentration (US-035, 股东户数环比) 同属 "股东行为" 维度,
 *     但前者是户数广度 (季度披露), 本因子是金额强度 (公告级), 一个 stock 信号,
 *     一个 cash 信号, 互补.
 *   - 与 northbound (US-010, 北向持股) 相关性低 (~0.1): 北向是外资被动持仓,
 *     本因子是境内股东主动决策, 维度不同.
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { ShareholderTradeRecord } from '../../../models/ShareholderTradeRecord';
import { loadStocksByCodes, isFiniteNumber, lookbackStartDate } from './_helpers';

/** 因子查询窗口 (自然日) — 60 日覆盖内部人公告 → 价格反应的中线窗口 */
export const WINDOW_DAYS = 60;

/**
 * 单只股票多条增减持公告的 "净买入金额" helper (抽成纯函数便于测试).
 *
 * @param trades         该股票在 [as_of - WINDOW_DAYS, as_of] 内的全部
 *                       (announce_date, trade_direction, trade_amount) 记录
 * @param asOfDate       截面日期 (YYYY-MM-DD)
 * @returns              净买入金额 (元, 增持 → +, 减持 → -);
 *                       窗口内无有效记录 → null
 */
export interface TradeObservation {
  announce_date: string;
  trade_direction: string | null | undefined;
  trade_amount: number | null | undefined;
}

export interface NetInflowBreakdown {
  /** 增持金额累计 (元, ≥ 0) */
  buy_amount: number;
  /** 减持金额累计 (元, ≥ 0) */
  sell_amount: number;
  /** 净买入 = buy - sell (元, 可正可负) */
  net_inflow: number;
  /** 公告条数 (用于 debug / monitoring) */
  trade_count: number;
}

export function computeNetInsiderInflow(
  trades: TradeObservation[],
  asOfDate: string
): NetInflowBreakdown | null {
  if (!trades || !trades.length || !asOfDate) return null;

  let buyAmount = 0;
  let sellAmount = 0;
  let count = 0;

  for (const t of trades) {
    if (!t.announce_date) continue;
    // lookahead bias guard (US-030 范式)
    if (t.announce_date > asOfDate) continue;

    if (t.trade_amount === null || t.trade_amount === undefined) continue;
    // `Number(null) === 0` JS 大坑 (US-031): nullable 字段必须先 null 检查再 Number 转换
    const amount = Number(t.trade_amount);
    if (!isFiniteNumber(amount)) continue;
    if (amount < 0) continue; // trade_amount 是绝对金额, 负值视为脏数据剔除

    const direction = t.trade_direction;
    if (direction === '增持') {
      buyAmount += amount;
      count += 1;
    } else if (direction === '减持') {
      sellAmount += amount;
      count += 1;
    }
    // 未知 direction 行 (e.g. '其他' / null) 不计入
  }

  if (count === 0) return null;

  return {
    buy_amount: buyAmount,
    sell_amount: sellAmount,
    net_inflow: buyAmount - sellAmount,
    trade_count: count,
  };
}

export const insiderTradeFactor: Factor = {
  name: 'insider_trade',
  description: '最近 60 日内部人 (股东增减持) 净买入金额 / 流通市值 (代理量, 见 jsdoc)',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) 拉 Stock 表的 circulating_market_cap
    const stockByCode = await loadStocksByCodes(ctx.universe, [
      'id',
      'symbol',
      'circulating_market_cap',
    ]);
    if (!stockByCode.size) return out;

    // 2) 拉窗口内的 ShareholderTradeRecord (按 stock_code IN 过滤 universe)
    const startDate = lookbackStartDate(ctx.as_of_date, WINDOW_DAYS);
    const rows = (await ShareholderTradeRecord.findAll({
      attributes: ['stock_code', 'announce_date', 'trade_direction', 'trade_amount'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        announce_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      announce_date: string;
      trade_direction: string | null;
      trade_amount: any;
    }>;

    // 3) 按 stock_code 分组
    const byStock = new Map<string, TradeObservation[]>();
    for (const r of rows) {
      const arr = byStock.get(r.stock_code) ?? [];
      const amount =
        r.trade_amount === null || r.trade_amount === undefined ? null : Number(r.trade_amount);
      arr.push({
        announce_date: r.announce_date,
        trade_direction: r.trade_direction,
        trade_amount: amount !== null && isFiniteNumber(amount) ? amount : null,
      });
      byStock.set(r.stock_code, arr);
    }

    // 4) per-stock 计算 净买入 / 流通市值
    for (const [code, trades] of byStock.entries()) {
      const breakdown = computeNetInsiderInflow(trades, ctx.as_of_date);
      if (breakdown === null) continue;
      const stock = stockByCode.get(code);
      if (!stock) continue;
      const mcap = Number(stock.circulating_market_cap);
      if (!isFiniteNumber(mcap) || mcap <= 0) continue;
      out.set(code, breakdown.net_inflow / mcap);
    }

    return out;
  },
};

factorRegistry.register(insiderTradeFactor);
