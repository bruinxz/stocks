import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { dataHealthStatusService, listDataSources } from '../../services/DataHealthStatusService';
import { NorthboundSyncService } from '../../data/services/NorthboundSyncService';
import {
  DragonTigerSyncService,
  ListDragonTigerOptions,
} from '../../data/services/DragonTigerSyncService';
import { LimitUpSyncService } from '../../data/services/LimitUpSyncService';
import { IndustrySyncService } from '../../data/services/IndustrySyncService';
import { SnowballHotKeywordSyncService } from '../../data/services/SnowballHotKeywordSyncService';
import { ETFFlowSyncService, ListFlowOptions } from '../../data/services/ETFFlowSyncService';
import { getAllETFIndustries } from '../../constants/etfIndustry';
import { isValidSeatType, SeatType } from '../../constants/famousSeats';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

/**
 * US-079 数据健康度看板控制器（US-088 扩展龙虎榜查询端点 / US-092 扩展 ETF 资金流查询端点）
 *
 * - GET /api/data/health-status                          → 聚合所有数据源最新同步状态
 * - POST /api/data/sync/:source                          → 手动触发指定数据源的同步任务
 * - GET /api/data/dragon-tiger?stock_code=&seat_type=…   → US-088: 按归属机构查询龙虎榜
 * - GET /api/data/etf-flow?industry=&days=…              → US-092: 行业 ETF 资金流查询
 *
 * 手动触发只覆盖"日级 syncDate(date)"类数据源（北向 / 龙虎榜 / 涨停 / 行业流 /
 * 雪球热词）；周期性数据源（财报 / 业绩预告 / 分析师 / 分红 / 股东户数）和
 * 事件流数据源（公告 / KOL）的同步走 per-stock 批量模式，靠 cron 调度而非
 * 用户单次按钮触发——本 controller 返回 400 提示用户走运维 CLI 同步。
 */
export class DataController {
  constructor() {
    this.getHealthStatus = this.getHealthStatus.bind(this);
    this.getSystemTopology = this.getSystemTopology.bind(this);
    this.getMarketBreadth = this.getMarketBreadth.bind(this);
    this.getQualityDeepCheck = this.getQualityDeepCheck.bind(this);
    this.triggerSync = this.triggerSync.bind(this);
    this.listDragonTiger = this.listDragonTiger.bind(this);
    this.listEtfFlow = this.listEtfFlow.bind(this);
  }

  /**
   * GET /api/data/health-status
   * 返回所有数据源的健康状态卡片 + 汇总。
   */
  async getHealthStatus(_req: Request, res: Response) {
    try {
      const result = await dataHealthStatusService.getHealthStatus();
      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error(`DataController.getHealthStatus failed: ${error?.message ?? error}`);
      return res.status(500).json({
        success: false,
        error: error?.message ?? '获取数据源健康状态失败',
      });
    }
  }

  /**
   * GET /api/data/market-breadth
   * Phase 8: 全市场宽度指标 (用户优先级 #8)
   *
   * Query: ?days=7  (默认 7 天, max 30)
   */
  async getMarketBreadth(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { marketBreadthService } = require('../../services/MarketBreadthService');
      const days = req.query.days ? parseInt(String(req.query.days), 10) : 7;
      const data = await marketBreadthService.getReport(days);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取 market breadth 失败:', error);
      res.status(500).json({ success: false, message: error?.message || '获取失败' });
    }
  }

  /**
   * GET /api/data/quality-deep-check
   * Phase 8: 数据质量深度检查 (用户优先级 #1)
   *
   * Query: ?days=30  (检查最近 N 天，max 90)
   */
  async getQualityDeepCheck(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dataQualityDeepCheckService } = require('../../services/DataQualityDeepCheckService');
      const days = req.query.days
        ? Math.max(1, Math.min(90, parseInt(String(req.query.days), 10)))
        : 30;
      const data = await dataQualityDeepCheckService.runDeepCheck(days);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取 quality deep check 失败:', error);
      res.status(500).json({ success: false, message: error?.message || '获取失败' });
    }
  }

  /**
   * GET /api/data/system-topology
   * 返回系统架构拓扑图数据：
   *   - 9 个核心节点 (data → compute → decision → execution → output)
   *   - Phase 2+/4+/5+ 后新增 3 个节点:
   *       sizing_decision (Phase 2 sizing 策略 + 决策审计)
   *       kill_switch    (Phase 4 策略熔断监控)
   *       outcome_analysis (Phase 5 root_cause + postmortem 闭环分析)
   *   - 每个节点的真实健康状态 + 最近决策 + 跨阶段连线
   */
  async getSystemTopology(_req: Request, res: Response) {
    try {
      const today = todayIso();
      const q = async (sql: string) => {
        const [[row]] = await sequelize.query(sql);
        return row as any;
      };

      // ---- 各模块真实状态采集 ----
      const [taskRows] = await sequelize.query(
        "SELECT type, name, last_run_at, last_run_status FROM scheduled_tasks WHERE is_active=true"
      ) as [any[], any];

      const taskStatus = (types: string[]) => {
        const matching = taskRows.filter((t: any) => types.includes(t.type));
        if (!matching.length) return { status: 'gray', lastRun: null, lastStatus: 'NEVER' };
        const statuses = matching.map((t: any) => t.last_run_status || 'NEVER');
        const lastRun = matching
          .filter((t: any) => t.last_run_at)
          .sort((a: any, b: any) => new Date(b.last_run_at).getTime() - new Date(a.last_run_at).getTime())[0];
        const hasFailure = statuses.some((s: string) => s === 'FAILED');
        const allNever = statuses.every((s: string) => s === 'NEVER');
        return {
          status: allNever ? 'gray' : hasFailure ? 'yellow' : 'green',
          lastRun: lastRun?.last_run_at?.toISOString?.()?.slice(0, 19) || null,
          lastStatus: lastRun?.last_run_status || 'NEVER',
          taskName: lastRun?.name || matching[0]?.name,
        };
      };

      // 1. 数据采集
      const healthResult = await dataHealthStatusService.getHealthStatus();
      const cards = healthResult?.cards || [];
      const greenCount = cards.filter((c: any) => c.level === 'green').length;
      const redCount = cards.filter((c: any) => c.level === 'red').length;
      const yellowCount = cards.filter((c: any) => c.level === 'yellow').length;
      const dataStatus = redCount > 0 ? 'red' : yellowCount > 0 ? 'yellow' : 'green';

      // 2. 因子引擎
      const factorRow = await q("SELECT COUNT(DISTINCT factor_name)::int AS n, MAX(trade_date)::date AS d FROM factor_scores");
      const factorLag = factorRow.d ? Math.floor((Date.now() - new Date(factorRow.d).getTime()) / 86400000) : 999;
      const factorStatus = factorLag > 3 ? 'red' : factorLag > 1 ? 'yellow' : 'green';

      // 3. 策略引擎
      const sigRow = await q("SELECT COUNT(*)::int AS n FROM quant_signals WHERE trade_date::date = CURRENT_DATE");
      const sigTotal = await q("SELECT COUNT(DISTINCT strategy_key)::int AS n FROM quant_signals WHERE trade_date >= (CURRENT_DATE - 7)");
      const strategyStatus = sigRow.n > 0 ? 'green' : sigTotal.n > 0 ? 'yellow' : 'red';

      // 4. 宏观环境
      const macroRow = await q("SELECT MAX(observation_date)::date AS d FROM macro_indicators");
      const qvixRow = await q("SELECT MAX(observation_date)::date AS d FROM option_qvix");
      const macroLag = macroRow.d ? Math.floor((Date.now() - new Date(macroRow.d).getTime()) / 86400000) : 999;
      const macroStatus = macroLag > 7 ? 'red' : macroLag > 2 ? 'yellow' : 'green';

      // 5. 自主决策
      const autopilotTask = taskStatus(['PAPER_TRADING_AUTO_SYNC']);

      // 6. 风控
      const riskTask = taskStatus(['PAPER_TRADING_RISK_CHECK', 'PAPER_TRADING_MARKET_REGIME_CHECK']);
      const alertRow = await q("SELECT COUNT(*)::int AS n FROM risk_alerts WHERE user_id=4 AND created_at > NOW() - INTERVAL '24 hours'");

      // 7. 模拟盘
      const pfRow = await q("SELECT current_cash, total_value FROM paper_trading_portfolios WHERE user_id=4 LIMIT 1");
      const posRow = await q("SELECT COUNT(*)::int AS n FROM paper_trading_positions WHERE portfolio_id IN (SELECT id FROM paper_trading_portfolios WHERE user_id=4)");
      const tradeRow = await q("SELECT symbol, name, direction, created_at FROM paper_trading_trades WHERE portfolio_id IN (SELECT id FROM paper_trading_portfolios WHERE user_id=4) ORDER BY created_at DESC LIMIT 1");

      // 8. 通知
      const webhookOk = !!(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK);
      const webhookDisabled = String(process.env.DISABLE_FEISHU_BOT_WEBHOOK) === 'true';

      // 9. (Phase 2+) Sizing 决策审计 — 最近 7 天的 sizing_decision_audits + 主流方法
      let sizingStats: any = { recent_count: 0, hard_count: 0, methods: '—', last_run: null };
      let sizingStatus: 'green' | 'yellow' | 'gray' = 'gray';
      try {
        const sizing = await q(
          `SELECT
            COUNT(*)::int AS recent_count,
            COUNT(*) FILTER (WHERE hard_cutover = true)::int AS hard_count,
            MAX(created_at) AS last_run,
            string_agg(DISTINCT method, ',') AS methods
          FROM sizing_decision_audits
          WHERE created_at > NOW() - INTERVAL '7 days'`
        );
        sizingStats = {
          recent_count: Number(sizing.recent_count || 0),
          hard_count: Number(sizing.hard_count || 0),
          methods: sizing.methods || '—',
          last_run: sizing.last_run?.toISOString?.()?.slice(11, 16) || null,
        };
        // green 如果近 7 天有数据；gray 如果是空表 (新表 / 用户未开)
        sizingStatus = sizingStats.recent_count > 0 ? 'green' : 'gray';
      } catch (_e) {
        // 表不存在或权限问题 → gray，不影响整个 topology
        sizingStatus = 'gray';
      }

      // 10. (Phase 4+) Kill switch 监控 — 多少策略配了 kill_switch + 多少已 disabled
      let killSwitchStats: any = { strategies_with_killswitch: 0, disabled_count: 0 };
      try {
        const killRow = await q(
          `SELECT
            COUNT(*) FILTER (WHERE edge_hypothesis ? 'kill_switch_metric')::int AS strategies_with_killswitch,
            COUNT(*) FILTER (WHERE enabled = false)::int AS disabled_count,
            COUNT(*)::int AS total
          FROM quant_strategies`
        );
        killSwitchStats = {
          strategies_with_killswitch: Number(killRow.strategies_with_killswitch || 0),
          disabled_count: Number(killRow.disabled_count || 0),
          total: Number(killRow.total || 0),
        };
      } catch (_e) {
        // ignore
      }
      const killSwitchStatus: 'green' | 'yellow' | 'gray' =
        killSwitchStats.strategies_with_killswitch === 0
          ? 'gray'
          : killSwitchStats.disabled_count > 0
          ? 'yellow'
          : 'green';

      // 11. (Phase 5+) Outcome 闭环分析 — closed outcomes + root_cause 覆盖率 + postmortem 生成数
      let outcomeStats: any = {
        closed_count: 0,
        with_root_cause: 0,
        with_postmortem: 0,
        coverage_pct: 0,
      };
      try {
        const oRow = await q(
          `SELECT
            COUNT(*) FILTER (WHERE trade_status = 'closed')::int AS closed_count,
            COUNT(*) FILTER (WHERE trade_status = 'closed' AND root_cause IS NOT NULL)::int AS with_root_cause,
            COUNT(*) FILTER (WHERE trade_status = 'closed' AND metadata->'postmortem' IS NOT NULL)::int AS with_postmortem
          FROM recommendation_trade_outcomes`
        );
        const closed = Number(oRow.closed_count || 0);
        const wrc = Number(oRow.with_root_cause || 0);
        outcomeStats = {
          closed_count: closed,
          with_root_cause: wrc,
          with_postmortem: Number(oRow.with_postmortem || 0),
          coverage_pct: closed > 0 ? Math.round((wrc / closed) * 1000) / 10 : 0,
        };
      } catch (_e) {
        // ignore
      }
      const outcomeStatus: 'green' | 'yellow' | 'gray' =
        outcomeStats.closed_count === 0
          ? 'gray'
          : outcomeStats.coverage_pct < 80
          ? 'yellow'
          : 'green';

      // ---- 构建节点 ----
      const nodes = [
        {
          id: 'quant_system', label: '量化推荐系统', category: 'core',
          status: [dataStatus, factorStatus, strategyStatus, autopilotTask.status].includes('red') ? 'red' :
                  [dataStatus, factorStatus, strategyStatus, autopilotTask.status].includes('yellow') ? 'yellow' : 'green',
          stats: {
            // activeModules → 前端映射"活跃策略" 显示
            activeModules: sigTotal.n,
            totalCrons: taskRows.length,
            // 新增 stats 字段：UI 可扩展显示
            totalModules: 11, // data×2 + compute×2 + decision×4 + execution×1 + output×2
            totalSources: cards.length,
            factorCount: factorRow.n,
          },
          lastAction: `${cards.length} 数据源 / ${factorRow.n} 因子 / ${sigTotal.n} 策略 / ${killSwitchStats.total || 0} 策略带 EH`,
        },
        {
          id: 'data_collection', label: '数据采集层', category: 'data',
          status: dataStatus,
          stats: { sources: cards.length, green: greenCount, yellow: yellowCount, red: redCount },
          lastAction: `${greenCount}✅ ${yellowCount}⚠️ ${redCount}❌ (共${cards.length}源)`,
        },
        {
          id: 'macro_env', label: '宏观环境', category: 'data',
          status: macroStatus,
          stats: { macroLatest: macroRow.d, qvixLatest: qvixRow.d },
          lastAction: `macro=${macroRow.d || '—'} qvix=${qvixRow.d || '—'}`,
        },
        {
          id: 'factor_engine', label: '因子引擎', category: 'compute',
          status: factorStatus,
          stats: { factorCount: factorRow.n, latest: factorRow.d, lag: factorLag },
          lastAction: `${factorRow.n} 因子 latest=${factorRow.d || '—'} lag=${factorLag}d`,
        },
        {
          id: 'strategy_engine', label: '策略引擎', category: 'compute',
          status: strategyStatus,
          stats: {
            todaySignals: sigRow.n,
            activeStrategies: sigTotal.n,
            totalStrategies: killSwitchStats.total || 0,
          },
          lastAction: `今日 ${sigRow.n} 信号 / ${sigTotal.n} 策略活跃 / ${killSwitchStats.total || 0} 总注册`,
        },
        {
          id: 'autopilot', label: '自主决策', category: 'decision',
          status: autopilotTask.status,
          stats: { lastRun: autopilotTask.lastRun, lastStatus: autopilotTask.lastStatus },
          lastAction: autopilotTask.lastRun ? `${autopilotTask.lastStatus} @ ${autopilotTask.lastRun?.slice(11, 16)}` : '等待首次运行',
        },
        // Phase 2+ NEW: sizing 决策 + 决策审计
        {
          id: 'sizing_decision', label: 'Sizing 决策', category: 'decision',
          status: sizingStatus,
          stats: sizingStats,
          lastAction:
            sizingStats.recent_count > 0
              ? `7d ${sizingStats.recent_count} 决策 (${sizingStats.hard_count} hard) method=${sizingStats.methods}`
              : '尚未触发非 equal_pct sizing',
        },
        {
          id: 'risk_control', label: '风控系统', category: 'decision',
          status: riskTask.status === 'gray' && alertRow.n === 0 ? 'green' : riskTask.status,
          stats: { alerts24h: alertRow.n, lastRun: riskTask.lastRun },
          lastAction: `${alertRow.n} 告警/24h` + (riskTask.lastRun ? ` 上次=${riskTask.lastRun?.slice(11, 16)}` : ''),
        },
        // Phase 4+ NEW: kill switch 监控
        {
          id: 'kill_switch', label: '策略熔断监控', category: 'decision',
          status: killSwitchStatus,
          stats: killSwitchStats,
          lastAction:
            killSwitchStats.strategies_with_killswitch > 0
              ? `${killSwitchStats.strategies_with_killswitch}/${killSwitchStats.total} 策略配 kill_switch · ${killSwitchStats.disabled_count} 已禁用`
              : '尚未配置 kill_switch',
        },
        {
          id: 'portfolio', label: '模拟盘', category: 'execution',
          status: pfRow ? 'green' : 'gray',
          stats: {
            totalValue: pfRow ? Number(pfRow.total_value) : 0,
            positions: posRow.n,
            cash: pfRow ? Number(pfRow.current_cash) : 0,
          },
          lastAction: pfRow
            ? `¥${Number(pfRow.total_value).toLocaleString()} / ${posRow.n}只持仓`
            : '未创建',
          lastTrade: tradeRow
            ? `${tradeRow.direction} ${tradeRow.name || tradeRow.symbol} @ ${tradeRow.created_at?.toISOString?.()?.slice(11, 16) || ''}`
            : null,
        },
        // Phase 5+ NEW: 闭环分析 (root_cause + postmortem)
        {
          id: 'outcome_analysis', label: '闭环分析', category: 'output',
          status: outcomeStatus,
          stats: outcomeStats,
          lastAction:
            outcomeStats.closed_count > 0
              ? `${outcomeStats.closed_count} 闭环 · root_cause 覆盖 ${outcomeStats.coverage_pct}% · ${outcomeStats.with_postmortem} 自动复盘`
              : '尚无闭环 outcome',
        },
        {
          id: 'notification', label: '通知推送', category: 'output',
          status: webhookOk && !webhookDisabled ? 'green' : webhookDisabled ? 'gray' : 'red',
          stats: { feishu: webhookOk, disabled: webhookDisabled },
          lastAction: webhookOk ? (webhookDisabled ? '已禁用' : '飞书 webhook 就绪') : '未配置',
        },
        // Sprint 1-3 新模块
        {
          id: 'meta_label_filter', label: 'MetaLabel 信号过滤', category: 'decision',
          status: 'green',
          stats: { layer: 'pre-feasibility', model: 'logistic-regression' },
          lastAction: '二层模型 confidence 判断是否下注',
        },
        {
          id: 'execution_feasibility', label: '执行可行性评分', category: 'decision',
          status: 'green',
          stats: { components: 4, weights: '30/30/20/20' },
          lastAction: '涨跌停 / 流动性 / spread / T+1 综合评分',
        },
        {
          id: 'portfolio_construction', label: '风险预算组合', category: 'decision',
          status: 'green',
          stats: { methods: 4, default: 'risk_parity' },
          lastAction: 'ERC + 行业约束 + 总仓位约束输出权重',
        },
        {
          id: 'research_integrity', label: '研究严谨性审计', category: 'risk',
          status: 'green',
          stats: { detectors: 5, gates: 'wf+edge+ri' },
          lastAction: 'DSR / PBO / OOS decay / Lookahead / Survivorship',
        },
        {
          id: 'equity_curve_governor', label: '资金曲线 Governor', category: 'risk',
          status: 'green',
          stats: { tiers: 5, default_mult: 1.0 },
          lastAction: '5 档 Kelly 倍数 (healthy → observe_only)',
        },
      ];

      // ---- 构建连线 ----
      const edges = [
        // 数据 → 计算
        { source: 'data_collection', target: 'factor_engine', label: 'K线+行情' },
        { source: 'data_collection', target: 'macro_env', label: '宏观+QVIX' },
        // 计算内部
        { source: 'macro_env', target: 'strategy_engine', label: 'regime 环境' },
        { source: 'factor_engine', target: 'strategy_engine', label: '因子分数' },
        // 计算 → 决策
        { source: 'strategy_engine', target: 'autopilot', label: 'quant signals' },
        { source: 'macro_env', target: 'risk_control', label: '恐慌预警' },
        // Phase 4+ kill switch 反馈环: 监控 ← 策略；触发禁用 → 策略
        { source: 'strategy_engine', target: 'kill_switch', label: '策略列表' },
        { source: 'kill_switch', target: 'strategy_engine', label: '触发禁用 (反馈)' },
        // Phase 2+ sizing 链: autopilot 决策 → sizing 计算 → 执行
        { source: 'autopilot', target: 'sizing_decision', label: '候选 BUY' },
        { source: 'sizing_decision', target: 'portfolio', label: 'sized order' },
        // 决策 → 执行
        { source: 'risk_control', target: 'portfolio', label: 'SELL 指令' },
        // Phase 5+ 闭环回流: outcome → 分析 → 反馈 Kelly stats
        { source: 'portfolio', target: 'outcome_analysis', label: '闭环 trades' },
        { source: 'outcome_analysis', target: 'sizing_decision', label: 'Kelly 统计 (反馈)' },
        // 输出
        { source: 'portfolio', target: 'notification', label: '交易通知' },
        { source: 'autopilot', target: 'notification', label: '买入推送' },
        { source: 'risk_control', target: 'notification', label: '告警推送' },
        { source: 'outcome_analysis', target: 'notification', label: 'postmortem 推送' },
        // 顶层调度
        { source: 'quant_system', target: 'data_collection', label: '调度' },
        { source: 'quant_system', target: 'macro_env', label: '调度' },
        // Sprint 1-3 新决策层: autopilot → MetaLabel → Feasibility → PortfolioConstruction → sizing
        { source: 'autopilot', target: 'meta_label_filter', label: '原始信号' },
        { source: 'meta_label_filter', target: 'execution_feasibility', label: '过滤后 bet 候选' },
        { source: 'execution_feasibility', target: 'portfolio_construction', label: 'fillable 候选' },
        { source: 'portfolio_construction', target: 'sizing_decision', label: 'target weights' },
        // ResearchIntegrity → PromotionGate (strategy_engine)
        { source: 'research_integrity', target: 'strategy_engine', label: 'PASS 才允许 promote' },
        { source: 'strategy_engine', target: 'research_integrity', label: '定期审计 (反馈)' },
        // Governor: 评估 portfolio → sizing 加 multiplier
        { source: 'portfolio', target: 'equity_curve_governor', label: '健康度评估' },
        { source: 'equity_curve_governor', target: 'sizing_decision', label: 'Kelly multiplier (反馈)' },
      ];

      return res.json({ success: true, data: { nodes, edges, generated_at: new Date().toISOString() } });
    } catch (error: any) {
      logger.error(`DataController.getSystemTopology failed: ${error?.message ?? error}`);
      return res.status(500).json({ success: false, error: error?.message ?? '获取系统拓扑失败' });
    }
  }

  /**
   * POST /api/data/sync/:source
   *
   * 触发指定数据源的当日同步。:source 必须对应注册中心的 sync_source 字段
   * （northbound / dragon_tiger / limit_up / industry_flow / snowball_hot 之一）。
   *
   * Body 可选 `date` (YYYY-MM-DD)，默认今天 ISO 日期。
   *
   * 返回结构：
   *   { success: true, source, date, result: <服务返回的 SyncDateResult> }
   *
   * 周期性 / per-stock 类数据源（财报 / 分析师 / 公告等）当前返回 400，
   * 提示走运维 CLI（npm run sync:financial-report -- --code=600519）。
   */
  async triggerSync(req: Request, res: Response) {
    const source = String(req.params.source || '').trim();
    const date = String((req.body && req.body.date) || todayIso());

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        error: 'date 必须为 YYYY-MM-DD 格式',
      });
    }

    // 只有 daily 类数据源支持 web 端一键触发
    const dailyRoutes: Record<string, () => Promise<unknown>> = {
      northbound: () => new NorthboundSyncService().syncDate(date),
      dragon_tiger: () => new DragonTigerSyncService().syncDate(date),
      limit_up: () => new LimitUpSyncService().syncDate(date),
      industry_flow: () => new IndustrySyncService().syncDate(date),
      snowball_hot: () => new SnowballHotKeywordSyncService().syncDate(date),
    };

    if (!Object.prototype.hasOwnProperty.call(dailyRoutes, source)) {
      // 校验是 已知 source 但非 daily 类 vs 完全未知 source
      const known = listDataSources().some(s => s.sync_source === source);
      if (known) {
        return res.status(400).json({
          success: false,
          error: `数据源 ${source} 为周期性 / per-stock 同步，请通过运维 CLI 触发 (npm run sync:${source.replace(
            '_',
            '-'
          )})`,
        });
      }
      return res.status(404).json({
        success: false,
        error: `未知数据源: ${source}`,
      });
    }

    try {
      const result = await dailyRoutes[source]();
      return res.json({
        success: true,
        source,
        date,
        result,
      });
    } catch (error: any) {
      logger.error(
        `DataController.triggerSync(${source}, ${date}) failed: ${error?.message ?? error}`
      );
      return res.status(500).json({
        success: false,
        source,
        date,
        error: error?.message ?? '数据源同步失败',
      });
    }
  }

  /**
   * US-088: GET /api/data/dragon-tiger
   *
   * 按归属机构类型 + 股票 + 日期范围查询龙虎榜营业部明细。短线策略 / 前端
   * "机构跟随面板"会按 `seat_type=public_fund` 或 `seat_type=foreign` 拉取。
   *
   * Query 参数：
   *   - `stock_code` (optional) 股票代码（无后缀，例如 600519），缺省返回全市场
   *   - `seat_type`  (optional) 归属机构类型，必须为枚举值之一：
   *                  public_fund | foreign | private_fund | famous_yz | unknown
   *   - `start`      (optional) YYYY-MM-DD，缺省 end-7d
   *   - `end`        (optional) YYYY-MM-DD，缺省今天
   *   - `limit`      (optional) 1..1000，默认 200
   *
   * 返回结构：
   *   { success: true, count, filters, data: DragonTigerEntry[] }
   *
   * seat_type 非法值返回 400；其他参数缺省 fallback 不报错（service 层兜底）。
   */
  async listDragonTiger(req: Request, res: Response) {
    const stockCode =
      typeof req.query.stock_code === 'string' && req.query.stock_code.trim()
        ? String(req.query.stock_code).trim()
        : undefined;
    const seatTypeRaw =
      typeof req.query.seat_type === 'string' && req.query.seat_type.trim()
        ? String(req.query.seat_type).trim()
        : undefined;
    const startRaw =
      typeof req.query.start === 'string' ? String(req.query.start).trim() : undefined;
    const endRaw = typeof req.query.end === 'string' ? String(req.query.end).trim() : undefined;
    const limitRaw =
      typeof req.query.limit === 'string' && req.query.limit.trim()
        ? Number(req.query.limit)
        : undefined;

    let seatType: SeatType | undefined;
    if (seatTypeRaw !== undefined) {
      if (!isValidSeatType(seatTypeRaw)) {
        return res.status(400).json({
          success: false,
          error: `seat_type 必须为 public_fund / foreign / private_fund / famous_yz / unknown 之一，收到: ${seatTypeRaw}`,
        });
      }
      seatType = seatTypeRaw;
    }

    const options: ListDragonTigerOptions = {
      stock_code: stockCode,
      seat_type: seatType,
      start: startRaw,
      end: endRaw,
      limit: limitRaw,
    };

    try {
      const service = new DragonTigerSyncService();
      const data = await service.listEntries(options);
      return res.json({
        success: true,
        count: data.length,
        filters: {
          stock_code: stockCode ?? null,
          seat_type: seatType ?? null,
          start: startRaw ?? null,
          end: endRaw ?? null,
          limit: limitRaw ?? null,
        },
        data,
      });
    } catch (error: any) {
      logger.error(`DataController.listDragonTiger failed: ${error?.message ?? error}`);
      return res.status(500).json({
        success: false,
        error: error?.message ?? '龙虎榜查询失败',
      });
    }
  }

  /**
   * US-092: GET /api/data/etf-flow
   *
   * 行业 ETF 资金流入流出查询. 前端"数据中心 / 行业研究"页面据此展示
   * "近 30 日哪些行业被资金大额申购 / 赎回".
   *
   * Query 参数 (industry 与 etf_code 互斥, industry 优先):
   *   - `industry` (optional) 行业标签 (e.g. "半导体" / "医药"), 必须在白名单内
   *   - `etf_code` (optional) ETF 代码 (e.g. "159995")
   *   - `days`     (optional) 回看自然日数, 默认 30, max 365
   *   - `end`      (optional) 终止日 YYYY-MM-DD, 默认今天
   *   - `limit`    (optional) 行数上限, 默认 5000, max 50000
   *
   * 返回结构:
   *   {
   *     success: true, count, filters,
   *     industries: string[]  ← 全部白名单行业 (供前端下拉)
   *     data: FlowEntry[]    ← (trade_date DESC, etf_code ASC) 排序
   *   }
   *
   * industry 非白名单值不会 4xx, 直接返回 count=0 (与 normalize 风格一致).
   */
  async listEtfFlow(req: Request, res: Response) {
    const industry =
      typeof req.query.industry === 'string' && req.query.industry.trim()
        ? String(req.query.industry).trim()
        : undefined;
    const etfCode =
      typeof req.query.etf_code === 'string' && req.query.etf_code.trim()
        ? String(req.query.etf_code).trim()
        : undefined;
    const daysRaw =
      typeof req.query.days === 'string' && req.query.days.trim()
        ? Number(req.query.days)
        : undefined;
    const endRaw =
      typeof req.query.end === 'string' && req.query.end.trim()
        ? String(req.query.end).trim()
        : undefined;
    const limitRaw =
      typeof req.query.limit === 'string' && req.query.limit.trim()
        ? Number(req.query.limit)
        : undefined;

    const options: ListFlowOptions = {
      industry,
      etf_code: etfCode,
      days: daysRaw,
      end: endRaw,
      limit: limitRaw,
    };

    try {
      const service = new ETFFlowSyncService();
      const data = await service.listFlow(options);
      return res.json({
        success: true,
        count: data.length,
        filters: {
          industry: industry ?? null,
          etf_code: etfCode ?? null,
          days: daysRaw ?? null,
          end: endRaw ?? null,
          limit: limitRaw ?? null,
        },
        industries: getAllETFIndustries(),
        data,
      });
    } catch (error: any) {
      logger.error(`DataController.listEtfFlow failed: ${error?.message ?? error}`);
      return res.status(500).json({
        success: false,
        error: error?.message ?? 'ETF 资金流查询失败',
      });
    }
  }
}

function todayIso(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}
