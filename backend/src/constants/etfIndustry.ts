/**
 * 行业 ETF 白名单 + 跟踪行业分类（US-092 引入；PR-F 2026-06-29 扩展到 70+ 只）
 *
 * 用途：
 *   ETFFlow (US-092) 同步服务只收录本白名单内的主流行业 ETF, 把每只 ETF
 *   对应到一个 underlying_industry 标签 (e.g. "半导体" / "医药" / "新能源车").
 *   不在白名单的 ETF (货币 / 债券 / 黄金 / 不主流) 跳过, 避免噪音.
 *
 * 维护规则：
 * - etf_code: 6 位数字 (无 sh/sz 前缀), 与 AKShare fund_etf_*_em 返回的 "基金代码"
 *   严格匹配 (5 位不补零, 6 位原样).
 * - 同一行业可有多只 ETF (e.g. 通信 ETF 有华夏 515050 / 国泰 515880 / 银华 159994
 *   / 嘉实 159695 / 南方 159511 / 富国 159583 / 广发 159507 等), 全部收录, sync
 *   服务层按 (trade_date, etf_code) PK 入库分别保留.
 * - underlying_industry: 业务侧聚合用 (前端按行业筛选 / 跨 ETF 累计净流入),
 *   保持稳定字符串 (不引入大小写漂移); 与 IndustryFlow.industry_name 完全独立
 *   (后者是中信一级行业分类, 这里是 ETF 标签).
 * - **绝不允许同 code 重复行** — 单元测试 enforce 唯一性 (US-092 原 33 行白名单
 *   有 `159928` / `515170` 两组重复, PR-F 清理).
 *
 * 数据源参考：
 *   - 东方财富网 ETF 中心 (https://quote.eastmoney.com/center/gridlist.html#fund_etf)
 *   - AKShare `fund_etf_fund_daily_em()` 全市场 ETF 主数据 (基金代码 + 简称)
 *   - 各基金公司官网 ETF 产品列表
 *
 * 后续若发现 AKShare 返回的代码漂移 (e.g. 港股 ETF 多了一位), 扩展前必须先校验
 * AKShare 实际返回值.
 *
 * PR-F (2026-06-29) 扩展说明：
 *   原 33 只 → 70+ 只, 重点新增:
 *     - 通信 7 只 (回应用户 "通信 ETF 买哪个" 诉求): 嘉实 / 南方 / 富国 / 广发 +
 *       原华夏 / 国泰 / 银华
 *     - 人工智能 / 算力 / 半导体设备 等 AI 主线
 *     - 卫星互联网 (智能驾驶 / 商业航天 关联)
 *     - 港股科技 / 中概互联 / 红利 / 黄金 等防御
 *     - 光伏 / 电池 / 新能源汽车 / 化工 等绿能扩展
 *   全部 code 已经 prod 实测 fund_etf_fund_daily_em + fund_etf_hist_em 双源返回
 *   2026-06-26 数据.
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
 * 主流行业 ETF 白名单 (PR-F 扩展到 70+ 只).
 *
 * 按主题分组维护方便人工增减; sync 服务把整 array flatten 后用 code → profile 索引.
 *
 * **唯一性约束**: 同 code 出现多次 → tests/constants/etf-industry.test.ts 立刻挂.
 */
export const ETF_PROFILES: ReadonlyArray<ETFProfile> = [
  // ===== 通信 / 5G / 卫星互联网 (用户关注主线, PR-F 重点扩展) =====
  { code: '515050', name: '通信ETF华夏', industry: '通信' },
  { code: '515880', name: '通信ETF国泰', industry: '通信' },
  { code: '159994', name: '通信ETF银华', industry: '通信' },
  { code: '159695', name: '通信ETF嘉实', industry: '通信' },
  { code: '159511', name: '通信ETF南方', industry: '通信' },
  { code: '159583', name: '通信ETF富国', industry: '通信' },
  { code: '159507', name: '通信ETF广发', industry: '通信' },
  { code: '159811', name: '5GETF博时', industry: '5G' },
  { code: '159206', name: '卫星ETF永赢', industry: '卫星互联网' },
  { code: '159218', name: '卫星ETF招商', industry: '卫星互联网' },
  { code: '563530', name: '卫星ETF易方达', industry: '卫星互联网' },

  // ===== 半导体 / 芯片 / 半导体设备 =====
  { code: '159995', name: '芯片ETF华夏', industry: '半导体' },
  { code: '512760', name: '芯片ETF国泰', industry: '半导体' },
  { code: '159801', name: '芯片ETF广发', industry: '半导体' },
  { code: '512480', name: '半导体ETF国联安', industry: '半导体' },
  { code: '159325', name: '半导体ETF南方', industry: '半导体' },
  { code: '159582', name: '半导体ETF博时', industry: '半导体' },
  { code: '159813', name: '半导体ETF鹏华', industry: '半导体' },
  { code: '159665', name: '半导体龙头ETF工银', industry: '半导体' },
  { code: '588170', name: '科创半导体ETF华夏', industry: '半导体' },
  { code: '588710', name: '科创半导体设备ETF', industry: '半导体设备' },
  { code: '159327', name: '半导体设备ETF万家', industry: '半导体设备' },

  // ===== 人工智能 / AI / 算力 / 云计算 / 软件 =====
  { code: '515070', name: '人工智能ETF华夏', industry: '人工智能' },
  { code: '159819', name: '人工智能ETF易方达', industry: '人工智能' },
  { code: '159248', name: '人工智能ETF万家', industry: '人工智能' },
  { code: '515980', name: '人工智能ETF华富', industry: '人工智能' },
  { code: '588730', name: '科创人工智能ETF易方达', industry: '人工智能' },
  { code: '560660', name: '云计算50ETF新华', industry: '云计算' },
  { code: '159739', name: '云计算ETF鹏华', industry: '云计算' },
  { code: '159852', name: '软件ETF嘉实', industry: '软件' },
  { code: '515000', name: '科技ETF华宝', industry: '科技综合' },
  { code: '515580', name: '科技100ETF华泰', industry: '科技综合' },
  { code: '159997', name: '电子ETF天弘', industry: '电子' },
  { code: '159998', name: '计算机ETF天弘', industry: '计算机' },
  { code: '512720', name: '计算机ETF国泰', industry: '计算机' },
  { code: '562500', name: '机器人ETF华夏', industry: '机器人' },
  { code: '159613', name: '信息安全ETF嘉实', industry: '信息安全' },

  // ===== 医药 / 创新药 / 医疗器械 =====
  { code: '512170', name: '医疗ETF华宝', industry: '医药' },
  { code: '512010', name: '医药ETF易方达', industry: '医药' },
  { code: '159992', name: '创新药ETF银华', industry: '医药' },
  { code: '159929', name: '医药ETF汇添富', industry: '医药' },
  { code: '512290', name: '生物医药ETF国泰', industry: '医药' },
  { code: '510660', name: '医药ETF华夏', industry: '医药' },
  { code: '159883', name: '医疗器械ETF永赢', industry: '医疗器械' },

  // ===== 消费 / 食品饮料 / 家电 / 农业 =====
  { code: '510150', name: '消费ETF', industry: '消费' },
  { code: '159928', name: '消费ETF汇添富', industry: '消费' },
  { code: '159996', name: '家电ETF国泰', industry: '家电' },
  { code: '512690', name: '酒ETF鹏华', industry: '食品饮料' },
  { code: '515170', name: '食品饮料ETF华夏', industry: '食品饮料' },
  { code: '159825', name: '农业ETF富国', industry: '农业' },
  { code: '159865', name: '养殖ETF国泰', industry: '养殖' },

  // ===== 新能源 / 电池 / 光伏 / 新能源车 =====
  { code: '515030', name: '新能源车ETF华夏', industry: '新能源车' },
  { code: '159806', name: '新能源车ETF国泰', industry: '新能源车' },
  { code: '516160', name: '新能源ETF南方', industry: '新能源' },
  { code: '159875', name: '新能源ETF嘉实', industry: '新能源' },
  { code: '515790', name: '光伏ETF华泰柏瑞', industry: '光伏' },
  { code: '562970', name: '光伏ETF易方达', industry: '光伏' },
  { code: '159755', name: '电池ETF广发', industry: '电池' },
  { code: '159611', name: '电力ETF广发', industry: '电力' },

  // ===== 金融 / 防御 / 红利 =====
  { code: '512800', name: '银行ETF华宝', industry: '银行' },
  { code: '515290', name: '银行ETF天弘', industry: '银行' },
  { code: '512880', name: '证券ETF国泰', industry: '券商' },
  { code: '512000', name: '券商ETF华宝', industry: '券商' },
  { code: '510880', name: '红利ETF华泰柏瑞', industry: '红利' },
  { code: '512890', name: '红利低波ETF华泰柏', industry: '红利' },

  // ===== 军工 / 高端制造 / 化工 / 新材料 =====
  { code: '512660', name: '军工ETF国泰', industry: '军工' },
  { code: '512560', name: '军工ETF易方达', industry: '军工' },
  { code: '512710', name: '军工龙头ETF富国', industry: '军工' },
  { code: '159870', name: '化工ETF鹏华', industry: '化工' },

  // ===== 周期 / 资源 =====
  { code: '515220', name: '煤炭ETF国泰', industry: '煤炭' },
  { code: '515210', name: '钢铁ETF国泰', industry: '钢铁' },
  { code: '512400', name: '有色金属ETF南方', industry: '有色金属' },

  // ===== 港股 / 海外 (科技 / 互联网) =====
  { code: '513050', name: '中概互联ETF易方达', industry: '中概互联' },
  { code: '513180', name: '恒生科技ETF华夏', industry: '恒生科技' },
  { code: '159740', name: '恒生科技ETF大成', industry: '恒生科技' },
  { code: '159792', name: '港股通互联网ETF富', industry: '港股互联网' },
  { code: '159570', name: '港股通创新药ETF汇', industry: '港股创新药' },
  { code: '159509', name: '纳指科技ETF景顺', industry: '纳指科技' },

  // ===== 商品 / 防御 =====
  { code: '518880', name: '黄金ETF华安', industry: '黄金' },

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
 *
 * 注意: 若 ETF_PROFILES 含重复 code, Map 构造会保留**后一行**, 前面那条静默丢失.
 * tests/constants/etf-industry.test.ts 显式校验唯一性以防漂移.
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
 *
 * 注意: 若 ETF_PROFILES 含重复 code, 这里返回的数组也会重复, 但 Sync 调用方
 * (ETFFlowSyncService.syncDate) 会经过 service-layer in-memory dedup (Map<key,row>)
 * 兜底, 不会重复入库; 仅 Python 端会多请求几次. tests/constants/etf-industry.test.ts
 * 显式校验唯一性以避免该退化.
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
