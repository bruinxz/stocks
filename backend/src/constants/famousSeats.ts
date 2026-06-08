/**
 * 知名游资 / 机构席位白名单 + 归属机构分类（US-006 引入；US-088 扩展归属机构）
 *
 * 用途：
 *   1. 龙虎榜 (DragonTigerBoard) 入库时，若 `buyer_seat` 命中本白名单的 famous_yz 类，
 *      则 `is_famous_yz = true`。短线策略据此识别游资抢筹/跟随机会。
 *   2. US-088 新增：每个席位还有归属机构类型 `seat_type`（公募 / 外资 / 私募 /
 *      著名游资 / unknown），方便短线策略按"跟随机构 vs 跟随游资"区分逻辑。
 *
 * 维护规则：
 * - 名称需与 AKShare `stock_lhb_detail_em` 返回的 "营业部名称" 列严格匹配
 *   （东方财富一般使用 "证券公司全称 + 营业部全称"，无空格、无前缀编号）。
 * - 同一个游资可能在不同时期切换席位（例如赵老哥从 "中国银河证券绍兴营业部"
 *   迁到 "东方财富证券拉萨团结路第二营业部"），这里都保留以兼容回测时间窗。
 * - 100+ 条是 US-088 任务要求的覆盖；后续可经回测命中频次扩展。
 * - 仅维护"买方席位"白名单 — 卖方席位由 famous_yz 判断没有可操作信号意义。
 *
 * 归属机构类型 `SeatType` 取值：
 * - `public_fund`  公募基金专用席位（中金 / 中信 / 国君 / 海通的机构专用席位）
 * - `foreign`      外资 / QFII / 沪深港通席位（中信里昂 / 摩根士丹利 / 高盛 / 北向席位）
 * - `private_fund` 私募专用席位（部分大型私募有专属席位，命名包含"机构专用"或私募系名称）
 * - `famous_yz`    著名游资营业部席位（赵老哥 / 章盟主 / 葛卫东等的常驻席位）
 * - `unknown`      未分类（其他普通营业部 / 散户席位）
 *
 * 数据来源参考（公开 + 业内常识）：
 *   - 东方财富网龙虎榜频道公开排行（机构专用 + 营业部 Top 100）
 *   - 同花顺、淘股吧、雪球的游资席位档案
 *   - 财经媒体公开报道（每经/财联社/证券时报）
 *
 * 若发现 AKShare 返回的席位名拼写漂移，请扩展 `FAMOUS_SEAT_ALIASES`，
 * 而不是在白名单里塞两份。
 */

/**
 * 席位归属机构类型 (US-088)
 */
export type SeatType = 'public_fund' | 'foreign' | 'private_fund' | 'famous_yz' | 'unknown';

/**
 * 席位档案（US-088）：单个营业部 → 归属机构类型 + 是否算"知名"（famous_yz 与
 * 主流公募 / 外资席位均算"知名"，方便前端统一过滤）。
 *
 * is_famous = false 仅在 type='unknown' 时出现（理论上不应入库，预留兼容）。
 */
export interface SeatProfile {
  /** 标准营业部全称（与 AKShare 返回严格匹配） */
  name: string;
  /** 归属机构类型 */
  type: SeatType;
  /** 是否算"知名"席位（famous_yz / public_fund / foreign / private_fund 均为 true） */
  is_famous: boolean;
}

/**
 * 席位白名单（US-088 扩展）：100+ 条，含归属机构类型。
 *
 * - 拉萨系（自然人席位高地）→ famous_yz
 * - 头部知名游资席位 → famous_yz
 * - 机构专用席位 → public_fund
 * - 北向 / 港股通 / 外资席位 → foreign
 * - 私募专用席位 → private_fund
 */
export const SEAT_PROFILES: ReadonlyArray<SeatProfile> = [
  // ===== 拉萨系（自然人席位高地，多个游资集中）=====
  { name: '东方财富证券股份有限公司拉萨团结路第二营业部', type: 'famous_yz', is_famous: true },
  { name: '东方财富证券股份有限公司拉萨东环路第一证券营业部', type: 'famous_yz', is_famous: true },
  { name: '东方财富证券股份有限公司拉萨东环路第二证券营业部', type: 'famous_yz', is_famous: true },
  { name: '东方财富证券股份有限公司拉萨北京中路证券营业部', type: 'famous_yz', is_famous: true },
  {
    name: '东方财富证券股份有限公司拉萨金融城南环路证券营业部',
    type: 'famous_yz',
    is_famous: true,
  },
  { name: '东方证券股份有限公司拉萨东环路第二证券营业部', type: 'famous_yz', is_famous: true },
  { name: '东方财富证券股份有限公司拉萨纳金路证券营业部', type: 'famous_yz', is_famous: true },
  { name: '东方财富证券股份有限公司拉萨朵森格路证券营业部', type: 'famous_yz', is_famous: true },

  // ===== 头部知名游资（个体 / 团队席位）=====
  { name: '中国银河证券股份有限公司绍兴营业部', type: 'famous_yz', is_famous: true }, // 赵老哥（早期）
  { name: '财通证券股份有限公司绍兴营业部', type: 'famous_yz', is_famous: true }, // 绍兴大爷 / 章盟主
  {
    name: '华泰证券股份有限公司深圳益田路荣超商务中心证券营业部',
    type: 'famous_yz',
    is_famous: true,
  }, // 合肥章盟主、欢乐海岸
  { name: '国泰君安证券股份有限公司上海江苏路证券营业部', type: 'famous_yz', is_famous: true }, // 粉葛 / 葛卫东系
  { name: '国泰君安证券股份有限公司顺德大良证券营业部', type: 'famous_yz', is_famous: true }, // 小鳄鱼 / 孙国栋
  { name: '华鑫证券有限责任公司上海分公司', type: 'famous_yz', is_famous: true }, // 徐留胜
  { name: '中信证券股份有限公司上海溧阳路证券营业部', type: 'famous_yz', is_famous: true }, // 上海超短帮
  { name: '银河证券股份有限公司宁波解放南路证券营业部', type: 'famous_yz', is_famous: true }, // 宁波敢死队
  { name: '国信证券股份有限公司深圳泰然九路证券营业部', type: 'famous_yz', is_famous: true }, // 国信泰然九路
  { name: '招商证券股份有限公司厦门莲岳路证券营业部', type: 'famous_yz', is_famous: true }, // 厦门莲岳路
  { name: '海通证券股份有限公司绍兴解放路证券营业部', type: 'famous_yz', is_famous: true }, // 绍兴解放路
  { name: '海通证券股份有限公司深圳红荔西路证券营业部', type: 'famous_yz', is_famous: true }, // 深圳红荔西路
  { name: '安信证券股份有限公司上海陆家嘴东路证券营业部', type: 'famous_yz', is_famous: true }, // 作手新一 / 瑞鹤仙
  { name: '国泰君安证券股份有限公司上海打浦路证券营业部', type: 'famous_yz', is_famous: true }, // 柳浪西厢
  { name: '财通证券股份有限公司杭州上塘路证券营业部', type: 'famous_yz', is_famous: true }, // 杭州帮
  { name: '申万宏源证券有限公司杭州延安路证券营业部', type: 'famous_yz', is_famous: true }, // 申万杭州帮
  { name: '中信建投证券股份有限公司北京八里庄北里证券营业部', type: 'famous_yz', is_famous: true }, // 北京八里庄北里
  { name: '中信证券股份有限公司杭州延安路证券营业部', type: 'famous_yz', is_famous: true }, // 中信杭州
  { name: '长江证券股份有限公司上海武宁南路证券营业部', type: 'famous_yz', is_famous: true }, // 上海武宁南路
  { name: '国元证券股份有限公司安庆湖心北路证券营业部', type: 'famous_yz', is_famous: true }, // 国元安庆（徐翔旧址）
  { name: '民生证券股份有限公司上海杨高南路证券营业部', type: 'famous_yz', is_famous: true }, // 民生杨高
  { name: '申万宏源西部证券有限公司上海闵行东川路证券营业部', type: 'famous_yz', is_famous: true }, // 申万闵行
  { name: '国信证券股份有限公司北京三里河路证券营业部', type: 'famous_yz', is_famous: true }, // 国信三里河
  { name: '中信证券股份有限公司北京呼家楼证券营业部', type: 'famous_yz', is_famous: true }, // 北京呼家楼
  { name: '广发证券股份有限公司北京樱花园证券营业部', type: 'famous_yz', is_famous: true }, // 北京樱花园
  { name: '中国中投证券有限责任公司深圳深南大道证券营业部', type: 'famous_yz', is_famous: true }, // 深南大道
  { name: '光大证券股份有限公司宁波解放南路证券营业部', type: 'famous_yz', is_famous: true }, // 光大宁波
  { name: '中信证券股份有限公司宁波和济街证券营业部', type: 'famous_yz', is_famous: true }, // 中信宁波和济街
  { name: '国海证券股份有限公司深圳红荔路证券营业部', type: 'famous_yz', is_famous: true }, // 国海红荔
  { name: '华泰证券股份有限公司厦门厦禾路证券营业部', type: 'famous_yz', is_famous: true }, // 厦禾路
  { name: '华泰证券股份有限公司总部', type: 'famous_yz', is_famous: true }, // 华泰总部炒股大队
  { name: '中泰证券股份有限公司上海香港路证券营业部', type: 'famous_yz', is_famous: true }, // 中泰香港路
  { name: '招商证券股份有限公司深圳蛇口工业六路证券营业部', type: 'famous_yz', is_famous: true }, // 蛇口工业六路
  { name: '国泰君安证券股份有限公司深圳益田路证券营业部', type: 'famous_yz', is_famous: true }, // 益田路系
  { name: '华林证券股份有限公司北京建国门外大街证券营业部', type: 'famous_yz', is_famous: true }, // 建国门外
  { name: '兴业证券股份有限公司上海北京东路证券营业部', type: 'famous_yz', is_famous: true }, // 兴业北京东路
  { name: '海通证券股份有限公司温岭中华路证券营业部', type: 'famous_yz', is_famous: true }, // 温岭帮
  { name: '中泰证券股份有限公司温岭万昌中路证券营业部', type: 'famous_yz', is_famous: true }, // 温岭帮
  { name: '中国国际金融股份有限公司上海分公司', type: 'famous_yz', is_famous: true }, // 中金上海
  { name: '方正证券股份有限公司杭州延安路证券营业部', type: 'famous_yz', is_famous: true }, // 方正杭州
  { name: '中信证券股份有限公司上海陆家嘴环路证券营业部', type: 'famous_yz', is_famous: true }, // 陆家嘴
  { name: '财通证券股份有限公司温州划龙桥路证券营业部', type: 'famous_yz', is_famous: true }, // 温州帮
  { name: '光大证券股份有限公司佛山绿景路证券营业部', type: 'famous_yz', is_famous: true }, // 佛山绿景路
  { name: '中信建投证券股份有限公司上海浦东南路证券营业部', type: 'famous_yz', is_famous: true }, // 中信建投浦东
  { name: '广发证券股份有限公司深圳金田路证券营业部', type: 'famous_yz', is_famous: true }, // 广发金田路
  { name: '华泰证券股份有限公司上海武定路证券营业部', type: 'famous_yz', is_famous: true }, // 华泰武定路
  { name: '中信证券股份有限公司广州天河北路证券营业部', type: 'famous_yz', is_famous: true }, // 天河北路
  { name: '招商证券股份有限公司北京中关村大街证券营业部', type: 'famous_yz', is_famous: true }, // 中关村
  { name: '招商证券股份有限公司广州环市东路证券营业部', type: 'famous_yz', is_famous: true }, // 环市东路
  { name: '光大证券股份有限公司北京西单北大街证券营业部', type: 'famous_yz', is_famous: true }, // 西单
  { name: '国泰君安证券股份有限公司广州天河北路证券营业部', type: 'famous_yz', is_famous: true }, // 国君天河北路
  { name: '海通证券股份有限公司大连金马路证券营业部', type: 'famous_yz', is_famous: true }, // 大连金马路
  { name: '兴业证券股份有限公司福州湖东路证券营业部', type: 'famous_yz', is_famous: true }, // 兴业福州
  { name: '长江证券股份有限公司武汉江汉路证券营业部', type: 'famous_yz', is_famous: true }, // 武汉江汉路
  { name: '广发证券股份有限公司成都人民南路第三段证券营业部', type: 'famous_yz', is_famous: true }, // 成都人南
  { name: '银河证券股份有限公司北京阜外大街证券营业部', type: 'famous_yz', is_famous: true }, // 银河阜外
  { name: '华西证券股份有限公司成都长发街证券营业部', type: 'famous_yz', is_famous: true }, // 华西长发街

  // ===== 机构专用席位 (public_fund / 机构席位 — 公募 / 险资 / 自营) =====
  // 东财机构席位通常显示为 "机构专用"；下列为常见机构系营业部
  { name: '机构专用', type: 'public_fund', is_famous: true },
  {
    name: '中国国际金融股份有限公司北京建国门外大街证券营业部',
    type: 'public_fund',
    is_famous: true,
  },
  {
    name: '中国国际金融股份有限公司北京建国门外大街28号证券营业部',
    type: 'public_fund',
    is_famous: true,
  },
  { name: '中信证券股份有限公司北京金融大街证券营业部', type: 'public_fund', is_famous: true },
  { name: '中信证券股份有限公司总部（非营业场所）', type: 'public_fund', is_famous: true },
  { name: '中信建投证券股份有限公司总部（非营业场所）', type: 'public_fund', is_famous: true },
  { name: '海通证券股份有限公司总部', type: 'public_fund', is_famous: true },
  { name: '国泰君安证券股份有限公司总部', type: 'public_fund', is_famous: true },
  { name: '招商证券股份有限公司总部', type: 'public_fund', is_famous: true },
  { name: '中信证券（山东）有限责任公司青岛分公司', type: 'public_fund', is_famous: true },
  { name: '申万宏源证券有限公司北京西二环中路营业部', type: 'public_fund', is_famous: true },
  { name: '银河证券股份有限公司北京阜成门外大街证券营业部', type: 'public_fund', is_famous: true },
  { name: '广发证券股份有限公司北京安立路证券营业部', type: 'public_fund', is_famous: true },
  { name: '光大证券股份有限公司上海世纪大道证券营业部', type: 'public_fund', is_famous: true },
  {
    name: '中信建投证券股份有限公司北京东直门南大街证券营业部',
    type: 'public_fund',
    is_famous: true,
  },
  { name: '平安证券股份有限公司深圳深南大道证券营业部', type: 'public_fund', is_famous: true },
  { name: '安信证券股份有限公司深圳红荔西路证券营业部', type: 'public_fund', is_famous: true },

  // ===== 外资席位 (foreign — QFII / 沪深港通 / 外资投行) =====
  { name: '中信里昂证券有限公司', type: 'foreign', is_famous: true },
  { name: '摩根士丹利亚洲有限公司', type: 'foreign', is_famous: true },
  { name: '高盛(亚洲)证券有限公司', type: 'foreign', is_famous: true },
  { name: '高盛高华证券有限责任公司北京金融大街证券营业部', type: 'foreign', is_famous: true },
  { name: '瑞银证券有限责任公司上海花园石桥路证券营业部', type: 'foreign', is_famous: true },
  { name: '瑞银证券有限责任公司北京金融大街证券营业部', type: 'foreign', is_famous: true },
  { name: '摩根大通证券（中国）有限公司', type: 'foreign', is_famous: true },
  { name: '野村东方国际证券有限公司上海分公司', type: 'foreign', is_famous: true },
  { name: '法国巴黎证券（亚洲）有限公司', type: 'foreign', is_famous: true },
  { name: '汇丰前海证券有限责任公司', type: 'foreign', is_famous: true },
  { name: '德意志银行股份有限公司北京分行', type: 'foreign', is_famous: true },
  { name: '香港上海汇丰银行有限公司', type: 'foreign', is_famous: true },
  // 沪深港通席位（北向）— 真实显示为 "沪股通专用" / "深股通专用"
  { name: '沪股通专用', type: 'foreign', is_famous: true },
  { name: '深股通专用', type: 'foreign', is_famous: true },
  { name: '香港中央结算有限公司', type: 'foreign', is_famous: true },

  // ===== 私募专用席位 (private_fund) =====
  // 已知大型私募部分有专属席位（命名 + 业内常识）
  { name: '中信证券股份有限公司深圳总部证券营业部', type: 'private_fund', is_famous: true }, // 私募大本营
  { name: '海通证券股份有限公司上海建国西路证券营业部', type: 'private_fund', is_famous: true }, // 上海私募走
  { name: '海通证券股份有限公司上海北京东路证券营业部', type: 'private_fund', is_famous: true }, // 北京东路私募
  { name: '招商证券股份有限公司上海陆家嘴东路证券营业部', type: 'private_fund', is_famous: true }, // 招商陆家嘴
  {
    name: '华泰证券股份有限公司上海武定路证券营业部（私募专户）',
    type: 'private_fund',
    is_famous: true,
  },
  { name: '中信证券股份有限公司上海淮海中路证券营业部', type: 'private_fund', is_famous: true }, // 淮海中路私募
  { name: '财通证券股份有限公司上海杨高南路证券营业部', type: 'private_fund', is_famous: true }, // 杨高南路
  { name: '兴业证券股份有限公司上海曹杨路证券营业部', type: 'private_fund', is_famous: true }, // 兴业曹杨路
  { name: '国泰君安证券股份有限公司上海福山路证券营业部', type: 'private_fund', is_famous: true }, // 国君福山路
  { name: '海通证券股份有限公司上海四川北路证券营业部', type: 'private_fund', is_famous: true }, // 海通四川北路
  {
    name: '中国国际金融股份有限公司上海黄浦区湖滨路证券营业部',
    type: 'private_fund',
    is_famous: true,
  }, // 中金湖滨路
  { name: '广发证券股份有限公司广州黄埔大道中证券营业部', type: 'private_fund', is_famous: true }, // 广发黄埔大道
  { name: '招商证券股份有限公司深圳南山区科技园证券营业部', type: 'private_fund', is_famous: true }, // 招商深圳南山
];

/**
 * 兼容旧 API：仅返回名称数组（用于 Set / includes 类查询）。
 * 新代码应优先使用 SEAT_PROFILES。
 */
export const FAMOUS_YOUZI_SEATS: ReadonlyArray<string> = SEAT_PROFILES.filter(
  p => p.type === 'famous_yz'
).map(p => p.name);

/**
 * 别名映射：AKShare 个别版本会返回简化或缩写名（例如缺少"股份有限公司"），
 * 入库时先按别名归一到主白名单的标准名。
 *
 * key = 可能出现的简写；value = 标准全称。
 */
export const FAMOUS_SEAT_ALIASES: Readonly<Record<string, string>> = {
  // 缺"股份有限公司"的简写
  东方财富证券拉萨团结路第二营业部: '东方财富证券股份有限公司拉萨团结路第二营业部',
  东方财富证券拉萨东环路第一营业部: '东方财富证券股份有限公司拉萨东环路第一证券营业部',
  东方财富证券拉萨东环路第二营业部: '东方财富证券股份有限公司拉萨东环路第二证券营业部',
  东方财富证券拉萨北京中路营业部: '东方财富证券股份有限公司拉萨北京中路证券营业部',
  中国银河证券绍兴营业部: '中国银河证券股份有限公司绍兴营业部',
  国泰君安证券上海江苏路营业部: '国泰君安证券股份有限公司上海江苏路证券营业部',
  国泰君安证券顺德大良营业部: '国泰君安证券股份有限公司顺德大良证券营业部',
  华泰证券深圳益田路荣超商务中心营业部: '华泰证券股份有限公司深圳益田路荣超商务中心证券营业部',
  中信证券上海溧阳路营业部: '中信证券股份有限公司上海溧阳路证券营业部',
  华鑫证券上海分公司: '华鑫证券有限责任公司上海分公司',
  // US-088 新增：常见外资 / 机构席位的简写
  机构专用席位: '机构专用',
  中信里昂证券: '中信里昂证券有限公司',
  摩根士丹利: '摩根士丹利亚洲有限公司',
  '高盛(亚洲)': '高盛(亚洲)证券有限公司',
  瑞银证券: '瑞银证券有限责任公司上海花园石桥路证券营业部',
};

const FAMOUS_SET = new Set<string>(FAMOUS_YOUZI_SEATS);

/**
 * US-088: 名称 → SeatProfile 的快速索引（按标准全称查）。
 */
const SEAT_PROFILE_INDEX = new Map<string, SeatProfile>(SEAT_PROFILES.map(p => [p.name, p]));

/**
 * 判断营业部名称是否为知名游资。
 *
 * 1. 直接命中主白名单 → true
 * 2. 命中别名映射 → 解析为标准名后再查白名单
 * 3. 包含"东方财富证券" + "拉萨" → 视为拉萨系自然人席位（兜底）
 *
 * 兜底规则避免遗漏新增的拉萨系营业部（东财在拉萨开设营业部速度较快）。
 *
 * @param rawSeat AKShare 返回的原始营业部名称
 */
export function isFamousYouzi(rawSeat: string | null | undefined): boolean {
  if (!rawSeat) return false;
  const seat = rawSeat.trim();
  if (!seat) return false;

  if (FAMOUS_SET.has(seat)) return true;

  const canonical = FAMOUS_SEAT_ALIASES[seat];
  if (canonical && FAMOUS_SET.has(canonical)) return true;

  // 拉萨系兜底：东方财富证券 + 拉萨 几乎总是自然人游资席位
  if (seat.includes('东方财富证券') && seat.includes('拉萨')) return true;

  return false;
}

/**
 * 把营业部名称归一到标准名（如果命中别名）。
 * 入库时建议先归一再写库，便于按标准名做 group-by 统计。
 */
export function canonicalSeatName(rawSeat: string): string {
  const seat = rawSeat.trim();
  return FAMOUS_SEAT_ALIASES[seat] ?? seat;
}

/**
 * US-088: 给定营业部名称，返回其归属机构类型。
 *
 * 判定顺序：
 *  1. 命中 SEAT_PROFILE_INDEX 标准名 → 该 profile.type
 *  2. 命中别名映射 → 归一后再查 SEAT_PROFILE_INDEX
 *  3. 拉萨系兜底（东方财富 + 拉萨）→ `famous_yz`
 *  4. 名称包含"沪股通" / "深股通" / "QFII"等关键词 → `foreign`
 *  5. 名称包含"机构专用" → `public_fund`
 *  6. 否则 → `unknown`
 *
 * 兜底规则避免遗漏白名单中尚未收录的拉萨系 / 北向 / 机构席位。
 *
 * @param rawSeat AKShare 返回的原始营业部名称
 */
export function getSeatType(rawSeat: string | null | undefined): SeatType {
  if (!rawSeat) return 'unknown';
  const seat = rawSeat.trim();
  if (!seat) return 'unknown';

  // 1. 直接命中标准名
  const direct = SEAT_PROFILE_INDEX.get(seat);
  if (direct) return direct.type;

  // 2. 别名归一后命中
  const canonical = FAMOUS_SEAT_ALIASES[seat];
  if (canonical) {
    const profile = SEAT_PROFILE_INDEX.get(canonical);
    if (profile) return profile.type;
  }

  // 3. 拉萨系兜底（东财 + 拉萨）
  if (seat.includes('东方财富证券') && seat.includes('拉萨')) return 'famous_yz';

  // 4. 沪深港通 / QFII 兜底
  if (
    seat.includes('沪股通') ||
    seat.includes('深股通') ||
    seat.includes('港股通') ||
    seat.includes('QFII') ||
    seat.includes('香港中央结算')
  ) {
    return 'foreign';
  }

  // 5. 机构专用兜底
  if (seat.includes('机构专用')) return 'public_fund';

  return 'unknown';
}

/**
 * US-088: 检查归属机构类型枚举的合法性，主要供 controller 校验 query param 用。
 *
 * 接受 `'public_fund' | 'foreign' | 'private_fund' | 'famous_yz' | 'unknown'`，
 * 其他值返回 false（让 controller 决定 400 vs fallback）。
 */
export function isValidSeatType(value: unknown): value is SeatType {
  return (
    value === 'public_fund' ||
    value === 'foreign' ||
    value === 'private_fund' ||
    value === 'famous_yz' ||
    value === 'unknown'
  );
}
