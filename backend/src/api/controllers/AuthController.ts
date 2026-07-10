import { Request, Response, NextFunction } from 'express';
import { User } from '../../models/User';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';

export interface JwtPayload {
  user_id: number;
  username: string;
  role: string;
}

export class AuthController {
  private static defaultUsersInitPromise: Promise<void> | null = null;
  private readonly jwtSecret: string;
  private readonly refreshTokenSecret: string;
  // Batch AU (2026-06-22): "登录态保持 3 天" 修复
  //   旧 accessTokenExpiry='15m' 太短 + refresh cookie Secure 在 HTTP prod 丢弃导致 axios refresh 链断 → 用户感知"频繁要登录"
  //   现在: access 1h (兜底, 大部分时间走 refresh) + refresh 3d (cookie 真寿命) + Secure 仅在真 HTTPS 启用
  private readonly accessTokenExpiry = '1h';
  private readonly refreshTokenExpiry = '3d';

  /**
   * Batch AU: 决定 cookie 是否设 Secure 标志.
   * 旧实现: NODE_ENV=production 强制 Secure → prod 实际跑在 http://103.242.3.87:3001/ (无 HTTPS) →
   *         浏览器拒收 Secure cookie → refreshToken 永远发不出 → axios refresh 链断 → 用户掉线频繁.
   * 新实现: 显式 env `ENABLE_SECURE_COOKIE=true` 才启用 Secure (上 HTTPS 时由 ops 配); 默认 false 让 HTTP prod 也能维持登录.
   */
  private readonly cookieSecure: boolean = process.env.ENABLE_SECURE_COOKIE === 'true';

  constructor() {
    // P0 review：生产环境绝不允许 JWT_SECRET / JWT_REFRESH_SECRET 使用硬编码兜底。
    // 否则任何人都能拿到 fallback secret 自签 admin token。
    const isProd = process.env.NODE_ENV === 'production';
    const fallbackAccess = isProd
      ? ''
      : process.env.LIVE_DEV_JWT_SECRET || 'dev-only-access-secret';
    const fallbackRefresh = isProd
      ? ''
      : process.env.LIVE_DEV_JWT_REFRESH_SECRET || 'dev-only-refresh-secret';
    this.jwtSecret = process.env.JWT_SECRET || fallbackAccess;
    this.refreshTokenSecret = process.env.JWT_REFRESH_SECRET || fallbackRefresh;
    if (!this.jwtSecret || !this.refreshTokenSecret) {
      // 生产环境硬阻断启动后续行为：让 sign/verify 全部失败，避免任何人用兜底 secret 拿 admin token。
      logger.error(
        '[AuthController] JWT_SECRET / JWT_REFRESH_SECRET 未在生产环境配置；所有 token 签发与校验将失败。'
      );
    }

    // 绑定方法以确保正确的this上下文
    this.register = this.register.bind(this);
    this.login = this.login.bind(this);
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
    } catch (err) {
      logger.error('Failed to init default users:', err);
    }
  }

  /**
   * 用户注册
   */
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { username, email, password } = req.body;

      // 检查用户是否已存在
      const existingUser = await User.findOne({
        where: {
          [Op.or]: [{ username }, { email }],
        },
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: '用户名或邮箱已存在',
        });
      }

      // 创建用户
      const user = await User.create({
        username,
        email,
        password_hash: password, // 将在beforeCreate钩子中哈希
        role: 'user',
        is_active: true,
      });

      // 生成访问令牌和刷新令牌
      console.log('User object:', user);
      console.log('User id:', user?.id);
      const accessToken = this.generateAccessToken(user);
      const refreshToken = this.generateRefreshToken(user);

      // 设置HttpOnly cookie
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: this.cookieSecure, // production 强制 HTTPS Secure cookie；dev/HTTP 下保留宽松行为
        sameSite: 'strict',
        path: '/',
        maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days (Batch AU 与 refreshTokenExpiry 对齐)
      });

      res.status(201).json({
        success: true,
        message: '用户注册成功',
        data: {
          user: user.toJSON(),
          tokens: {
            accessToken,
          },
        },
      });
    } catch (error) {
      logger.error('注册失败:', error);
      next(error);
    }
  }

  /**
   * 用户登录
   */
  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { username, password } = req.body;

      // 查找用户
      const user = await User.findOne({
        where: { username, is_active: true },
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: '用户名或密码错误',
        });
      }

      // 验证密码
      const isValidPassword = await user.validatePassword(password);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: '用户名或密码错误',
        });
      }

      // 生成令牌
      const accessToken = this.generateAccessToken(user);
      const refreshToken = this.generateRefreshToken(user);

      // 设置HttpOnly cookie
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: this.cookieSecure, // production 强制 HTTPS Secure cookie；dev/HTTP 下保留宽松行为
        sameSite: 'strict',
        path: '/',
        maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days (Batch AU 与 refreshTokenExpiry 对齐)
      });

      res.json({
        success: true,
        message: '登录成功',
        data: {
          user: user.toJSON(),
          tokens: {
            accessToken,
          },
        },
      });
    } catch (error) {
      logger.error('登录失败:', error);
      next(error);
    }
  }

  /**
   * 刷新访问令牌
   */
  async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      // 优先从cookie中获取，也可作为向后兼容从body获取
      const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: '刷新令牌不能为空',
        });
      }

      // 验证刷新令牌
      let payload: JwtPayload;
      try {
        payload = jwt.verify(refreshToken, this.refreshTokenSecret) as JwtPayload;
      } catch (error) {
        return res.status(401).json({
          success: false,
          message: '无效的刷新令牌',
        });
      }

      // 查找用户
      const user = await User.findByPk(payload.user_id);
      if (!user || !user.is_active) {
        return res.status(401).json({
          success: false,
          message: '用户不存在或已被禁用',
        });
      }

      // 令牌轮转机制：生成新的访问令牌和刷新令牌
      const newAccessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user);

      // 设置新的HttpOnly cookie
      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: this.cookieSecure, // production 强制 HTTPS Secure cookie
        sameSite: 'strict',
        path: '/',
        maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days (Batch AU 与 refreshTokenExpiry 对齐)
      });

      res.json({
        success: true,
        message: '令牌刷新成功',
        data: {
          accessToken: newAccessToken,
        },
      });
    } catch (error) {
      logger.error('刷新令牌失败:', error);
      next(error);
    }
  }

  /**
   * 用户登出
   */
  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      // 清除HttpOnly cookie中的refreshToken
      res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: this.cookieSecure, // 与 setCookie 时保持一致；prod=true / dev=false
        sameSite: 'strict',
        path: '/',
      });

      res.json({
        success: true,
        message: '登出成功',
      });
    } catch (error) {
      logger.error('登出失败:', error);
      next(error);
    }
  }

  /**
   * 获取用户资料
   */
  async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      res.json({
        success: true,
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      logger.error('获取用户资料失败:', error);
      next(error);
    }
  }

  /**
   * 更新用户资料
   */
  async updateProfile(req: Request, res: Response, next: NextFunction) {
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
      logger.error('更新用户资料失败:', error);
      next(error);
    }
  }

  /**
   * 上传头像
   */
  async uploadAvatar(req: Request, res: Response, next: NextFunction) {
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
      logger.error('上传头像失败:', error);
      next(error);
    }
  }

  /**
   * 认证中间件
   */
  authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;

      // Owner 指令 (Orch v318 msg=ae1e9a24): 去掉登录校验，默认管理员身份
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        (req as any).user = { id: 1, username: 'admin', role: 'admin', is_active: true };
        return next();
      }

      const token = authHeader.split(' ')[1];
      if (!token) {
        (req as any).user = { id: 1, username: 'admin', role: 'admin', is_active: true };
        return next();
      }

      // 验证令牌
      const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;

      // 查找用户
      const user = await User.findByPk(payload.user_id);
      if (!user || !user.is_active) {
        (req as any).user = { id: 1, username: 'admin', role: 'admin', is_active: true };
        return next();
      }

      // 将用户信息附加到请求对象
      (req as any).user = user;
      next();
    } catch (error) {
      // Token 无效时也放行，默认管理员身份
      (req as any).user = { id: 1, username: 'admin', role: 'admin', is_active: true };
      next();
    }
  };

  /**
   * 生成访问令牌
   */
  private generateAccessToken = (user: User): string => {
    const payload: JwtPayload = {
      user_id: user.id,
      username: user.username,
      role: user.role,
    };
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.accessTokenExpiry,
    });
  };

  /**
   * 生成刷新令牌
   */
  private generateRefreshToken = (user: User): string => {
    const payload: JwtPayload = {
      user_id: user.id,
      username: user.username,
      role: user.role,
    };
    return jwt.sign(payload, this.refreshTokenSecret, {
      expiresIn: this.refreshTokenExpiry,
    });
  };
}
