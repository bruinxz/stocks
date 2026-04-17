import { Request, Response, NextFunction } from 'express';
import { aiAdvisorService } from '../../services/AIAdvisorService';
import { logger } from '../../utils/logger';
import axios from 'axios';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

export class AIAdvisorController {
  async analyze(req: Request, res: Response, next: NextFunction) {
    try {
      const { ticker, targetDate, isAsync } = req.body;
      if (!ticker) {
        return res.status(400).json({ success: false, message: '股票代码 (ticker) 不能为空' });
      }

      const result = await aiAdvisorService.analyzeStock(ticker, targetDate, isAsync);
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
      const { ticker, target_date } = req.query;
      if (!ticker) {
        return res.status(400).json({ success: false, message: '股票代码 (ticker) 不能为空' });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let url = `${TRADING_AGENTS_URL}/api/analyze/stream?ticker=${ticker}`;
      if (target_date) {
        url += `&target_date=${target_date}`;
      }

      const streamResponse = await axios.get(url, {
        responseType: 'stream',
        timeout: 60000, // 增加 60 秒超时，防止下游服务挂起导致内存泄漏
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
