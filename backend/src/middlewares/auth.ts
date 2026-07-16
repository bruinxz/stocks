import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload as StandardJwtPayload } from 'jsonwebtoken';
import { User } from '../models/User';

export const AUTH_JWT_ISSUER = 'stocks-backend';
export const AUTH_ACCESS_TOKEN_AUDIENCE = 'stocks-api';
export const AUTH_REFRESH_TOKEN_AUDIENCE = 'stocks-refresh';

export interface AuthJwtPayload extends StandardJwtPayload {
  user_id: number;
  username: string;
  role: string;
  type: 'access' | 'refresh';
  family_id?: string;
}

export function resolveRefreshTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JWT_REFRESH_SECRET) return env.JWT_REFRESH_SECRET;
  if (env.NODE_ENV === 'production') return '';
  return env.LIVE_DEV_JWT_REFRESH_SECRET || 'dev-only-refresh-secret';
}

export function authJwtSecretsAreUsable(accessSecret: string, refreshSecret: string): boolean {
  return Boolean(accessSecret.trim() && refreshSecret.trim() && accessSecret !== refreshSecret);
}

export function verifyAccessToken(token: string, secret: string): AuthJwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: AUTH_JWT_ISSUER,
      audience: AUTH_ACCESS_TOKEN_AUDIENCE,
    });
    if (
      typeof decoded === 'string' ||
      decoded.type !== 'access' ||
      decoded.iss !== AUTH_JWT_ISSUER ||
      decoded.aud !== AUTH_ACCESS_TOKEN_AUDIENCE ||
      !Number.isSafeInteger(decoded.user_id) ||
      decoded.user_id <= 0 ||
      typeof decoded.username !== 'string' ||
      decoded.username.length === 0 ||
      typeof decoded.role !== 'string' ||
      decoded.role.length === 0 ||
      typeof decoded.iat !== 'number' ||
      !Number.isSafeInteger(decoded.iat) ||
      typeof decoded.exp !== 'number' ||
      !Number.isSafeInteger(decoded.exp) ||
      decoded.exp <= decoded.iat
    ) {
      return null;
    }
    return decoded as AuthJwtPayload;
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    username: string;
    email?: string;
    role: string;
  };
}

/**
 * Authenticate an access token and resolve its current database identity.
 * Credential failures are unauthorized; configuration/database failures are
 * unavailable. Neither class of failure is allowed to reach protected code.
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const unavailable = () =>
    res.status(503).json({
      success: false,
      error: '认证服务暂不可用',
    });
  const unauthorized = () =>
    res.status(401).json({
      success: false,
      error: '未认证',
    });

  const authHeader = req.headers.authorization;
  const bearerMatch = typeof authHeader === 'string' ? /^Bearer ([^\s]+)$/i.exec(authHeader) : null;
  if (!bearerMatch) {
    return unauthorized();
  }

  const secret = process.env.JWT_SECRET;
  const refreshSecret = resolveRefreshTokenSecret();
  if (!secret || !authJwtSecretsAreUsable(secret, refreshSecret)) {
    return unavailable();
  }

  const decoded = verifyAccessToken(bearerMatch[1], secret);
  if (!decoded) return unauthorized();

  let user: User | null;
  try {
    user = await User.findByPk(decoded.user_id);
  } catch {
    return unavailable();
  }

  if (!user || !user.is_active) {
    return unauthorized();
  }

  req.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  };
  return next();
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
