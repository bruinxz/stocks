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

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

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

      return res.json({ success: true, data: result });
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
}

export const aiAdvisorController = new AIAdvisorController();
