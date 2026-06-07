import { Router } from 'express';
import { sentimentController } from '../controllers/SentimentController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/sentiment/index
 * @desc US-057 — 最近 N 天市场情绪指数时序 (days 默认 30, 上限 365)
 * @access Private
 *
 * **NOTE**: /index/latest 与 /index/compute 必须在 /index 之前 (虽然这里没有 :param 冲突,
 *           但按 express 顶向下匹配 GET /index 也会接到 /index/latest 的请求时返回错误)
 *           —— Express 实际上只有 path 完全相等时才匹配 GET '/index',所以此处其实无冲突,
 *           但保留显式顺序便于将来加 :param。
 */
router.get('/index/latest', authController.authenticate, (req, res) => {
  void sentimentController.getLatestIndex(req, res);
});

router.post('/index/compute', authController.authenticate, (req, res) => {
  void sentimentController.compute(req, res);
});

router.get('/index', authController.authenticate, (req, res) => {
  void sentimentController.getIndexSeries(req, res);
});

export default router;
