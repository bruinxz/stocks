import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    username: string;
    email: string;
    role: string;
  };
}

/**
 * 简单的JWT认证中间件
 * 在开发环境中，如果未提供token，会创建一个模拟用户
 */
export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  // 开发环境：如果没有token，使用模拟用户
  if (process.env.NODE_ENV === 'development' && !authHeader) {
    req.user = {
      id: 1,
      username: 'demo',
      email: 'demo@example.com',
      role: 'user',
    };
    logger.debug('Using demo user in development mode');
    return next();
  }

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: '未提供认证令牌',
    });
  }

  const token = authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({
      success: false,
      error: '认证令牌格式错误',
    });
  }

  try {
    // P0 review：JWT_SECRET 必须在环境变量里显式配置；
    // 不再回退到硬编码字符串 —— 否则任何人都能用 'your-secret-key-change-in-production' 自签 admin token。
    // 仅 NODE_ENV !== production 时为了兼容本地脚本，允许显式使用 LIVE_DEV_JWT_SECRET（仍要求非空）。
    const secret =
      process.env.JWT_SECRET ||
      (process.env.NODE_ENV !== 'production' ? process.env.LIVE_DEV_JWT_SECRET : '');
    if (!secret) {
      logger.error('JWT_SECRET 未配置，拒绝校验 token');
      return res.status(500).json({
        success: false,
        error: '服务端未配置 JWT_SECRET，拒绝验证 token',
      });
    }
    const decoded = jwt.verify(token, secret) as any;
    // decoded 可能是 { user_id: 1, username: 'xz', role: 'admin', iat: ..., exp: ... } 或者嵌套在 user 中
    req.user = decoded.user || {
      id: decoded.user_id,
      username: decoded.username,
      email: decoded.email || '',
      role: decoded.role,
    };
    next();
  } catch (error) {
    logger.error('JWT验证失败:', error);
    return res.status(401).json({
      success: false,
      error: '认证令牌无效或已过期',
    });
  }
};

/**
 * 角色检查中间件
 */
export const requireRole = (role: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: '未认证',
      });
    }

    if (req.user.role !== role && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: '权限不足',
      });
    }

    next();
  };
};
