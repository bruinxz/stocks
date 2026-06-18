import winston from 'winston';
import path from 'path';
import moment from 'moment-timezone';
import { ensureLogsRuntime, getLogsRoot } from './runtimePaths';

// 强制所有通过 logger 的时间都是北京时间
const appendTimestamp = winston.format((info, opts: any) => {
  if (opts.tz) {
    info.timestamp = moment().tz(opts.tz).format('YYYY-MM-DD HH:mm:ss.SSS');
  }
  return info;
});

ensureLogsRuntime();
const logDir = getLogsRoot();

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const level = () => {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : 'info';
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// 针对终端打印的彩色格式
const consoleFormat = winston.format.combine(
  appendTimestamp({ tz: 'Asia/Shanghai' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

// 针对文件存储的无色纯文本格式
const fileFormat = winston.format.combine(
  appendTimestamp({ tz: 'Asia/Shanghai' }),
  winston.format.uncolorize(),
  winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
  // Batch Z (2026-06-17, m-4 fix): 加 maxsize (50MB/file) + maxFiles (10 = 总 500MB)
  // 防 combined.log 无限增长 OOM LogController.getLogs 全文 read.
  // winston 内置 rotation: 文件满 50MB 自动 rename + new file, 保留最近 10 个.
  new winston.transports.File({
    filename: path.join(logDir, 'error.log'),
    level: 'error',
    format: fileFormat,
    maxsize: 50 * 1024 * 1024,
    maxFiles: 10,
    tailable: true,
  }),
  new winston.transports.File({
    filename: path.join(logDir, 'combined.log'),
    format: fileFormat,
    maxsize: 50 * 1024 * 1024,
    maxFiles: 10,
    tailable: true,
  }),
];

export const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
});
