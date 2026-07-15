import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import {
  KNOWN_LEAKED_SECRET_FINGERPRINTS,
  secretFingerprint,
} from '../security/leakedSecretFingerprints';

function authenticateInternalApiWithFingerprints(
  req: Request,
  res: Response,
  next: NextFunction,
  leakedFingerprints: ReadonlySet<string>
): void {
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

  if (
    process.env.NODE_ENV === 'production' &&
    leakedFingerprints.has(secretFingerprint(configuredKey.trim()))
  ) {
    logger.error('[internalAuth] production INTERNAL_API_KEY is blocked by the leak registry.');
    res.status(503).json({
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
}

/**
 * 简单的 API Key 认证中间件，专门用于内部系统之间的数据同步（如 TradingAgents）
 */
export const authenticateInternalApi = (req: Request, res: Response, next: NextFunction): void => {
  authenticateInternalApiWithFingerprints(
    req,
    res,
    next,
    KNOWN_LEAKED_SECRET_FINGERPRINTS
  );
};

export const __TESTING__ = {
  secretFingerprint,
  authenticateInternalApiWithFingerprints,
};
