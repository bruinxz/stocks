/**
 * 股票代码格式转换工具类
 * 处理不同数据源和数据库之间的股票代码格式兼容性
 *
 * 格式说明：
 * 1. 数据库标准格式：带点的完整代码，如 'sh.600000', 'sz.000001', 'bj.830799'
 * 2. AKShare数据源格式：
 *    - stock_zh_a_hist: 纯代码，如 '000001'
 *    - stock_zh_a_daily: 带前缀不带点，如 'sh000001'
 *    - stock_individual_info_em: 纯代码，如 '000001'
 * 3. Tushare数据源格式：带点的完整代码，如 '000001.SZ', '600000.SH'
 * 4. 东方财富数据源格式：待确认
 */

/**
 * 统一股票代码格式（转换为数据库标准格式）
 * @param symbol 任意格式的股票代码
 * @returns 标准格式股票代码
 */
export function normalizeSymbol(symbol: string): string {
  if (!symbol || symbol.trim() === '') {
    return '';
  }

  const trimmed = symbol.trim();

  // 处理 Tushare 格式（000001.SZ, 600000.SH, 830799.BJ），大小写均兼容
  if (/\.(SH|SZ|BJ)$/i.test(trimmed)) {
    const parts = trimmed.split('.');
    if (parts.length === 2) {
      const code = parts[0];
      const suffix = parts[1].toUpperCase();

      if (suffix === 'SH') {
        return `sh.${code}`;
      } else if (suffix === 'SZ') {
        return `sz.${code}`;
      } else if (suffix === 'BJ') {
        return `bj.${code}`;
      }
    }
  }

  // 如果已经是标准格式（sh.600000, sz.000001, bj.830799），统一小写市场前缀后返回
  if (/^(sh|sz|bj)\.\d{6}$/i.test(trimmed)) {
    const [market, code] = trimmed.split('.');
    return `${market.toLowerCase()}.${code}`;
  }

  // 处理AKShare带前缀不带点格式（sh000001, sz000001）
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('sh') && trimmed.length > 2 && !lower.startsWith('sh.')) {
    const code = trimmed.substring(2);
    return `sh.${code}`;
  }

  if (lower.startsWith('sz') && trimmed.length > 2 && !lower.startsWith('sz.')) {
    const code = trimmed.substring(2);
    return `sz.${code}`;
  }

  if (lower.startsWith('bj') && trimmed.length > 2 && !lower.startsWith('bj.')) {
    const code = trimmed.substring(2);
    return `bj.${code}`;
  }

  // 纯数字代码，根据开头判断市场
  if (/^\d+$/.test(trimmed)) {
    const firstChar = trimmed.charAt(0);

    if (firstChar === '6') {
      return `sh.${trimmed}`;
    } else if (firstChar === '0' || firstChar === '3') {
      return `sz.${trimmed}`;
    } else if (firstChar === '8' || firstChar === '4' || firstChar === '9') {
      return `bj.${trimmed}`;
    } else {
      return `sh.${trimmed}`; // 兜底给 sh，防止产生无前缀的孤儿数据
    }
  }

  // 无法识别的格式，返回原值
  return trimmed;
}

/**
 * 转换为AKShare stock_zh_a_hist所需的格式（纯代码）
 * @param symbol 标准格式股票代码
 * @returns 纯代码格式
 */
export function toAKSharePureCode(symbol: string): string {
  const normalized = normalizeSymbol(symbol);

  if (normalized.includes('.')) {
    return normalized.split('.')[1];
  }

  // 如果已经是不带点的格式，直接返回
  return normalized;
}

/**
 * 转换为AKShare stock_zh_a_daily所需的格式（带前缀不带点）
 * @param symbol 标准格式股票代码
 * @returns AKShare daily格式
 */
export function toAKShareDailyCode(symbol: string): string {
  const normalized = normalizeSymbol(symbol);

  if (normalized.includes('.')) {
    return normalized.replace('.', '');
  }

  // 如果已经是不带点的格式，尝试添加前缀
  if (normalized.startsWith('6')) {
    return `sh${normalized}`;
  } else if (normalized.startsWith('0') || normalized.startsWith('3')) {
    return `sz${normalized}`;
  } else if (normalized.startsWith('8') || normalized.startsWith('4') || normalized.startsWith('9')) {
    return `bj${normalized}`;
  }

  return normalized;
}

/**
 * 转换为Tushare格式（代码.市场）
 * @param symbol 标准格式股票代码
 * @returns Tushare格式
 */
export function toTushareFormat(symbol: string): string {
  const normalized = normalizeSymbol(symbol);

  if (normalized.includes('.')) {
    const parts = normalized.split('.');
    const code = parts[1];
    const market = parts[0].toUpperCase();

    if (market === 'SH') {
      return `${code}.SH`;
    } else if (market === 'SZ') {
      return `${code}.SZ`;
    } else if (market === 'BJ') {
      return `${code}.BJ`;
    }
  }

  // 如果不是标准格式，尝试转换
  if (normalized.startsWith('6')) {
    return `${normalized}.SH`;
  } else if (normalized.startsWith('0') || normalized.startsWith('3')) {
    return `${normalized}.SZ`;
  } else if (normalized.startsWith('8') || normalized.startsWith('4') || normalized.startsWith('9')) {
    return `${normalized}.BJ`;
  } else {
    return `${normalized}.SH`;
  }
}

/**
 * 转换为东方财富格式（待确认，目前假设与AKShare stock_individual_info_em相同，使用纯代码）
 * @param symbol 标准格式股票代码
 * @returns 东方财富格式
 */
export function toEastMoneyFormat(symbol: string): string {
  // 东方财富的stock_individual_info_em需要纯代码
  return toAKSharePureCode(symbol);
}

/**
 * 从股票代码提取市场代码
 * @param symbol 股票代码
 * @returns 市场代码：'SH', 'SZ', 'BJ', 'UNKNOWN'
 */
export function extractMarket(symbol: string): string {
  const normalized = normalizeSymbol(symbol);

  if (normalized.includes('.')) {
    const market = normalized.split('.')[0].toUpperCase();
    if (market === 'SH' || market === 'SZ' || market === 'BJ') {
      return market;
    }
  }

  // 根据纯数字代码判断
  if (/^\d+$/.test(normalized)) {
    const firstChar = normalized.charAt(0);

    if (firstChar === '6') {
      return 'SH';
    } else if (firstChar === '0' || firstChar === '3') {
      return 'SZ';
    } else if (firstChar === '8' || firstChar === '4') {
      return 'BJ';
    }
  }

  return 'UNKNOWN';
}

/**
 * 验证股票代码格式是否有效
 * @param symbol 股票代码
 * @returns 是否有效
 */
export function isValidSymbol(symbol: string): boolean {
  if (!symbol || symbol.trim() === '') {
    return false;
  }

  const trimmed = symbol.trim();

  // 检查常见的无效值
  if (
    trimmed.toLowerCase() === 'undefined' ||
    trimmed.toLowerCase() === 'null' ||
    trimmed.includes('undefined') ||
    trimmed.includes('null')
  ) {
    return false;
  }

  // 尝试标准化，如果标准化后为空或与原始值差异过大，可能无效
  const normalized = normalizeSymbol(trimmed);
  if (!normalized || normalized === '') {
    return false;
  }

  // 检查标准化后的格式
  if (normalized.includes('.')) {
    const parts = normalized.split('.');
    if (parts.length !== 2) {
      return false;
    }

    const market = parts[0];
    const code = parts[1];

    // 检查市场前缀
    if (!['sh', 'sz', 'bj'].includes(market.toLowerCase())) {
      return false;
    }

    // 检查代码是否为数字
    if (!/^\d+$/.test(code)) {
      return false;
    }

    // 检查代码长度（一般为6位）
    if (code.length < 5 || code.length > 7) {
      return false;
    }
  }

  return true;
}

/**
 * 批量标准化股票代码数组
 * @param symbols 股票代码数组
 * @returns 标准化后的股票代码数组
 */
export function normalizeSymbols(symbols: string[]): string[] {
  return symbols.map(symbol => normalizeSymbol(symbol)).filter(symbol => isValidSymbol(symbol));
}
