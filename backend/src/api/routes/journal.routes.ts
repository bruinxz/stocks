import { Router } from 'express';
import { journalController } from '../controllers/JournalController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/journals:
 *   get:
 *     tags: [日记 Journals]
 *     summary: 获取当前用户的复盘日记列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 */
router.get('/', authController.authenticate, journalController.getJournals);

/**
 * @openapi
 * /api/journals/{date}:
 *   get:
 *     tags: [日记 Journals]
 *     summary: 获取指定日期的复盘日记详情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: date
 *         schema: { type: string, format: date }
 *         required: true
 *     responses:
 *       200: { description: 操作成功, content: { application/json: { schema: { $ref: '#/components/schemas/Journal' } } } }
 *       401: { description: 未授权 }
 *       404: { description: 日记不存在 }
 */
router.get('/:date', authController.authenticate, journalController.getJournalDetail);

/**
 * @openapi
 * /api/journals:
 *   post:
 *     tags: [日记 Journals]
 *     summary: 创建复盘日记
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [review_date]
 *             properties:
 *               review_date: { type: string, format: date }
 *               mood: { type: string }
 *               notes: { type: string }
 *     responses:
 *       200: { description: 操作成功, content: { application/json: { schema: { $ref: '#/components/schemas/Journal' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/', authController.authenticate, journalController.createJournal);

/**
 * @openapi
 * /api/journals/{date}:
 *   put:
 *     tags: [日记 Journals]
 *     summary: 更新复盘日记
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: date
 *         schema: { type: string, format: date }
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mood: { type: string }
 *               notes: { type: string }
 *     responses:
 *       200: { description: 操作成功 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 日记不存在 }
 */
router.put('/:date', authController.authenticate, journalController.updateJournal);

/**
 * @openapi
 * /api/journals/{date}:
 *   delete:
 *     tags: [日记 Journals]
 *     summary: 删除复盘日记
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: date
 *         schema: { type: string, format: date }
 *         required: true
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 *       404: { description: 日记不存在 }
 */
router.delete('/:date', authController.authenticate, journalController.deleteJournal);

/**
 * @openapi
 * /api/journals/{date}/notes:
 *   post:
 *     tags: [日记 Journals]
 *     summary: US-017 追加用户手记（不修改 AI 生成的字段）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: date
 *         schema: { type: string, format: date }
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [note]
 *             properties:
 *               note: { type: string }
 *     responses:
 *       200: { description: 操作成功 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 日记不存在 }
 */
router.post('/:date/notes', authController.authenticate, journalController.appendNote);

export default router;
