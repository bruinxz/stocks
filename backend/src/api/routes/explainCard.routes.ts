/**
 * explainCard.routes.ts — ADR-0010 §1 · /api/v1/explain-card Phase 1 stub.
 *
 * Full implementation deferred; Phase 1 establishes the URL mount so
 * Frontend + QADocs can pin routing tests. Returns 501 Not Implemented.
 */
import { Router } from 'express';

const router = Router();

router.get('/:stock_code', (_req, res) => {
  res.status(501).json({
    error: 'not_implemented',
    endpoint: '/api/v1/explain-card/:stock_code',
    phase: '1',
  });
});

export default router;
