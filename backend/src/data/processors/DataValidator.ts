import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { logger } from '../../utils/logger';

export interface ValidationRule {
  name: string;
  validate: (data: any) => boolean;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export class DataValidator {
  /**
   * 验证单条日线数据
   */
  validateDailyBar(bar: Partial<DailyBar>): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 基本字段验证
    if (!bar.time) {
      errors.push('时间字段缺失');
    }

    if (bar.open === undefined || bar.open === null) {
      errors.push('开盘价缺失');
    } else if (bar.open <= 0) {
      warnings.push('开盘价为非正数');
    }

    if (bar.high === undefined || bar.high === null) {
      errors.push('最高价缺失');
    } else if (bar.high <= 0) {
      warnings.push('最高价为非正数');
    }

    if (bar.low === undefined || bar.low === null) {
      errors.push('最低价缺失');
    } else if (bar.low <= 0) {
      warnings.push('最低价为非正数');
    }

    if (bar.close === undefined || bar.close === null) {
      errors.push('收盘价缺失');
    } else if (bar.close <= 0) {
      warnings.push('收盘价为非正数');
    }

    if (bar.volume === undefined || bar.volume === null) {
      errors.push('成交量缺失');
    } else if (bar.volume < 0) {
      warnings.push('成交量为负数');
    }

    // 价格逻辑验证
    if (bar.high !== undefined && bar.low !== undefined && bar.high < bar.low) {
      errors.push('最高价低于最低价');
    }

    if (bar.high !== undefined && bar.open !== undefined && bar.high < bar.open) {
      errors.push('最高价低于开盘价');
    }

    if (bar.low !== undefined && bar.open !== undefined && bar.low > bar.open) {
      errors.push('最低价高于开盘价');
    }

    if (bar.high !== undefined && bar.close !== undefined && bar.high < bar.close) {
      errors.push('最高价低于收盘价');
    }

    if (bar.low !== undefined && bar.close !== undefined && bar.low > bar.close) {
      errors.push('最低价高于收盘价');
    }

    // 涨跌幅验证（如果存在）
    if (bar.changePercent !== undefined) {
      if (Math.abs(bar.changePercent) > 50) {
        warnings.push(`涨跌幅异常: ${bar.changePercent}%`);
      }
    }

    // 换手率验证
    if (bar.turnoverRate !== undefined) {
      if (bar.turnoverRate < 0 || bar.turnoverRate > 100) {
        warnings.push(`换手率异常: ${bar.turnoverRate}%`);
      }
    }

    // PE/PB验证
    if (bar.pe !== undefined && (bar.pe < 0 || bar.pe > 1000)) {
      warnings.push(`市盈率异常: ${bar.pe}`);
    }

    if (bar.pb !== undefined && (bar.pb < 0 || bar.pb > 100)) {
      warnings.push(`市净率异常: ${bar.pb}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 验证股票基本信息
   */
  validateStock(stock: Partial<Stock>): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!stock.symbol) {
      errors.push('股票代码缺失');
    } else {
      // 验证股票代码格式
      const symbolRegex = /^[0-9]{6}\.(SH|SZ|BJ)$|^(sh|sz|bj)\.[0-9]{6}$/i;
      if (!symbolRegex.test(stock.symbol)) {
        warnings.push(`股票代码格式可能不正确: ${stock.symbol}`);
      }
    }

    if (!stock.name) {
      warnings.push('股票名称缺失');
    }

    if (stock.listingDate) {
      const listingDate = new Date(stock.listingDate);
      const today = new Date();
      if (listingDate > today) {
        warnings.push('上市日期在未来');
      }
    }

    if (stock.delistingDate && stock.listingDate) {
      const delistingDate = new Date(stock.delistingDate);
      const listingDate = new Date(stock.listingDate);
      if (delistingDate < listingDate) {
        errors.push('退市日期早于上市日期');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 批量验证日线数据
   */
  validateDailyBars(bars: Partial<DailyBar>[]): {
    valid: Partial<DailyBar>[];
    invalid: { bar: Partial<DailyBar>; errors: string[] }[];
    warnings: { bar: Partial<DailyBar>; warnings: string[] }[];
  } {
    const valid: Partial<DailyBar>[] = [];
    const invalid: { bar: Partial<DailyBar>; errors: string[] }[] = [];
    const warnings: { bar: Partial<DailyBar>; warnings: string[] }[] = [];

    for (const bar of bars) {
      const result = this.validateDailyBar(bar);
      if (result.isValid) {
        valid.push(bar);
        if (result.warnings.length > 0) {
          warnings.push({ bar, warnings: result.warnings });
        }
      } else {
        invalid.push({ bar, errors: result.errors });
      }
    }

    return { valid, invalid, warnings };
  }

  /**
   * 检测异常值（使用统计方法）
   */
  detectOutliers(bars: DailyBar[], field: keyof DailyBar): {
    outliers: DailyBar[];
    stats: {
      mean: number;
      median: number;
      std: number;
      min: number;
      max: number;
    };
  } {
    const values = bars
      .map(bar => bar[field] as number)
      .filter(value => value !== null && value !== undefined);

    if (values.length === 0) {
      return { outliers: [], stats: { mean: 0, median: 0, std: 0, min: 0, max: 0 } };
    }

    // 计算统计量
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);
    const min = Math.min(...values);
    const max = Math.max(...values);

    // 使用3σ原则检测异常值
    const outliers = bars.filter(bar => {
      const value = bar[field] as number;
      if (value === null || value === undefined) return false;
      return Math.abs(value - mean) > 3 * std;
    });

    return {
      outliers,
      stats: { mean, median, std, min, max },
    };
  }

  /**
   * 检查数据连续性
   */
  checkContinuity(bars: DailyBar[]): {
    gaps: { start: Date; end: Date; days: number }[];
    duplicates: Date[];
    missingDays: number;
  } {
    if (bars.length < 2) {
      return { gaps: [], duplicates: [], missingDays: 0 };
    }

    // 按时间排序
    const sortedBars = [...bars].sort((a, b) => a.time.getTime() - b.time.getTime());

    const gaps: { start: Date; end: Date; days: number }[] = [];
    const dateSet = new Set<string>();
    const duplicates: Date[] = [];

    let missingDays = 0;

    for (let i = 1; i < sortedBars.length; i++) {
      const prevDate = sortedBars[i - 1].time;
      const currDate = sortedBars[i].time;

      // 检查重复
      const dateStr = currDate.toISOString().split('T')[0];
      if (dateSet.has(dateStr)) {
        duplicates.push(currDate);
      } else {
        dateSet.add(dateStr);
      }

      // 计算日期差
      const diffTime = currDate.getTime() - prevDate.getTime();
      const diffDays = diffTime / (1000 * 60 * 60 * 24);

      // 如果差大于1天，则有间隔
      if (diffDays > 1) {
        const gapStart = new Date(prevDate);
        gapStart.setDate(gapStart.getDate() + 1);
        const gapEnd = new Date(currDate);
        gapEnd.setDate(gapEnd.getDate() - 1);

        gaps.push({
          start: gapStart,
          end: gapEnd,
          days: diffDays - 1,
        });

        missingDays += diffDays - 1;
      }
    }

    return { gaps, duplicates, missingDays };
  }

  /**
   * 生成数据质量报告
   */
  generateQualityReport(bars: DailyBar[], stock?: Stock): {
    summary: {
      totalBars: number;
      validBars: number;
      invalidBars: number;
      warningBars: number;
      missingDays: number;
      duplicateDays: number;
    };
    details: {
      validation: ReturnType<typeof this.validateDailyBars>;
      continuity: ReturnType<typeof this.checkContinuity>;
      outliers: {
        [field in keyof DailyBar]?: ReturnType<typeof this.detectOutliers>;
      };
    };
  } {
    const validationResult = this.validateDailyBars(bars);
    const continuityResult = this.checkContinuity(bars);

    // 检测关键字段的异常值
    const outlierFields: (keyof DailyBar)[] = ['close', 'volume', 'changePercent', 'turnoverRate'];
    const outliers: any = {};

    for (const field of outlierFields) {
      outliers[field] = this.detectOutliers(bars, field);
    }

    return {
      summary: {
        totalBars: bars.length,
        validBars: validationResult.valid.length,
        invalidBars: validationResult.invalid.length,
        warningBars: validationResult.warnings.length,
        missingDays: continuityResult.missingDays,
        duplicateDays: continuityResult.duplicates.length,
      },
      details: {
        validation: validationResult,
        continuity: continuityResult,
        outliers,
      },
    };
  }

  /**
   * 修复常见数据问题
   */
  fixCommonIssues(bar: DailyBar): Partial<DailyBar> {
    const fixed = { ...bar };

    // 确保最高价是最高值
    fixed.high = Math.max(fixed.open, fixed.high, fixed.close, fixed.low);

    // 确保最低价是最低值
    fixed.low = Math.min(fixed.open, fixed.high, fixed.close, fixed.low);

    // 如果涨跌幅缺失但前后价格存在，则计算
    if (fixed.changePercent === undefined && bar.open && bar.close) {
      fixed.changePercent = ((bar.close - bar.open) / bar.open) * 100;
    }

    // 如果换手率异常，设为null
    if (fixed.turnoverRate !== undefined && (fixed.turnoverRate < 0 || fixed.turnoverRate > 100)) {
      fixed.turnoverRate = null as any;
    }

    // 如果PE/PB异常，设为null
    if (fixed.pe !== undefined && (fixed.pe < 0 || fixed.pe > 1000)) {
      fixed.pe = null as any;
    }

    if (fixed.pb !== undefined && (fixed.pb < 0 || fixed.pb > 100)) {
      fixed.pb = null as any;
    }

    return fixed;
  }
}