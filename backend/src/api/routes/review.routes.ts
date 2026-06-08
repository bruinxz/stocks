import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { reviewController } from '../controllers/ReviewController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/review/performance-center:
 *   get:
 *     tags: [复盘 Review]
 *     summary: 获取绩效复盘中心数据
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 复盘数据, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/performance-center',
  authController.authenticate,
  reviewController.getPerformanceCenter.bind(reviewController)
);

export default router;
