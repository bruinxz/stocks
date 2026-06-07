import { Router } from 'express';
import { announcementController } from '../controllers/AnnouncementController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * US-059 — 公司公告 NLP 抽取相关 endpoint.
 *
 * 路由前缀: /api/announcements
 *
 * NOTE: /by-date 与 /sync 必须在 /:stock_code 等 :param catchall 之前注册 (US-015 lesson)
 * —— 当前 controller 没有 :param 路由, 但显式 ordering 防未来加路由破坏匹配.
 */

/**
 * @route GET /api/announcements
 * @desc 某只股票最近 N 天的公告 NLP 抽取列表
 * @access Private
 *
 *   Query params:
 *     - stock_code  6 位股票代码 (必填)
 *     - days        回看天数 (默认 30, 上限 365)
 *     - limit       返回上限 (默认 200, 上限 1000)
 */
router.get('/', authController.authenticate, (req, res) => {
  void announcementController.listByStock(req, res);
});

/**
 * @route GET /api/announcements/by-date
 * @desc 某交易日全市场公告列表
 * @access Private
 *
 *   Query params:
 *     - date       'YYYY-MM-DD' (必填)
 *     - sentiment  '正面' / '中性' / '负面' (可选 — 过滤情绪)
 *     - limit      上限 (默认 200, 上限 1000)
 */
router.get('/by-date', authController.authenticate, (req, res) => {
  void announcementController.listByDate(req, res);
});

/**
 * @route POST /api/announcements/sync
 * @desc 手动触发某日同步 (admin)
 * @access Private
 *
 *   Body:
 *     - date              'YYYY-MM-DD' (默认今日)
 *     - symbol            '全部' / '重大事项' / ... (默认 '全部')
 *     - extract_with_ai   boolean (默认 false)
 *     - dry_run           boolean (默认 false)
 */
router.post('/sync', authController.authenticate, (req, res) => {
  void announcementController.triggerSync(req, res);
});

export default router;
