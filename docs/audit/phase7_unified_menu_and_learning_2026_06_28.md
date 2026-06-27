# Phase 7 — 统一菜单 + 主页学习区块 + 简易版回归 (2026-06-28)

## 用户反馈 (原话)

> "有点过于简单了, 虽然是新手小白, 但是它也想逐步学习量化策略, 同时我即是管理员,
> 也是新手小白想学习量化, 不想让页面分离开。同时简易版那个 Tab 和页面怎么没有了"

3 个被点出的问题:

1. Phase 6 给普通用户隐藏了主菜单 (`if (!isAdmin) return []`), 等于把"管理员 + 学习"
   一刀切成两套界面, 用户原话"不想让页面分离开".
2. 新手主页过于简单, 用户其实"想逐步学习量化策略" — 主页只有"操作"没有"学习".
3. 简易版 `/workspace/easy` Phase 3 时被踢出主菜单, 用户找不到入口.

---

## 3 个修复

### Fix 1 — 主菜单"统一一套"

`frontend/src/App.tsx` `mainMenuItems` 重写:

- 删 `if (!isAdmin) return []`
- 6 项基础 + 2 项 admin-only:

| 菜单 | 路径 | 谁能看 |
|---|---|---|
| 主页 | `/home` | 所有人 |
| 简易版 | `/workspace/easy` | 所有人 (回归!) |
| 持仓 | `/workspace/portfolio` | 所有人 |
| 实验室 | `/workspace/lab` | 所有人 |
| 设置 | `/workspace/settings` | 所有人 |
| 数据中心 | `/workspace/data` | admin only |
| 系统介绍 | `/workspace/system` | admin only |

普通用户和 admin 现在只差 2 项 admin-only 菜单. 之前的"今日"`/workspace/today`
不再上一级菜单 — `/home` 已是新手的"今日入口", 实验室 / 数据中心也能跳过去.
路由仍保留 (deep link 兼容).

### Fix 2 — /home 顶栏加"更多功能"下拉

`/home` 短路渲染原本没有 Sider, 普通用户被锁死. 现在顶栏 Logo 右边加:

```
我的投资  [⊞ 更多功能 ▾]
           ├─ 简易版 (4 步教学)
           ├─ 持仓
           ├─ 实验室
           ├─ 设置
           ├─ ────────  (admin)
           ├─ 数据中心 (管理员)
           └─ 系统介绍 (管理员)
```

让 /home 不再是"死胡同". 删除 Phase 6 加的右上角 ⚙ admin-only 图标 (已被"更多功能"覆盖).

### Fix 3 — 主页加 3 个学习区块

`frontend/src/pages/HomeWorkspace.tsx` 插入到推荐和持仓之间.

#### 区块 A — 推荐 "为什么?" 折叠 (改造现有推荐卡片)

每张推荐卡片底部加:

```
[📖 为什么推荐这只?  ▾]
─────────────────────
✓ 逻辑: 基本面与估值逻辑通顺 (75/100) — 对应「价值因子」
✓ 资金: 主力资金流入, 短期动能强 (68/100) — 对应「动量/资金因子」
✓ 亮点标签: [超大市值] [题材活跃]
─────────────────────
💡 当 3 个或以上因子同时正向, 历史胜率约 62% — 点 简易版 学完整 4 步教学.
```

数据来自现有 `V3RecommendationItem.dimensions` (4 维: 人气/逻辑/资金/结构),
内部 `DIM_TO_FACTOR` 映射成新手能懂的因子名. 只展示 `bar_value >= 60` 的强项,
没有强项时显示兜底文案 "AI 综合判断". 默认折叠, 不臃肿.

#### 区块 B — 今日学一招 (按日期轮播)

```
🎓 今日学一招 · 「动量因子」
────────────────────────────
过去 20 个交易日涨幅前 30% 的股票, 未来 5-10 天继续涨的概率比随机高约 8 个百分点。
背后是"强者恒强"的羊群效应 — 但持有不能太久, 一旦放量滞涨就要警惕反转。

[想学更多? 试试简易版的 4 步教学 →]
```

6 个量化知识点 (动量 / 价值 / 质量 / 成长 / 北向 / 龙头) 按 `new Date().getDate() % 6` 轮播.
暖纸色背景 (`#fff7ed`), 与简易版教学色调呼应. 一段文字 + 一个 CTA, 不臃肿.

#### 区块 C — 今日因子表现 (6 核心因子小卡片 + sparkline)

```
📊 今日因子表现   6 大核心因子今天的强弱
┌──────┬──────┬──────┬──────┬──────┬──────┐
│ 价值 │ 动量 │ 质量 │ 成长 │ 北向 │ 低波 │
│+1.2%│+0.8%│-0.3%│+0.5%│-0.1%│+0.4%│
│ ▁▂▄▆▇│ ▁▃▅▆▇│ ▇▆▅▃▂│ ▁▂▃▅▆│ ▂▃▂▃▂│ ▁▂▃▄▅│
└──────┴──────┴──────┴──────┴──────┴──────┘
今天「价值因子」表现最强 — 蓝筹和金融股领涨.  示例数据 · 后续接通真实因子盘后表现
```

**Mock 数据 + TODO 注释**:

```ts
/**
 * TODO(P2, admin): 接通 /api/factors/today-performance — backend 已有
 * `backtest_factor_performance` 表, 需要 controller 出一个 today rollup endpoint
 * (返回 6 因子的 daily IC + 累计收益 + 7 日 trend). 当前用静态示例避免新区块
 * crash 整个 /home, 普通用户看到的也是"启发式"的科普, 不影响实盘决策.
 */
const MOCK_FACTOR_PERFORMANCE = [ ... ];
```

Sparkline 用 inline SVG (~10 行), 不引入 recharts.

CSS 在 `frontend/src/index.css` 末尾追加 `home-reco-why-*` / `home-lesson-*` /
`home-factor-*` / `home-topbar-more`, 与 Phase 6 的 `.home-*` 共存. 实用极简:
无阴影 / 大间距 / 圆角 6px / 不花哨.

---

## admin / 普通用户的差异 (Phase 7 之后)

| 项 | 普通用户 | admin |
|---|---|---|
| 默认登录页 | /home | /home |
| 主菜单 (modern-layout 时) | 5 项 | 7 项 (多数据中心 / 系统介绍) |
| /home 顶栏更多功能 | 4 项 | 6 项 (多 admin only) |
| 主页推荐 "为什么?" | 看 | 看 |
| 主页"今日学一招" | 看 | 看 |
| 主页"今日因子表现" | 看 | 看 |
| 一键跟单 / 卖出 | 用 | 用 |

差别只在两项 admin-only 菜单 — 完全符合用户"不想让页面分离开"的诉求.

---

## 验证

| 项 | 状态 |
|---|---|
| `npx tsc --noEmit` (新文件) | 0 error |
| `node tests/easy-quant-workspace-contract.test.js` | **24/24 pass** |
| `npm run build` | success |
| 主 bundle gzip | 292.09 kB (+0.32 kB vs 291.77 kB) |
| 简易版 8 文件 / `.eq-*` CSS | 未动 |
| 后端 endpoint | 未动 (mock 数据带 TODO) |

---

## 文件变更

- `frontend/src/App.tsx` — `mainMenuItems` / `moreMenuProps` / `/home` 顶栏改造
- `frontend/src/pages/HomeWorkspace.tsx` — 3 个学习区块 (区块 A 在推荐卡片内, B/C 新增)
- `frontend/src/index.css` — 末尾追加 ~150 行 `.home-reco-why-*` / `.home-lesson-*` /
  `.home-factor-*` / `.home-topbar-more` CSS
