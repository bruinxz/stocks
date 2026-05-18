import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * 简单的 API Key 认证中间件，专门用于内部系统之间的数据同步（如 TradingAgents）
 */
export const authenticateInternalApi = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const configuredKey = process.env.INTERNAL_API_KEY;

  if (!configuredKey) {
    logger.warn('INTERNAL_API_KEY is not configured in .env file!');
    res.status(500).json({
      success: false,
      message: 'Server configuration error',
    });
    return;
  }

  if (!apiKey || apiKey !== configuredKey) {
    logger.warn(`Unauthorized internal API access attempt from IP: ${req.ip}`);
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid or missing API Key',
    });
    return;
  }

  next();
};
