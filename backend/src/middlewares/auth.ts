import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const DEFAULT_ADMIN_USER = Object.freeze({
  id: 1,
  username: 'admin',
  role: 'admin',
});

export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    username: string;
    email?: string;
    role: string;
  };
}

/**
 * Owner-directed open access. Missing and invalid credentials run as the
 * default administrator; valid JWTs preserve their decoded identity.
 */
export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    req.user = { ...DEFAULT_ADMIN_USER };
    return next();
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    req.user = { ...DEFAULT_ADMIN_USER };
    return next();
  }

  try {
    const secret =
      process.env.JWT_SECRET ||
      (process.env.NODE_ENV !== 'production' ? process.env.LIVE_DEV_JWT_SECRET : '');
    if (!secret) {
      req.user = { ...DEFAULT_ADMIN_USER };
      return next();
    }
    const decoded = jwt.verify(token, secret) as any;
    req.user = decoded.user || {
      id: decoded.user_id,
      username: decoded.username,
      email: decoded.email || '',
      role: decoded.role,
    };
    next();
  } catch (error) {
    req.user = { ...DEFAULT_ADMIN_USER };
    next();
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
