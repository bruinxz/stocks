import { Request, Response } from 'express';
import { bridgeService } from '../services/BridgeService';
import { killSwitchService } from '../services/KillSwitchService';
import { logger } from '../../utils/logger';

function ctxOrFail(req: Request, res: Response) {
  if (!req.bridgeAuth) {
    res.status(401).json({ success: false, message: 'bridge 鉴权上下文缺失' });
    return null;
  }
  return req.bridgeAuth;
}

class BridgeController {
  async heartbeat(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const result = await bridgeService.ingestHeartbeat(ctx, req.body || {});
      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error('bridge heartbeat 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge heartbeat 失败' });
    }
  }

  async accountSnapshot(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const result = await bridgeService.ingestAccountSnapshot(ctx, req.body || {});
      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error('bridge accountSnapshot 失败:', e);
      res
        .status(400)
        .json({ success: false, message: e?.message || 'bridge accountSnapshot 失败' });
    }
  }

  async positions(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const arr = Array.isArray(body) ? body : body.positions || [];
      const result = await bridgeService.ingestPositions(ctx, arr);
      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error('bridge positions 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge positions 失败' });
    }
  }

  async orders(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const arr = Array.isArray(body) ? body : body.orders || [];
      const result = await bridgeService.ingestOrders(ctx, arr);
      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error('bridge orders 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge orders 失败' });
    }
  }

  async trades(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const arr = Array.isArray(body) ? body : body.trades || [];
      const result = await bridgeService.ingestTrades(ctx, arr);
      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error('bridge trades 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge trades 失败' });
    }
  }

  /** 长轮询拉取 pending 命令 */
  async pullCommands(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      // kill switch 触发时立刻强制超时返回 204
      let killed = false;
      const onKill = () => {
        killed = true;
      };
      killSwitchService.on('kill_switch_triggered', onKill);
      // 监听客户端断开
      let clientClosed = false;
      req.on('close', () => {
        clientClosed = true;
      });
      try {
        const wait = req.query.wait != null ? Number(req.query.wait) : 30;
        const limit = req.query.limit != null ? Number(req.query.limit) : 10;
        // 直接传整个 wait 给 service，由 service tick 判 abort，避免外层切片放大 DB 压力
        const result = await bridgeService.pullPendingCommands(ctx, {
          wait_seconds: wait,
          limit,
          channel: 'long_poll',
          abort: () => killed || clientClosed,
        });
        if (killed) {
          return res.status(204).end();
        }
        res.json({ success: true, data: result });
      } finally {
        killSwitchService.off('kill_switch_triggered', onKill);
      }
    } catch (e: any) {
      logger.error('bridge pullCommands 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge pullCommands 失败' });
    }
  }

  /** SSE 通道：撤单等高时效命令立刻 push */
  async streamCommands(req: Request, res: Response) {
    const ctx = ctxOrFail(req, res);
    if (!ctx) return;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let closed = false;
    const flush = (event: string, data: any) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(': heartbeat\n\n');
      } catch {
        closed = true;
        clearInterval(heartbeat);
      }
    }, 15000);
    const onKill = (state: any) => {
      flush('kill_switch', state);
      closed = true;
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {}
    };
    killSwitchService.on('kill_switch_triggered', onKill);
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      killSwitchService.off('kill_switch_triggered', onKill);
      try {
        res.end();
      } catch {}
    });

    let backoff = 500;
    while (!closed) {
      try {
        const result = await bridgeService.pullPendingCommands(ctx, {
          wait_seconds: 25,
          limit: 10,
          channel: 'sse',
          abort: () => closed,
        });
        backoff = 500;
        if (result.commands.length) {
          for (const cmd of result.commands) flush('command', cmd);
        }
      } catch (e: any) {
        logger.warn('SSE pull failed:', e?.message || e);
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
    clearInterval(heartbeat);
    killSwitchService.off('kill_switch_triggered', onKill);
    try {
      res.end();
    } catch {}
  }

  async ackCommand(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const commandId = Number(req.params.id);
      if (!Number.isFinite(commandId)) {
        return res.status(400).json({ success: false, message: 'command id 不合法' });
      }
      const result = await bridgeService.ackCommand(ctx, commandId);
      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error('bridge ackCommand 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge ackCommand 失败' });
    }
  }

  async orderEvents(req: Request, res: Response) {
    try {
      const ctx = ctxOrFail(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const events = Array.isArray(body) ? body : body.events || [body];
      const results: any[] = [];
      for (const ev of events) {
        try {
          const r = await bridgeService.ingestOrderEvent(ctx, ev);
          results.push({ command_id: ev.command_id, ...r });
        } catch (e: any) {
          results.push({
            command_id: ev.command_id,
            accepted: false,
            reason: e?.message || 'error',
          });
        }
      }
      res.json({ success: true, data: { results } });
    } catch (e: any) {
      logger.error('bridge orderEvents 失败:', e);
      res.status(400).json({ success: false, message: e?.message || 'bridge orderEvents 失败' });
    }
  }
}

export const bridgeController = new BridgeController();
