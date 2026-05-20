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
  new winston.transports.File({
    filename: path.join(logDir, 'error.log'),
    level: 'error',
    format: fileFormat,
  }),
  new winston.transports.File({
    filename: path.join(logDir, 'combined.log'),
    format: fileFormat,
  }),
];

export const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
});
