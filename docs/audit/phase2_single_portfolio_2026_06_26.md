# Phase 2 完成报告: 模拟盘 21 → 1 (综合策略主盘)

**日期**: 2026-06-27
**分支**: `claude/happy-torvalds-180c51`
**Master plan**: [docs/audit/simplification_master_plan_2026_06_26.md](./simplification_master_plan_2026_06_26.md) Phase 2
**勘探基础**: [docs/audit/portfolio_consolidation_2026_06_26.md](./portfolio_consolidation_2026_06_26.md) (DA-0)

---

## 1. 目标 + 范围

用户原话: **"把模拟盘缩减到一个, 不要有数量概念"**

Phase 2 做到 3 件事:
1. **DB 层** 新建 1 个 '综合策略主盘', 关闭其余 20 个旧盘 (16 active 实跑盘 + 4 Agent 空盘)
2. **FE 层** PortfolioManagementPanel 的破坏性操作 (新建 / 编辑 / 重置 / 删除) 加 admin guard
3. **不动**: `/workspace/easy` 简易版任何文件; 不删任何 portfolio row; 不平任何持仓

## 2. 综合策略主盘配置

| 字段 | 值 |
|------|------|
| `name` | `综合策略主盘` |
| `user_id` | 4 (`stock`, prod 实际跑 PaperTradingAutomation 的系统账号) |
| `initial_capital` | 200,000 |
| `is_active` | true |
| `auto_trade_enabled` | true |

### 2.1 strategy_keys (10 个, DA-0 推荐)

```
bollinger_reversion, rsi_reversion, left_side_reversal, trend_pullback_reentry,
dual_momentum_rotation, cta100_momentum, sector_rotation_leader, relative_strength_momentum,
volume_price_confirmation, dragon_head_momentum
```

**弃用** (DA-0 数据驱动): `multi_factor_alpha`, `multi_factor_ranking`, `breakout_*`, `turtle_*`, `low_volatility_quality`, `garp_strategy`, `high_dividend_value`, `quality_momentum_blend`, `donchian_trend`, `ma_trend`, `macd_trend`, `minervini_trend_template` — 这些策略在过去 16 天 0 胜率, 全部贡献亏损卖出.

### 2.2 enabled_factors (22 个, 不裁剪)

```
value, quality, quality_high, growth, momentum, momentum_reversal,
low_vol, liquidity, money_flow, northbound, dragon_tiger,
analyst_consensus, earnings_surprise, fund_consensus, industry_momentum,
gradual_breakout, insider_trade, margin_flow, east_money_qa,
shareholder_concentration, block_trade_signal, concept_heat
```

DA-0 证实 17 个盘共享同一 22 因子集, **无独家因子优势** — 因子是 ranking 输入, 不直接产 trade. 当前问题是 strategy 阈值, 不是因子集.

### 2.3 risk_profile_overrides (DA-0 数据驱动升级)

| 参数 | 旧 (user 级) | 新 (主盘 override) | 依据 |
|------|--------|---------|------|
| `stop_loss_percent` | 5 | **6** | DA-0: 99 笔 5% 硬止损全亏 -11,085 元 |
| `take_profit_percent` | 10 | **12** | 拉长收益跑道 |
| `trailing_stop_pct` | — | **4** | DA-0: trailing_take_profit 是唯一净正退出 (4 胜/6 负, 净 +37) |
| `single_stock_max_weight` | 0.15 | **0.10** | DA-0: #36/40 持有 4 只时单票过大 |
| `max_industry_weight` | 0.40 | **0.30** | 避免行业过度集中 |
| `max_positions` | — | **8** | 提升分散度 |
| `drawdown_breaker` | — | **{threshold_pct:3, cooldown_days:2}** | CB-4 DrawdownCircuitBreaker 已实现 |

## 3. 关闭的 20 个旧盘

| id | name | owner | total_value | 备注 |
|----|------|-------|-------------|------|
| 25 | Codex纯量化模拟盘 | lym | 198,953.65 | 0% 胜率 |
| 26 | Codex参数实验模拟盘 | lym | 199,467.21 | 0% |
| 27 | Codex趋势突破模拟盘 | lym | 198,722.10 | 0% |
| 28 | Codex动量轮动模拟盘 | lym | 199,806.94 | 22% (并列冠军) |
| 29 | Codex均值回归模拟盘 | lym | 199,749.64 | **25% (DA-0 综合最佳)** |
| 30 | Codex多因子质量模拟盘 | lym | 199,446.99 | 0% |
| 31 | Codex低波防守模拟盘 | lym | 199,049.98 | 0% |
| 32 | Codex量价确认模拟盘 | lym | 199,531.90 | 11% |
| 33 | Codex纯量化模拟盘 | stock | 199,395.28 | 0% |
| 34 | Codex参数实验模拟盘 | stock | 199,438.28 | 0% |
| 35 | Codex趋势突破模拟盘 | stock | 199,072.99 | 14% |
| 36 | Codex动量轮动模拟盘 | stock | 198,599.80 | 0% |
| 37 | Codex均值回归模拟盘 | stock | 200,079.04 | **12% (唯一正收益)** |
| 38 | Codex多因子质量模拟盘 | stock | 199,437.24 | 0% |
| 39 | Codex低波防守模拟盘 | stock | 199,378.39 | 12% |
| 40 | Codex量价确认模拟盘 | stock | 198,514.71 | 0% |
| 61 | Codex自主荐股模拟盘 | stock | 200,000.00 | Agent 空盘 |
| 62 | Codex量化Agent融合模拟盘 | stock | 200,000.00 | Agent 空盘 |
| 63 | Codex Agent独立模拟盘 | stock | 200,000.00 | Agent 空盘 |
| 64 | Codex自主荐股模拟盘 | lym | 200,000.00 | Agent 空盘 |

`is_active=false` + `auto_trade_enabled=false`. 历史 trades / snapshots / positions **全部保留**, 旧盘所有持仓**不平**, 用户可通过 admin "include_inactive" 入口查归档.

`#24 系统观测盘` 已是 is_active=false, 不动.

## 4. 代码改动

### 4.1 后端 (5 文件新增)

| 文件 | 用途 |
|------|------|
| `backend/scripts/ops/phase2_create_master_portfolio.sql` | 新建综合主盘 SQL (psql 路径) |
| `backend/scripts/ops/phase2_create_master_portfolio_rollback.sql` | 反向: 删综合主盘 (要求 0 trade) |
| `backend/scripts/ops/phase2_close_legacy_portfolios.sql` | UPDATE 关闭 20 旧盘 SQL |
| `backend/scripts/ops/phase2_close_legacy_portfolios_rollback.sql` | UPDATE 恢复 20 旧盘 is_active=true |
| `backend/scripts/ops/phase2_run_consolidation.ts` | 节点 runner — 包裹 create + close 在 1 事务 (因 prod ops/deploy 账号无 psql) |

### 4.2 前端 (1 文件改)

`frontend/src/components/portfolio/PortfolioManagementPanel.tsx` (+63 / -36):
- import `useSelector` + `RootState`, 读取 `auth.user.role === 'admin'` → `isAdmin`
- '新建模拟盘' 按钮 wrap in `{isAdmin && ...}`
- 列表行操作: '编辑' / '重置' / '删除' 3 个按钮 wrap in `{isAdmin && ...}`
  → 普通用户只能 '查看详情' (Drawer 净值曲线 + 最近 trades)
- 普通用户看到一条 warning Alert: "Phase 2: 已统一为综合策略主盘, 新建/编辑/重置/删除 仅管理员可见"
- 空列表 emptyText 区分 admin / 非 admin 文案

### 4.3 不需要动的

- `frontend/src/components/layout/GlobalPortfolioSelector.tsx` — 已有逻辑 `portfolios.length === 1` 显示 Tag 而非下拉, 单盘场景天然生效
- `frontend/src/contexts/PortfolioContext.tsx` — 列表为 1 时自动 fallback 到 `list[0]`, 自动选盘
- `backend/src/api/...` — list 端点默认 `is_active=true` 过滤 (`PaperTradingPortfolioCrudService.listForUser` opts.include_inactive=false), 关闭旧盘后自动只返 1 个

## 5. 部署步骤 (PR merge 后)

### Step A: 后端 deploy hook 自动重启

PR merge → `bash scripts/deployment/deploy_remote_build.sh main main`:
```bash
SKIP_DB_BACKUP=true SKIP_HEALTH_GATE=true bash scripts/deployment/deploy_remote_build.sh main main
```
(详见 [deploy-remote-build-pitfalls](/Users/bytedance/.claude/projects/-Users-bytedance-go-src-github-com-bruinxz-stocks/memory/deploy-remote-build-pitfalls.md))

### Step B: ops 一次性跑 consolidation

deploy 完成后 (新 `phase2_run_consolidation.js` 已经在 `/opt/stocks/current/backend/dist/scripts/ops/`):
```bash
# 1. dry-run 看 plan
ssh -o IdentitiesOnly=yes -i ~/.ssh/crp_prod_deploy_103_242_3_87 -p 14126 deploy@103.242.3.87 \
  "cd /opt/stocks/current/backend && node dist/scripts/ops/phase2_run_consolidation.js"

# 2. 真改
ssh -o IdentitiesOnly=yes -i ~/.ssh/crp_prod_deploy_103_242_3_87 -p 14126 deploy@103.242.3.87 \
  "cd /opt/stocks/current/backend && node dist/scripts/ops/phase2_run_consolidation.js --apply"
```
脚本输出会打印新主盘 `id`. 记下来供后续验证.

### Step C: 验证

```bash
# 1. DB 端: 只剩 1 个 active portfolio
ssh ... "cd /opt/stocks/current/backend && node -e \"
  require('./dist/config/database').sequelize.query(
    'SELECT id, name, user_id, is_active FROM paper_trading_portfolios WHERE is_active=true'
  ).then(r => { console.log(r[0]); process.exit(0); });
\""

# 2. FE 端: 浏览器登录看顶部 selector 已退化为单个 Tag "综合策略主盘"
```

## 6. 回滚步骤 (如发现问题, 1 小时内)

```bash
# 1. 关闭新主盘 + 恢复 20 旧盘
ssh ... "cd /opt/stocks/current/backend && node -e \"
  const { sequelize } = require('./dist/config/database');
  Promise.all([
    sequelize.query(\\\"UPDATE paper_trading_portfolios SET is_active=true WHERE id IN (25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,61,62,63,64)\\\"),
    sequelize.query(\\\"DELETE FROM paper_trading_portfolios WHERE name = '综合策略主盘' AND (SELECT COUNT(*) FROM paper_trading_trades WHERE portfolio_id = paper_trading_portfolios.id) = 0\\\")
  ]).then(() => process.exit(0));
\""

# 2. revert PR
gh pr revert <pr-number>
```

**主盘有 trade 后不能 DELETE** — 只能 `is_active=false` 同样下线.

## 7. 验收检查

- [x] 综合主盘 DB 配置写好 (10 strategies + 22 factors + 6 个 risk overrides)
- [x] 关闭 SQL 排除"综合策略主盘" by `name`, 不会误关
- [x] 双向 SQL (up + down) 都写了, rollback 在 trade 出现前可用
- [x] 普通用户登录 → FE 隐藏新建/编辑/重置/删除 (admin 仍可见)
- [x] 普通用户看到 warning Alert 解释整合
- [x] `npx tsc --noEmit` (backend) 通过
- [x] `npm run build` (frontend) 通过
- [ ] PR merge → deploy → ops 跑 consolidation → 主盘 id 记录在此文档
- [ ] 用户开 https://prod 验证 selector 显示 '综合策略主盘'

## 8. 后续 Phase

完成本 Phase 后, 按 [master plan](./simplification_master_plan_2026_06_26.md):
- **Phase 3** UI 简化 (主菜单 8→5 + 删 206 处 US-XXX 装饰)
- **Phase 4** 清理 18 个 legacy pages + 18 条死路由

---

## 附录: 关键 commit 列表

| commit | 内容 |
|--------|------|
| docs(audit) | DA-0/DA-1/DA-2 勘探报告 + master plan |
| feat(phase2/ops) 综合主盘 SQL | create + rollback |
| feat(phase2/ops) 关闭旧盘 + node runner | close + rollback + 一站式 ts-runner |
| feat(phase2/fe) admin-gating | PortfolioManagementPanel 4 个破坏性操作 admin-only |
| docs(phase2) 本文档 | 完成报告 |
