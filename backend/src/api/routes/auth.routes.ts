import { Router } from 'express';
import { body } from 'express-validator';
import { AuthController } from '../controllers/AuthController';
import { wechatAuthController } from '../controllers/WechatAuthController';
import { validateRequest } from '../../middlewares/validateRequest';
import { uploadAvatarMiddleware } from '../../middlewares/upload';

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
  [body('username').isString(), body('password').isString()],
  validateRequest,
  authController.login
);

/**
 * @route POST /api/auth/refresh
 * @desc 刷新访问令牌
 * @access Public
 */
router.post('/refresh', authController.refreshToken);

/**
 * @route POST /api/auth/logout
 * @desc 用户登出
 * @access Private
 */
router.post('/logout', authController.authenticate, authController.logout);

/**
 * @route GET /api/auth/profile
 * @desc 获取用户资料
 * @access Private
 */
router.get('/profile', authController.authenticate, authController.getProfile);

/**
 * @route PUT /api/auth/profile
 * @desc 更新用户资料
 * @access Private
 */
router.put(
  '/profile',
  authController.authenticate,
  [
    body('nickname').optional().isString().isLength({ max: 50 }),
    body('phone').optional().isString().isLength({ max: 20 }),
    body('avatar_url').optional().isString().isLength({ max: 255 }),
  ],
  validateRequest,
  authController.updateProfile
);

/**
 * @route POST /api/auth/avatar
 * @desc 上传头像
 * @access Private
 */
router.post(
  '/avatar',
  authController.authenticate,
  (req, res, next) => {
    uploadAvatarMiddleware.single('avatar')(req, res, err => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  authController.uploadAvatar
);

/**
 * ------------------ 微信推送绑定相关（PushPlus） ------------------
 */

/**
 * @route POST /api/auth/wechat/bind
 * @desc  绑定 PushPlus Token
 */
router.post(
  '/wechat/bind',
  authController.authenticate,
  [body('token').isString().isLength({ min: 32, max: 32 })],
  validateRequest,
  wechatAuthController.bindPushPlusToken
);

/**
 * @route POST /api/auth/wechat/test
 * @desc  发送测试推送
 */
router.post(
  '/wechat/test',
  authController.authenticate,
  wechatAuthController.sendTestPush
);

/**
 * @route POST /api/auth/wechat/unbind
 * @desc  解绑微信
 */
router.post(
  '/wechat/unbind',
  authController.authenticate,
  wechatAuthController.unbindWechat
);

/**
 * @route PUT /api/auth/wechat/notify
 * @desc  开关微信通知
 */
router.put(
  '/wechat/notify',
  authController.authenticate,
  wechatAuthController.updateNotifyEnabled
);

export default router;
