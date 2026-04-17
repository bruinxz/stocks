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
    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const decoded = jwt.verify(token, secret) as any;
    // decoded 可能是 { userId: 1, username: 'xz', role: 'admin', iat: ..., exp: ... } 或者嵌套在 user 中
    req.user = decoded.user || {
      id: decoded.userId,
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
