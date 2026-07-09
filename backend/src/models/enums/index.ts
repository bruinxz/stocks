/**
 * Backend enum authority barrel (ADR-0011 §5 SSOT · PR-M3-1).
 *
 * Frontend must consume these types via alias re-export at
 * `frontend/src/types/backend-enums.ts` (PR-M3-2 · Frontend elim T+7d).
 * Do NOT redefine any enum listed here in `frontend/**` — enum-matrix-lock.test
 * (`backend/tests/enum/enum-matrix-lock.test.ts`) will fail on byte-drift.
 */
export { QuantWorkflowStatus } from '../../quant/workflow/QuantWorkflowReadinessService';
