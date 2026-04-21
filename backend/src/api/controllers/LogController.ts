import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

export class LogController {
  private logDir: string;

  constructor() {
    // 根据项目结构，logs文件夹通常在 backend 根目录下
    this.logDir = path.join(process.cwd(), 'logs');
  }

  /**
   * @desc 获取系统日志列表 (支持分页、级别过滤、关键词搜索)
   */
  getLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 100;
      const level = req.query.level as string; // 'info', 'warn', 'error'
      const keyword = req.query.keyword as string; // 关键词搜索
      const type = req.query.type as string; // 'combined' or 'error'

      // 确定要读取的文件
      const logFileName = type === 'error' ? 'error.log' : 'combined.log';
      const logFilePath = path.join(this.logDir, logFileName);

      if (!fs.existsSync(logFilePath)) {
        res.status(404).json({ success: false, message: '日志文件不存在', data: [] });
        return;
      }

      const logs: any[] = [];
      const fileStream = fs.createReadStream(logFilePath, 'utf-8');
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      // 逐行读取并过滤
      for await (const line of rl) {
        if (!line.trim()) continue;
        
        // 剥离老日志中可能残留的 ANSI 颜色控制字符（如 [32m 等）
        // \x1b 或 \u001b 表示 ESC，\[ 匹配左括号，[0-9;]* 匹配数字或分号，[a-zA-Z] 匹配结尾的字母(通常是m)
        const cleanLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        // 简单正则匹配解析 winston printf 格式: `${info.timestamp} ${info.level}: ${info.message}`
        // 例如: "2026-04-20 09:21:31.213 info: 数据更新队列处理器已启动" 或 "2026-04-20 09:21:31:2131 info: ..."
        const match = cleanLine.match(/^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}[.:]\d+)\s+([a-zA-Z]+):\s+(.*)$/);
        
        let logEntry;
        if (match) {
          logEntry = {
            timestamp: match[1],
            level: match[2].toLowerCase(),
            message: match[3],
            raw: cleanLine,
          };
        } else {
          // 如果解析失败，可能是多行日志的堆栈，将其标记为上一个日志的追加或未知格式
          logEntry = {
            timestamp: '',
            level: 'unknown',
            message: cleanLine,
            raw: cleanLine,
          };
        }

        // 过滤条件：级别
        if (level && logEntry.level !== level.toLowerCase() && logEntry.level !== 'unknown') {
          continue;
        }

        // 过滤条件：关键词 (大小写不敏感)
        if (keyword && !cleanLine.toLowerCase().includes(keyword.toLowerCase())) {
          continue;
        }

        logs.push(logEntry);
      }

      // 因为我们是从文件头读取到尾，最新日志在最后。反转数组让最新日志在前
      logs.reverse();

      // 分页
      const total = logs.length;
      const totalPages = Math.ceil(total / limit);
      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const paginatedLogs = logs.slice(startIndex, endIndex);

      res.json({
        success: true,
        data: {
          logs: paginatedLogs,
          pagination: {
            page,
            limit,
            total,
            totalPages,
          },
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, message: '读取日志失败', error: error.message });
    }
  };

  /**
   * @desc 获取日志统计数据 (例如各级别日志数量，用于前端图表)
   */
  getLogStats = async (req: Request, res: Response): Promise<void> => {
    try {
      const logFilePath = path.join(this.logDir, 'combined.log');
      if (!fs.existsSync(logFilePath)) {
        res.json({ success: true, data: { info: 0, warn: 0, error: 0, debug: 0 } });
        return;
      }

      const stats: Record<string, number> = { info: 0, warn: 0, error: 0, debug: 0 };
      const fileStream = fs.createReadStream(logFilePath, 'utf-8');
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        const cleanLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        const match = cleanLine.match(/^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}[.:]\d+)\s+([a-zA-Z]+):/);
        if (match) {
          const level = match[2].toLowerCase();
          if (stats[level] !== undefined) {
            stats[level]++;
          } else {
            stats[level] = 1;
          }
        }
      }

      res.json({ success: true, data: stats });
    } catch (error: any) {
      res.status(500).json({ success: false, message: '读取日志统计失败', error: error.message });
    }
  };
}
