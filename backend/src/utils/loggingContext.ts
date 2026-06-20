/**
 * US-097 [OPS-008] 日志统一字段 — AsyncLocalStorage 上下文 + winston format 注入.
 *
 * 目标:
 *   - 任何 logger.info/warn/error 都自动携带 `trace_id` + `module` (无需 caller 显式传)
 *   - `grep trace_id=<x>` 能从 combined.log 追踪一次请求 (或 cron / dispatcher) 全链路
 *
 * 用法 (零侵入):
 *   import { runWithLoggingContext, runWithModule } from './utils/loggingContext';
 *
 *   // 请求入口 (middleware)
 *   runWithLoggingContext({ trace_id, module: 'http' }, () => next());
 *
 *   // cron / 任务子作用域 (沿用上层 trace_id, 仅替换 module)
 *   runWithModule('scheduler', async () => {
 *     await runTask();
 *   });
 *
 *   // helper / service 内主动取
 *   const ctx = getLoggingContext();
 *   logger.info(`do thing trace_id=${ctx?.trace_id || '-'}`);
 *
 * 设计原则:
 *   - 纯 Node 内置 AsyncLocalStorage, 不引第三方 cls-hooked (后者 monkey-patch promise hooks 已知坑多)
 *   - 任何取不到 context 的路径都 fail-OPEN 返 '-' 占位, 不阻塞主流程
 *   - winston format 输出仍兼容既有 `${ts} ${level}: ${msg}` 文本协议,
 *     trace_id / module 作为后缀附加 — LogController.getLogs 的正则 (line 51-52)
 *     仍能解析 timestamp/level/message, message 段含 `trace_id=... module=...` 后缀.
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

/** 日志上下文字段, 全部 optional — caller 任选填充. */
export interface LoggingContext {
  trace_id?: string;
  module?: string;
}

const storage = new AsyncLocalStorage<LoggingContext>();

/**
 * 在 callback 作用域内绑定 logging context. context 仅在 callback 同步/异步链路内可见.
 * 嵌套 run 时内层完全覆盖外层 (与 ALS 默认语义一致), 想"继承外层 trace_id 仅替换 module"
 * 用 `runWithModule` 助手.
 */
export function runWithLoggingContext<T>(ctx: LoggingContext, fn: () => T): T {
  return storage.run({ ...ctx }, fn);
}

/**
 * 沿用当前作用域的 trace_id, 仅替换 module — 典型用于 cron / dispatcher / 子任务,
 * caller 不必显式拷贝 trace_id.
 */
export function runWithModule<T>(moduleName: string, fn: () => T): T {
  const current = storage.getStore() || {};
  return storage.run({ ...current, module: moduleName }, fn);
}

/** 取当前作用域 context, 不存在返 undefined. */
export function getLoggingContext(): LoggingContext | undefined {
  return storage.getStore();
}

/**
 * 生成一个新的 trace_id — 16 字节 hex (32 chars), 与 UUIDv4 同款熵但不带 dash 更短.
 * 与 crypto.randomUUID() 行为等价但环境兼容性更好 (老 Node).
 */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 取 trace_id, 不存在返 '-' (winston printf 友好的 placeholder).
 * 外部告警/dispatcher 想要"无 trace_id 时退化字符串"可直接调本函数.
 */
export function currentTraceId(): string {
  return storage.getStore()?.trace_id || '-';
}

/**
 * 取 module, 不存在返 '-'.
 */
export function currentModule(): string {
  return storage.getStore()?.module || '-';
}

/**
 * 测试专用: 重置全局 storage. 真正业务路径不要调 — ALS 是请求级隔离, 没有"全局 reset"概念.
 * 仅在 helper 单测里, 想确认"未 run 时 currentTraceId() 返 '-'" 这种边界, 不需 reset 因为
 * 测试默认就在 storage 外执行. 保留 export 作为 future-proof 但当前未使用.
 */
export function __resetLoggingContextForTests(): void {
  // ALS 没有真正的 reset, 但 disable 后再调 storage.run 是 no-op — 这里仅返 void
  // 保持 API 对称 (与 prom-client __resetPrometheusBundleForTests 思想一致).
  storage.disable();
}
