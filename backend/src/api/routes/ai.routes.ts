import { Router } from 'express';
import { aiAdvisorController } from '../controllers/AIAdvisorController';
import { screenerController } from '../controllers/ScreenerController';
import { aiSignalController } from '../controllers/AISignalController';
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
 * @route GET /api/ai/signals
 * @desc 获取已归档 AI 投研信号及后验收益
 * @access Private
 */
router.get('/signals', authController.authenticate, aiSignalController.listSignals);

/**
 * @route GET /api/ai/signals/stats
 * @desc 获取 AI 投研信号统计表现
 * @access Private
 */
router.get('/signals/stats', authController.authenticate, aiSignalController.getSignalStats);

/**
 * @route POST /api/ai/signals/sync-screeners
 * @desc 从 AI 每日优选同步为可验证信号
 * @access Private
 */
router.post('/signals/sync-screeners', authController.authenticate, aiSignalController.syncFromScreeners);

/**
 * @route POST /api/ai/signals/verify
 * @desc 刷新 AI 信号后验收益验证
 * @access Private
 */
router.post('/signals/verify', authController.authenticate, aiSignalController.verifySignals);

/**
 * @route GET /api/ai/screener
 * @desc 获取 AI 每日优选列表
 * @access Private
 */
router.get('/screener', authController.authenticate, screenerController.getDailyScreener);

/**
 * @route GET /api/ai/screener/:id
 * @desc 获取单条 AI 优选详情（包含 detail 大字段）
 * @access Private
 */
router.get(
  '/screener/:id',
  authController.authenticate,
  screenerController.getDailyScreenerDetail
);

export default router;
