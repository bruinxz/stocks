import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

export interface StrategyMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
  parameters: StrategyParameter[];
  defaultValues: Record<string, any>;
  requiredSymbols: number;
  supportsFrequency: string[];
}

export interface StrategyParameter {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'array';
  label: string;
  description: string;
  required: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: any; label: string }[];
  defaultValue?: any;
}

export class StrategyController {
  private strategies: StrategyMetadata[] = [
    {
      id: 'moving_average_crossover',
      name: '移动平均线交叉策略',
      description: '当短期移动平均线上穿长期移动平均线时买入，下穿时卖出',
      category: '趋势跟踪',
      parameters: [
        {
          name: 'shortPeriod',
          type: 'number',
          label: '短期均线周期',
          description: '短期移动平均线的计算周期',
          required: true,
          min: 5,
          max: 100,
          step: 1,
          defaultValue: 10,
        },
        {
          name: 'longPeriod',
          type: 'number',
          label: '长期均线周期',
          description: '长期移动平均线的计算周期',
          required: true,
          min: 10,
          max: 200,
          step: 1,
          defaultValue: 30,
        },
        {
          name: 'threshold',
          type: 'number',
          label: '交叉阈值',
          description: '均线交叉的阈值百分比，避免频繁交易',
          required: false,
          min: 0,
          max: 0.1,
          step: 0.001,
          defaultValue: 0,
        },
      ],
      defaultValues: {
        shortPeriod: 10,
        longPeriod: 30,
        threshold: 0,
      },
      requiredSymbols: 1,
      supportsFrequency: ['daily', 'weekly', 'monthly'],
    },
    // 可以添加更多策略
  ];

  /**
   * 获取所有可用策略
   */
  async getStrategies(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        success: true,
        data: {
          strategies: this.strategies,
        },
      });
    } catch (error) {
      logger.error('获取策略列表失败:', error);
      next(error);
    }
  }

  /**
   * 获取策略详情
   */
  async getStrategyDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { strategyId } = req.params;
      const strategy = this.strategies.find(s => s.id === strategyId);

      if (!strategy) {
        return res.status(404).json({
          success: false,
          message: '策略不存在',
        });
      }

      res.json({
        success: true,
        data: { strategy },
      });
    } catch (error) {
      logger.error('获取策略详情失败:', error);
      next(error);
    }
  }

  /**
   * 验证策略参数
   */
  async validateStrategyParams(req: Request, res: Response, next: NextFunction) {
    try {
      const { strategyId, params } = req.body;
      const strategy = this.strategies.find(s => s.id === strategyId);

      if (!strategy) {
        return res.status(404).json({
          success: false,
          message: '策略不存在',
        });
      }

      const errors: string[] = [];

      // 验证必填参数
      for (const paramDef of strategy.parameters) {
        if (paramDef.required && params[paramDef.name] === undefined) {
          errors.push(`缺少必填参数: ${paramDef.label} (${paramDef.name})`);
          continue;
        }

        const value = params[paramDef.name];
        if (value === undefined) {
          continue;
        }

        // 类型验证
        switch (paramDef.type) {
          case 'number':
            if (typeof value !== 'number' || isNaN(value)) {
              errors.push(`参数 ${paramDef.label} 必须是数字`);
            } else if (paramDef.min !== undefined && value < paramDef.min) {
              errors.push(`参数 ${paramDef.label} 不能小于 ${paramDef.min}`);
            } else if (paramDef.max !== undefined && value > paramDef.max) {
              errors.push(`参数 ${paramDef.label} 不能大于 ${paramDef.max}`);
            }
            break;
          case 'string':
            if (typeof value !== 'string') {
              errors.push(`参数 ${paramDef.label} 必须是字符串`);
            }
            break;
          case 'boolean':
            if (typeof value !== 'boolean') {
              errors.push(`参数 ${paramDef.label} 必须是布尔值`);
            }
            break;
          case 'array':
            if (!Array.isArray(value)) {
              errors.push(`参数 ${paramDef.label} 必须是数组`);
            }
            break;
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({
          success: false,
          message: '参数验证失败',
          errors,
        });
      }

      res.json({
        success: true,
        message: '参数验证成功',
        data: { validatedParams: params },
      });
    } catch (error) {
      logger.error('验证策略参数失败:', error);
      next(error);
    }
  }

  /**
   * 获取策略性能统计
   */
  async getStrategyStats(req: Request, res: Response, next: NextFunction) {
    try {
      // 这里可以添加从数据库获取策略历史回测统计的逻辑
      // 暂时返回示例数据
      const stats = {
        totalBacktests: 0,
        avgReturn: 0,
        winRate: 0,
        bestReturn: 0,
        worstReturn: 0,
      };

      res.json({
        success: true,
        data: { stats },
      });
    } catch (error) {
      logger.error('获取策略统计失败:', error);
      next(error);
    }
  }
}
