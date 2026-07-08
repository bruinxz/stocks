# ADR-0010 · API Versioning Strategy · workspace draft

**Status**: workspace-draft (Orch self armed) · SLA 23:35 · pre-landing at `docs/refactor/adr/0010-api-versioning-strategy.md` after Strategy + Frontend + Backend + QADocs 4-sign PASS

**Authors**: Orchestrator (owner-review 独占独裁 · 完全掌控令 v2 · zero owner confirm)

**Anchor 引用锚**:
- Q-P2-6 pending 决策位 (Orch msg=09551306 §三)
- Frontend Path ξ ExplainCardDto 11 字段 shape (msg=e06c023c)
- QADocs Task #6 §API-Contract 7 lint (PR #101 · L2 HTTP verb 收窄 · L3 auth 12 敏感)
- DP §D4.G2 shape 四方完形 (PR #100 landed `6d3d831d`)
- 教训 #12 v1.0 · contract draft vs code truth

---

## §1 · Context

M2 后进入 M3 · 后端将陆续 expose `/api/v1/explain-card/:stock_code` (Q-P0-1) + `/api/v1/paper-trading/*` + `/api/v1/screener/*` + `/api/v1/portfolio/rebalance` + `/api/v1/quant/*` 等 5+ BFF-facing endpoint 群 · 前端 Path ξ ExplainCardDto 11 字段 + Path ν BFF requirements 12 domain × 83 endpoint 消费点 · 契约体量已超单 endpoint 拓展的 M1 阶段边界

**问题**:
1. **契约演进**: shape 从 v0 draft → v1 stable → v2 breaking 的迁移期，如何让前端渐进采纳而不 break production 消费？
2. **消费方 mismatch 检测**: 前端 Zod schema 与后端 response 分歧时，如何在 runtime double-source（前端不 aware 权威锁 · 教训 #12 反向应用范式）？
3. **版本收敛**: v1 稳定期不宜爆炸增长（`v1.1`/`v1.1.1` 语义脆弱），主版本 (v1 → v2) 何时触发？

**约束** (owner + Strategy + Frontend 已冻结):
- 教训 #12: contract draft ≠ code truth · code truth 唯一权威（Sequelize model + PG DDL + Zod schema 三源 pin）
- Frontend 不 aware 权威锁: 前端 zero data_source / fallback_reason awareness (Path ν §5)
- Independence v1.1 §5: 契约 field 命名与参考项目 zero drift
- Backend/Frontend 解耦: 契约由 Orchestrator 冻结后 · 双方并行开发

---

## §2 · Decision

**采纳 URL 路径版本 + `X-API-Version` header 双源范式** (D8 独裁 · 完全掌控令 v2)

### §2.1 · URL 路径版本主源
- 所有 BFF-facing endpoint 前缀 `/api/v1/*` · 强制版本存在（zero `/api/*` 无版本 endpoint）
- 主版本 (v1 → v2) 通过 URL 路径切换 · 前后端并存期允许双 mount
- 例: `/api/v1/explain-card/:stock_code` · `/api/v2/explain-card/:stock_code`
- **优点**: gh grep 直查、curl/Postman 直观、CDN cache key 天然分离、log route 归属清晰、URL immutable pin

### §2.2 · `X-API-Version` header 辅源（响应头强制）
- 每次响应必带 `X-API-Version: 1` (或 `X-API-Version: 1.2` for minor rev · 见 §2.4)
- Frontend Zod schema 校验 response 时 · **双源交叉验证** (URL 路径 v1 == header 版本 major)
- 不匹配 → Frontend runtime error boundary throw · 上报 `contract_drift_detected` metric（教训 #12 反向应用范式 · code truth verify)
- **优点**: header 可传 minor rev（前端 opt-in feature detect）· 不强 URL rewrite

### §2.3 · Zod runtime double-source 校验（Frontend 侧）
- Frontend `services/httpClient.ts` (Path ν §4) interceptor: response 到达即 `versionSchema.parse({ url_v: urlMatch, header_v: headerMatch })`
- 版本双源 mismatch → **抛 `ApiVersionMismatchError`** · 上层 React error boundary 处理 · 用户不感知（fallback UI · Frontend Path ρ 兜底策略）
- 教训 #12 传导: **前端 zero 依赖 contract draft** · 校验 = URL path immutable + header runtime 双源 (code truth 唯一权威)

### §2.4 · Minor rev 语义（可选 · header 携带）
- **Minor rev (`v1.1`, `v1.2`)** = 新增可选 field / 新增 endpoint · **backward-compat**
- **Major rev (`v2`)** = 删除 field / 语义变更 / 拆分 shape · **breaking change**
- Minor rev 由 header `X-API-Version: 1.2` 携带 · URL 保持 `/api/v1/*`
- Frontend feature-detect: `header_v >= 1.2 && response.new_field != null ? render : skip`
- **QADocs Task #6 L2 lint 联批**: 未来引入 `X-API-Version-Deprecated: 1.0` warning header (未来 fail-mode)

### §2.5 · v1 → v2 触发条件（收敛红线）
以下任一触发 v2 迁移评估:
1. 至少 3 个 endpoint 需要 breaking shape (例: ExplainCardDto 拆 factors 数组)
2. Frontend Path ξ ExplainCardDto 11 字段有 ≥ 2 个语义变更（rename 或删除）
3. Strategy Q7 权重蓝图从 3 因子扩到 ≥ 5 因子（Path β Q7 v2 冻结）
4. Baostock/AKShare 数据源 fallback 语义变更（DP §D4.G3 semantic 冲突）

**v2 上线**:
- v1 + v2 双 mount 保留至少 **1 sprint** (~1 week) · Frontend 全站 migrate 后 v1 EOL
- QADocs Task #6 L2 lint 追加 `deprecated_v1_routes` baseline JSON · v1 EOL 前 baseline 空 warning-only · EOL 后 hard-fail

---

## §3 · Consequences

### §3.1 · 正向
- Frontend 与 Backend 契约漂移 runtime 检出 · 教训 #12 反向应用范式 code truth 唯一权威
- BFF-facing endpoint 群 (Q-P0-1 explain-card + Q-P2-5 screener + 5 主入口) 100% 统一版本前缀
- QADocs Task #6 L2 lint 天然联批 (URL 前缀强制 · zero orphan `/api/*` 无版本 route)
- gh grep 直查 (`grep -rn "/api/v[0-9]/"` 全域路由 audit) · Cleanup 侧 discipline 强
- 前端不 aware 权威锁 (双源 verify 在 httpClient interceptor · 组件层 zero aware)

### §3.2 · 负向
- URL 路径版本切换意味 v2 上线时前端全站 route rewrite (mitigation: httpClient baseURL 变量 · single source of switch)
- Header 双源增加 middleware overhead (mitigation: Express middleware `app.use((req, res, next) => { res.set('X-API-Version', pkg.apiVersion); next(); })` · 单行常量)
- Minor rev 语义 requires Strategy + Backend + Frontend 三方共识（不由 Orch 独裁 · 每 minor rev 走 M3 4-sign flow）

### §3.3 · Alternatives 拒绝
- **Header-only** (`X-API-Version` 独占 · URL 无版本): 拒绝 · Cleanup grep + CDN cache key + log route 归属全部 miss
- **URL query string** (`/api/explain-card?v=1`): 拒绝 · immutable URL 破坏 · CDN cache 兼容差
- **Content-Type versioning** (`Accept: application/vnd.stocks.v1+json`): 拒绝 · 复杂度过高 · Frontend + curl 双端认知负担 · 不契合 M3 阶段成熟度

---

## §4 · Implementation Plan

### §4.1 · Phase 1 (M2 收官 · 本 ADR landing 后 · SLA T+3d)
- Backend `backend/src/api/index.ts` `app.use('/api/v1', router)` · 强制版本前缀
- Backend middleware `X-API-Version` header 强制注入 · single source: `package.json.api_version` (pin `1.0`)
- QADocs Task #6 L2 lint 升级: 未挂 `/api/v[0-9]+/` 前缀的 route → **hard-fail** (currently warning-only)
- Frontend `services/httpClient.ts` axios interceptor: response `X-API-Version` header 校验 · mismatch throw `ApiVersionMismatchError`

### §4.2 · Phase 2 (M3 中期 · SLA T+1w)
- Frontend Zod schema: 每个 shape schema 附 `.readonly()` + `versioned('1.0')` marker
- QADocs Playwright golden snapshot: 每个 shape response 附带 header assertion `expect(response.headers['x-api-version']).toBe('1.0')`
- Backend log 中间件: 每个 request/response pair 带 `api_version` 字段 · 便于 audit

### §4.3 · Phase 3 (M3 收官 · SLA T+2w)
- Backend `/health` endpoint 附 `supported_api_versions: [1]` · 未来 v2 上线时 `[1, 2]` 并存
- Frontend feature-detect infra: `useApiVersionDetect()` hook · 根据 header minor rev 决定 UI feature toggle
- Runbook: v1 → v2 迁移 SOP checklist（4-sign flow · 双 mount 保留 1 sprint · v1 EOL 前 QADocs L2 baseline 追加 warn → fail）

---

## §5 · Cross-references

- 教训 #12 v1.0 `notes/lesson-12-contract-draft-vs-code-truth.md` · code truth 唯一权威范式反向应用
- Q-P2-6 pending 决策位 (Orch msg=09551306 §三) · 本 ADR 兑现
- Frontend Path ξ ExplainCardDto TypeScript draft (msg=e06c023c) · shape 消费方
- Frontend Path ν BFF-API-requirements draft · 12 domain × 83 endpoint 消费点全域
- QADocs Task #6 §API-Contract 7 lint (PR #101 · L2 HTTP verb 收窄 + L3 auth) · 契约门禁位
- DP §D4.G2 shape 四方完形 (PR #100 landed `6d3d831d`) · Loader 层版本传导锚
- Strategy Q7 v1 冻结（M-Draft 三绿窗口）· minor rev 触发源

---

## §6 · Landing 位

- workspace-draft: `notes/adr-0010-api-versioning-strategy-draft.md` (本文件 · Orch self armed)
- 落地目标: `docs/refactor/adr/0010-api-versioning-strategy.md` (post 4-sign PASS · Strategy + Frontend + Backend + QADocs)
- 副签路由: Orch 主 (架构决策) + Strategy 副 (shape 冻结源) + Frontend 副 (double-source verify 消费方) + Backend 副 (中间件实施) + QADocs 副 (L2 lint 联批 + Playwright header assertion)
