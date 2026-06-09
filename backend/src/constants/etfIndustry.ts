/**
 * 行业 ETF 白名单 + 跟踪行业分类（US-092 引入）
 *
 * 用途：
 *   ETFFlow (US-092) 同步服务只收录本白名单内的 30+ 主流行业 ETF, 把每只 ETF
 *   对应到一个 underlying_industry 标签 (e.g. "半导体" / "医药" / "新能源车").
 *   不在白名单的 ETF (货币 / 债券 / 黄金 / 不主流) 跳过, 避免噪音.
 *
 * 维护规则：
 * - etf_code: 6 位数字 (无 sh/sz 前缀), 与 AKShare fund_etf_*_em 返回的 "基金代码"
 *   严格匹配 (5 位不补零, 6 位原样).
 * - 同一行业可有多只 ETF (e.g. 芯片 ETF 有华夏 159995 / 国联安 512290 / 易方达
 *   512760 等), 全部收录, sync 服务层按 (trade_date, etf_code) PK 入库分别保留.
 * - underlying_industry: 业务侧聚合用 (前端按行业筛选 / 跨 ETF 累计净流入),
 *   保持稳定字符串 (不引入大小写漂移); 与 IndustryFlow.industry_name 完全独立
 *   (后者是中信一级行业分类, 这里是 ETF 标签).
 *
 * 数据源参考：
 *   - 东方财富网 ETF 中心 (https://quote.eastmoney.com/center/gridlist.html#fund_etf)
 *   - 各基金公司官网 ETF 产品列表
 *   - 雪球 / 同花顺基金分类
 *
 * 后续若发现 AKShare 返回的代码漂移 (e.g. 港股 ETF 多了一位), 扩展前必须先校验
 * AKShare 实际返回值.
 *
 * 30+ 只代表性 ETF, 覆盖 A 股主流投资主题 (科技 / 医药 / 消费 / 周期 / 金融 / 防御).
 */

/**
 * 行业 ETF 档案
 */
export interface ETFProfile {
  /** 6 位 ETF 代码 (与 AKShare 基金代码列严格匹配) */
  code: string;
  /** ETF 简称 (debug 用; 实际入库的 etf_name 以 AKShare 返回为准, 这里只是文档) */
  name: string;
  /** 跟踪的底层行业 / 主题分类 */
  industry: string;
}

/**
 * 主流行业 ETF 白名单 (US-092 初始 30+ 只).
 *
 * 按主题分组维护方便人工增减; sync 服务把整 array flatten 后用 code → profile 索引.
 */
export const ETF_PROFILES: ReadonlyArray<ETFProfile> = [
  // ===== 科技 / TMT =====
  { code: '159995', name: '芯片ETF华夏', industry: '半导体' },
  { code: '512290', name: '生物医药ETF国联', industry: '医药' },
  { code: '512760', name: '芯片ETF国联安', industry: '半导体' },
  { code: '512480', name: '半导体ETF国联安', industry: '半导体' },
  { code: '515050', name: '5G ETF华夏', industry: '5G通信' },
  { code: '515000', name: '科技ETF华宝', industry: '科技综合' },
  { code: '159994', name: '通信ETF银华', industry: '5G通信' },
  { code: '159997', name: '电子ETF天弘', industry: '电子' },
  { code: '159998', name: '计算机ETF天弘', industry: '计算机' },
  { code: '512720', name: '计算机ETF国联安', industry: '计算机' },

  // ===== 医药 / 生物 =====
  { code: '512170', name: '医疗ETF华宝', industry: '医药' },
  { code: '512010', name: '医药ETF易方达', industry: '医药' },
  { code: '159992', name: '创新药ETF银华', industry: '医药' },
  { code: '159929', name: '医药ETF汇添富', industry: '医药' },

  // ===== 消费 =====
  { code: '510150', name: '消费ETF', industry: '消费' },
  { code: '159928', name: '消费ETF汇添富', industry: '消费' },
  { code: '159996', name: '家电ETF国泰', industry: '家电' },
  { code: '512690', name: '酒ETF鹏华', industry: '食品饮料' },
  { code: '515170', name: '食品ETF华夏', industry: '食品饮料' },

  // ===== 新能源 / 双碳 =====
  { code: '515030', name: '新能源车ETF华夏', industry: '新能源车' },
  { code: '516160', name: '新能源ETF南方', industry: '新能源' },
  { code: '159806', name: '新能源车ETF国泰', industry: '新能源车' },
  { code: '515790', name: '光伏ETF华泰柏瑞', industry: '光伏' },
  { code: '512400', name: '有色金属ETF南方', industry: '有色金属' },

  // ===== 金融 / 防御 =====
  { code: '512800', name: '银行ETF华宝', industry: '银行' },
  { code: '512880', name: '证券ETF国泰', industry: '券商' },
  { code: '512000', name: '券商ETF华宝', industry: '券商' },
  { code: '510660', name: '医药卫生ETF', industry: '医药' },

  // ===== 军工 / 高端制造 =====
  { code: '512660', name: '军工ETF国泰', industry: '军工' },
  { code: '512560', name: '军工龙头ETF富国', industry: '军工' },

  // ===== 周期 / 资源 =====
  { code: '515220', name: '煤炭ETF国泰', industry: '煤炭' },
  { code: '515210', name: '钢铁ETF国泰', industry: '钢铁' },
  { code: '515170', name: '食品ETF华夏', industry: '食品饮料' },

  // ===== 宽基 (允许收录以观察整体资金流向) =====
  { code: '510300', name: '沪深300ETF华泰柏瑞', industry: '宽基-沪深300' },
  { code: '510500', name: '中证500ETF南方', industry: '宽基-中证500' },
  { code: '510050', name: '上证50ETF华夏', industry: '宽基-上证50' },
  { code: '588000', name: '科创50ETF华夏', industry: '宽基-科创50' },
  { code: '159949', name: '创业板50ETF华安', industry: '宽基-创业板50' },
];

/**
 * code → profile 索引 (O(1) 查询).
 * Sync 服务用此 Map 判断 ETF 是否在白名单 + 取 industry 标签.
 */
const ETF_PROFILE_INDEX = new Map<string, ETFProfile>(
  ETF_PROFILES.map(profile => [profile.code, profile])
);

/**
 * 查询白名单 ETF 档案. 若 code 不在白名单则返回 undefined.
 */
export function getETFProfile(code: string): ETFProfile | undefined {
  if (!code) return undefined;
  return ETF_PROFILE_INDEX.get(String(code).trim());
}

/**
 * 判断 ETF 是否在白名单内. Sync 服务用此判断是否要入库该行.
 */
export function isWhitelistedETF(code: string): boolean {
  return getETFProfile(code) !== undefined;
}

/**
 * 返回所有白名单 ETF 代码 (供 Python helper 拉取时按代码批量调用).
 */
export function getAllWhitelistedETFCodes(): string[] {
  return ETF_PROFILES.map(p => p.code);
}

/**
 * 返回白名单内某行业下所有 ETF 代码 (供 GET /api/data/etf-flow?industry=半导体 用).
 *
 * industry 大小写敏感 (与 ETFProfile.industry 字符串严格匹配).
 */
export function getETFCodesByIndustry(industry: string): string[] {
  if (!industry) return [];
  return ETF_PROFILES.filter(p => p.industry === industry).map(p => p.code);
}

/**
 * 返回白名单中所有已知行业标签 (前端可用作下拉选项).
 */
export function getAllETFIndustries(): string[] {
  const set = new Set<string>();
  for (const p of ETF_PROFILES) set.add(p.industry);
  return Array.from(set).sort();
}
