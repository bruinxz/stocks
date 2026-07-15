import { Request, Response, NextFunction } from 'express';
import {
  aiAdvisorService,
  normalizeAnalysisDimensions,
  AnalysisDimension,
} from '../../services/AIAdvisorService';
import { AIStockAnalysisReport } from '../../models/AIStockAnalysisReport';
import { logger } from '../../utils/logger';
import { Stock } from '../../models/Stock';
import { Op } from 'sequelize';
import axios from 'axios';
import {
  aiInvestmentSignalService,
  inferAgentSession,
} from '../../services/AIInvestmentSignalService';
import {
  technicalAnalysisService,
  normalizeLookbackDays,
} from '../../services/TechnicalAnalysisService';
import { marketBriefService } from '../../services/MarketBriefService';
import { TRADING_AGENTS_BASE_URL } from '../../config/externalServices';

// audit L-19: 集中常量, 不再硬编码 IP.
const TRADING_AGENTS_URL = TRADING_AGENTS_BASE_URL;

export class AIAdvisorController {
  constructor() {
    this.streamAnalyze = this.streamAnalyze.bind(this);
    this.analyze = this.analyze.bind(this);
    this.getTask = this.getTask.bind(this);
    this.getHealth = this.getHealth.bind(this);
    this.resolveTicker = this.resolveTicker.bind(this);
    this.analyzeSingleStock = this.analyzeSingleStock.bind(this);
    this.streamSingleStockAnalysis = this.streamSingleStockAnalysis.bind(this);
    this.getReportById = this.getReportById.bind(this);
    this.listReports = this.listReports.bind(this);
    this.getTechnicalAnalysis = this.getTechnicalAnalysis.bind(this);
    this.getMarketBriefToday = this.getMarketBriefToday.bind(this);
  }

  /**
   * 将用户输入的代码或名称解析为实际的股票代码 (ticker)
   */
  private async resolveTicker(input: string): Promise<string | null> {
    if (!input) return null;

    // 如果看起来已经是合法的 ticker 格式 (例如 sh.600000 或 sz.000001)
    if (/^(sh\.|sz\.|bj\.)?\d{6}$/.test(input.toLowerCase())) {
      // 如果只有6位数字，尝试补全
      if (/^\d{6}$/.test(input)) {
        const stock = await Stock.findOne({ where: { symbol: { [Op.like]: `%${input}%` } } });
        if (stock) return stock.symbol;
      }
      return input.toLowerCase();
    }

    // 否则当做股票名称去数据库查询
    const stock = await Stock.findOne({
      where: {
        name: { [Op.like]: `%${input}%` },
      },
    });

    if (stock) {
      return stock.symbol;
    }

    return null;
  }

  async getHealth(req: Request, res: Response, next: NextFunction) {
    try {
      const health = await aiAdvisorService.getHealth(req.query.refresh === 'true');
      res.json({ success: true, data: health });
    } catch (error: any) {
      logger.error('获取 TradingAgents 健康状态失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async analyze(req: Request, res: Response, next: NextFunction) {
    try {
      const { ticker, targetDate, isAsync, task_label, agent_session } = req.body;
      if (!ticker) {
        return res
          .status(400)
          .json({ success: false, message: '股票代码或名称 (ticker) 不能为空' });
      }

      const resolvedTicker = await this.resolveTicker(ticker);
      if (!resolvedTicker) {
        return res.status(404).json({ success: false, message: `无法识别股票: ${ticker}` });
      }

      const result = await aiAdvisorService.analyzeStock(resolvedTicker, targetDate, isAsync);

      // 同步分析完成后自动归档为可后验验证的 AI 投研信号；异步任务仍由轮询结果后续归档。
      if (!isAsync && result?.status === 'COMPLETED' && result?.data) {
        try {
          const archivedSignal = await aiInvestmentSignalService.archiveTradingAgentsResult({
            task_id: result.task_id,
            symbol: resolvedTicker,
            signal_date: result.target_date,
            decision: result.data.decision,
            rationale: result.data.rationale,
            detail: result.data.detail,
            source_type: 'tradingagents',
            task_label,
            agent_session: agent_session || inferAgentSession(task_label),
          });
          await aiInvestmentSignalService.verifySignalReturns(archivedSignal);
        } catch (archiveError: any) {
          logger.warn(`AI 分析结果归档失败: ${archiveError.message}`);
        }
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      logger.error('提交 AI 分析任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getTask(req: Request, res: Response, next: NextFunction) {
    try {
      const { taskId } = req.params;
      if (!taskId) {
        return res.status(400).json({ success: false, message: '任务ID 不能为空' });
      }

      const result = await aiAdvisorService.getTaskStatus(taskId);

      if (result?.status === 'COMPLETED' && result?.data) {
        try {
          const archivedSignal = await aiInvestmentSignalService.archiveTradingAgentsResult({
            task_id: result.task_id,
            symbol: result.ticker,
            signal_date: result.target_date,
            decision: result.data.decision,
            rationale: result.data.rationale,
            detail: result.data.detail,
            source_type: 'tradingagents',
            task_label: result.task_label,
            agent_session: inferAgentSession(result.task_label),
          });
          await aiInvestmentSignalService.verifySignalReturns(archivedSignal);
        } catch (archiveError: any) {
          logger.warn(`AI 异步任务结果归档失败: ${archiveError.message}`);
        }
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      logger.error('查询 AI 分析任务状态失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * 代理 SSE 请求，避免跨域和直连暴露外部服务 IP
   */
  async streamAnalyze(req: Request, res: Response, next: NextFunction) {
    try {
      const tickerInput = req.query.ticker as string;
      if (!tickerInput) {
        return res
          .status(400)
          .json({ success: false, message: '股票代码或名称 (ticker) 不能为空' });
      }

      const resolvedTicker = await this.resolveTicker(tickerInput);
      if (!resolvedTicker) {
        return res.status(404).json({ success: false, message: `无法识别股票: ${tickerInput}` });
      }

      const target_date = req.query.target_date as string;
      const task_label = req.query.task_label as string;
      const agent_session =
        (req.query.agent_session as string) || inferAgentSession(task_label, new Date());

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let url = `${TRADING_AGENTS_URL}/api/analyze/stream?ticker=${resolvedTicker}`;
      if (target_date) {
        url += `&target_date=${target_date}`;
      }

      logger.info(`Forwarding SSE request to TradingAgent: ${url}`);

      const streamResponse = await axios.get(url, {
        responseType: 'stream',
        timeout: 1200000, // 将超时时间增加到 20 分钟 (1,200,000 毫秒)
        headers: {
          Accept: 'text/event-stream',
        },
      });

      let finalDecision = '';
      let streamBuffer = '';

      streamResponse.data.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        streamBuffer += text;
        const events = streamBuffer.split('\n\n');
        streamBuffer = events.pop() || '';

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(line => line.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.replace(/^data:\s*/, ''));
            if (payload.type === 'completed' && payload.decision) {
              finalDecision = payload.decision;
            }
          } catch {
            // 忽略非标准 SSE 片段，继续透传给前端。
          }
        }
      });

      streamResponse.data.pipe(res);

      streamResponse.data.on('end', async () => {
        if (!finalDecision) return;
        try {
          const archivedSignal = await aiInvestmentSignalService.archiveTradingAgentsResult({
            symbol: resolvedTicker,
            signal_date: target_date,
            decision: finalDecision,
            rationale: finalDecision,
            detail: { text: finalDecision, stream: true },
            source_type: 'tradingagents',
            task_label,
            agent_session,
          });
          await aiInvestmentSignalService.verifySignalReturns(archivedSignal);
        } catch (archiveError: any) {
          logger.warn(`AI SSE 结果归档失败: ${archiveError.message}`);
        }
      });

      streamResponse.data.on('error', (err: any) => {
        logger.error('AI SSE stream error:', err);
        if (!res.headersSent) res.end();
      });

      req.on('close', () => {
        streamResponse.data.destroy();
      });
    } catch (error: any) {
      logger.error('AI SSE 代理请求失败:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: '无法建立 AI 分析数据流' });
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  US-055 — 单股深度问答
  // ---------------------------------------------------------------------------

  /**
   * POST /api/ai/analyze-stock — 单股深度分析（普通 JSON 返回）。
   *
   * Body:
   *   - stock_code:   股票代码或名称（必填）
   *   - dimensions:   要分析的维度子集；不传或空数组 = 全 5 维度
   *   - target_date:  目标日期（YYYY-MM-DD）；不传则取当日
   *   - dry_run:      不写表，仅返回结果（前端预览用）
   *   - is_async:     异步任务模式（TradingAgents 后台跑，立即返回 task_id）
   *   - task_label:   任务来源标签（PortfolioWorkspace / FactorWorkspace 等）
   */
  async analyzeSingleStock(req: Request, res: Response, next: NextFunction) {
    try {
      const { stock_code, dimensions, target_date, dry_run, is_async, task_label, stock_name } =
        req.body || {};

      if (!stock_code || typeof stock_code !== 'string') {
        return res
          .status(400)
          .json({ success: false, message: 'stock_code 不能为空（股票代码或名称）' });
      }

      const resolvedTicker = await this.resolveTicker(stock_code);
      if (!resolvedTicker) {
        return res.status(404).json({ success: false, message: `无法识别股票: ${stock_code}` });
      }

      const normalizedDimensions: AnalysisDimension[] = normalizeAnalysisDimensions(dimensions);

      const userId = (req as any).user?.id;

      const result = await aiAdvisorService.analyzeSingleStock(resolvedTicker, {
        dimensions: normalizedDimensions,
        target_date: typeof target_date === 'string' ? target_date : undefined,
        dry_run: dry_run === true,
        is_async: is_async === true,
        task_label: typeof task_label === 'string' ? task_label : undefined,
        stock_name: typeof stock_name === 'string' ? stock_name : undefined,
        user_id: typeof userId === 'number' ? userId : undefined,
      });

      // Bug AY-12 fix: data.status 是远端 / 引擎实际结果, success 必须随之.
      // 之前永远 return { success: true } 即使 status='failed' 让前端拿不到错误信号.
      // 现在: failed/pending 都返 success=false (HTTP 仍 200 保持兼容), message 字段
      // 走前端 throw 路径让用户看到 toast; completed/partial 维持 success=true.
      const status = (result as any)?.status;
      const ok = status === 'completed' || status === 'partial';
      if (ok) {
        return res.json({ success: true, data: result });
      }
      const errMsg = (result as any)?.error || '';
      return res.json({
        success: false,
        data: result,
        message: `AI 分析未完成 (status=${status || 'unknown'})${errMsg ? ': ' + errMsg : ''}`,
      });
    } catch (error: any) {
      logger.error('analyzeSingleStock 失败:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/ai/analyze-stock/stream — 单股深度分析（SSE 流式返回）。
   *
   * Query params:
   *   - stock_code:   股票代码或名称（必填）
   *   - dimensions:   逗号分隔的维度（e.g. "fundamental,technical"）；不传 = 全 5 维度
   *   - target_date:  目标日期（YYYY-MM-DD）；不传则取当日
   *   - task_label:   任务来源标签
   *
   * Stream events (newline-delimited):
   *   - event: status, data: {phase: "calling_tradingagents"}
   *   - event: payload, data: <raw TradingAgents SSE payload>
   *   - event: completed, data: <AnalyzeSingleStockResult>
   *   - event: error, data: {message}
   */
  async streamSingleStockAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const stockCodeInput = req.query.stock_code as string;
      if (!stockCodeInput) {
        return res
          .status(400)
          .json({ success: false, message: 'stock_code 不能为空（股票代码或名称）' });
      }

      const resolvedTicker = await this.resolveTicker(stockCodeInput);
      if (!resolvedTicker) {
        return res.status(404).json({ success: false, message: `无法识别股票: ${stockCodeInput}` });
      }

      const dimensions = normalizeAnalysisDimensions(
        typeof req.query.dimensions === 'string'
          ? (req.query.dimensions as string).split(',')
          : undefined
      );

      const targetDate = req.query.target_date as string | undefined;
      const taskLabel = (req.query.task_label as string) || 'single_stock_stream';

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent('status', {
        phase: 'starting',
        stock_code: resolvedTicker,
        dimensions,
      });

      // 透传上游 TradingAgents SSE，最后用一次同步 analyzeSingleStock 落库 & 给前端 completed 事件
      try {
        let url = `${TRADING_AGENTS_URL}/api/analyze/stream?ticker=${resolvedTicker}`;
        if (targetDate) {
          url += `&target_date=${targetDate}`;
        }

        const streamResponse = await axios
          .get(url, {
            responseType: 'stream',
            timeout: 1200000,
            headers: { Accept: 'text/event-stream' },
          })
          .catch((err: any) => {
            // 上游 SSE 不可用时退回同步路径
            logger.warn(`TradingAgents SSE unavailable, falling back to sync: ${err.message}`);
            return null;
          });

        let streamedBuffer = '';
        let upstreamClosed = false;

        if (streamResponse) {
          streamResponse.data.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            streamedBuffer += text;
            const events = streamedBuffer.split('\n\n');
            streamedBuffer = events.pop() || '';
            for (const evt of events) {
              const dataLine = evt.split('\n').find(line => line.startsWith('data:'));
              if (!dataLine) continue;
              const payloadStr = dataLine.replace(/^data:\s*/, '');
              try {
                const parsed = JSON.parse(payloadStr);
                sendEvent('payload', parsed);
              } catch {
                // 无法解析的片段透传成 raw
                sendEvent('payload', { raw: payloadStr });
              }
            }
          });

          await new Promise<void>(resolve => {
            streamResponse.data.on('end', () => {
              upstreamClosed = true;
              resolve();
            });
            streamResponse.data.on('error', (err: any) => {
              logger.warn(`Upstream SSE error: ${err.message}`);
              upstreamClosed = true;
              resolve();
            });
            req.on('close', () => {
              streamResponse.data.destroy();
              upstreamClosed = true;
              resolve();
            });
          });
        }

        // 最终一次 sync 调用拉回 final result + 落库
        sendEvent('status', { phase: 'finalizing' });
        const userId = (req as any).user?.id;
        const finalResult = await aiAdvisorService.analyzeSingleStock(resolvedTicker, {
          dimensions,
          target_date: targetDate,
          task_label: taskLabel,
          user_id: typeof userId === 'number' ? userId : undefined,
        });

        sendEvent('completed', finalResult);
        res.end();
      } catch (innerErr: any) {
        logger.error('streamSingleStockAnalysis upstream error:', innerErr);
        sendEvent('error', { message: innerErr.message || '上游 SSE 失败' });
        res.end();
      }
    } catch (error: any) {
      logger.error('streamSingleStockAnalysis 失败:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: error.message });
      } else {
        try {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * GET /api/ai/analyze-stock/reports/:reportId — 单条 AI 分析报告详情。
   */
  async getReportById(req: Request, res: Response, next: NextFunction) {
    try {
      const { reportId } = req.params;
      if (!reportId) {
        return res.status(400).json({ success: false, message: 'reportId 不能为空' });
      }
      const row = await AIStockAnalysisReport.findOne({ where: { report_id: reportId } });
      if (!row) {
        return res
          .status(404)
          .json({ success: false, message: `未找到 report_id=${reportId} 的分析报告` });
      }
      return res.json({ success: true, data: row });
    } catch (error: any) {
      logger.error('getReportById 失败:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/ai/analyze-stock/reports — 列表查询（按 stock_code / 时间倒序）。
   */
  async listReports(req: Request, res: Response, next: NextFunction) {
    try {
      const stockCodeQuery = req.query.stock_code as string | undefined;
      const limit = Math.min(
        Math.max(parseInt((req.query.limit as string) || '20', 10) || 20, 1),
        200
      );
      const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);

      const where: any = {};
      if (stockCodeQuery) {
        const resolved = await this.resolveTicker(stockCodeQuery);
        where.stock_code = resolved || stockCodeQuery;
      }

      const rows = await AIStockAnalysisReport.findAll({
        where,
        order: [['generated_at', 'DESC']],
        limit,
        offset,
      });
      return res.json({ success: true, data: rows });
    } catch (error: any) {
      logger.error('listReports 失败:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // ---------------------------------------------------------------------------
  //  US-061 — AI 大模型技术面 K 线解读
  // ---------------------------------------------------------------------------

  /**
   * POST /api/ai/technical-analysis
   *
   * Body:
   *   - stock_code:    股票代码 / 名称 (必填)
   *   - lookback_days: K 线回看天数 (默认 60, 范围 20-250, service 层 clamp)
   *   - force_refresh: 强制刷新跳过 24h 缓存 (默认 false)
   *   - dry_run:       不写表 (默认 false, 前端预览用)
   *   - task_label:    任务来源标签 (写入 metadata)
   *
   * Returns:
   *   { success: true, data: {
   *       stock_code, stock_name, lookback_days,
   *       trend, support_levels, resistance_levels,
   *       buy_zone, sell_zone, summary, confidence,
   *       status, nlp_engine, indicators_snapshot,
   *       from_cache, persisted, generated_at, expires_at, error, metadata
   *   } }
   */
  async getTechnicalAnalysis(req: Request, res: Response, _next: NextFunction) {
    try {
      const body = req.body || {};
      const stockCodeInput = typeof body.stock_code === 'string' ? body.stock_code.trim() : '';
      if (!stockCodeInput) {
        return res
          .status(400)
          .json({ success: false, message: 'stock_code 不能为空（股票代码或名称）' });
      }

      const resolvedTicker = await this.resolveTicker(stockCodeInput);
      if (!resolvedTicker) {
        return res.status(404).json({
          success: false,
          message: `无法识别股票: ${stockCodeInput}`,
        });
      }

      // 静默退回默认而不 4xx (与 normalizeXxxConfig 模式一致)
      const lookbackDays = normalizeLookbackDays(body.lookback_days);

      const userId = (req as any).user?.id;
      const result = await technicalAnalysisService.analyze(resolvedTicker, lookbackDays, {
        force_refresh: body.force_refresh === true,
        dry_run: body.dry_run === true,
        task_label: typeof body.task_label === 'string' ? body.task_label : undefined,
        user_id: typeof userId === 'number' ? userId : undefined,
      });

      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('getTechnicalAnalysis 失败:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/ai/market-brief/today
   *
   * US-073 — TodayWorkspace 顶部 AI 大盘速读卡片 的数据源。
   *
   * 行为：
   *   - 优先从 DB 缓存读取当日记录（一日一行，由 SchedulerService 08:30 cron
   *     生成）；
   *   - 若当日尚未生成（机器重启 / cron miss / 首次访问） → 懒求值触发
   *     `computeAndPersist` 同步生成并返回。
   *
   * Query 参数：
   *   - `date=YYYY-MM-DD`：可选，覆盖默认"今日 Asia/Shanghai"；
   *   - `refresh=true`：强制重新生成（绕过 cache，e.g. ops 重跑）。
   */
  async getMarketBriefToday(req: Request, res: Response, _next: NextFunction) {
    try {
      const date = (req.query.date as string | undefined)?.trim() || undefined;
      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
      const result = refresh
        ? await marketBriefService.computeAndPersist({ trade_date: date })
        : await marketBriefService.getTodayBrief({ trade_date: date });
      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('getMarketBriefToday 失败:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const aiAdvisorController = new AIAdvisorController();
