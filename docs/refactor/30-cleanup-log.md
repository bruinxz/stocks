# 30 · Cleanup Log

> 记录每一批清理的：批次号 / 目标 / 依据 / 影响面 / commit / DoD 自检。
> 契约冻结后 Phase 0 清理专员维护。本轮范围（li-yiming 授权 msg=fa1caa7a + Orchestrator 编排 msg=e0fd0725）：仅 `.verify_token` + `verify.mjs` 及配套 `.gitignore` 加固。

## 批次 C-01 · `.verify_token` 删除 + `.gitignore` 追加

- **分支**：`refactor/cleanup-verify-token-env`（从 `main` HEAD `e47e5a28` 建）
- **变更**：
  - 删 `.verify_token`（tracked 文件，185 字节）
  - `.gitignore` 追加 `.verify_token` + `shots/`（防将来复现）
- **依据**：
  - 文件是 JWT token（HS256），payload `{user_id:1, username:"xz", role:"admin", iat:1783170323, exp:1783177523}`
  - 有效期 2h，`exp=2026-07-04 15:05:23 UTC`，扫描时（2026-07-07）**已过期约 3 天**，事实风险归零
  - 远端 `103.242.3.87:3001` 本轮 out-of-scope（li-yiming msg=fa1caa7a "废弃处理" = 本轮不部署到线上；服务器仍活，访问治理由 @Orchestrator 承接，见 msg=a5297512 + 约束令 msg=b091c74d），无需 token 轮换（JWT 已自然过期 3 天）
  - QADocs pre-baseline gitleaks 命中该文件（`docs/refactor/baseline/security/gitleaks-pre.json`）
- **影响面**：
  - 只被 `verify.mjs` 引用（`grep -rn ".verify_token"` 全仓 → 唯一命中 `verify.mjs:5`）
  - `verify.mjs` 本身在 C-02 删，因此无遗留调用
- **git 历史**：首次引入 `f403964`（"ui: polish all workspace pages clarity + settings profile view" — token 混入无关 UI commit）；工作树本轮删，历史重写延后 Phase 0 密钥治理批（token 已过期 + 本轮不部署到线上 → 无实活风险）
- **DoD 自检**：
  - [x] 删前留据（本条）
  - [x] 保护 glob 零触碰（仓库根，非 quant/backtest/portfolio/ai）
  - [x] 已获用户确认（li-yiming msg=aa4a755c 授权 + msg=fa1caa7a 明确废弃）
  - [x] 独占检查（本轮只 Cleanup 动仓库根这 3 个孤儿路径）

## 批次 C-02 · `verify.mjs` 删除

- **变更**：删 `verify.mjs`（44 行 playwright 截图脚本）
- **依据**：
  - `BASE = 'http://103.242.3.87:3001'` 硬编码指向本轮 out-of-scope 的远端（服务器访问治理归 @Orchestrator，见约束令 msg=b091c74d）
  - 只输出到 `shots/` 目录（`OUT` 常量）；`shots/` 为空目录、未 tracked、随 C-01 gitignore 防御
  - 依赖已删除的 `.verify_token`（C-01）
  - 全仓 grep `verify\.mjs` → **零外部引用**（既无脚本调用、无 npm script、无文档链接）
  - 归属：孤儿工具产物，作者 QA 手工验证痕迹，非核心资产
- **影响面**：无（零调用链）
- **git 历史**：与 `.verify_token` 同一 commit `f403964`；工作树本轮删，历史与 token 同批延后 Phase 0
- **DoD 自检**：
  - [x] 删前留据
  - [x] 保护 glob 零触碰
  - [x] 独占检查

## Post-baseline 期望（交 @QADocs 验证）

`gitleaks detect --source . --log-opts=--all` 再跑，tracked+history 侧 `jwt` 命中数：
- 期望：**2 → 1**（`.verify_token` 从工作树消失，`.claude/settings.local.json` 历史 2 处保留 → 归 Phase 0 灰名单批）
- history 侧 `.verify_token` 仍在（filter-repo 延后 Phase 0）

## 后续（不本轮做）

- 灰名单：`.claude/settings.local.json`（2 处 JWT）→ Phase 0 单列决策
- 真实业务代码密钥嫌疑（`SystemTopologyMap.tsx:176` / `LabWorkspace.AdvancedQuantTab.tsx:747`）→ Phase 0 密钥治理批
- `scripts/deployment/*.js` 4 处 `generic-api-key` → 归 Research 待删清单
- `.env.example` / `env-validator.test.ts` fixture → Phase 0 内验证脱敏形式
- git filter-repo 历史重写 → Phase 0 密钥治理批统一执行
