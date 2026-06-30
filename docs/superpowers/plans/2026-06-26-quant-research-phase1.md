# Quant Research Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the phase 1 research credibility ledger to easy quant: traceable experiments, integrity/execution audit artifacts, a credibility screen, and observation gating.

**Architecture:** Keep professional-mode pages stable. Add a new research ledger domain (`QuantResearchExperiment`, `QuantResearchArtifact`, `ResearchExperimentService`) that coexists with the existing strategy-parameter experiment model. Integrate it into quant backtest creation/completion and expose it to `/workspace/easy` through focused service methods and source-level contract tests.

**Tech Stack:** Node.js, Express, TypeScript, Sequelize, React, Ant Design icons, script-style TypeScript/JavaScript tests already used in this repo.

---

## File Structure

- Create `backend/src/models/QuantResearchExperiment.ts`: research ledger parent row.
- Create `backend/src/models/QuantResearchArtifact.ts`: append-only-ish artifacts for backtest, integrity audit, execution audit, and credibility summary.
- Modify `backend/src/models/QuantBacktestTask.ts`: add `experiment_id`, `data_policy_json`, and `constraint_policy_json`.
- Modify `backend/src/config/database.ts` and `backend/src/index.ts`: register/sync new models.
- Create `backend/src/services/research/ResearchExperimentService.ts`: pure verdict helpers plus DB-backed ledger orchestration.
- Modify `backend/src/quant/backtest/internal/QuantBacktestService.ts`: auto-create/bind experiments on easy-mode backtests and trigger audit after completion.
- Modify `backend/src/quant/backtest/BacktestEngine.ts`: expose research audit list/detail methods through the public facade.
- Modify `backend/src/api/controllers/QuantController.ts` and `backend/src/api/routes/quant.routes.ts`: add authenticated research experiment/audit endpoints.
- Modify `frontend/src/services/labService.ts`: extend payload/detail types for research fields.
- Modify `frontend/src/services/easyQuantService.ts`: send easy-mode research payload and fetch audit detail.
- Modify `frontend/src/pages/workspace/easyQuantTemplates.ts`: provide default hypothesis/policy payload from template.
- Modify `frontend/src/pages/workspace/easyQuantResultHelpers.ts`: combine return metrics with credibility verdict.
- Modify `frontend/src/pages/workspace/EasyQuantWorkspace.tsx` and `.css`: add hypothesis, ledger drawer, credibility step, and observation gate.
- Modify `frontend/tests/easy-quant-workspace-contract.test.js`: protect the simplified IA and safety gate.
- Create `backend/tests/services/research-experiment-service.test.ts`: TDD guard for verdict aggregation and easy-mode audit payload.

---

### Task 1: Backend Research Ledger Tests

**Files:**
- Create: `backend/tests/services/research-experiment-service.test.ts`
- Later implementation target: `backend/src/services/research/ResearchExperimentService.ts`

- [ ] **Step 1: Write the failing service contract test**

Create `backend/tests/services/research-experiment-service.test.ts` with script-style assertions:

```ts
import {
  buildCredibilitySummary,
  mapResearchIntegrityArtifact,
  buildExecutionArtifactFromRejectedOrders,
} from '../../src/services/research/ResearchExperimentService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n## ResearchExperimentService credibility helpers');

const passSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '回测完成。' },
  integrity_artifact: { status: 'pass', summary: '没有发现未来函数。' },
  execution_artifact: { status: 'pass', summary: 'A 股约束未阻断。' },
});
assert('all pass allows observation', passSummary.can_create_observation === true);
assert('all pass verdict=pass', passSummary.verdict === 'pass');

const watchSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '收益为正。' },
  integrity_artifact: { status: 'watch', summary: '存在轻微样本外衰减。' },
  execution_artifact: { status: 'pass', summary: '无硬阻断。' },
});
assert('watch allows observation with caution', watchSummary.can_create_observation === true);
assert('watch has watch reason', watchSummary.watch_reasons.length === 1);

const rejectSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '收益很好。' },
  integrity_artifact: { status: 'reject', summary: '使用了尚未披露的数据。' },
  execution_artifact: { status: 'pass', summary: '无硬阻断。' },
});
assert('reject blocks observation', rejectSummary.can_create_observation === false);
assert('reject has blocking reason', rejectSummary.blocking_reasons[0].includes('尚未披露'));

const insufficientSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '回测完成。' },
  integrity_artifact: { status: 'insufficient', summary: '缺少披露日数据。' },
  execution_artifact: { status: 'pass', summary: '无硬阻断。' },
});
assert('insufficient blocks observation', insufficientSummary.verdict === 'insufficient');
assert('insufficient next action checks data', insufficientSummary.next_action_label.includes('查数据'));

const integrity = mapResearchIntegrityArtifact({
  verdict: 'FAIL',
  summary_message: '检测到未来函数。',
  lookahead_issues: [{ pattern: 'Date.now()', severity: 'high' }],
  survivorship_issues: [],
  persisted_id: 9,
});
assert('FAIL maps to reject', integrity.status === 'reject');
assert('integrity artifact keeps source id', integrity.source_id === 9);

const execution = buildExecutionArtifactFromRejectedOrders([
  { reason: 'limit_up_blocked_buy', detail: '涨停买入不可成交' },
  { reason: 't_plus_1_violation', detail: 'T+1 不允许当日卖出' },
]);
assert('rejected orders map to reject', execution.status === 'reject');
assert('execution summary explains count', execution.summary.includes('2'));

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd backend && npx ts-node --transpile-only tests/services/research-experiment-service.test.ts
```

Expected: FAIL with a module-not-found or missing-export error for `ResearchExperimentService`.

- [ ] **Step 3: Do not implement in this task**

Leave the test red. Task 2 supplies the implementation.

---

### Task 2: Models and ResearchExperimentService

**Files:**
- Create: `backend/src/models/QuantResearchExperiment.ts`
- Create: `backend/src/models/QuantResearchArtifact.ts`
- Create: `backend/src/services/research/ResearchExperimentService.ts`
- Modify: `backend/src/models/QuantBacktestTask.ts`
- Modify: `backend/src/config/database.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/tests/services/research-experiment-service.test.ts`

- [ ] **Step 1: Implement models and pure helper exports**

Add model fields using `declare` and `snake_case`. In `ResearchExperimentService.ts`, export:

```ts
export type QuantResearchVerdict = 'pending' | 'pass' | 'watch' | 'reject' | 'insufficient';
export type QuantResearchArtifactStatus =
  | 'pending'
  | 'pass'
  | 'watch'
  | 'reject'
  | 'insufficient'
  | 'error';

export function mapResearchIntegrityArtifact(report: any): ResearchArtifactDraft;
export function buildExecutionArtifactFromRejectedOrders(rejectedOrders: any[]): ResearchArtifactDraft;
export function buildCredibilitySummary(input: {
  backtest_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  integrity_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  execution_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
}): {
  verdict: QuantResearchVerdict;
  can_create_observation: boolean;
  blocking_reasons: string[];
  watch_reasons: string[];
  next_action_label: string;
  title: string;
  summary: string;
};
```

The minimal verdict rule is:

```ts
const statuses = [backtest, integrity, execution].filter(Boolean).map(item => item.status);
if (statuses.includes('reject') || statuses.includes('error')) verdict = 'reject';
else if (statuses.includes('insufficient') || statuses.includes('pending')) verdict = 'insufficient';
else if (statuses.includes('watch')) verdict = 'watch';
else verdict = 'pass';
```

- [ ] **Step 2: Register models**

Import and add both new models to the `models` array in `backend/src/config/database.ts`, and add both to the runtime sync list in `backend/src/index.ts`.

- [ ] **Step 3: Run RED test and verify GREEN**

Run:

```bash
cd backend && npx ts-node --transpile-only tests/services/research-experiment-service.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/QuantResearchExperiment.ts backend/src/models/QuantResearchArtifact.ts backend/src/models/QuantBacktestTask.ts backend/src/config/database.ts backend/src/index.ts backend/src/services/research/ResearchExperimentService.ts backend/tests/services/research-experiment-service.test.ts
git commit -m "feat: add quant research ledger service"
```

---

### Task 3: Backtest Integration and Quant API

**Files:**
- Modify: `backend/src/quant/types/QuantTypes.ts`
- Modify: `backend/src/quant/backtest/internal/QuantBacktestService.ts`
- Modify: `backend/src/quant/backtest/BacktestEngine.ts`
- Modify: `backend/src/api/controllers/QuantController.ts`
- Modify: `backend/src/api/routes/quant.routes.ts`
- Test: `backend/tests/services/research-experiment-service.test.ts`

- [ ] **Step 1: Extend test for backtest-facing payload shape**

Append assertions that the summary can become a frontend verdict:

```ts
const easyVerdict = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '冠军策略收益为正。' },
  integrity_artifact: { status: 'pass', summary: '没有发现未来函数。' },
  execution_artifact: { status: 'reject', summary: '1 笔涨停买入不可成交。' },
});
assert('easy status blocks when execution rejects', easyVerdict.verdict === 'reject');
assert('easy label tells user to adjust', easyVerdict.next_action_label.includes('修正') || easyVerdict.next_action_label.includes('查数据'));
```

- [ ] **Step 2: Run test and verify RED if helper copy is incomplete**

Run:

```bash
cd backend && npx ts-node --transpile-only tests/services/research-experiment-service.test.ts
```

Expected: PASS if Task 2 already covers this behavior, otherwise FAIL on next-action text.

- [ ] **Step 3: Implement DB orchestration**

In `ResearchExperimentService`, add methods:

```ts
async createOrAttachForBacktest(options: QuantBacktestOptions, task: QuantBacktestTask, user_id?: number): Promise<QuantResearchExperiment | null>
async runAuditForBacktest(task_id: number): Promise<ResearchAuditPayload | null>
async getBacktestResearchAudit(task_id: number): Promise<ResearchAuditPayload | null>
async listExperiments(options: { user_id?: number; limit?: number }): Promise<any[]>
async getExperiment(id: number, user_id?: number): Promise<any | null>
```

Use `ResearchIntegrityService.auditBacktest({ backtest_id: bestResult.id, source: 'quant_backtest_result', scan_strategy_code: true }, { persist: true })` for integrity. Use `QuantBacktestResult.rejected_orders_json` to aggregate execution artifact. If no result or required audit data is absent, write `insufficient`, not `pass`.

- [ ] **Step 4: Wire backtest create and completion**

In `QuantBacktestService.createBacktestTask`, persist `experiment_id`, `data_policy_json`, and `constraint_policy_json` from options. If `easy_mode` is true and no `experiment_id` exists, create an experiment before queueing.

After task status becomes `COMPLETED`, call:

```ts
const researchAudit = await researchExperimentService.runAuditForBacktest(task.id);
```

Include `research_audit` in the returned summary without letting audit failure mark the backtest failed.

- [ ] **Step 5: Add API facade/controller/routes**

Expose:

```text
GET  /api/quant/research-experiments
POST /api/quant/research-experiments
GET  /api/quant/research-experiments/:id
POST /api/quant/research-experiments/:id/run-audit
GET  /api/quant/backtests/:id/research-audit
```

Register `/backtests/:id/research-audit` before `/backtests/:id`.

- [ ] **Step 6: Run backend service tests**

Run:

```bash
cd backend && npx ts-node --transpile-only tests/services/research-experiment-service.test.ts
cd backend && npx ts-node --transpile-only tests/services/research-integrity-service.test.ts
cd backend && npx ts-node --transpile-only tests/services/execution-feasibility-service.test.ts
cd backend && npx ts-node --transpile-only tests/backtest/ashare-constraints.test.ts
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/quant/types/QuantTypes.ts backend/src/quant/backtest/internal/QuantBacktestService.ts backend/src/quant/backtest/BacktestEngine.ts backend/src/api/controllers/QuantController.ts backend/src/api/routes/quant.routes.ts backend/src/services/research/ResearchExperimentService.ts backend/tests/services/research-experiment-service.test.ts
git commit -m "feat: bind research audits to quant backtests"
```

---

### Task 4: Easy Quant Frontend Contract and Service

**Files:**
- Modify: `frontend/tests/easy-quant-workspace-contract.test.js`
- Modify: `frontend/src/services/labService.ts`
- Modify: `frontend/src/services/easyQuantService.ts`
- Modify: `frontend/src/pages/workspace/easyQuantTemplates.ts`
- Modify: `frontend/src/pages/workspace/easyQuantResultHelpers.ts`

- [ ] **Step 1: Extend frontend contract test first**

Add assertions:

```js
assert('page adds credibility step before observation', page.includes('可信度') && page.indexOf('可信度') < page.indexOf('模拟观察'));
assert('easy service sends easy-mode research payload', service.includes('easy_mode: true') && service.includes('hypothesis'));
assert('easy service reads research audit', service.includes('getEasyQuantResearchAudit') && service.includes('/research-audit'));
assert('observation is gated by credibility verdict', helpers.includes('credibility_verdict') && page.includes('researchAuditVerdict.can_create_observation'));
assert('ledger drawer is available', page.includes('实验账本') && page.includes('eq-ledger'));
```

- [ ] **Step 2: Run frontend contract and verify RED**

Run:

```bash
node frontend/tests/easy-quant-workspace-contract.test.js
```

Expected: FAIL on missing credibility/research-audit assertions.

- [ ] **Step 3: Implement service/types/helpers**

Extend `CreateBacktestPayload`, `BacktestTask`, and `BacktestDetail` with research fields. Add `EasyQuantResearchAudit`, `getEasyQuantResearchAudit(taskId)`, and an optional `hypothesis` parameter to `runEasyQuantBacktest`.

In `easyQuantTemplates.ts`, include:

```ts
default_hypothesis: string;
```

and send:

```ts
easy_mode: true,
template_id: template.id,
hypothesis,
data_policy_json: { point_in_time: true, disclosure_date_required: true },
constraint_policy_json: { market: 'A_SHARE', t_plus_one: true, block_limit_up: true, block_limit_down: true, block_suspended: true },
```

In result helpers, prefer `detail.research_audit.credibility_verdict` or fetched audit verdict over local return-only thresholds.

- [ ] **Step 4: Run frontend contract and verify GREEN**

Run:

```bash
node frontend/tests/easy-quant-workspace-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/easy-quant-workspace-contract.test.js frontend/src/services/labService.ts frontend/src/services/easyQuantService.ts frontend/src/pages/workspace/easyQuantTemplates.ts frontend/src/pages/workspace/easyQuantResultHelpers.ts
git commit -m "feat: add easy quant research audit contract"
```

---

### Task 5: Easy Quant UI

**Files:**
- Modify: `frontend/src/pages/workspace/EasyQuantWorkspace.tsx`
- Modify: `frontend/src/pages/workspace/EasyQuantWorkspace.css`
- Test: `frontend/tests/easy-quant-workspace-contract.test.js`

- [ ] **Step 1: Update journey structure**

Add a `credibility` step between `backtest` and `observe`. Add section nav label `可信度`. Keep professional link unchanged.

- [ ] **Step 2: Add hypothesis and audit state**

Add state:

```ts
const [hypothesis, setHypothesis] = useState(selectedTemplateData.default_hypothesis);
const [researchAudit, setResearchAudit] = useState<EasyQuantResearchAudit | null>(null);
const [researchAuditLoading, setResearchAuditLoading] = useState(false);
const [researchAuditError, setResearchAuditError] = useState<string | null>(null);
```

After backtest completes, call `getEasyQuantResearchAudit(task_id)`.

- [ ] **Step 3: Add credibility screen**

Render a new stage with three simple verdict panels:

- `回测来源`
- `未来数据`
- `A股成交`

Show one dark CTA: `进入模拟观察` only when `researchAuditVerdict.can_create_observation` is true. Otherwise show a disabled dark CTA and one quiet action back to `查数据` or `选模板`.

- [ ] **Step 4: Add ledger drawer content**

Add `ledger` to drawer keys and quick actions. The drawer lists experiment metadata and artifacts with user-facing statuses `通过`, `需谨慎`, `阻断`, `数据不足`.

- [ ] **Step 5: Run frontend contract**

Run:

```bash
node frontend/tests/easy-quant-workspace-contract.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/workspace/EasyQuantWorkspace.tsx frontend/src/pages/workspace/EasyQuantWorkspace.css frontend/tests/easy-quant-workspace-contract.test.js
git commit -m "feat: add easy quant credibility step"
```

---

### Task 6: Full Verification and Local Smoke

**Files:**
- No required source edits unless verification exposes a regression.

- [ ] **Step 1: Install dependencies if missing**

Run only if `backend/node_modules` or `frontend/node_modules` is absent:

```bash
cd backend && npm install
cd frontend && npm install
```

- [ ] **Step 2: Run targeted tests**

```bash
cd backend && npx ts-node --transpile-only tests/services/research-experiment-service.test.ts
cd backend && npx ts-node --transpile-only tests/services/research-integrity-service.test.ts
cd backend && npx ts-node --transpile-only tests/services/execution-feasibility-service.test.ts
cd backend && npx ts-node --transpile-only tests/backtest/ashare-constraints.test.ts
node frontend/tests/easy-quant-workspace-contract.test.js
```

Expected: all PASS.

- [ ] **Step 3: Run TypeScript build checks**

```bash
cd backend && npm run build
cd frontend && npm run build
```

Expected: both builds complete without TypeScript errors.

- [ ] **Step 4: Start local dev servers for manual smoke**

Use existing test environment variables. Start backend on `3000` and frontend on `3001`:

```bash
cd backend && npm run dev
cd frontend && PORT=3001 npm start
```

Open `http://localhost:3001/workspace/easy`, log in with a local test account, and smoke:

- choose a template;
- keep/edit the default hypothesis;
- run a backtest;
- confirm the credibility section appears;
- confirm blocked/pending audit status does not allow observation;
- confirm professional mode link still points to `/workspace/lab`.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short --branch
```

Expected: clean worktree except intentionally running dev servers.
