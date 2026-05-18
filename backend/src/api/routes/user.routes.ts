import { Router } from 'express';
import { body } from 'express-validator';
import { UserController } from '../controllers/UserController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const userController = new UserController();
const authController = new AuthController();

// 所有用户管理接口都需要认证
router.use(authController.authenticate);

/**
 * @route GET /api/users
 * @desc 获取所有用户列表 (管理员)
 */
router.get('/', userController.getUsers);

/**
 * @route POST /api/users
 * @desc 创建新用户 (管理员)
 */
router.post(
  '/',
  [
    body('username').isString().isLength({ min: 3, max: 50 }),
    body('email').isEmail(),
    body('password').isString().isLength({ min: 6 }),
    body('role').optional().isIn(['admin', 'user']),
    body('is_active').optional().isBoolean(),
  ],
  validateRequest,
  userController.createUser
);

/**
 * @route PUT /api/users/:id
 * @desc 更新用户信息 (管理员)
 */
router.put(
  '/:id',
  [
    body('email').optional().isEmail(),
    body('role').optional().isIn(['admin', 'user']),
    body('is_active').optional().isBoolean(),
  ],
  validateRequest,
  userController.updateUser
);

/**
 * @route PUT /api/users/:id/password
 * @desc 修改用户密码 (管理员)
 */
router.put(
  '/:id/password',
  [body('newPassword').isString().isLength({ min: 6 })],
  validateRequest,
  userController.changePassword
);

/**
 * @route DELETE /api/users/:id
 * @desc 删除用户 (管理员)
 */
router.delete('/:id', userController.deleteUser);

export default router;
