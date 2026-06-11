/**
 * ST / *ST 股票名称识别 — A 股退市风险预警约定
 *
 * 历史背景：原本同一份 isSTName 实现在 9 处 (8 个组合级 strategy +
 * AShareConstraintEngine) 被复制粘贴。US-025 之前抽取到本文件统一导出，
 * 各处通过 re-export 保持向后兼容（旧的 `import { isSTName } from
 * './<StrategyName>'` 仍可用），不必修改已有测试的 import 路径。
 *
 * 判定规则（compact 后大写比较）：
 *   1) "ST..." 前缀                → true（普通退市风险预警）
 *   2) "*ST..." 前缀              → true（已被特别处理）
 *   3) "S...ST..." 早期 + ST 复合 → true（如 "S*ST..." / "SST..." / "S ST..."）
 *   4) "S<非英数>..." (旧 S 股)   → true（如 "S 石化"；避免误判 "SAMSUNG"）
 *   5) 其他                        → false
 *
 * 输入 null / undefined / 纯空白 → false。
 *
 * 调用方：MultiFactorAlphaStrategy / DragonHeadMomentumStrategy /
 *   EarningsSurpriseStrategy / NorthboundFollowStrategy /
 *   SectorRotationLeaderStrategy / HighDividendValueStrategy /
 *   BreakoutStrategy / GARPStrategy / GameTraderRelayStrategy /
 *   AShareConstraintEngine（共 9 个 strategy + 1 个 backtest 约束引擎）。
 *
 * 改判定逻辑时只改这里，调用方零修改。
 */
export function isSTName(name?: string | null): boolean {
  if (!name) return false;
  const compact = name.replace(/\s+/g, '');
  if (!compact) return false;
  const upper = compact.toUpperCase();
  // 直接前缀命中（最常见）
  if (upper.startsWith('ST')) return true;
  if (upper.startsWith('*ST')) return true;
  // "S*ST..." / "SST..." / "S ST..."（已 compact 掉空格）
  if (upper.startsWith('S') && upper.indexOf('ST') >= 0 && upper.indexOf('ST') <= 3) {
    return true;
  }
  // 旧 S 股（"S 石化"），紧跟非 ASCII 字母（避免误判 SAMSUNG）
  if (/^S[^A-Z0-9]/.test(upper)) return true;
  // 退市股 — "退市XX" / "XX退" 中文前后缀（A 股退市风险板）
  if (compact.startsWith('退市') || compact.endsWith('退')) return true;
  // PT 板（暂停上市）
  if (upper.startsWith('PT')) return true;
  return false;
}

/**
 * 兼容别名 — 是否为不可交易股票 (ST + 退市 + PT).
 */
export function isUntradableName(name?: string | null): boolean {
  return isSTName(name);
}
