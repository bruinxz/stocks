# Phase 6 — 新手主页 `/home` (2026-06-27)

## 用户原话

> "我是个股票的新手小白, 想要用这套系统来帮我自动化赚钱, 但是现在还是太复杂,
> 我还是用不起来, 所以我希望你的目标应该是能让新手小白用起来。"

## 设计意图

Phase 1-5 在 admin 5 workspace 里做减法 (菜单 8→5 / tab 37→15 / 视觉简化),
但**新手根本不该看 admin**。真正要解决的是把入口收到一个极简的新手主页 —
新手登录后只看一个页面, 操作不超过 3 步就能完成"日常自动化赚钱"。

设计目标 (一句话): **新手登录 → 看到 1 个页面 → 上面 3 件事 (今天该买什么 /
我有什么 / 我赚多少) → 每个动作 1 次点击搞定**。

## 页面结构 (`/home` 唯一一页, 无 tab 无侧栏)

```
┌────────────────────────────────────────────────────┐
│ Logo  我的投资                          我 ▼ ⚙(admin) │ ← 极简顶栏
├────────────────────────────────────────────────────┤
│  账户总值 ¥ 200,000.00                              │ ← 区块 1
│  今日 +0.00   累计 +0.00   可用 ¥0.00              │
├────────────────────────────────────────────────────┤
│  📈 今天 AI 推荐 (3 只)                  [刷新]    │ ← 区块 2
│  ① 中国卫星 sh.600118 ¥38.45 +2.3% [一键跟单 →] │
│  理由: 商业航天龙头, 朱雀三号催化                  │
│  AI 建议买入约 ¥5,000 (约 130 股)                  │
│  ... ② ③                                          │
├────────────────────────────────────────────────────┤
│  💼 我的持仓 (2 只)                                │ ← 区块 3
│  中国卫星 130 股 @ ¥38.10                          │
│  现价 ¥38.45  浮盈 +¥45.50 (+0.9%)  [一键卖出↓]  │
├────────────────────────────────────────────────────┤
│  • 当前仓位较轻 — 可关注上面的 AI 推荐, 单只 ≤ 5%  │ ← 区块 4 (动态提示)
└────────────────────────────────────────────────────┘
```

## 关键交互

### 一键跟单 (推荐 → 买入)

1. 用户点击「一键跟单」按钮
2. Modal.confirm 弹: "买入 中国卫星 130 股 (约 ¥5,000), 当前价 ¥38.45"
3. 用户点「确定买入」
4. `POST /api/paper-trading/trade` `{symbol, direction: 'BUY', quantity, portfolio_id}`
5. 成功 toast → 推荐卡片本地隐藏 → 账户区/持仓区刷新

**默认每单 ¥5,000** — 新手不需要填表, `yuanToShares()` 自动换 100 股整。

### 一键卖出 (持仓 → 全部卖出)

1. 用户点击「一键卖出」按钮
2. Modal.confirm 弹: "卖出全部 130 股, 预计 ¥4,998, 当前浮盈 +¥45.50"
3. 用户点「确定卖出」 (danger 红色)
4. `POST /api/paper-trading/trade` `{symbol, direction: 'SELL', quantity: 全部, portfolio_id}`
5. 成功 toast 含 `realized_pnl` → 账户区/持仓区刷新

## 路由变更

| 入口         | 旧 (Phase 5)        | 新 (Phase 6)                            |
| ------------ | ------------------- | --------------------------------------- |
| `/` 默认     | → `/workspace/today` | → `/home`                               |
| 登录 redirect | → `/dashboard`      | → `/home`                               |
| `*` 兜底     | → `/workspace/today` | → `/home`                               |
| `/home`      | (不存在)            | 新增 — HomeWorkspace 短路渲染            |

deep link 仍尊重 `location.state.from`, 任何 `/workspace/*` 路径未变.

## admin / 普通用户入口差异

| 角色   | 登录后 | 主菜单 (侧栏) | 进入 admin                         |
| ------ | ------ | -------------- | ---------------------------------- |
| admin  | /home  | 隐藏 (在 /home 短路下) | 右上 ⚙ 图标 → `/workspace/today` |
| 普通   | /home  | `mainMenuItems = []` (空) | 无入口 — /home 一页搞定           |

进入 admin 后, admin 仍能切回 `/home` (浏览器后退或直接输入).

## 复用的后端 API

**完全不加新接口**:

| Endpoint                         | 用途                          |
| -------------------------------- | ----------------------------- |
| `GET /api/today/signals`         | 账户 KPI (total_value / pnl) |
| `GET /api/today/v3-recommendations?limit=3` | top 3 AI 推荐       |
| `GET /api/paper-trading`         | 持仓列表                       |
| `POST /api/paper-trading/trade`  | 一键跟单 (BUY) / 一键卖出 (SELL) |

`getTodaySignals` 调用时传 `dragon_head_limit=0 / earnings_limit=0 / alerts_limit=0`
减少不必要的 candidate 负载, 只拿 `account` 字段.

## 不动的部分 (回归保护)

- **简易版** `/workspace/easy` + `EasyQuantWorkspace*` 8 文件 + `.eq-*` CSS 完整保留
- 简易版 contract test `frontend/tests/easy-quant-workspace-contract.test.js` **24/24 pass**
- admin 5 个 workspace 文件 (TodayWorkspace / PortfolioWorkspace / LabWorkspace /
  SettingsWorkspace / DataWorkspace + SystemWorkspace + FactorWorkspace) 全留
- 所有后端 API / 数据结构 / contract 未变

## 文件改动

| 文件                              | 改动        | 行数      |
| --------------------------------- | ----------- | --------- |
| `frontend/src/pages/HomeWorkspace.tsx` | 新建    | +530     |
| `frontend/src/index.css`          | 追加 .home-* | +268     |
| `frontend/src/App.tsx`            | 改动        | +37/-21   |
| `frontend/src/pages/Login.tsx`    | 改动        | +3/-1     |

总计 ~ 840 行净新增 (不含 build artifact).

## 视觉与交互细节

- **顶栏**: 56px 高, sticky, 白底 + 1px 下边框. Logo (BarChartOutlined +
  '我的投资'), 用户名 Dropdown 含个人中心/登出, admin 额外加 ⚙ 链接进 admin.
- **卡片**: 圆角 10px, 1px 边框, 无阴影 (Phase 5 极简风延续)
- **账户总值**: 28px 数字, 字符行距 1.2, 负数自动 A 股惯例红涨绿跌
- **一键按钮**: height 40px (比标准 32px 略大), borderRadius 8px, 主色填充
- **区块间距**: 24px gap, 卡片内 16-24px padding
- **响应式**: max-width 920px 居中, 推荐/持仓内部 flex-wrap 在窄屏自动堆叠

## 验证

```bash
cd frontend
npx tsc --noEmit         # 0 production error
npm run build            # compiled with (pre-existing) warnings
node tests/easy-quant-workspace-contract.test.js  # 24/24 pass
```

Bundle 影响:
- HomeWorkspace lazy chunk: ~ 12KB (单独 split, 仅 /home 路径加载)
- main.js: 919KB (与 Phase 5 基线持平 — 因为 HomeWorkspace lazy)

## 用户期望流程

1. 用户访问 `/` → 自动 redirect 到 `/login`
2. 登录 → redirect 到 `/home`
3. 看到「账户 / 推荐 / 持仓」3 区块
4. 选一只推荐 → 点「一键跟单」→ confirm → 1 秒后 toast「已买入 130 股」
5. 持仓区出现这只股 → 看到浮盈
6. 想卖 → 点「一键卖出」→ confirm → 1 秒后 toast「已卖出, 实现 +¥45.50」

全流程 admin / 简易版 / 实验室 / 设置一概不出现 — 新手只需要看一页.

## 后续可扩展

(本批不做, 留给后续验证用户反馈再决定)

- 推荐区显示更多上下文 (置信度 tier / 行业 / 信号年龄)
- 持仓区加止损止盈一键设置
- 区块 4 提示接入 risk profile 真模型 (现在是 cash% 启发式)
- /home 支持移动端 (响应式已基础, 但未做触摸优化)
