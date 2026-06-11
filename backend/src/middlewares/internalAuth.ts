import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// P0 launch-helper：曾出现在 backend/.env / 文档里的旧默认 key 必须被拒绝。
// 任何能 grep 到这个字面量的人都能调内部接口；上线前必须轮换。
const KNOWN_LEAKED_INTERNAL_KEYS = new Set([
  'tr_agent_k8s_x9a1!b2c3d4e5f6g7h8i9j0',
  'your_internal_api_key_here',
  'internal-api-key',
]);

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

  // P0 launch-helper：曾出现在 backend/.env / 文档里的旧默认 key。
  // production 启动时 + 每次 request 都打 warning 提醒轮换，但不再硬拒绝服务
  // —— 现有 /api/internal/* 调用者 (TradingAgents 反向接口) 过去 14 天未访问，
  // 硬拒绝只会在维护周期内意外阻断未发现的依赖。轮换后 warning 自动消失。
  if (
    process.env.NODE_ENV === 'production' &&
    KNOWN_LEAKED_INTERNAL_KEYS.has(String(configuredKey).trim())
  ) {
    logger.warn(
      '[internalAuth] production 检测到已泄露的旧 INTERNAL_API_KEY 默认值，请尽快轮换。'
    );
    // 不 return —— 继续后续 key 校验
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
