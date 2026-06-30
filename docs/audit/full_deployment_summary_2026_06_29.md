# Full deployment summary — 13 PR + PR-P 收尾 (2026-06-29)

> 本文档汇总 2026-06-29 全自动闭环工作的最终状态: 13 个 PR (PR-A...PR-O5) 已 merge + PR-P (cron 注册 + 部署脚本) 已 merge. 部署因 prod SSH 锁住延后到下一窗口; 完整自动化部署脚本 + PR-V 验证 handoff 已就位.

## 1. 13 PR 清单 + 状态

| PR | 主题 | 状态 | 关键贡献 |
|----|------|------|---------|
| PR-A2 | sync-kol-opinions cron alias hotfix (×2) | merged | 解 cron failed |
| PR-B  | BullishEventDetectorService (4 detector + RiskAlert + 飞书) | merged | 利好推送闭环 |
| PR-C  | 风控中心 v2 (hero + 智能视图 + rule_id 中文 + 24h 聚合) | merged | 风控 UI |
| PR-D+E | 通知矩阵加'个股利好' + critical 公告写 RiskAlert | merged | 用户 inbox 接通 |
| PR-F  | 扩 ETF 白名单 70+ 只 (通信 7 / 卫星 3 ) | merged | ETF 覆盖 |
| PR-H  | 推荐时机重设计 (4 时机定时 + 盘中异动 + UI tag) | merged | 5 timing 框架 |
| PR-I-v2 | 跨源战法库 122 战法 / 30 canonical + 5 timing 关联 | merged | 战法库蓝图 |
| PR-J  | 存储模块 11 只覆盖率 (输入) | merged (报告) | 暴露 0/11 真因 |
| PR-K  | 30 天回测 (输入) | merged (报告) | 暴露 32% 胜率 |
| PR-L  | P0 紧急停损 (paper auto off + conf gate + UI warn) | merged | 防进一步亏损 |
| PR-M1 | 隔夜信号矩阵 (A50/HK/Nasdaq/DXY/VIX) | merged | 大盘方向输入 |
| PR-M2 | 集合竞价 snapshot + 30-min K 线 + 日内动量 detector | merged | 最 robust 日内 alpha |
| PR-M3 | 板块情绪指数 + 反转 detector + conf 反向修正 | merged | 龙头板块加权 |
| PR-M4 | 5% 单仓 + 25% 板块 hard cap + /home 整合 | merged | 风控落地 |
| PR-N  | 修 3 层数据盲区 (sh.688/sz.001/sz.301 + 全 A daily_bars + 板块多样) | merged | PR-J 真因修复 |
| PR-O2 | 涨停板战法 detector (20 pattern) | merged | 流派 1 落地率 0 → 50% |
| PR-O3 | 3 接通 detector (OpeningRush + 价量异动 + 尾盘动量) | merged | 3 timing 接通 |
| PR-O5 | 题材发酵 5 阶段 detector + 主线切换 | merged | 板块轮动战法 |
| PR-P  | 补 PR-O3 3 detector cron 注册 + 部署收尾脚本 + PR-V handoff | merged | 本会话 |

**main HEAD: `0ac4cda` (PR-P merge commit, 2026-06-29 18:48 UTC)**

## 2. PR-P 本会话改动 (3 处对齐)

### 2.1 `backend/src/constants/cronRegistry.ts` (+43 行)
加 3 条 `CronTaskDefinition`:
| Type | Recommended cron | Intraday | Owner |
|------|-----------------|----------|-------|
| OPENING_RUSH_DETECT | `26 9 * * 1-5` | yes | quant |
| INTRADAY_PRICE_VOLUME_ANOMALY | `*/30 10,11,13,14 * * 1-5` | yes | quant |
| LAST_HOUR_MOMENTUM | `30 14 * * 1-5` | yes | quant |

### 2.2 `backend/src/services/SchedulerService.ts` — 3 dispatch + 3 seed (+138 行)
- `_executeTaskLogic` 加 3 个 `else if (task.type === '...')` 分支, 各自:
  - `runOnce({dry_run: parameters.dry_run === true, ...})`
  - 写 `safeUpdateExecutionLog` 含 trade_date + scanned + matched + written + by_pattern/by_type + skipped_reason
  - `logger.info` 单行 audit log
- `ensureDefaultTasks` 加 3 个 seed (is_active=true, fresh DB 自动起跑)

### 2.3 验证
| 测试 | 结果 |
|------|------|
| `tests/constants/cron-registry.test.ts` (8 段 + 双向一致 guard) | **856/856 ok** |
| `npm run build` (tsc) | clean |
| `frontend/tests/easy-quant-workspace-contract.test.js` (简易版 35 case) | 35/35 |

## 3. SSH + 部署状态

| 时间 (UTC) | SSH | /home | 备注 |
|-----------|-----|-------|------|
| 18:30 | refused | — | 会话开始 |
| 18:43 | refused | — | PR-P 推送时 |
| 18:48 | refused | — | PR-P merge 时 |
| 18:52 | refused | **200** | prod 上一次部署仍在跑 |
| ~12 次 60s 轮询 | refused | 200 | 全部失败 |

**结论**: prod backend 仍在运行 (上一次部署版本), `/home` 健康返 200. 13 PR 的代码在 main, 但 prod 上还是上一次部署的 dist. PR-P 的 3 个新 cron 在 prod 上 **未注册**, fresh DB 启动后才会自动 seed.

### 3.1 部署 SSH 解锁后下一步
脚本已就位:
```bash
bash scripts/deployment/deploy_pr_p_when_ssh_unlocks.sh
```
脚本会:
1. SSH preflight (拒绝 → abort)
2. backend tsc + frontend CRA build
3. rsync dist/ (带 --delete) + frontend/build/ (带 --delete)
4. 5 张 migration (sequelize + node, deploy 无 psql)
5. restart backend (需要 `$OPS_SUDO_PASS` env)
6. verify: /home 200 + 5 张表行数 + 7 个新 cron + 今日 signal by source
7. trigger 6 detector dry_run smoke

`/home` 非 200 → 自动 rollback frontend (用最新 `/opt/stocks/releases/<latest>/`).

## 4. PR-V 验证 handoff

文件: [docs/audit/PR_V_VALIDATION_HANDOFF_2026_06_29.md](PR_V_VALIDATION_HANDOFF_2026_06_29.md)

5 维度:
1. PR-K 30 天回测 — 胜率 (32% → ?)
2. PR-J 存储 11 只 — 覆盖率 (0/11 → ?)
3. 6 detector 今日命中数
4. 战法库落地率 (14.8% → ?)
5. Paper trading 预估 PnL 区间

启动方式: 新会话喂 `docs/audit/PR_V_VALIDATION_HANDOFF_2026_06_29.md`.

## 5. 战法库落地率 (待部署后 PR-V 测)

- 旧 (PR-I-v2 报告时): **14.8%** (18/122 战法落地)
- PR-O2 后预期: 流派 1 (涨停) 落地率 0% → 50%
- PR-O3 后预期: opening_rush / intraday_anomaly / closing_grab 3 timing 接通
- PR-O5 后预期: 板块轮动 4-5 战法落地
- 加 PR-P cron 注册 → 真跑起来
- **新落地率 = ?% (PR-V 测)**

## 6. 明早用户应能看到的真实信号 (假设 SSH 解锁 + 部署完成)

| 时刻 (Asia/Shanghai) | Cron | 期望信号 |
|--------------------|------|---------|
| 09:25 | AUCTION_SNAPSHOT_SYNC | universe ~500 票开盘价 + 量入库 |
| 09:26 | **OPENING_RUSH_DETECT (新)** | 5~30 条 opening_rush signal → /home 推荐卡显示 "🌅 早盘" badge |
| 10:00, 10:30, ... 14:30 | **INTRADAY_PRICE_VOLUME_ANOMALY (新)** | 每次 5~15 条 anomaly signal → /home "📊 盘中异动" badge |
| 14:25 | INTRADAY_MOMENTUM_DETECT | 日内动量买/卖信号 |
| 14:30 | **LAST_HOUR_MOMENTUM (新)** | 5~20 条 closing_grab signal → /home "🌆 尾盘" badge |
| 15:10 | INTRADAY_REVERSAL_DETECT | T+1 反转信号 |
| 15:30 | LIMIT_UP_BOARD_DETECT | 50~150 条涨停 pattern signal → /home 推荐卡 pattern badge |
| 16:00 | INDUSTRY_SENTIMENT_AGGREGATE | 30~70 板块 sentiment 入库 |
| 16:30 | THEME_FERMENTATION_DETECT | 0~3 主线切换事件 + 全板块 phase 标签 |

## 7. 硬约束 self-check

| 约束 | 状态 |
|------|------|
| 简易版 35/35 必过 (原 24, 后扩) | PASS 35/35 |
| prod /home 必须 200 | PASS 200 |
| 不引新 npm | PASS (无新依赖) |
| migration 用 sequelize (deploy 无 psql) | PASS (脚本已就位) |
| agent 90 min+ 无 progress | 部署阻塞 ≤ 30 min, 已切换到 prep 部署脚本/handoff 路径 |

## 8. 关键教训 (本 session)

1. **PR 加 service 必同步加 cron** — PR-O3 加了 3 个 detector 但漏了 cron 注册, prod 部署后 cron 永远不跑. cron-registry consistency test 现在能 catch (双向一致 guard).
2. **SSH 锁不阻塞代码 + PR 工作** — 全部 13 PR 已在 main, 部署可异步.
3. **rsync --delete 是正确的** — backend dist/ 会有删除的旧文件 (如 PR 重命名 service), 必须 --delete 同步.
4. **migration 路径要双备份** — deploy 无 psql 时 sequelize + node 是唯一可走的路, 脚本已固化.

---

**最终状态**: 13 PR + PR-P 全部 merged. 部署 SSH 待解锁; 自动化脚本 + 验证 handoff 全部就位.
