# CI diagnostic baselines

These files pin debt that already existed at `da801a52c6f5bc3e862e144f770113130e87e766`,
immediately after CI began preserving producer exit codes. The gate permits a diagnostic
to disappear or decrease, but fails closed when a fingerprint is added, its count grows,
the producer exits outside the baseline's explicit `allowed_producer_exits` policy,
the producer fails without parseable diagnostics, the baseline SHA is not an ancestor,
or a pinned tool/config file changes.

Regenerate only from a clean checkout of the pinned SHA. A baseline update is a reviewed
debt-governance change, never an automatic response to a failing PR.

```bash
git switch --detach da801a52c6f5bc3e862e144f770113130e87e766

(cd backend && npm ci)
(cd backend && npx eslint src --ext .ts --format json > ../backend-eslint-da801a52.json)
node scripts/ci/diagnostic-baseline.js generate \
  --kind eslint \
  --input backend-eslint-da801a52.json \
  --baseline-sha da801a52c6f5bc3e862e144f770113130e87e766 \
  --tool-version 8.57.1 \
  --repo-root . \
  --workdir backend \
  --config backend/.eslintrc.js \
  --config backend/tsconfig.json \
  --config backend/package.json \
  --config backend/package-lock.json \
  --output docs/refactor/baseline/ci/backend-eslint-da801a52.json

(cd frontend && npm ci)
(cd frontend && npx tsc --noEmit --pretty false > ../frontend-tsc-da801a52.log 2>&1)
node scripts/ci/diagnostic-baseline.js generate \
  --kind tsc \
  --input frontend-tsc-da801a52.log \
  --baseline-sha da801a52c6f5bc3e862e144f770113130e87e766 \
  --tool-version 4.9.5 \
  --repo-root . \
  --workdir frontend \
  --config frontend/tsconfig.json \
  --config frontend/package.json \
  --config frontend/package-lock.json \
  --output docs/refactor/baseline/ci/frontend-tsc-da801a52.json
```
