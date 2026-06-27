# 系统简化 Master Plan (2026-06-26)

**用户目标**:
1. 模拟盘缩减到 1 个 (融合最优策略 + 因子, 不要数量概念)
2. 页面太复杂, 入手不知道怎么操作
3. 设计 AI 感太强, 不好看, 整体重构
4. 数据有效性 + 及时性 + 告警机制
5. 清理冗余, 让网站可用可看

**关键约束**: `/workspace/easy` 简易版**绝对不动** (在 main 上, 本分支落后 60 commit, 修改前必须先 rebase main)

**勘探基础**:
- [portfolio_consolidation_2026_06_26.md](portfolio_consolidation_2026_06_26.md) — DA-0 模拟盘
- [ui_simplification_plan_2026_06_26.md](ui_simplification_plan_2026_06_26.md) — DA-1 前端
- [data_pipeline_health_2026_06_26.md](data_pipeline_health_2026_06_26.md) — DA-2 数据 cron

---

## 🎯 4 阶段路线图 + 验收标准

### Phase 1: 数据修复 (P0, 1-2 天) — 没数据后面全白搭

**根因 1: 时区 bug 让周五 16:00+ 全部 cron 假绿**
- 文件: `backend/src/utils/tradingCalendar.ts` L71-78 + L89-96
- 修复: `isAShareTradeDay()` 和 `explainNonTradeDay()` 改用 `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'})` 而不是手算 timezoneOffset
- 影响: 30+ cron (DAILY_UPDATE / SYNC_HISTORY / DATA_FRESHNESS_CHECK / FACTOR_SCORE_COMPUTE / ETF_FLOW_SYNC / DAILY_HEALTH_REPORT 等) 周五盘后能正常跑
- 5 行 diff + 单元测试 (verify 周五 16:00+ 不被误判)

**根因 2: DataFreshnessCheck 自己有 off-by-one bug**
- 文件: `backend/src/services/DataFreshnessCheckService.ts`
- 修复: daily_bars staleness 算法用 trade calendar 而非自然日, 让"周五入库 周一晚上才算 stale"
- 影响: 告警机制真生效, 用户能收到 Lark 推送

**根因 3: REALTIME_QUOTE_SYNC universe 只 360 票不含热门 CPO**
- 临时 fix: 手动加 9 只热门 CPO 票到 IntradayUniverseService 的 priority list
- 长期 fix: CE-A IntradayUniverseService 已 ready, 但需要 ops 启用 cron (cron 已 seeded 但未 active)

**根因 4: DAILY_UPDATE max_stocks=300 每天只补 300 票, 5500 总数靠周一 bulk_sync 才轮一圈**
- 修复: 把 max_stocks 提到 1000 + 加 `priority_symbols` 优先列 (持仓 + 用户自选 + 当日活跃)

**Phase 1 验收**:
- [ ] 周五 ≥ 16:00 跑 cron 不被误杀 (写单测)
- [ ] 6/29 周一 09:30 用户问"今天行情怎样" 我能给到当天的 daily_bars
- [ ] daily_bars stale > 1 个交易日 触发真 RiskAlert + Lark 推送
- [ ] 9 只 CPO 主板票 实时报价 5 分钟内可查

**预计**: 6/26-6/29, 周一开盘前完成

---

### Phase 2: 单一模拟盘 (P1, 2-3 天)

**目标**: 21 个盘 → 1 个综合主盘, frontend 去掉"组合数量"概念

**步骤**:
1. **新建综合主盘** (不是改 #29, 因为 #29 自己也亏 sharpe=-1.63)
   - 名字: "综合策略主盘"
   - 初始资金: 20W
   - strategy_keys: 10 个 (4 均值回归族 + 4 动量族 + volume_price_confirmation + dragon_head_momentum)
   - factor_weights: 全 22 因子默认权重
   - risk_config 关键升级:
     - `trailing_stop_pct=4` (DA-0 发现 trailing 才是真退出, 5 笔贡献 +)
     - `drawdown_breaker.threshold=3%` (统一组合级熔断)
     - **硬止损从 5% 放宽到 6%** (DA-0 关键发现: 99 笔 5% 硬止损全亏 -11k 元)
     - `take_profit_pct=8` (避免错过大涨)
2. **关闭旧 16 个 active 盘** (`is_active=false`), 不删 row 保历史数据
3. **关闭 4 个僵尸盘** (#61/62/63/64)
4. **frontend 改动**:
   - 移除 `GlobalPortfolioSelector` (用户不需要选了)
   - 移除 `PortfolioManagementPanel` 的"新建"按钮
   - `PortfolioContext` 退化为单 portfolio 常量
   - 保留"查看历史盘"入口 (admin only, 用于复盘)

**Phase 2 验收**:
- [ ] 用户登录后只看到 1 个盘, 名字明确叫"综合策略主盘"
- [ ] 自动跟单走综合盘 (不是分散在多个盘)
- [ ] 老盘历史 trade 仍可查 (data 不丢)
- [ ] 综合盘第 1 周跑出来的胜率 / sharpe ≥ 老 #29

**预计**: 6/30-7/2

---

### Phase 3: UI 简化 + 视觉重构 (P1, 3-5 天)

**绝对不动**: `/workspace/easy` 简易版 + 8 个相关文件 + App.tsx 内的 4 个位点

**3a. 主菜单 8 → 5**
- 保留: 简易版 (默认登陆) / 今日 / 持仓 / 实验室 / 设置
- 合并: 选股因子 → 实验室
- 降级: 数据中心 → admin only
- 降级: 系统介绍 → 右上 "?" Drawer

**3b. 二级 tab 精简**
- Lab: 11 → 5 (walk-forward/shadow/overfit/advanced 折叠到 admin)
- Settings: 12 → 4 (sizing/kill-switch/black-swan 折叠到 admin)
- Today: 6 → 3
- Portfolio: 8 → 4

**3c. 降"AI 感"**
- 8 种 Tag 色 → 4 种
- 10 种 fontSize → 3 种
- 5 种 borderRadius → 1 种
- 删 workspace 内 **206 处 "US-XXX / Sprint NN+" 装饰 Tag** (这是核心 AI 感来源)
- 删 borderLeft 3px 装饰条
- RobotOutlined → 中性 icon
- 引入 `--qx-*` 全局令牌, 复用简易版 `--eq-*` 暖纸调色板

**3d. KPI 精简**
- 每个 workspace ≤ 4 个 KPI
- 删 5 处"总收益"重复
- 总收益 / 当月 / 浮动 / 已实现 / 当日 P&L 统一到 Portfolio 单一口径
- Today 顶部从 9 信息点 → ≤ 4

**3e. 默认 tab**
- Today: 默认"今日核心推荐" (用户登录最关心的)
- Portfolio: 默认"持仓" (而不是"管理")
- Lab: 默认"我的策略" (而不是"新建")

**Phase 3 验收**:
- [ ] 新用户第 1 次登录, 能在 3 秒看懂主页
- [ ] 关键操作 (查持仓 / 下模拟单 / 看推荐) 1 分钟内可完成
- [ ] 不再有"满屏花花绿绿 Tag"的 AI 感

**预计**: 7/3-7/8

---

### Phase 4: 清理冗余 + 验收 (P2, 1-2 天)

**4a. 删除 18 个 legacy pages** (≈ 1.9 万行死代码)
**4b. 删除 18 条 /legacy/* 路由 + 18 条 routeSelectionAliases**
**4c. 删除孤立 component** (没人 import 的)
**4d. 删除老 controller** (workspace 已替代的 API)

**4e. 端到端验收**:
- 用户登录 → 看到简易版 (默认)
- 切到"今日" → 看到当天推荐 (数据是今天的)
- 切到"持仓" → 看到唯一 1 个综合盘
- 切到"实验室" → 看到自己的策略 + 回测
- 切到"设置" → 配置 + 模拟盘管理

**Phase 4 验收**:
- [ ] frontend bundle size 减小 ≥ 20%
- [ ] 用户能用 5 分钟做完一个典型操作流程
- [ ] 没有 console error / 404

**预计**: 7/9-7/10

---

## ⚠️ 执行规则

1. **每个 Phase 完成后回头看是否达标**, 不达标继续迭代
2. **简易版绝对不动** — 任何动手前 `git fetch origin main && git rebase origin/main`
3. **不删任何数据**, 只 `is_active=false` 或注释
4. **prod 数据库改动写双向 migration** (up + down)
5. **每个 phase 写 commit message**, 不混合

---

## 📊 总览

| Phase | 范围 | 工时 | 关键风险 |
|------|------|------|---------|
| 1 数据 | tradingCalendar bug + freshness check + RT universe + DAILY_UPDATE max | 1-2 天 | 5 行修一个 bug 但要测全周 |
| 2 单盘 | 新建综合盘 + 关闭旧盘 + frontend selector 隐藏 | 2-3 天 | 老盘历史不能丢 |
| 3 UI | 主菜单 + 二级 tab + 视觉 + KPI + 默认 tab | 3-5 天 | 简易版不能动, rebase 风险 |
| 4 清理 | 删 18 + 18 + 孤立 + 老 controller | 1-2 天 | 别误删被 import 的 |

总工时: 7-12 天 (1.5-2.5 周)

下一步: 立即开始 Phase 1 (数据修复), 因为这影响用户每天的体验。
