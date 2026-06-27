# Design System 2026-06-27 (Phase 5 — Visual Redesign)

## 选定方向: **B — 极简专业 (Linear / Notion + 金融数据感)**

为什么选 B, 不选 A (Bloomberg 暗色) 也不选 C (东财红绿):
- **A 暗色金融终端**: 视觉冲击最强但与登录后整套已有的浅色 antd 表格/Modal/Form 强烈冲突, 改造范围会蔓延到 200+ 组件 — 当前 PR 周期 (单次提交) 控制不住。同时简易版 (已交付方向) 是浅色暖色风, 一登录一暗一暖更分裂。
- **C 东财红绿**: 用户已经经历"简易版被外包做成暖纸色而不满"。再倒回去走熟悉的中股零售配色, 会失去"专业 quant 工具"的品牌位置。
- **B 极简专业**: 用一个收敛的中性 + 单一冷色强调 + 黄金比例字号梯度 + 等宽数字, 既能在"无暗色"前提下做出 Linear/Notion 的克制感, 又能用 tabular mono 立刻把价格/百分比的"数字感"撑起来。这是当前代码与品牌位置同时能落地的最优解。

## 一句话品牌定位
"安静的金融工作台" — 信息密度第一, 装饰为零, 单色立秩序, 数字立专业。

---

## 核心 Tokens (全部进 `frontend/src/index.css :root` + `App.tsx ConfigProvider theme.token`)

### 色板 — 从 8 色降到 5 色
| token              | 值          | 用途                                  |
| ------------------ | ----------- | ------------------------------------- |
| `--brand`          | `#4338ca`   | 主操作 / 主选中 / 链接 (indigo 700)   |
| `--brand-soft`     | `#eef2ff`   | 选中行/选中卡片背景                   |
| `--up`             | `#dc2626`   | 涨 (A 股惯例 — 红涨)                  |
| `--down`           | `#16a34a`   | 跌                                    |
| `--warn`           | `#d97706`   | 警告 / 待处理                         |
| (已删) `--secondary-accent / --quant-gold / 蓝灰多色派系` | | |

### 中性色 — 7 档
| token            | 值         | 用途                          |
| ---------------- | ---------- | ----------------------------- |
| `--bg-canvas`    | `#f8fafc`  | 页面底色 (slate-50)           |
| `--bg-surface`   | `#ffffff`  | 卡片 / 表格 / Modal 表面      |
| `--bg-subtle`    | `#f1f5f9`  | hover / 二级容器              |
| `--border`       | `#e2e8f0`  | 默认 border (slate-200)       |
| `--border-strong`| `#cbd5e1`  | 强调 border / divider         |
| `--ink-1`        | `#0f172a`  | 主文本 (slate-900)            |
| `--ink-2`        | `#475569`  | 次文本 (slate-600)            |
| `--ink-3`        | `#94a3b8`  | 三级 / 占位 / 标签 (slate-400)|

### 字号 — 5 档黄金比例 (1.25 modular scale)
| token          | 值     | 用途                                |
| -------------- | ------ | ----------------------------------- |
| `--font-xs`    | `12px` | Tag / 二级 label / 表格头           |
| `--font-sm`    | `13px` | body 文本默认                       |
| `--font-md`    | `15px` | section title / 强调 body           |
| `--font-lg`    | `20px` | workspace title / card title        |
| `--font-xl`    | `28px` | KPI 数字 (混合 tabular mono)        |

字体栈:
- `--font-sans`: `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif`
- `--font-mono`: `'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace`
- `font-feature-settings: 'tnum' 1` 默认全局打开 — 数字等宽对齐免布局抖动。

### 间距 — 4 档
| token         | 值     |
| ------------- | ------ |
| `--space-1`   | `4px`  |
| `--space-2`   | `8px`  |
| `--space-3`   | `16px` |
| `--space-4`   | `24px` |

### 圆角 — 2 档
| token         | 值     | 用途                |
| ------------- | ------ | ------------------- |
| `--radius-1`  | `6px`  | Input / Button / Tag|
| `--radius-2`  | `10px` | Card / Modal / 表格 |

### 阴影 — 2 档
| token         | 值                                       | 用途                          |
| ------------- | ---------------------------------------- | ----------------------------- |
| `--shadow-1`  | `0 1px 2px rgba(15, 23, 42, 0.04)`       | 默认卡片 (subtle)             |
| `--shadow-2`  | `0 4px 16px rgba(15, 23, 42, 0.08)`      | 浮层 (Dropdown / Drawer / Modal) |

(已删: `--shadow-medium / --shadow-card / --shadow-floating / --shadow-soft` 4 档 + 所有 gradient 装饰背景)

---

## 5 个核心组件的设计意图

### 1. WorkspaceLayout shell
- **KPI bar 改为自适应高度** (`min-height: 56px`, 不再固定 96px), 标题 / KPI 在同一行水平居中, 标题与 KPI 之间用 `border-left: 1px solid var(--border)` 立分隔。
- **左侧 tabs rail 从 220px 减到 180px**, 取消 antd Menu 圆角胶囊, 改为 `border-left: 2px solid transparent` (选中时变 `--brand`)。
- **去掉外层 gradient + radial-gradient 装饰背景**, 整个 modern-layout 改为 `--bg-canvas` 纯色。
- **modern-sider 从胶囊圆角浮岛改为纯白 + 1px 右 border**, 与内容区共面, 信息密度立刻提高。
- **modern-header 去除毛玻璃 + 装饰渐变 + 圆角胶囊**, 高度从 64px 降到 56px, 仅留底部 1px border。

### 2. KPI / Statistic 数字
- Statistic 的 `value` slot 全局接管 `font-family: var(--font-mono); font-variant-numeric: tabular-nums;` — 价格 / 百分比 / 数量在表格 / KPI / Modal 内永远等宽不抖。
- 字号 `--font-xl (28px)`, 不再让 antd 默认 24px 把多个数字挤糊。

### 3. Table
- header 灰底 (`#f7f1e7` 老暖色) 改为 `--bg-subtle`, header 字号 12, 字色 `--ink-2`, 字重 600。
- 行 hover 从老暖色 `#fbf7ef` 改为 `--brand-soft`。
- 表格圆角从 14 降到 10, 与 Card 一致。
- 单元格 padding 紧凑化 (默认 16/16 → 12/16) — 信息密度优先。

### 4. Tag (涨跌 / 状态)
- 不再用 antd Tag 的圆框边线 + 内填色 8 种, 改为 `border: none; background: var(--bg-subtle); color: var(--ink-2); border-radius: var(--radius-1); padding: 2px 8px; font-size: 12px;`。
- 涨跌专用 `up-text/down-text` class: `color: var(--up/down); font-weight: 600;` — 纯文字 + 颜色, 无背景, 让数字本身说话。

### 5. Card
- 默认 `box-shadow: var(--shadow-1)` + `border: 1px solid var(--border)`, 圆角统一 `--radius-2 (10px)`。删除原本 14/20/28 三档大圆角混杂。
- Card title 字号 `--font-md`, 字重 600, padding 上下 14px (从 16 紧凑) — workspace 内一屏可见更多卡片。

---

## 装饰删除清单
1. `index.css` 中所有 `radial-gradient` (8 处) — 包括 `--gradient-page / --gradient-brand / --gradient-soft / modern-sider-inner / modern-logo .logo-icon / .modern-layout::after / 各 workspace 内联`。
2. 所有 `box-shadow` 中 `inset 0 1px 0 rgba(255,255,255,...)` 高光层 (假玻璃光泽)。
3. modern-sider 的胶囊圆角 (radius-xl 28px) → 0 圆角直边。
4. modern-header 毛玻璃 (`backdrop-filter: blur(20px)`) → 实心白底。
5. header-user-dropdown 的渐变 + 阴影胶囊 → 纯文字 + hover 灰底。
6. logo-icon 的 indigo→cyan 渐变方块 → 纯 `--brand` 单色方块。

## bundle 影响预期
- index.css 净减少 (gradient / shadow 长度 + 重复 token), 预计 -3 ~ -5KB。
- JS 无变化 (仅 token 引用)。
- 不引入新字体 lib, JetBrains Mono / IBM Plex 全部走原有 Google Fonts (实际 Mono 也保留用作 --font-mono, 但 Sans 改为 system stack — 起码砍掉 IBM Plex Sans 4 weight, 节省首屏 ~80KB 字体下载)。
