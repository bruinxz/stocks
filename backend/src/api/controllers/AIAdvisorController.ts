import { Request, Response, NextFunction } from 'express';
import { aiAdvisorService } from '../../services/AIAdvisorService';
import { logger } from '../../utils/logger';
import { Stock } from '../../models/Stock';
import { Op } from 'sequelize';
import axios from 'axios';
import { aiInvestmentSignalService } from '../../services/AIInvestmentSignalService';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

export class AIAdvisorController {
  constructor() {
    this.streamAnalyze = this.streamAnalyze.bind(this);
    this.analyze = this.analyze.bind(this);
    this.getTask = this.getTask.bind(this);
    this.resolveTicker = this.resolveTicker.bind(this);
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
        name: { [Op.like]: `%${input}%` }
      }
    });

    if (stock) {
      return stock.symbol;
    }

    return null;
  }

  async analyze(req: Request, res: Response, next: NextFunction) {
    try {
      const { ticker, targetDate, isAsync } = req.body;
      if (!ticker) {
        return res.status(400).json({ success: false, message: '股票代码或名称 (ticker) 不能为空' });
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
        return res.status(400).json({ success: false, message: '股票代码或名称 (ticker) 不能为空' });
      }

      const resolvedTicker = await this.resolveTicker(tickerInput);
      if (!resolvedTicker) {
        return res.status(404).json({ success: false, message: `无法识别股票: ${tickerInput}` });
      }

      const target_date = req.query.target_date as string;

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

      streamResponse.data.pipe(res);

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
}

export const aiAdvisorController = new AIAdvisorController();
