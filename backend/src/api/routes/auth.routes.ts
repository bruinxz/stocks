import { Router } from 'express';
import { body } from 'express-validator';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const authController = new AuthController();

/**
 * @route POST /api/auth/register
 * @desc 用户注册
 * @access Public
 */
router.post(
  '/register',
  [
    body('username').isString().isLength({ min: 3, max: 50 }),
    body('email').isEmail(),
    body('password').isString().isLength({ min: 6 }),
  ],
  validateRequest,
  authController.register
);

/**
 * @route POST /api/auth/login
 * @desc 用户登录
 * @access Public
 */
router.post(
  '/login',
  [
    body('username').isString(),
    body('password').isString(),
  ],
  validateRequest,
  authController.login
);

/**
 * @route POST /api/auth/refresh
 * @desc 刷新访问令牌
 * @access Public
 */
router.post(
  '/refresh',
  [
    body('refreshToken').isString(),
  ],
  validateRequest,
  authController.refreshToken
);

/**
 * @route POST /api/auth/logout
 * @desc 用户登出
 * @access Private
 */
router.post(
  '/logout',
  authController.authenticate,
  authController.logout
);

/**
 * @route GET /api/auth/profile
 * @desc 获取用户资料
 * @access Private
 */
router.get(
  '/profile',
  authController.authenticate,
  authController.getProfile
);

export default router;