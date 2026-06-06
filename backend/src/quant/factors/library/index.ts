/**
 * 因子库（library）入口 — US-009 仅创建占位，US-010+ 会在此 re-export 各因子文件。
 *
 * 约定：每个因子文件（library/<NameFactor>.ts）通过 `factorRegistry.register(...)`
 * 在 import-time 完成自我登记，所以本文件**只需要把它们 import**，无需重复
 * register。CLI / Pipeline / Strategy 只要 import 'library' 一次，所有因子
 * 就到位（registry 的副作用模式）。
 *
 * 当 US-010 添加 ValueFactor / QualityFactor / … 8 个因子时，在这里追加
 * `import './ValueFactor';` 即可。不要从这里 re-export 个别因子——
 * 调用方应该走 factorRegistry.get('value')，避免双重事实源。
 */

export {}; // 暂时空，确保 TypeScript 把本文件当作模块
