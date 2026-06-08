import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { signalTraceController } from '../controllers/SignalTraceController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/signals/{id}/trace:
 *   get:
 *     tags: [信号 SignalTrace]
 *     summary: 获取单笔推荐/信号的完整因果链路
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 信号 ID }
 *     responses:
 *       200: { description: 因果链路 (来源任务/量化/风控/交易/收益), content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 信号不存在 }
 */
router.get(
  '/:id/trace',
  authController.authenticate,
  signalTraceController.getTrace.bind(signalTraceController)
);

export default router;
