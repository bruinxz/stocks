import { Router } from 'express';
import { body } from 'express-validator';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';
import { uploadAvatarMiddleware } from '../../middlewares/upload';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [认证 Auth]
 *     summary: 用户注册
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username: { type: string, minLength: 3, maxLength: 50 }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 6 }
 *     responses:
 *       200: { description: 注册成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
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
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [认证 Auth]
 *     summary: 用户登录
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: 登录成功，返回 JWT
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     token: { type: string }
 *                     user: { $ref: '#/components/schemas/User' }
 *       401: { description: 用户名或密码错误 }
 */
router.post(
  '/login',
  [body('username').isString(), body('password').isString()],
  validateRequest,
  authController.login
);

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [认证 Auth]
 *     summary: 刷新访问令牌
 *     security: []
 *     responses:
 *       200: { description: 新 token 返回 }
 *       401: { description: refresh token 无效或过期 }
 */
router.post('/refresh', authController.refreshToken);

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [认证 Auth]
 *     summary: 用户登出
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 登出成功 }
 */
router.post('/logout', authController.authenticate, authController.logout);

/**
 * @openapi
 * /api/auth/profile:
 *   get:
 *     tags: [认证 Auth]
 *     summary: 获取用户资料
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 用户资料
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/User' }
 *       401: { description: 未授权 }
 */
router.get('/profile', authController.authenticate, authController.getProfile);

/**
 * @openapi
 * /api/auth/profile:
 *   put:
 *     tags: [认证 Auth]
 *     summary: 更新用户资料
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nickname: { type: string, maxLength: 50 }
 *               phone: { type: string, maxLength: 20 }
 *               avatar_url: { type: string, maxLength: 255 }
 *     responses:
 *       200: { description: 更新成功 }
 *       400: { description: 参数错误 }
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
 * @openapi
 * /api/auth/avatar:
 *   post:
 *     tags: [认证 Auth]
 *     summary: 上传头像
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               avatar: { type: string, format: binary }
 *     responses:
 *       200: { description: 上传成功，返回 avatar_url }
 *       400: { description: 文件格式错误 }
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

export default router;
