import { Request, Response, NextFunction } from 'express';
import { User } from '../../models/User';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';

export interface JwtPayload {
  userId: number;
  username: string;
  role: string;
}

export class AuthController {
  private readonly jwtSecret: string;
  private readonly refreshTokenSecret: string;
  private readonly accessTokenExpiry = '15m';
  private readonly refreshTokenExpiry = '7d';

  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    this.refreshTokenSecret =
      process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production';

    // 绑定方法以确保正确的this上下文
    this.register = this.register.bind(this);
    this.login = this.login.bind(this);
    this.refreshToken = this.refreshToken.bind(this);
    this.logout = this.logout.bind(this);
    this.getProfile = this.getProfile.bind(this);
    this.updateProfile = this.updateProfile.bind(this);
    this.uploadAvatar = this.uploadAvatar.bind(this);

    // 初始化默认用户
    this.initDefaultUsers();
  }

  private async initDefaultUsers() {
    try {
      const defaultUsers = [
        { username: 'xz', passwordHash: '666', email: 'xz@example.com' },
        { username: 'lym', passwordHash: '666', email: 'lym@example.com' },
      ];

      for (const u of defaultUsers) {
        const existingUser = await User.findOne({ where: { username: u.username } });
        if (!existingUser) {
          await User.create({
            username: u.username,
            email: u.email,
            passwordHash: u.passwordHash,
            role: 'admin',
            isActive: true,
          });
          logger.info(`Default user ${u.username} created.`);
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
        passwordHash: password, // 将在beforeCreate钩子中哈希
        role: 'user',
        isActive: true,
      });

      // 生成访问令牌和刷新令牌
      console.log('User object:', user);
      console.log('User id:', user?.id);
      const accessToken = this.generateAccessToken(user);
      const refreshToken = this.generateRefreshToken(user);

      res.status(201).json({
        success: true,
        message: '用户注册成功',
        data: {
          user: user.toJSON(),
          tokens: {
            accessToken,
            refreshToken,
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
        where: { username, isActive: true },
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

      res.json({
        success: true,
        message: '登录成功',
        data: {
          user: user.toJSON(),
          tokens: {
            accessToken,
            refreshToken,
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
      const { refreshToken } = req.body;

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
      const user = await User.findByPk(payload.userId);
      if (!user || !user.isActive) {
        return res.status(401).json({
          success: false,
          message: '用户不存在或已被禁用',
        });
      }

      // 生成新的访问令牌
      const newAccessToken = this.generateAccessToken(user);

      res.json({
        success: true,
        message: '令牌刷新成功',
        data: {
          accessToken: newAccessToken,
          refreshToken, // 返回相同的刷新令牌（可考虑刷新刷新令牌）
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
      // 在实际应用中，可以将令牌加入黑名单
      // 这里只是简单返回成功
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
      const { nickname, phone, avatarUrl } = req.body;

      if (nickname !== undefined) user.nickname = nickname;
      if (phone !== undefined) user.phone = phone;
      if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

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
      const avatarUrl = `/uploads/avatars/${file.filename}`;
      user.avatarUrl = avatarUrl;
      await user.save();

      res.json({
        success: true,
        message: '头像上传成功',
        data: {
          avatarUrl,
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
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          success: false,
          message: '未提供访问令牌',
        });
      }

      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).json({
          success: false,
          message: '无效的令牌格式',
        });
      }

      // 验证令牌
      const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;

      // 查找用户
      const user = await User.findByPk(payload.userId);
      if (!user || !user.isActive) {
        return res.status(401).json({
          success: false,
          message: '用户不存在或已被禁用',
        });
      }

      // 将用户信息附加到请求对象
      (req as any).user = user;
      next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({
          success: false,
          message: '无效的令牌',
        });
      }
      logger.error('认证失败:', error);
      next(error);
    }
  };

  /**
   * 生成访问令牌
   */
  private generateAccessToken = (user: User): string => {
    const payload: JwtPayload = {
      userId: user.id,
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
      userId: user.id,
      username: user.username,
      role: user.role,
    };
    return jwt.sign(payload, this.refreshTokenSecret, {
      expiresIn: this.refreshTokenExpiry,
    });
  };
}
