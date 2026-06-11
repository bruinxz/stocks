import { Request, Response } from 'express';
import { strategyEngine } from '../../quant/engine/StrategyEngine';
import { signalEngine } from '../../quant/engine/SignalEngine';
import { backtestEngine } from '../../quant/backtest/BacktestEngine';
import { performanceReporter } from '../../quant/performance/PerformanceReporter';
import { quantHealthMonitor } from '../../quant/health/QuantHealthMonitor';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { logger } from '../../utils/logger';

export class QuantController {
  async getStrategies(_req: Request, res: Response) {
    try {
      const strategies = await strategyEngine.listStrategies();
      res.json({ success: true, data: strategies });
    } catch (error: any) {
      logger.error('获取量化策略失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-078: 策略详情页 — 单只策略元数据 + 近 10 次回测 + 最新 IC + 实盘绑定。
   * 路由 `/api/quant/strategies/:strategy_key/detail` 必须注册在 PATCH `/strategies/:strategy_key`
   * 之前，避免 Express 把 "detail" 解释成 sub-resource 之外的歧义路径（见 quant.routes.ts 注释）。
   */
  async getStrategyDetail(req: Request, res: Response) {
    try {
      const strategyKey = String(req.params.strategy_key || '').trim();
      if (!strategyKey) {
        return res.status(400).json({ success: false, message: '缺少 strategy_key' });
      }
      const data = await strategyEngine.getStrategyDetail(strategyKey);
      if (!data) {
        return res.status(404).json({ success: false, message: '策略不存在' });
      }
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取量化策略详情失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-093: 返回策略源文件（.ts）内容供前端 Monaco 编辑器只读展示。
   *
   * 路由 `/api/quant/strategies/:strategy_key/source` 必须注册在 PATCH
   * `/strategies/:strategy_key` 之前（与 /detail 同款 ordering 规则，见
   * quant.routes.ts 注释）。strategy_key 由 service 层严格校验 `^[a-z][a-z0-9_]*$`
   * 杜绝 path traversal；找不到对应文件返回 404；超 256KB 返回 413。
   */
  async getStrategySource(req: Request, res: Response) {
    try {
      const strategyKey = String(req.params.strategy_key || '').trim();
      if (!strategyKey) {
        return res.status(400).json({ success: false, message: '缺少 strategy_key' });
      }
      const data = await strategyEngine.getStrategySource(strategyKey);
      res.json({ success: true, data });
    } catch (error: any) {
      const code = error?.code;
      if (code === 'INVALID_STRATEGY_KEY') {
        return res
          .status(400)
          .json({ success: false, message: 'strategy_key 格式非法（仅允许小写字母/数字/下划线）' });
      }
      if (code === 'STRATEGY_NOT_FOUND') {
        return res.status(404).json({ success: false, message: '未找到该策略源文件' });
      }
      if (code === 'FILE_TOO_LARGE') {
        return res
          .status(413)
          .json({ success: false, message: '源文件过大（>256KB），无法在线展示' });
      }
      logger.error('获取量化策略源码失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async updateStrategyConfig(req: AuthenticatedRequest, res: Response) {
    try {
      const default_params =
        req.body?.default_params !== undefined
          ? req.body.default_params
          : req.body?.defaultParams !== undefined
          ? req.body.defaultParams
          : undefined;
      // US-083: typed shortcut — UI sends {dry_run: true/false} at top level
      // (instead of {lifecycle_policy: {dry_run: ...}}).  We merge into
      // lifecycle_policy so the existing JSONB patch path handles persistence.
      // body.lifecycle_policy still wins if both are sent — explicit wins over shortcut.
      const lifecyclePolicyPatch =
        req.body?.lifecycle_policy !== undefined
          ? req.body.lifecycle_policy
          : req.body?.lifecyclePolicy !== undefined
          ? req.body.lifecyclePolicy
          : undefined;
      const dryRunShortcut =
        req.body?.dry_run !== undefined
          ? Boolean(req.body.dry_run)
          : req.body?.dryRun !== undefined
          ? Boolean(req.body.dryRun)
          : undefined;
      const mergedLifecyclePolicy: Record<string, any> | undefined =
        dryRunShortcut === undefined
          ? lifecyclePolicyPatch
          : { ...(lifecyclePolicyPatch || {}), dry_run: dryRunShortcut };
      const strategy = await strategyEngine.updateStrategyConfig(req.params.strategy_key, {
        enabled:
          req.body?.enabled === undefined || req.body?.enabled === null
            ? undefined
            : Boolean(req.body.enabled),
        default_params,
        execution_policy:
          req.body?.execution_policy !== undefined
            ? req.body.execution_policy
            : req.body?.executionPolicy !== undefined
            ? req.body.executionPolicy
            : undefined,
        environment_policy:
          req.body?.environment_policy !== undefined
            ? req.body.environment_policy
            : req.body?.environmentPolicy !== undefined
            ? req.body.environmentPolicy
            : undefined,
        lifecycle_policy: mergedLifecyclePolicy,
        notes: req.body?.notes !== undefined ? String(req.body.notes || '') : undefined,
        display_order:
          req.body?.display_order !== undefined
            ? Number(req.body.display_order)
            : req.body?.displayOrder !== undefined
            ? Number(req.body.displayOrder)
            : undefined,
      });
      res.json({ success: true, data: strategy });
    } catch (error: any) {
      logger.error('更新量化策略配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getIndicatorCatalog(_req: Request, res: Response) {
    try {
      const catalog = performanceReporter.getIndicatorCatalog();
      res.json({ success: true, data: catalog });
    } catch (error: any) {
      logger.error('获取量化指标目录失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getPerformanceDashboard(req: AuthenticatedRequest, res: Response) {
    try {
      const dashboard = await performanceReporter.getDashboard({
        user_id: req.user?.id,
        username: req.user?.username,
      });
      res.json({ success: true, data: dashboard });
    } catch (error: any) {
      logger.error('获取量化收益驾驶舱失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getOpenWatchdog(req: AuthenticatedRequest, res: Response) {
    try {
      const watchdog = await quantHealthMonitor.getOpenWatchdog(req.query as any);
      res.json({ success: true, data: watchdog });
    } catch (error: any) {
      logger.error('获取量化开盘链路看门狗失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getDataFreshness(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await quantHealthMonitor.getDataFreshness({
        trade_date: req.query.trade_date as string,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取量化数据新鲜度失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getRuntimeHealth(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await quantHealthMonitor.getRuntimeHealth({ user_id: req.user?.id });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取量化运行时健康失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listStrategyExperiments(req: AuthenticatedRequest, res: Response) {
    try {
      const summary = await strategyEngine.listExperiments({
        limit: Number(req.query.limit || 80),
      });
      res.json({ success: true, data: summary });
    } catch (error: any) {
      logger.error('获取量化策略实验版本失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getExperimentParamSuggestions(req: AuthenticatedRequest, res: Response) {
    try {
      const suggestions = await strategyEngine.getExperimentParamSuggestions({
        limit: Number(req.query.limit || 300),
        min_rank_score: Number(req.query.min_rank_score || 8),
        min_excess_return_pct: Number(req.query.min_excess_return_pct || 0),
        min_trade_count: Number(req.query.min_trade_count || 1),
        max_drawdown_pct: Number(req.query.max_drawdown_pct || 35),
        min_stable_count: Number(req.query.min_stable_count || 1),
      });
      res.json({ success: true, data: suggestions });
    } catch (error: any) {
      logger.error('获取量化策略实验参数建议失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listParamVersions(req: AuthenticatedRequest, res: Response) {
    try {
      const dashboard = await strategyEngine.listParamVersions({
        limit: Number(req.query.limit || 200),
        strategy_key: req.query.strategy_key as string,
      });
      res.json({ success: true, data: dashboard });
    } catch (error: any) {
      logger.error('获取量化策略参数 A/B 验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getActiveScanParams(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys =
        typeof req.query.strategy_keys === 'string'
          ? req.query.strategy_keys
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
          : typeof req.query.strategyKeys === 'string'
          ? req.query.strategyKeys
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
          : undefined;
      const result = await strategyEngine.getActiveScanParams({
        strategy_keys,
        include_grid_search: req.query.include_grid_search !== 'false',
        include_experiment: req.query.include_experiment !== 'false',
        include_observing: req.query.include_observing === 'true',
        include_degraded: req.query.include_degraded === 'true',
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('获取开盘扫描参数版本失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshParamVersions(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await strategyEngine.refreshParamVersions({
        suggestion_options: req.body?.suggestion_options || req.body?.suggestionOptions || {},
        manual_params_by_strategy: req.body?.params_by_strategy || req.body?.paramsByStrategy,
        use_experiment_params:
          req.body?.use_experiment_params !== undefined
            ? Boolean(req.body.use_experiment_params)
            : req.body?.useExperimentParams !== undefined
            ? Boolean(req.body.useExperimentParams)
            : true,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略参数版本失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshParamValidations(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await strategyEngine.refreshParamValidations({
        trade_date: req.body?.trade_date || req.body?.tradeDate,
        start_date: req.body?.start_date || req.body?.startDate,
        end_date: req.body?.end_date || req.body?.endDate,
        strategy_keys: req.body?.strategy_keys || req.body?.strategyKeys,
        horizons: req.body?.horizons,
        limit: Number(req.body?.limit || 500),
        signal: req.body?.signal,
        refresh_limit: Number(req.body?.refresh_limit || req.body?.refreshLimit || 1000),
        include_completed: Boolean(req.body?.include_completed || req.body?.includeCompleted),
        auto_sync_benchmark: Boolean(req.body?.auto_sync_benchmark || req.body?.autoSyncBenchmark),
        dry_run_lifecycle: Boolean(req.body?.dry_run_lifecycle || req.body?.dryRunLifecycle),
        lifecycle_policy: req.body?.lifecycle_policy || req.body?.lifecyclePolicy,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略参数收益验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshParamLifecycle(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await strategyEngine.refreshParamLifecycle({
        dry_run: Boolean(req.body?.dry_run || req.body?.dryRun),
        policy: req.body?.policy,
        limit: Number(req.body?.limit || 5000),
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略参数生命周期失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createBacktest(req: AuthenticatedRequest, res: Response) {
    try {
      const asyncMode = req.body?.async !== false && req.body?.async_mode !== false;
      const result = await backtestEngine.create(req.body, req.user?.id, asyncMode);
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('运行量化跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createWalkForwardBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await backtestEngine.createWalkForward(req.body, req.user?.id);
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      logger.error('创建滚动验证跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ============================================================
  // Phase 1: Walk-Forward Validation (in-process, with DSR/PBO)
  // ============================================================

  /**
   * Phase 1: POST /api/quant/walk-forward
   * 触发一次完整 walk-forward 验证。同步返回（请求里建议设较长 timeout）。
   *
   * 请求体支持：
   *   - strategy_key (必填)
   *   - param_grid 或 param_bounds (取决于 optimizer_type)
   *   - base_config: { initial_capital, benchmark_symbol, universe, symbols, ... }
   *   - train_months / test_months / start_date / end_date
   *   - scheme: 'rolling' | 'cpcv' (默认 'rolling')
   *   - optimizer_type: 'grid_search' | 'bayesian' (默认 'grid_search')
   *   - purging: { label_horizon_days, embargo_days } | null
   *   - cpcv: { n_groups, k_test_groups }
   *
   * 返回 { run, windows, summary, best_window }
   */
  async runWalkForwardValidation(req: AuthenticatedRequest, res: Response) {
    try {
      const body = req.body || {};
      if (!body.strategy_key) {
        return res.status(400).json({ success: false, message: '缺少 strategy_key' });
      }
      if (!body.start_date || !body.end_date) {
        return res
          .status(400)
          .json({ success: false, message: '缺少 start_date 或 end_date' });
      }
      const result = await backtestEngine.runWalkForwardValidation(
        {
          strategy_key: body.strategy_key,
          param_grid: body.param_grid,
          param_bounds: body.param_bounds,
          base_config: body.base_config || {},
          train_months: body.train_months ?? 12,
          test_months: body.test_months ?? 3,
          start_date: body.start_date,
          end_date: body.end_date,
          scheme: body.scheme,
          optimizer_type: body.optimizer_type,
          purging: body.purging,
          cpcv: body.cpcv,
        },
        {
          weights: body.weights,
          persist: body.persist !== false,
          persist_train: body.persist_train !== false,
          train_concurrency: body.train_concurrency,
          max_combos: body.max_combos,
          user_id: req.user?.id,
        }
      );
      res.json({
        success: true,
        data: {
          run_id: result.run?.id ?? null,
          summary: result.summary,
          windows: result.windows,
          best_window: result.best_window,
        },
        message: `Walk-forward 完成，${result.summary.completed_windows}/${result.summary.total_windows} 窗口通过，verdict=${result.summary.verdict}`,
      });
    } catch (error: any) {
      logger.error('Walk-forward 验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Phase 1: GET /api/quant/walk-forward/runs
   * Query: ?strategy_name=xxx&limit=30
   */
  async listWalkForwardRuns(req: AuthenticatedRequest, res: Response) {
    try {
      const runs = await backtestEngine.listWalkForwardRuns({
        strategy_name: req.query.strategy_name as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 30,
        user_id: req.query.user_id ? Number(req.query.user_id) : undefined,
      });
      res.json({ success: true, data: runs });
    } catch (error: any) {
      logger.error('查询 walk-forward runs 失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Phase 1: GET /api/quant/walk-forward/runs/:id/windows
   */
  async getWalkForwardWindows(req: AuthenticatedRequest, res: Response) {
    try {
      const runId = parseInt(req.params.id, 10);
      if (!Number.isFinite(runId)) {
        return res.status(400).json({ success: false, message: '非法 run_id' });
      }
      const windows = await backtestEngine.getWalkForwardWindows(runId);
      res.json({ success: true, data: windows });
    } catch (error: any) {
      logger.error('查询 walk-forward windows 失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Phase 1: DELETE /api/quant/walk-forward/runs/:id
   */
  async deleteWalkForwardRun(req: AuthenticatedRequest, res: Response) {
    try {
      const runId = parseInt(req.params.id, 10);
      if (!Number.isFinite(runId)) {
        return res.status(400).json({ success: false, message: '非法 run_id' });
      }
      const result = await backtestEngine.deleteWalkForwardRun(runId);
      res.json({ success: true, data: result, message: '已删除 walk-forward run' });
    } catch (error: any) {
      logger.error('删除 walk-forward run 失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createParameterGridBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await backtestEngine.createParameterGrid(req.body, req.user?.id);
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      logger.error('创建参数网格跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getParameterGridSummary(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await backtestEngine.summarizeParameterGrid({
        user_id: req.user?.id,
        group_id: req.query.group_id as string,
        limit: Number(req.query.limit || 300),
      });
      let param_versions: any = null;
      if (req.query.upsert_versions === 'true' || req.query.upsertVersions === 'true') {
        param_versions = await strategyEngine.upsertGridSearchCandidates({
          groups: data.groups,
          min_rank_score: Number(req.query.min_rank_score || 0),
        });
      }
      res.json({ success: true, data: { ...data, param_versions } });
    } catch (error: any) {
      logger.error('获取参数网格搜索汇总失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const tasks = await backtestEngine.list(req.user?.id, Number(req.query.limit || 30));
      res.json({ success: true, data: tasks });
    } catch (error: any) {
      logger.error('获取量化跑分任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getBacktest(req: Request, res: Response) {
    try {
      const data = await backtestEngine.get(Number(req.params.id));
      if (!data) return res.status(404).json({ success: false, message: '跑分任务不存在' });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取量化跑分详情失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async retryBacktest(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await backtestEngine.retry(Number(req.params.id), req.user?.id);
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('重试量化跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-016：回测对比 — 给定 2-4 个 task_id，返回每个 task 的元数据、策略指标
   * 和净值曲线。请求体：{ task_ids: number[] }。
   */
  async compareBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const rawIds = req.body?.task_ids ?? req.body?.taskIds ?? [];
      const taskIds = Array.isArray(rawIds)
        ? rawIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
        : [];
      const data = await backtestEngine.compare(taskIds);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('对比量化跑分失败:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  }

  /**
   * US-075：取冠军策略回撤序列（per-day drawdown_pct）。前端 LabWorkspace 回测对比
   * tab 叠加多任务的曲线。
   */
  async getBacktestDrawdownSeries(req: Request, res: Response) {
    try {
      const data = await backtestEngine.getDrawdownSeries(Number(req.params.id));
      if (!data)
        return res.status(404).json({ success: false, message: '跑分任务不存在或暂无结果' });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取回测回撤序列失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-075：取冠军策略月度收益（year × month 矩阵）。前端用于热力图渲染。
   */
  async getBacktestMonthlyReturns(req: Request, res: Response) {
    try {
      const data = await backtestEngine.getMonthlyReturns(Number(req.params.id));
      if (!data)
        return res.status(404).json({ success: false, message: '跑分任务不存在或暂无结果' });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取回测月度收益失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-075：取冠军策略滚动 N 日（默认 90）夏普序列。?window=N 可调，限制 2-252。
   */
  async getBacktestRollingSharpe(req: Request, res: Response) {
    try {
      const window = req.query.window ? Number(req.query.window) : 90;
      const data = await backtestEngine.getRollingSharpeSeries(Number(req.params.id), window);
      if (!data)
        return res.status(404).json({ success: false, message: '跑分任务不存在或暂无结果' });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取回测滚动夏普失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-085：交易成本敏感性分析 — 对一个已完成 backtest 按 3 档佣金（万 1.5 /
   * 万 2.5 / 万 5）重跑，每档写一行 (base_run_id, strategy_key, cost_level)
   * 到 CostSensitivityResult。
   *
   * Body 可选：
   *   - `cost_levels?: string[]` — 仅分析指定档（默认全部 3 档）
   *   - `dry_run?: boolean` — 不落库，仅返回结果
   *   - `metadata?: Record<string, any>` — 写入 row.metadata_json
   */
  async runCostSensitivityAnalysis(req: AuthenticatedRequest, res: Response) {
    try {
      const taskId = Number(req.params.id);
      if (!Number.isFinite(taskId) || taskId <= 0) {
        return res.status(400).json({ success: false, message: 'task id 无效' });
      }
      const rawLevels = req.body?.cost_levels ?? req.body?.costLevels;
      const cost_levels = Array.isArray(rawLevels)
        ? rawLevels.map((l: any) => String(l).trim()).filter(Boolean)
        : undefined;
      const persist = !(req.body?.dry_run === true || req.body?.dryRun === true);
      const metadata = {
        ...(req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
        triggered_by_user_id: req.user?.id ?? null,
        triggered_at: new Date().toISOString(),
      };
      const data = await backtestEngine.runCostSensitivityAnalysis(taskId, {
        cost_levels,
        persist,
        metadata,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('交易成本敏感性分析失败:', error);
      const status =
        typeof error?.message === 'string' && error.message.includes('不存在') ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  }

  async generateSignals(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys = await strategyEngine.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = {
        ...(await strategyEngine.getDefaultParamsByStrategy(strategy_keys)),
        ...(req.body?.params_by_strategy || req.body?.paramsByStrategy || {}),
      };
      const result = await signalEngine.generate({
        ...req.body,
        strategy_keys,
        params_by_strategy,
        user_id: req.user?.id,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('生成量化信号失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async runDailyPipeline(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys = await strategyEngine.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = req.body?.params_by_strategy || req.body?.paramsByStrategy;
      const result = await strategyEngine.runDailyPipeline({
        ...req.body,
        strategy_keys,
        params_by_strategy,
        user_id: req.user?.id,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('运行量化融合闭环失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listSignals(req: Request, res: Response) {
    try {
      const signals = await signalEngine.list(req.query as any);
      res.json({ success: true, data: signals });
    } catch (error: any) {
      logger.error('获取量化信号失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshStrategyWeights(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await strategyEngine.refreshWeights(req.body || {});
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略权重失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listStrategyWeights(_req: AuthenticatedRequest, res: Response) {
    try {
      const weights = await strategyEngine.listWeights();
      res.json({ success: true, data: weights });
    } catch (error: any) {
      logger.error('获取量化策略权重失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getAllocationPolicy(req: AuthenticatedRequest, res: Response) {
    try {
      const policy = await strategyEngine.getAllocationPolicy({
        capital: Number(req.query.capital || req.body?.capital || 200000),
        max_weight_pct: Number(req.query.max_weight_pct || req.body?.max_weight_pct || 35),
        min_weight_pct: Number(req.query.min_weight_pct || req.body?.min_weight_pct || 4),
      });
      res.json({ success: true, data: policy });
    } catch (error: any) {
      logger.error('获取量化策略资金分配建议失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listFusionAudits(req: AuthenticatedRequest, res: Response) {
    try {
      const audits = await signalEngine.listAudits(req.query as any);
      res.json({ success: true, data: audits });
    } catch (error: any) {
      logger.error('获取量化融合审计失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getRankings(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await signalEngine.getRankings({
        trade_date: req.query.trade_date as string,
        signal_date: (req.query.signal_date || req.query.trade_date) as string,
        limit: Number(req.query.limit || 30),
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取量化排行榜失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/quant/strategy-leaderboard
   * 策略排行榜：按 sharpe / annual_return / max_drawdown 综合排序所有策略
   * 每个策略取它最新的 backtest 结果
   */
  async getStrategyLeaderboard(req: AuthenticatedRequest, res: Response) {
    try {
      const { QuantBacktestResult } = require('../../models/QuantBacktestResult');
      const sortBy = (req.query.sort_by as string) || 'sharpe';
      // 取每个 strategy_key 最新的 backtest
      const rows = await QuantBacktestResult.findAll({
        attributes: [
          'strategy_key', 'strategy_name', 'task_id', 'total_return_pct', 'annual_return_pct',
          'max_drawdown_pct', 'sharpe_ratio', 'win_rate', 'profit_factor',
          'trade_count', 'benchmark_return_pct', 'excess_return_pct', 'created_at',
        ],
        order: [['created_at', 'DESC']],
        raw: true,
        limit: 500,
      });
      // 按 strategy_key 去重，保留最新
      const latestByKey = new Map<string, any>();
      for (const r of rows as any[]) {
        if (!latestByKey.has(r.strategy_key)) {
          latestByKey.set(r.strategy_key, r);
        }
      }
      const items = Array.from(latestByKey.values()).filter(r => {
        const v = Number(r[sortBy === 'annual' ? 'annual_return_pct' : sortBy === 'sharpe' ? 'sharpe_ratio' : 'total_return_pct']);
        return Number.isFinite(v);
      });
      // 排序
      items.sort((a, b) => {
        const va = Number(a[sortBy === 'annual' ? 'annual_return_pct' : sortBy === 'sharpe' ? 'sharpe_ratio' : 'total_return_pct']) || 0;
        const vb = Number(b[sortBy === 'annual' ? 'annual_return_pct' : sortBy === 'sharpe' ? 'sharpe_ratio' : 'total_return_pct']) || 0;
        return vb - va;
      });
      res.json({ success: true, data: { items, sort_by: sortBy, count: items.length } });
    } catch (error: any) {
      logger.error('获取策略排行榜失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const quantController = new QuantController();
