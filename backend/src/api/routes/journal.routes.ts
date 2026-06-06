import { Router } from 'express';
import { journalController } from '../controllers/JournalController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/journals
 * @desc 获取当前用户的复盘日记列表
 * @access Private
 */
router.get('/', authController.authenticate, journalController.getJournals);

/**
 * @route GET /api/journals/:date
 * @desc 获取指定日期的复盘日记详情
 * @access Private
 */
router.get('/:date', authController.authenticate, journalController.getJournalDetail);

/**
 * @route POST /api/journals
 * @desc 创建复盘日记
 * @access Private
 */
router.post('/', authController.authenticate, journalController.createJournal);

/**
 * @route PUT /api/journals/:date
 * @desc 更新复盘日记
 * @access Private
 */
router.put('/:date', authController.authenticate, journalController.updateJournal);

/**
 * @route DELETE /api/journals/:date
 * @desc 删除复盘日记
 * @access Private
 */
router.delete('/:date', authController.authenticate, journalController.deleteJournal);

/**
 * @route POST /api/journals/:date/notes
 * @desc US-017 — 追加用户手记（不修改 AI 生成的市场/持仓/明日策略字段）
 * @access Private
 */
router.post('/:date/notes', authController.authenticate, journalController.appendNote);

export default router;
