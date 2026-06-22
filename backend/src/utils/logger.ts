import winston from 'winston';
import path from 'path';
import moment from 'moment-timezone';
import { ensureLogsRuntime, getLogsRoot } from './runtimePaths';
import { currentModule, currentTraceId } from './loggingContext';

// 强制所有通过 logger 的时间都是北京时间
const appendTimestamp = winston.format((info, opts: any) => {
  if (opts.tz) {
    info.timestamp = moment().tz(opts.tz).format('YYYY-MM-DD HH:mm:ss.SSS');
  }
  return info;
});

// US-097 [OPS-008] 统一字段注入: 任何 logger.info/warn/error 输出末尾追加
// `trace_id=<x> module=<y>` 后缀, 让 grep trace_id=<x> 能贯穿一次请求全链路.
// 无 ALS 上下文时 (e.g. boot-time / 后台 cron 没 run 子作用域) 自动返 '-' 占位,
// 不阻塞 — fail-OPEN. 已显式在 message 里手写 `trace_id=` 的旧代码不重复追加.
const appendContext = winston.format(info => {
  const msg = String(info.message ?? '');
  if (!/trace_id=/.test(msg)) {
    const traceId = currentTraceId();
    const mod = currentModule();
    info.message = `${msg} trace_id=${traceId} module=${mod}`;
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
  appendContext(),
  winston.format.colorize({ all: true }),
  winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

// 针对文件存储的无色纯文本格式
const fileFormat = winston.format.combine(
  appendTimestamp({ tz: 'Asia/Shanghai' }),
  appendContext(),
  winston.format.uncolorize(),
  winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

const transports = [
  // Bug AY-15 fix: Console transport 默认走 stdout, 让 CLI 脚本 `node script.js > out.json`
  // 时 168 行 winston banner 混入 JSON 输出, 让 caller 没法直接 pipe 解析.
  // 设置 LOG_STDERR_ONLY=true (任何 CLI / eval 脚本启动前 export 一下) → Console 走
  // stderr, stdout 留给业务 JSON; 默认 (server 模式) 保持原 stdout 不变以保 systemd
  // append:/var/log/stocks/backend.log 行为不变.
  new winston.transports.Console({
    format: consoleFormat,
    stderrLevels:
      process.env.LOG_STDERR_ONLY === 'true'
        ? ['error', 'warn', 'info', 'http', 'debug']
        : ['error', 'warn'],
  }),
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
