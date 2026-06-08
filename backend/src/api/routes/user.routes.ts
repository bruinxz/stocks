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
 * @openapi
 * /api/users:
 *   get:
 *     tags: [用户 Users]
 *     summary: 获取所有用户列表 (管理员)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 用户列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       403: { description: 无管理员权限 }
 */
router.get('/', userController.getUsers);

/**
 * @openapi
 * /api/users:
 *   post:
 *     tags: [用户 Users]
 *     summary: 创建新用户 (管理员)
 *     security: [{ bearerAuth: [] }]
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
 *               role: { type: string, enum: [admin, user] }
 *               is_active: { type: boolean }
 *     responses:
 *       200: { description: 创建成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       403: { description: 无管理员权限 }
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
 * @openapi
 * /api/users/{id}:
 *   put:
 *     tags: [用户 Users]
 *     summary: 更新用户信息 (管理员)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 用户 ID }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               role: { type: string, enum: [admin, user] }
 *               is_active: { type: boolean }
 *     responses:
 *       200: { description: 更新成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       403: { description: 无管理员权限 }
 *       404: { description: 用户不存在 }
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
 * @openapi
 * /api/users/{id}/password:
 *   put:
 *     tags: [用户 Users]
 *     summary: 修改用户密码 (管理员)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 用户 ID }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword]
 *             properties:
 *               newPassword: { type: string, minLength: 6 }
 *     responses:
 *       200: { description: 修改成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       403: { description: 无管理员权限 }
 *       404: { description: 用户不存在 }
 */
router.put(
  '/:id/password',
  [body('newPassword').isString().isLength({ min: 6 })],
  validateRequest,
  userController.changePassword
);

/**
 * @openapi
 * /api/users/{id}:
 *   delete:
 *     tags: [用户 Users]
 *     summary: 删除用户 (管理员)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 用户 ID }
 *     responses:
 *       200: { description: 删除成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       403: { description: 无管理员权限 }
 *       404: { description: 用户不存在 }
 */
router.delete('/:id', userController.deleteUser);

export default router;
