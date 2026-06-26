# Quant Research Phase 1 Design

Date: 2026-06-26

## Goal

Implement phase 1 of the quant research roadmap: every simplified quant research run should answer three questions before it can move into observation:

1. Where did this backtest result come from?
2. Did it use data that would not have been visible at the time?
3. Could its orders be executed under A-share rules?

The backend scope follows the phase 1 roadmap. The frontend entry point is intentionally changed from the roadmap's `LabWorkspace` proposal to the simplified workspace at `/workspace/easy`, per product direction. Professional-mode pages must remain stable and should not be redesigned in this iteration.

## Approved UX Direction

Use option A, "experiment ledger as the spine."

The simplified workspace remains a step-by-step flow. Each step writes to a research ledger in the background, and the user receives a plain-language credibility verdict after the backtest finishes.

The updated easy flow is:

1. Start: position the surface as "first trustworthy research" while keeping the existing `/workspace/easy` route.
2. Define + choose template: keep template cards, add a short research hypothesis and time range context.
3. Check data: keep the simple health verdict, but expose point-in-time visibility, disclosure-date coverage, suspension, limit, and adjustment checks in a drawer.
4. Run backtest: create the backtest as today, auto-bind it to a research experiment, and persist the result as a ledger artifact.
5. Credibility: add a new independent screen between backtest and observation. It shows theory result, integrity audit, and A-share execution feasibility as one action-oriented verdict.
6. Observe: allow observation only when the credibility verdict is `pass` or `watch`. A `reject` verdict blocks the primary observation CTA and points the user back to the step that needs correction.

The experiment ledger is a drawer/side context in simplified mode, not a new professional-mode tab. It contains provenance and audit artifacts for the current run.

## Product Boundaries

- Do not change the professional-mode IA, tabs, or visual system in this phase.
- Do not weaken existing authenticated API behavior.
- Do not bypass the local development safety switches already added in prior work.
- Do not make simplified mode a toy surface: it should hide complexity until needed, while preserving traceability.
- Reuse the existing warm-paper easy UI tokens and copy vocabulary, especially "查数据".

## Existing Code Context

Reusable backend pieces:

- `backend/src/services/research/ResearchIntegrityService.ts`
- `backend/src/services/execution/ExecutionFeasibilityService.ts`
- `backend/src/quant/backtest/AShareConstraintEngine.ts`
- `backend/src/models/QuantBacktestTask.ts`
- `backend/src/models/ResearchIntegrityAudit.ts`
- `backend/src/models/ExecutionFeasibilityRecord.ts`
- `backend/src/api/controllers/QuantController.ts`
- `backend/src/api/routes/quant.routes.ts`

There is already a `QuantStrategyExperiment` model and `QuantStrategyExperimentService`, but that concept currently means "strategy parameter experiment/ranking." It should not be overloaded as the research trust ledger. The new phase 1 ledger should use explicit research names so both concepts can coexist without confusing API consumers.

Reusable simplified frontend pieces:

- `frontend/src/pages/workspace/EasyQuantWorkspace.tsx`
- `frontend/src/pages/workspace/EasyQuantWorkspace.css`
- `frontend/src/services/easyQuantService.ts`
- `frontend/src/pages/workspace/easyQuantHooks.ts`
- `frontend/src/pages/workspace/easyQuantTemplates.ts`
- `frontend/src/pages/workspace/easyQuantResultHelpers.ts`
- `frontend/tests/easy-quant-workspace-contract.test.js`
- `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md`

## Data Model Design

Add `QuantResearchExperiment` backed by `quant_research_experiments`.

Core fields:

- `id`
- `user_id`
- `experiment_key`
- `hypothesis`
- `strategy_key`
- `template_id`
- `task_id`
- `status`: `draft | running | completed | rejected | archived`
- `verdict`: `pending | pass | watch | reject | insufficient`
- `start_date`
- `end_date`
- `universe`
- `symbols`
- `params_json`
- `data_policy_json`
- `cost_policy_json`
- `constraint_policy_json`
- `summary_json`
- `created_at`
- `updated_at`

Add `QuantResearchArtifact` backed by `quant_research_artifacts`.

Core fields:

- `id`
- `experiment_id`
- `task_id`
- `artifact_type`: `backtest | integrity_audit | execution_audit | credibility_summary`
- `source_type`
- `source_id`
- `status`: `pending | pass | watch | reject | insufficient | error`
- `title`
- `summary`
- `payload_json`
- `created_at`
- `updated_at`

Extend `QuantBacktestTask` with:

- `experiment_id`
- `data_policy_json`
- `constraint_policy_json`

All model attributes and API fields must use `snake_case`.

## Backend Service Design

Create `ResearchExperimentService`.

Responsibilities:

- Create or reuse a research experiment when simplified mode starts a backtest.
- Attach a completed `QuantBacktestTask` and its result summary to the experiment.
- Run integrity and execution audits after task completion.
- Persist each report as a `QuantResearchArtifact`.
- Derive a final credibility verdict:
  - `pass`: no blocking integrity or execution issue.
  - `watch`: warnings exist, but the run may be observed with visible caution.
  - `reject`: future-data leakage, infeasible execution, or hard A-share constraints make observation unsafe.
  - `insufficient`: audit could not finish because required data is missing.

Use `ResearchIntegrityService` for the first integrity pass. For phase 1, the required minimum is:

- Preserve current code-pattern lookahead detection.
- Attach the audit to a specific research experiment/backtest.
- Add point-in-time issue slots for disclosure date, ST/suspension visibility, and universe visibility even when some sources are still partial.
- Mark missing audit data as `insufficient`, not `pass`.

Use `ExecutionFeasibilityService` and `AShareConstraintEngine` for A-share feasibility. For phase 1, the required minimum is:

- Limit-up buy blocks or downgrades feasibility.
- Limit-down sell blocks or downgrades feasibility.
- Suspension blocks trading.
- T+1 sell attempts are blocked or deferred.
- The summary is aggregated at experiment level, not only per single order.

## API Design

Add authenticated routes under `/api/quant`.

```text
GET  /api/quant/research-experiments
POST /api/quant/research-experiments
GET  /api/quant/research-experiments/:id
POST /api/quant/research-experiments/:id/run-audit
GET  /api/quant/backtests/:id/research-audit
```

Extend `POST /api/quant/backtests` to accept optional research fields:

```json
{
  "easy_mode": true,
  "experiment_id": 123,
  "hypothesis": "验证稳健趋势模板在近两年沪深300成分中的表现",
  "data_policy_json": {},
  "constraint_policy_json": {}
}
```

When `easy_mode` is true and `experiment_id` is absent, the backend auto-creates a `QuantResearchExperiment`.

Extend `GET /api/quant/backtests/:id` or add `GET /api/quant/backtests/:id/research-audit` so the simplified frontend can retrieve:

- `experiment`
- `artifacts`
- `credibility_verdict`
- `can_create_observation`
- `blocking_reasons`
- `watch_reasons`
- `next_action_label`

## Simplified Frontend Design

Update `EasyQuantWorkspace` only.

Required UI changes:

- Add a short hypothesis input/selection affordance near template selection. Keep it low-friction and prefill from the selected template.
- Add a new journey step and section: `可信度`.
- Keep one primary CTA per screen.
- Add a ledger drawer entry to quick actions. The drawer should show the current experiment, backtest artifact, integrity artifact, execution artifact, and final verdict.
- Update the backtest result screen so it does not imply a good return is enough to proceed.
- Gate observation creation on the backend credibility verdict.

Service changes:

- Extend `easyQuantService.runEasyQuantBacktest` to send `easy_mode`, hypothesis, and policy fields.
- Add `getEasyQuantResearchAudit(task_id)` or return audit detail through the existing detail loader.
- Extend result helpers to merge return/risk metrics with the credibility verdict.

Copy principles:

- Use "可信度" for the new screen.
- Use "通过", "需谨慎", and "阻断" as user-facing verdicts.
- Translate technical causes into plain Chinese, for example "这笔买入发生在涨停价，真实交易里大概率买不到".
- Keep professional details in the drawer, not the main screen.

## Observation Gate

Observation is allowed when:

- backtest is complete;
- research audit exists;
- final verdict is `pass`, or verdict is `watch` and no hard blocking reason exists.

Observation is blocked when:

- final verdict is `reject`;
- audit is still `pending`;
- audit is `insufficient` because required data is missing;
- backtest failed.

The disabled CTA must explain the reason in plain Chinese and give one next action: rerun, check data, or adjust the hypothesis/template.

## Testing Plan

Backend tests:

- Add model/service tests for creating a research experiment and writing artifacts.
- Add a service test that a completed backtest produces a credibility summary artifact.
- Add point-in-time cases around disclosure-date leakage and missing PIT data becoming `insufficient`.
- Reuse/extend existing A-share tests for limit-up buy, limit-down sell, suspension, and T+1 blocking/defer behavior.
- Add route-level tests for research experiment list/detail and backtest audit retrieval.

Frontend tests:

- Extend `frontend/tests/easy-quant-workspace-contract.test.js` to assert the simplified flow includes `可信度`, keeps `/workspace/lab` as professional mode, and calls only quant/paper APIs.
- Add contract checks that observation is gated by credibility status.
- Keep the existing easy UI source-level guard against blue dashboard styling and terminology drift.

Regression/self-check:

- Run the easy workspace contract test.
- Run research integrity and execution feasibility service tests.
- Run A-share constraint tests.
- Use the existing local test database environment for a smoke run that creates an easy-mode backtest, retrieves its audit, and verifies the frontend-facing payload shape.

## Rollout Notes

- Existing backtests without `experiment_id` should still load.
- Existing professional mode routes and components remain compatible.
- Audit failures should not crash backtest detail retrieval. They should produce `insufficient` or `error` artifacts visible in the ledger.
- The first implementation may not have perfect historical index/industry PIT data if the data source is absent; it must not silently pass those checks. Missing source coverage must be visible as `insufficient`.

## Out Of Scope

- Building the second-stage research gate, factor IC decay UI, or portfolio exposure UI.
- Redesigning `LabWorkspace`.
- Creating production promotion automation.
- Copying or resyncing production database data.
- Enabling real trading or live order placement from simplified mode.
