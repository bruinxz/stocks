import { Request, Response, NextFunction } from 'express';
import { User } from '../../models/User';
import { AuthRefreshSession } from '../../models/AuthRefreshSession';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';
import { alertsBroadcaster } from '../../realtime/alertsBroadcaster';

export class UserController {
  /**
   * 获取所有用户列表 (仅限管理员)
   */
  async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-expect-error -- req.user augmented by auth middleware, see issues with @types/express
      const currentUserRole = req.user?.role;
      if (currentUserRole !== 'admin') {
        return res.status(403).json({ success: false, message: '权限不足，需要管理员权限' });
      }

      const users = await User.findAll({
        order: [['created_at', 'DESC']],
      });

      // 手动构造返回数据，添加一个脱敏的假密码字段供前端展示
      const usersWithMaskedPassword = users.map(u => {
        const json = u.toJSON() as any;
        json.password = '******'; // 脱敏展示
        return json;
      });

      res.json({
        success: true,
        data: usersWithMaskedPassword,
      });
    } catch (error) {
      logger.error('获取用户列表失败:', error);
      next(error);
    }
  }

  /**
   * 创建新用户 (仅限管理员)
   */
  async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-expect-error -- req.user augmented by auth middleware, see issues with @types/express
      const currentUserRole = req.user?.role;
      if (currentUserRole !== 'admin') {
        return res.status(403).json({ success: false, message: '权限不足，需要管理员权限' });
      }

      const { username, email, password, role, is_active } = req.body;

      const existingUser = await User.findOne({ where: { username } });
      if (existingUser) {
        return res.status(400).json({ success: false, message: '用户名已存在' });
      }

      const existingEmail = await User.findOne({ where: { email } });
      if (existingEmail) {
        return res.status(400).json({ success: false, message: '邮箱已被注册' });
      }

      const newUser = await User.create({
        username,
        email,
        password_hash: password, // 将被 @BeforeCreate 钩子自动加密
        role: role || 'user',
        is_active: is_active !== undefined ? is_active : true,
      });

      const json = newUser.toJSON() as any;
      json.password = '******';

      res.status(201).json({
        success: true,
        message: '用户创建成功',
        data: json,
      });
    } catch (error) {
      logger.error('创建用户失败:', error);
      next(error);
    }
  }

  /**
   * 更新用户信息 (仅限管理员)
   */
  async updateUser(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-expect-error -- req.user augmented by auth middleware, see issues with @types/express
      const currentUserRole = req.user?.role;
      if (currentUserRole !== 'admin') {
        return res.status(403).json({ success: false, message: '权限不足，需要管理员权限' });
      }

      const { id } = req.params;
      const { email, role, is_active } = req.body;

      const result = await sequelize.transaction(async transaction => {
        const user = await User.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) return { kind: 'missing' as const };

        if (email && email !== user.email) {
          const existingEmail = await User.findOne({ where: { email }, transaction });
          if (existingEmail) return { kind: 'email_conflict' as const };
          user.email = email;
        }

        if (role) user.role = role;
        if (is_active !== undefined) user.is_active = is_active;

        await user.save({ transaction });
        if (is_active === false) {
          await AuthRefreshSession.update(
            { revoked_at: new Date(), revocation_reason: 'user_inactive' },
            { where: { user_id: user.id, revoked_at: null }, transaction }
          );
        }
        return { kind: 'updated' as const, user };
      });

      if (result.kind === 'missing') {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }
      if (result.kind === 'email_conflict') {
        return res.status(400).json({ success: false, message: '该邮箱已被其他账号使用' });
      }
      if (is_active === false) {
        alertsBroadcaster.disconnectUser(result.user.id, 'account disabled');
      }

      const json = result.user.toJSON() as any;
      json.password = '******';

      res.json({
        success: true,
        message: '用户信息更新成功',
        data: json,
      });
    } catch (error) {
      logger.error('更新用户信息失败:', error);
      next(error);
    }
  }

  /**
   * 修改用户密码 (仅限管理员)
   */
  async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-expect-error -- req.user augmented by auth middleware, see issues with @types/express
      const currentUserRole = req.user?.role;
      if (currentUserRole !== 'admin') {
        return res.status(403).json({ success: false, message: '权限不足，需要管理员权限' });
      }

      const { id } = req.params;
      const { newPassword } = req.body;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新密码不能为空且至少6位' });
      }

      const result = await sequelize.transaction(async transaction => {
        const user = await User.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) return null;

        user.password_hash = newPassword;
        await user.save({ transaction });
        await AuthRefreshSession.update(
          { revoked_at: new Date(), revocation_reason: 'password_changed' },
          { where: { user_id: user.id, revoked_at: null }, transaction }
        );
        return user;
      });

      if (!result) {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }

      alertsBroadcaster.disconnectUser(result.id, 'password changed');

      res.json({
        success: true,
        message: '密码修改成功',
      });
    } catch (error) {
      logger.error('修改密码失败:', error);
      next(error);
    }
  }

  /**
   * 删除用户 (仅限管理员)
   */
  async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      // @ts-expect-error -- req.user augmented by auth middleware, see issues with @types/express
      const currentUserRole = req.user?.role;
      // @ts-expect-error -- req.user augmented by auth middleware, see issues with @types/express
      const currentUserId = req.user?.id;

      if (currentUserRole !== 'admin') {
        return res.status(403).json({ success: false, message: '权限不足，需要管理员权限' });
      }

      const { id } = req.params;

      // 不能删除自己
      if (Number(id) === currentUserId) {
        return res.status(400).json({ success: false, message: '不能删除当前登录的账号' });
      }

      const user = await User.findByPk(id);
      if (!user) {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }

      await user.destroy();

      res.json({
        success: true,
        message: '用户删除成功',
      });
    } catch (error) {
      logger.error('删除用户失败:', error);
      next(error);
    }
  }
}
