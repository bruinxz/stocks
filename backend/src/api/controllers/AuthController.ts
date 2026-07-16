import { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { User } from '../../models/User';
import {
  AuthRefreshSession,
  AuthRefreshSessionRevocationReason,
} from '../../models/AuthRefreshSession';
import jwt from 'jsonwebtoken';
import { Op, Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';
import { alertsBroadcaster } from '../../realtime/alertsBroadcaster';
import {
  AUTH_ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ISSUER,
  AUTH_REFRESH_TOKEN_AUDIENCE,
  AuthJwtPayload,
  authJwtSecretsAreUsable,
  resolveRefreshTokenSecret,
  verifyAccessToken,
} from '../../middlewares/auth';

export interface JwtPayload extends AuthJwtPayload {
  family_id?: string;
}

interface PreparedRefreshToken {
  token: string;
  token_hash: string;
  jti: string;
  family_id: string;
  expires_at: Date;
}

type RefreshRotationOutcome =
  | { kind: 'rotated'; access_token: string; refresh_token: string }
  | { kind: 'invalid' }
  | { kind: 'reused'; user_id: number };

type VerifiedRefreshTokenPayload = JwtPayload & {
  type: 'refresh';
  family_id: string;
  jti: string;
  iat: number;
  exp: number;
};

export class AuthController {
  private static defaultUsersInitPromise: Promise<void> | null = null;
  private readonly jwtSecret: string;
  private readonly refreshTokenSecret: string;
  private readonly tokenConfigurationReady: boolean;
  private readonly cookieSecure: boolean;
  private readonly accessTokenExpiry = '1h';
  private readonly refreshTokenExpiry = '3d';
  private readonly refreshCookieMaxAgeMs = 3 * 24 * 60 * 60 * 1000;

  constructor() {
    const isProd = process.env.NODE_ENV === 'production';
    this.jwtSecret = process.env.JWT_SECRET || '';
    this.refreshTokenSecret = resolveRefreshTokenSecret();
    this.tokenConfigurationReady = authJwtSecretsAreUsable(this.jwtSecret, this.refreshTokenSecret);

    // Secure is a production invariant. Only non-production environments may
    // explicitly opt out for local HTTP development and route tests.
    this.cookieSecure = isProd || process.env.ENABLE_SECURE_COOKIE !== 'false';

    if (!this.jwtSecret) {
      logger.error('[AuthController] JWT_SECRET is not configured; access tokens are unavailable.');
    }
    if (!this.refreshTokenSecret) {
      logger.error(
        '[AuthController] JWT_REFRESH_SECRET is not configured; refresh tokens are unavailable.'
      );
    }
    if (this.jwtSecret && this.refreshTokenSecret && this.jwtSecret === this.refreshTokenSecret) {
      logger.error('[AuthController] access and refresh token secrets must be distinct.');
    }

    // 绑定方法以确保正确的this上下文
    this.register = this.register.bind(this);
    this.login = this.login.bind(this);
    this.defaultAdminLogin = this.defaultAdminLogin.bind(this);
    this.refreshToken = this.refreshToken.bind(this);
    this.logout = this.logout.bind(this);
    this.getProfile = this.getProfile.bind(this);
    this.updateProfile = this.updateProfile.bind(this);
    this.uploadAvatar = this.uploadAvatar.bind(this);
  }

  static ensureDefaultUsersInitialized(): Promise<void> {
    if (String(process.env.SKIP_DEFAULT_USER_INIT || '').toLowerCase() === 'true') {
      logger.info('[AuthController] default user initialization skipped by environment flag');
      return Promise.resolve();
    }

    if (!AuthController.defaultUsersInitPromise) {
      AuthController.defaultUsersInitPromise = AuthController.initDefaultUsers().catch(err => {
        AuthController.defaultUsersInitPromise = null;
        throw err;
      });
    }

    return AuthController.defaultUsersInitPromise;
  }

  private static async initDefaultUsers() {
    try {
      // P0 launch-helper：硬编码 '666' admin 密码是上线最大后门。
      // production 环境必须显式 LIVE_ADMIN_BOOTSTRAP_PASSWORD 才创建默认 admin；
      // dev 环境可继续用 '666' 方便联调，但所有走 NODE_ENV=production 的部署都会被拦下。
      const isProd = process.env.NODE_ENV === 'production';
      const bootstrapPassword = process.env.LIVE_ADMIN_BOOTSTRAP_PASSWORD || '';
      if (isProd && !bootstrapPassword) {
        logger.warn(
          '[AuthController] production 环境未设置 LIVE_ADMIN_BOOTSTRAP_PASSWORD，跳过默认 admin 创建。' +
            ' 如需 bootstrap 第一个 admin，请通过 SQL 直接 INSERT 一条 role=admin 用户并用 bcrypt 哈希密码。'
        );
        return;
      }
      const defaultUsers = isProd
        ? [
            // Sprint 37: prod bootstrap user 改为 'stock' (生产实际跑的 user, 见 /opt/stocks portfolio 24)
            { username: 'stock', password_hash: bootstrapPassword, email: 'stock@example.com' },
          ]
        : [
            // dev 环境保留 xz/lym 兼容历史本地数据
            { username: 'xz', password_hash: '666', email: 'xz@example.com' },
            { username: 'lym', password_hash: '666', email: 'lym@example.com' },
          ];

      for (const u of defaultUsers) {
        const existingUser = await User.findOne({ where: { username: u.username } });
        if (!existingUser) {
          await User.create({
            username: u.username,
            email: u.email,
            password_hash: u.password_hash,
            role: 'admin',
            is_active: true,
          });
          logger.info(
            `Default user ${u.username} created (env=${process.env.NODE_ENV || 'development'}).`
          );
        }
      }
    } catch (error) {
      AuthController.logInfrastructureFailure('default-user-init', error);
    }
  }

  /**
   * 用户注册
   */
  async register(req: Request, res: Response, _next: NextFunction) {
    if (!this.tokenConfigurationReady) return this.serviceUnavailable(res);

    try {
      const { username, email, password } = req.body;
      const result: {
        kind: 'exists' | 'created';
        user?: User;
        access_token?: string;
        refresh_token?: string;
      } = await sequelize.transaction(async transaction => {
        const existingUser = await User.findOne({
          where: {
            [Op.or]: [{ username }, { email }],
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });

        if (existingUser) return { kind: 'exists' };

        const user = await User.create(
          {
            username,
            email,
            password_hash: password,
            role: 'user',
            is_active: true,
          },
          { transaction }
        );
        const preparedRefreshToken = this.prepareRefreshToken(user, randomUUID());
        await this.persistRefreshSession(user, preparedRefreshToken, transaction);

        return {
          kind: 'created',
          user,
          access_token: this.generateAccessToken(user),
          refresh_token: preparedRefreshToken.token,
        };
      });

      if (result.kind === 'exists') {
        return res.status(400).json({
          success: false,
          message: '用户名或邮箱已存在',
        });
      }

      this.setRefreshCookie(res, result.refresh_token as string);

      res.status(201).json({
        success: true,
        message: '用户注册成功',
        data: {
          user: (result.user as User).toJSON(),
          tokens: {
            accessToken: result.access_token,
          },
        },
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('register', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * 用户登录
   */
  async login(req: Request, res: Response, _next: NextFunction) {
    if (!this.tokenConfigurationReady) return this.serviceUnavailable(res);

    try {
      const { username, password } = req.body;
      const user = await User.findOne({
        where: { username, is_active: true },
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: '用户名或密码错误',
        });
      }

      const isValidPassword = await user.validatePassword(password);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: '用户名或密码错误',
        });
      }

      const issued = await sequelize.transaction(async transaction => {
        const currentUser = await User.findByPk(user.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!currentUser || !currentUser.is_active) return null;
        if (!(await currentUser.validatePassword(password))) return null;

        const preparedRefreshToken = this.prepareRefreshToken(currentUser, randomUUID());
        await this.persistRefreshSession(currentUser, preparedRefreshToken, transaction);
        return {
          user: currentUser,
          access_token: this.generateAccessToken(currentUser),
          refresh_token: preparedRefreshToken.token,
        };
      });

      if (!issued) {
        return res.status(401).json({
          success: false,
          message: '用户名或密码错误',
        });
      }

      this.setRefreshCookie(res, issued.refresh_token);

      res.json({
        success: true,
        message: '登录成功',
        data: {
          user: issued.user.toJSON(),
          tokens: {
            accessToken: issued.access_token,
          },
        },
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('login', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * Owner-approved kiosk mode: issue the configured default administrator
   * session without sending its password to the browser bundle.
   *
   * The endpoint is fail-closed unless all three deployment-only variables
   * are present. Normal installations therefore keep the login page.
   */
  async defaultAdminLogin(req: Request, res: Response, next: NextFunction) {
    if (String(process.env.DEFAULT_ADMIN_AUTO_LOGIN || '').toLowerCase() !== 'true') {
      return res.status(404).json({ success: false, message: '默认管理员登录未启用' });
    }

    const username = String(process.env.DEFAULT_ADMIN_USERNAME || '').trim();
    const password = String(process.env.DEFAULT_ADMIN_PASSWORD || '');
    if (!username || !password) {
      return res.status(503).json({ success: false, message: '默认管理员登录配置不完整' });
    }

    try {
      const admin = await User.findOne({
        where: { username, role: 'admin', is_active: true },
        attributes: ['id'],
      });
      if (!admin) {
        return res.status(503).json({ success: false, message: '默认管理员账号不可用' });
      }
    } catch (error) {
      AuthController.logInfrastructureFailure('defaultAdminLogin', error);
      return this.serviceUnavailable(res);
    }

    req.body = { username, password };
    return this.login(req, res, next);
  }

  /**
   * 刷新访问令牌
   */
  async refreshToken(req: Request, res: Response, _next: NextFunction) {
    const refreshToken = req.cookies?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      return res.status(400).json({
        success: false,
        message: '刷新令牌不能为空',
      });
    }
    if (!this.tokenConfigurationReady) {
      return this.serviceUnavailable(res);
    }

    const payload = this.verifyRefreshToken(refreshToken);
    if (!payload) {
      this.clearRefreshCookie(res);
      return this.invalidRefreshToken(res);
    }

    try {
      const presentedHash = this.hashRefreshToken(refreshToken);
      const outcome = await sequelize.transaction<RefreshRotationOutcome>(
        { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
        async transaction => {
          const session = await AuthRefreshSession.findOne({
            where: { jti: payload.jti },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });

          if (!session) {
            await this.revokeFamily(payload.family_id, 'reuse_detected', transaction);
            return { kind: 'reused', user_id: payload.user_id };
          }

          if (
            session.user_id !== payload.user_id ||
            session.family_id !== payload.family_id ||
            !this.hashesMatch(session.token_hash, presentedHash) ||
            new Date(session.expires_at).getTime() !== payload.exp * 1000
          ) {
            await this.revokeFamily(session.family_id, 'reuse_detected', transaction);
            if (session.family_id !== payload.family_id) {
              await this.revokeFamily(payload.family_id, 'reuse_detected', transaction);
            }
            return { kind: 'reused', user_id: payload.user_id };
          }

          if (session.revoked_at) {
            await this.revokeFamily(session.family_id, 'reuse_detected', transaction);
            return { kind: 'reused', user_id: payload.user_id };
          }

          const now = new Date();
          if (new Date(session.expires_at).getTime() <= now.getTime()) {
            await session.update(
              { revoked_at: now, revocation_reason: 'expired' },
              { transaction }
            );
            return { kind: 'invalid' };
          }

          const user = await User.findByPk(payload.user_id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!user || !user.is_active) {
            await this.revokeFamily(session.family_id, 'user_inactive', transaction);
            return { kind: 'invalid' };
          }

          const preparedRefreshToken = this.prepareRefreshToken(
            user,
            session.family_id,
            payload.exp
          );
          await session.update(
            {
              revoked_at: now,
              replaced_by_jti: preparedRefreshToken.jti,
              revocation_reason: 'rotated',
            },
            { transaction }
          );
          await this.persistRefreshSession(user, preparedRefreshToken, transaction);

          return {
            kind: 'rotated',
            access_token: this.generateAccessToken(user),
            refresh_token: preparedRefreshToken.token,
          };
        }
      );

      if (outcome.kind !== 'rotated') {
        if (outcome.kind === 'reused') {
          alertsBroadcaster.disconnectUser(outcome.user_id, 'refresh token reuse detected');
        }
        this.clearRefreshCookie(res);
        return this.invalidRefreshToken(res);
      }

      this.setRefreshCookie(res, outcome.refresh_token);

      return res.json({
        success: true,
        message: '令牌刷新成功',
        data: {
          accessToken: outcome.access_token,
        },
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('refresh', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * 用户登出
   */
  async logout(req: Request, res: Response, _next: NextFunction) {
    const refreshToken = req.cookies?.refreshToken;

    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      this.clearRefreshCookie(res);
      return res.json({ success: true, message: '登出成功' });
    }
    if (!this.tokenConfigurationReady) return this.serviceUnavailable(res);

    const payload = this.verifyRefreshToken(refreshToken);
    if (!payload) {
      this.clearRefreshCookie(res);
      return res.json({ success: true, message: '登出成功' });
    }

    try {
      const presentedHash = this.hashRefreshToken(refreshToken);
      await sequelize.transaction(async transaction => {
        const session = await AuthRefreshSession.findOne({
          where: { jti: payload.jti },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          session &&
          session.user_id === payload.user_id &&
          session.family_id === payload.family_id &&
          this.hashesMatch(session.token_hash, presentedHash)
        ) {
          await this.revokeFamily(session.family_id, 'logout', transaction);
          return;
        }

        // The JWT signature still authenticates the claimed family even when
        // its exact jti row was lost or corrupted. Preserve logout semantics
        // by revoking that family; if the colliding row names another family,
        // fail closed for both instead of silently leaving either one active.
        await this.revokeFamily(payload.family_id, 'logout', transaction);
        if (session && session.family_id !== payload.family_id) {
          await this.revokeFamily(session.family_id, 'logout', transaction);
        }
      });

      alertsBroadcaster.disconnectUser(payload.user_id, 'logged out');
      this.clearRefreshCookie(res);
      return res.json({
        success: true,
        message: '登出成功',
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('logout', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * 获取用户资料
   */
  async getProfile(req: Request, res: Response, _next: NextFunction) {
    try {
      const user = (req as any).user;
      res.json({
        success: true,
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('profile-read', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * 更新用户资料
   */
  async updateProfile(req: Request, res: Response, _next: NextFunction) {
    try {
      const user = (req as any).user as User;
      const { nickname, phone, avatar_url } = req.body;

      if (nickname !== undefined) user.nickname = nickname;
      if (phone !== undefined) user.phone = phone;
      if (avatar_url !== undefined) user.avatar_url = avatar_url;

      await user.save();

      res.json({
        success: true,
        message: '个人资料更新成功',
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('profile-update', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * 上传头像
   */
  async uploadAvatar(req: Request, res: Response, _next: NextFunction) {
    try {
      const user = (req as any).user as User;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({
          success: false,
          message: '未找到上传的文件',
        });
      }

      // 获取文件路径
      const avatar_url = `/uploads/avatars/${file.filename}`;
      user.avatar_url = avatar_url;
      await user.save();

      res.json({
        success: true,
        message: '头像上传成功',
        data: {
          avatar_url,
          user: user.toJSON(),
        },
      });
    } catch (error) {
      AuthController.logInfrastructureFailure('avatar-update', error);
      return this.serviceUnavailable(res);
    }
  }

  /**
   * 认证中间件
   */
  authenticate = async (req: Request, res: Response, next: NextFunction) => {
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
    const bearerMatch =
      typeof authHeader === 'string' ? /^Bearer ([^\s]+)$/i.exec(authHeader) : null;
    if (!bearerMatch) {
      return unauthorized();
    }

    if (!this.tokenConfigurationReady) {
      logger.error(
        '[AuthController] access-token authentication unavailable: invalid configuration'
      );
      return unavailable();
    }

    const payload = verifyAccessToken(bearerMatch[1], this.jwtSecret);
    if (!payload) return unauthorized();

    let user: User | null;
    try {
      user = await User.findByPk(payload.user_id);
    } catch (error) {
      AuthController.logInfrastructureFailure('access-user-lookup', error);
      return unavailable();
    }

    if (!user || !user.is_active) {
      return unauthorized();
    }

    // Downstream profile/update handlers require the Sequelize user instance.
    (req as any).user = user;
    return next();
  };

  /**
   * 生成访问令牌
   */
  private generateAccessToken = (user: User): string => {
    const payload: JwtPayload = {
      user_id: user.id,
      username: user.username,
      role: user.role,
      type: 'access',
    };
    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: this.accessTokenExpiry,
      issuer: AUTH_JWT_ISSUER,
      audience: AUTH_ACCESS_TOKEN_AUDIENCE,
    });
  };

  private prepareRefreshToken(
    user: User,
    family_id: string,
    family_expires_at_seconds?: number
  ): PreparedRefreshToken {
    const jti = randomUUID();
    const payload: JwtPayload = {
      user_id: user.id,
      username: user.username,
      role: user.role,
      type: 'refresh',
      family_id,
    };
    const token =
      family_expires_at_seconds === undefined
        ? jwt.sign(payload, this.refreshTokenSecret, {
            algorithm: 'HS256',
            expiresIn: this.refreshTokenExpiry,
            issuer: AUTH_JWT_ISSUER,
            audience: AUTH_REFRESH_TOKEN_AUDIENCE,
            jwtid: jti,
          })
        : jwt.sign({ ...payload, exp: family_expires_at_seconds }, this.refreshTokenSecret, {
            algorithm: 'HS256',
            issuer: AUTH_JWT_ISSUER,
            audience: AUTH_REFRESH_TOKEN_AUDIENCE,
            jwtid: jti,
          });
    const decoded = jwt.decode(token);
    if (
      typeof decoded === 'string' ||
      !decoded ||
      typeof decoded.exp !== 'number' ||
      !Number.isSafeInteger(decoded.exp)
    ) {
      throw new Error('AuthTokenSigningError');
    }

    return {
      token,
      token_hash: this.hashRefreshToken(token),
      jti,
      family_id,
      expires_at: new Date(decoded.exp * 1000),
    };
  }

  private verifyRefreshToken(token: string): VerifiedRefreshTokenPayload | null {
    try {
      const decoded = jwt.verify(token, this.refreshTokenSecret, {
        algorithms: ['HS256'],
        issuer: AUTH_JWT_ISSUER,
        audience: AUTH_REFRESH_TOKEN_AUDIENCE,
      });
      if (
        typeof decoded === 'string' ||
        decoded.type !== 'refresh' ||
        decoded.iss !== AUTH_JWT_ISSUER ||
        decoded.aud !== AUTH_REFRESH_TOKEN_AUDIENCE ||
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
        decoded.exp <= decoded.iat ||
        !this.isCanonicalUuidV4(decoded.jti) ||
        !this.isCanonicalUuidV4(decoded.family_id)
      ) {
        return null;
      }
      return decoded as VerifiedRefreshTokenPayload;
    } catch {
      return null;
    }
  }

  private async persistRefreshSession(
    user: User,
    prepared: PreparedRefreshToken,
    transaction: Transaction
  ): Promise<void> {
    await AuthRefreshSession.create(
      {
        session_id: randomUUID(),
        user_id: user.id,
        jti: prepared.jti,
        family_id: prepared.family_id,
        token_hash: prepared.token_hash,
        expires_at: prepared.expires_at,
        revoked_at: null,
        replaced_by_jti: null,
        revocation_reason: null,
      },
      { transaction }
    );
  }

  private async revokeFamily(
    family_id: string,
    reason: AuthRefreshSessionRevocationReason,
    transaction: Transaction
  ): Promise<void> {
    await AuthRefreshSession.update(
      {
        revoked_at: new Date(),
        revocation_reason: reason,
      },
      {
        where: { family_id, revoked_at: null },
        transaction,
      }
    );
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie('refreshToken', token, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: this.refreshCookieMaxAgeMs,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: '/',
    });
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private hashesMatch(storedHash: string, presentedHash: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(storedHash) || !/^[0-9a-f]{64}$/.test(presentedHash)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(presentedHash, 'hex'));
  }

  private isCanonicalUuidV4(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    );
  }

  private serviceUnavailable(res: Response) {
    return res.status(503).json({
      success: false,
      message: '认证服务暂不可用',
    });
  }

  private invalidRefreshToken(res: Response) {
    return res.status(401).json({
      success: false,
      message: '无效的刷新令牌',
    });
  }

  private static logInfrastructureFailure(operation: string, error: unknown): void {
    const rawName = error instanceof Error ? error.name : 'UnknownAuthError';
    const safeName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName) ? rawName : 'UnknownAuthError';
    logger.error(`[AuthController] ${operation} failed (${safeName})`);
  }
}
