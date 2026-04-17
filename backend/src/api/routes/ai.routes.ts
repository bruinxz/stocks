import { Router } from 'express';
import { aiAdvisorController } from '../controllers/AIAdvisorController';
import { screenerController } from '../controllers/ScreenerController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route POST /api/ai/analyze
 * @desc 提交 AI 同步或异步分析任务
 * @access Private
 */
router.post('/analyze', authController.authenticate, aiAdvisorController.analyze);

/**
 * @route GET /api/ai/tasks/:taskId
 * @desc 获取 AI 分析异步任务的状态
 * @access Private
 */
router.get('/tasks/:taskId', authController.authenticate, aiAdvisorController.getTask);

/**
 * @route GET /api/ai/analyze/stream
 * @desc 实时 SSE 流式返回 AI 研报分析过程
 * @access Private
 */
router.get(
  '/analyze/stream',
  // authController.authenticate, // EventSource 无法方便传递 Bearer Header，可能需要通过 URL token 验证或者放开
  aiAdvisorController.streamAnalyze
);

/**
 * @route GET /api/ai/screener
 * @desc 获取 AI 每日优选列表
 * @access Private
 */
router.get('/screener', authController.authenticate, screenerController.getDailyScreener);

export default router;
