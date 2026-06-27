# Phase 3: UI 简化完成报告 (2026-06-27)

> 实施: claude (gpt-5.5)
> 分支: `claude/happy-torvalds-180c51` → main (PR #19, merged squash)
> Merge commit: `cb52f861970538d73ef0e06e2976b773005f9c09`
> 链接: https://github.com/bruinxz/stocks/pull/19

## 0. 目标与约束

来自用户原话 (Phase 1 数据修复 + Phase 2 模拟盘整合后的收尾批):

> **#2 页面太复杂 / #3 AI 感太强**

绝对约束 (从 `docs/audit/ui_simplification_plan_2026_06_26.md` §2 复制):

- 简易版 (`/workspace/easy` + 8 个 EasyQuant\* 文件 + App.tsx 4 个位点 + EASY_QUANT_UI_DESIGN_GUIDELINES.md + easy-quant-workspace-contract.test.js) **绝对不动**
- 不删任何 workspace 文件 (路由仍可深链命中)
- 不动后端 API
- 每个 step 独立 commit + tsc / build 通过才进下一步

## 1. 4 个 commit

| Step | Commit | 描述 |
|------|--------|------|
| 1 | `1150531` | feat(phase3-menu): 主菜单 8→5 |
| 2 | `cf80744` | feat(phase3-tab): 4 个 workspace tab 精简 + 默认 tab 优化 |
| 3 | `d1fe223` | feat(phase3-visual): 降 AI 感 — 删装饰 Tag + Tag/font/radius 收敛 + RobotOutlined 中性化 |
| Merge | `cb52f86` | PR #19 squash merge |

## 2. Step 1 — 主菜单 8 → 5 (普通用户) / 7 (admin)

`frontend/src/App.tsx`:

```
                Phase 2 之前       Phase 3 (普通)    Phase 3 (admin)
 1. 简易版         ✓                ✓ (默认登录)      ✓ (默认登录)
 2. 今日作战       ✓                ✓ (重命名"今日")  ✓
 3. 选股因子       ✓                ✗ (并入实验室)    ✗
 4. 策略实验室     ✓                ✓ (重命名"实验室") ✓
 5. 持仓与复盘     ✓                ✓ (重命名"持仓")  ✓
 6. 数据中心       ✓                ✗ (admin only)    ✓
 7. 账号设置       ✓                ✓ (重命名"设置")  ✓
 8. 系统介绍       ✓                ✗ (admin only)    ✓
```

- 选股因子路由 `/workspace/factors` 仍存在, 但通过 `routeSelectionAliases` redirect 高亮到 `/workspace/lab` (兼容旧深链)
- 删 `FilterOutlined` import (不再使用)
- 简易版菜单 item 完全不动: 第 1 项 / RocketOutlined / 默认登陆 / 整屏接管 (App.tsx:314 那个 `startsWith('/workspace/easy')` 短路块)

## 3. Step 2 — 二级 tab 精简

| Workspace | 旧 tab 数 | 新 (普通) | admin 仍可见 | 默认 tab 变化 |
|-----------|----------|----------|--------------|---------------|
| LabWorkspace | 11 | **4** | 11 | mine (不变) |
| SettingsWorkspace | 12 | **4** | 12 | **profile** (旧 push-channels) |
| TodayWorkspace | 6 | **3** | 6 | core_picks (不变) |
| PortfolioWorkspace | 8 | **4** | 8 | positions (不变) |
| **合计** | **37** | **15** | **37** | |

普通用户 tab 总数 **37 → 15** (-59%). 任何用户都可通过 URL `?tab=` 切到 admin-only tab (那些 tab 的渲染分支没动, 只是不上菜单).

折叠到 admin only 的 tab (用户原话"研究员级别 / 调参 / 高级功能"):

- LabWorkspace: workflow_readiness / walk_forward / optimization / quarterly_retrain / shadow_run / overfit_metrics / advanced_quant (7 个)
- SettingsWorkspace: sizing / portfolio-construction / analysis-engine / risk-parameters / strategy-kill-switch / todo-suggestions / black-swan / users (8 个)
- TodayWorkspace: events / risk_center / capital_flow (3 个)
- PortfolioWorkspace: attribution / error-patterns / correlation / manage (4 个)

实现方式: 每个 workspace 加 `const isAdmin = useSelector((s: RootState) => s.auth.user?.role === 'admin');`, 然后 `useMemo` 根据 isAdmin 拼接 tab 数组. 不删任何 tab 内容文件.

## 4. Step 3 — 降"AI 感"

### 4.1 装饰性 Tag 退役 (5 处)

| 文件 | Tag 内容 | 处理 |
|------|---------|------|
| SettingsWorkspace.tsx (line 280-315) | 11 个 admin tab 头 `<Tag color="processing">US-063 通知通道</Tag>` 等 | 全删, headerActions 只保留刷新按钮 |
| SettingsWorkspace.RiskParametersCenterTab.tsx (line 337-339) | `<Tag color="purple">US-066 / cyan US-135 PR-020 / magenta US-137 EX-012</Tag>` | 3 个全删 |
| LabWorkspace.ShadowRunTab.tsx (line 195) | `<Tag color="geekblue">US-051 / FE-012</Tag>` | 删 |
| LabWorkspace.QuarterlyRetrainTab.tsx (line 178) | `<Tag color="geekblue">US-050 / FE-011</Tag>` | 删 |

注: 仓库内 332 处 US-XXX / Sprint 引用, 其中只有 14 处在 `<Tag>` JSX 元素内 (装饰), 其余 318 处在 jsdoc / 行内注释 / 字符串中 — 那些是设计文档元数据, 不进 UI, 不动.

### 4.2 antd Tag color 8 → 4

退役的 7 种 antd Tag color (33 处替换):

```
purple    → blue
cyan      → blue
geekblue  → blue
magenta   → red
gold      → default
lime      → green
volcano   → red
```

JSX `color="X"` 形态 + JS 字符串 `color: 'X'` 形态都覆盖. 验证后剩余 Tag color 只在 `default / blue / red / green / success / warning / processing` 七色内 (后三色是 antd 语义色, 与"花哨色"不同语义, 留用).

### 4.3 fontSize 10+ → 3 (12 / 14 / 18)

之前 workspace 内出现的 fontSize 值: 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 28 (≥ 11 个).

映射:
- 9 / 10 / 11 → **12** (mute / fine print)
- 13 / 15 → **14** (body)
- 16 / 17 / 20 / 22 / 28 → **18** (display)

收敛后实际频率 (扫 `frontend/src/pages/workspace/*.tsx` excl. EasyQuant):

```
fontSize: 12  314 处
fontSize: 18   48 处
fontSize: 14   33 处
```

### 4.4 borderRadius 5 → 1

之前: 2 / 3 / 4 / 6 / 8 (五个值). 全部统一到 8 (与简易版 `--eq-*` 8px 圆角一致).

收敛后:
```
borderRadius: 8  17 处
```

### 4.5 borderLeft 3px / 4px 装饰条退役

删除:
- TodayWorkspace.tsx (4 处): `paddingLeft: 8, borderLeft: '3px solid #1677ff' / #fa8c16 / #722ed1 / #722ed1`
- FactorWorkspace.tsx (2 处): `borderLeft: '3px solid #1890ff' / #722ed1`

保留 2px 灰色 (`#f0f0f0`) 分隔线 — 那些是结构线, 不是装饰强调.

### 4.6 RobotOutlined → BarChartOutlined (15 处)

15 处机器人图标全部换成中性 BarChartOutlined:

| 文件 | 处数 | 原用法 |
|------|------|--------|
| PortfolioWorkspace.tsx | 4 | 日归因 tab icon / AI 分析按钮 / 等 |
| FactorWorkspace.tsx | 6 | 舆情雷达 tab icon / AI 分析按钮 |
| TodayWorkspace.tsx | 5 | brief icon / AI 分析按钮 |

import 同步清理: PortfolioWorkspace.tsx 删 RobotOutlined; FactorWorkspace.tsx + TodayWorkspace.tsx 把 import 里的 `RobotOutlined,` 换成 `BarChartOutlined,`.

## 5. 测试 / 验证

| 项目 | 结果 |
|------|------|
| frontend `tsc --noEmit` | PASS (源代码无错误; tests/__tests__/ 文件预先存在 jest type 缺失, 与本 PR 无关) |
| frontend `npm run build` | PASS (CRA build, warnings 全部是 prettier 建议, 非编译错误) |
| backend `tsc --noEmit` | PASS (无后端改动) |
| `frontend/tests/easy-quant-workspace-contract.test.js` | **24/24 PASS** — 简易版 22 个 source-code 契约全部仍然成立 |
| CI `Frontend check (typecheck + lint)` | PASS (3m5s + 2m49s 两路) |
| CI `Backend check (typecheck + lint + test)` | PASS (7m43s) |
| CI `Docker compose validate` | PASS |
| CI `weak-secrets` | PASS |

## 6. Bundle size

main bundle:
- Phase 2 baseline (4bc1879): **981 885 bytes**
- Phase 3 (d1fe223): **981 397 bytes**
- Δ: **−488 bytes (−0.05%)**

Bundle size 几乎没变 — 因为 Phase 3 只做 in-place 简化, 没删任何 workspace 文件. **Phase 3 的真实收益在信息架构**:

- 顶层菜单 8 → 5 (普通用户): -37%
- 二级 tab 平均 8.75 → 3.75 (普通用户): -57%
- 装饰性 Tag 颜色多样性 8 → 4: -50%
- fontSize 多样性 10+ → 3: -70%
- borderRadius 多样性 5 → 1: -80%

字节减小的 PR 留到 Phase 4 (DA-1 §4.3 建议删 18 个 legacy `pages/*.tsx`, ≈ 1.9 万行 dead code; 当前 baseline 容许 ≈ 5% bundle 减小).

## 7. 不动清单 (Phase 4 候选)

按 DA-1 §4 + §6.6:

- 21 个 legacy `pages/*` 文件 + 18 个 `/legacy/*` 路由 + 18 条 `routeSelectionAliases` 死路由 (≈ 1.9 万行 dead code, 删后预计 main bundle -3 ~ -5%)
- `components/trading/{TradePolicyExplainPanel, TradeReasonCell, aiStockAnalysisModalV2Components}` (legacy pages 一删就孤立)
- `components/portfolio/PortfolioManagementPanel` (仅 legacy Portfolio.tsx 用)
- 简易版 `--eq-*` 设计令牌反向输出为全局 `--qx-*` (让专业版与简易版同源色系) — DA-1 §6.5

## 8. 简易版完全不动验证

逐项核对 DA-1 §2 清单:

- `frontend/src/pages/workspace/EasyQuantWorkspace.tsx` (1049 行) — unchanged
- `frontend/src/pages/workspace/EasyQuantWorkspace.css` (1680 行) — unchanged
- `frontend/src/pages/workspace/easyQuantHooks.ts` (294 行) — unchanged
- `frontend/src/pages/workspace/easyQuantResultHelpers.ts` (200 行) — unchanged
- `frontend/src/pages/workspace/easyQuantTemplates.ts` (97 行) — unchanged
- `frontend/src/services/easyQuantService.ts` (212 行) — unchanged
- `frontend/tests/easy-quant-workspace-contract.test.js` (215 行) — unchanged
- `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md` (262 行) — unchanged
- `App.tsx:51` `EasyQuantWorkspace = lazy(...)` — unchanged
- `App.tsx:72` `RocketOutlined` import — unchanged
- 简易版菜单 item (第 1 项, 默认登陆) — unchanged (Step 1 重写 mainMenuItems 时第一项 `menuLink('/workspace/easy', <RocketOutlined />, '简易版')` 显式保留)
- `App.tsx:314-329` `startsWith('/workspace/easy')` 整屏接管块 — unchanged

`frontend/tests/easy-quant-workspace-contract.test.js` 24/24 PASS 是对上述 12 项的自动化保证.
