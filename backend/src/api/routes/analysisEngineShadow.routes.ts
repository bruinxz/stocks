/**
 * AnalysisEngineShadow Routes — GAMMA 2026-06-18
 *
 * Mount: /api/admin/analysis-engine
 *
 * Admin-only. 复用 AuthController.authenticate + requireRole('admin').
 */

import { Router } from 'express';
import { analysisEngineShadowController } from '../controllers/AnalysisEngineShadowController';
import { AuthController } from '../controllers/AuthController';
import { requireRole } from '../../middlewares/auth';

const router = Router();
const authController = new AuthController();

router.get(
  '/shadow-stats',
  authController.authenticate,
  requireRole('admin'),
  analysisEngineShadowController.getShadowStats
);

export default router;
