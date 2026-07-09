/**
 * screener.routes.ts — ADR-0010 §1 · /api/v1/screener Phase 1 stub.
 *
 * Full implementation deferred; Phase 1 establishes the URL mount so
 * Frontend + QADocs can pin routing tests. Returns 501 Not Implemented.
 */
import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.status(501).json({
    error: 'not_implemented',
    endpoint: '/api/v1/screener',
    phase: '1',
  });
});

export default router;
