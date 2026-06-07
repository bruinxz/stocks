/**
 * 因子库（library）入口 — US-010 已注册 8 个基础因子。
 *
 * 约定：每个因子文件（library/<NameFactor>.ts）通过 `factorRegistry.register(...)`
 * 在 import-time 完成自我登记，所以本文件**只需要把它们 import**，无需重复
 * register。CLI / Pipeline / Strategy 只要 import 'library' 一次，所有因子
 * 就到位（registry 的副作用模式）。
 *
 * 添加新因子时（US-029+）：
 *   1) 新建 library/<NameFactor>.ts，文件尾 `factorRegistry.register(...)`
 *   2) 在本文件按字母序追加 `import './<NameFactor>';`
 *   3) **不要 re-export** 个别因子 —— 调用方应该走 factorRegistry.get('name')，
 *      避免双重事实源；类型在 quant/factors/index.ts 已暴露。
 *
 * US-010 注册的 8 个基础因子 + US-029 流动性因子（顺序按文件名字母序，与 .listNames() 排序一致）：
 *   dragon_tiger / growth / liquidity / low_vol / momentum / money_flow / northbound / quality / value
 */

import './DragonTigerFactor';
import './GrowthFactor';
import './LiquidityFactor';
import './LowVolFactor';
import './MomentumFactor';
import './MoneyFlowFactor';
import './NorthboundFactor';
import './QualityFactor';
import './ValueFactor';

export {}; // 保留 ESM 模块标记
