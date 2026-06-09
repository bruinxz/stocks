/**
 * US-093: 暴露策略 .ts 源码给前端 Monaco 编辑器（只读）。
 *
 * 设计要点：
 *  - **strategy_key 与文件名非 1:1 映射**（key 是 snake_case 如 `multi_factor_alpha`，
 *    文件名是 PascalCase 如 `MultiFactorAlphaStrategy.ts`）。启动时扫一遍 strategies/
 *    目录，按行匹配 `strategy_key: 'xxx',` 建立 key→filename 缓存。
 *  - **多路径回退** 找 `backend/src/quant/strategies/` 目录：
 *     (1) `process.cwd()/src/quant/strategies` — 生产 + 开发都走 backend 根启动；
 *     (2) `path.resolve(__dirname, '../../strategies')` — ts-node 开发模式；
 *     (3) `path.resolve(__dirname, '../../../../src/quant/strategies')` — production
 *         dist 模式（__dirname 在 dist/quant/engine/internal）。
 *  - **白名单 + 严格 strategy_key 校验**：strategy_key 必须匹配 `^[a-z][a-z0-9_]*$`，
 *    然后只能在缓存里查到的文件才能被读取。**不允许任意 path traversal**。
 *  - **content 大小硬上限 256KB**：避免被 oversize 文件 OOM 后端。
 *  - **缓存 source map 不缓存 content**：strategies 列表在运行时几乎不变，但 content
 *    可能在 watch 模式下被编辑（虽然只读，但开发者修改源码后期望刷新看到新代码）。
 *
 * 不复用 quant/strategies/ 下任何运行时代码，纯文件系统读取。
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../../../utils/logger';

const STRATEGY_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const STRATEGY_KEY_LINE = /^\s*strategy_key:\s*'([a-z][a-z0-9_]*)'\s*,?\s*$/m;
const MAX_FILE_BYTES = 256 * 1024;

export interface StrategySourceResult {
  strategy_key: string;
  filename: string;
  file_path: string;
  content: string;
  byte_size: number;
}

interface SourceMapEntry {
  filename: string;
  absolute_path: string;
  relative_path: string; // relative to backend/ root, e.g. "src/quant/strategies/MultiFactorAlphaStrategy.ts"
}

let cachedSourceMap: Map<string, SourceMapEntry> | null = null;
let cachedStrategiesDir: string | null = null;

/**
 * 找到 backend/src/quant/strategies/ 目录的绝对路径。
 *
 * 3 路回退（按优先级）：
 *   (1) process.cwd() + 'src/quant/strategies' — dev/prod 都从 backend 根启动；
 *   (2) __dirname + '../../strategies' — ts-node dev；
 *   (3) __dirname + '../../../../src/quant/strategies' — production dist。
 */
function resolveStrategiesDir(): string {
  if (cachedStrategiesDir) return cachedStrategiesDir;

  const candidates = [
    path.resolve(process.cwd(), 'src/quant/strategies'),
    path.resolve(__dirname, '../../strategies'),
    path.resolve(__dirname, '../../../../src/quant/strategies'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      cachedStrategiesDir = dir;
      return dir;
    }
  }

  throw new Error(`未能定位 strategies 目录（已尝试：${candidates.join(', ')}）`);
}

/**
 * 扫描 strategies/ 目录建 strategy_key → 文件元数据 map。
 *
 * 每个 .ts 文件用 STRATEGY_KEY_LINE 正则匹配第一处 `strategy_key: 'xxx',` —— 这是
 * 项目所有策略类 definition 的统一形态（registry 注册时也读这个字段），保证
 * key 与运行时一致。无 key 的文件（QuantStrategy.ts 基类、_helpers 等）自动跳过。
 */
export function buildSourceMap(strategiesDir: string): Map<string, SourceMapEntry> {
  const out = new Map<string, SourceMapEntry>();
  const backendRoot = path.resolve(process.cwd());
  const files = fs.readdirSync(strategiesDir).filter(f => f.endsWith('.ts'));

  for (const filename of files) {
    const absolutePath = path.join(strategiesDir, filename);
    try {
      const text = fs.readFileSync(absolutePath, 'utf-8');
      const match = text.match(STRATEGY_KEY_LINE);
      if (!match) continue;
      const key = match[1];
      // duplicate 检测：第一处胜出，后来者只 warn（registry 同款 dedup 策略）。
      if (out.has(key)) {
        logger.warn(
          `[QuantStrategySourceService] duplicate strategy_key '${key}' in ${filename}; keeping first`
        );
        continue;
      }
      // relative_path 用 backend 根的相对路径，前端展示用 'src/quant/strategies/Xxx.ts'
      // 而不是绝对路径，避免泄漏服务器目录结构。
      const relativePath = path.relative(backendRoot, absolutePath);
      out.set(key, { filename, absolute_path: absolutePath, relative_path: relativePath });
    } catch (err) {
      logger.warn(
        `[QuantStrategySourceService] failed to scan ${filename}: ${(err as Error).message}`
      );
    }
  }

  return out;
}

function getSourceMap(): Map<string, SourceMapEntry> {
  if (cachedSourceMap) return cachedSourceMap;
  const dir = resolveStrategiesDir();
  cachedSourceMap = buildSourceMap(dir);
  return cachedSourceMap;
}

/**
 * 测试 / dev hot-reload 用：清缓存让下一次 getStrategySource() 重新扫描。
 * 生产环境不会调用此方法。
 */
export function resetSourceMapCache() {
  cachedSourceMap = null;
  cachedStrategiesDir = null;
}

/**
 * 校验 strategy_key 是否符合 `^[a-z][a-z0-9_]*$`（snake_case 字母数字下划线）。
 * 严格校验避免任何 path traversal（'../' 等字符不在允许集合内）。
 */
export function isValidStrategyKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return STRATEGY_KEY_PATTERN.test(value);
}

export class QuantStrategySourceService {
  /**
   * 按 strategy_key 读对应 .ts 源码。
   *
   * @throws Error('invalid_strategy_key') 校验失败
   * @throws Error('strategy_not_found') 找不到该 key 对应的源文件
   * @throws Error('file_too_large') 超 256KB
   */
  async getStrategySource(strategyKey: string): Promise<StrategySourceResult> {
    if (!isValidStrategyKey(strategyKey)) {
      const err = new Error('invalid_strategy_key');
      (err as any).code = 'INVALID_STRATEGY_KEY';
      throw err;
    }
    const sourceMap = getSourceMap();
    const entry = sourceMap.get(strategyKey);
    if (!entry) {
      const err = new Error('strategy_not_found');
      (err as any).code = 'STRATEGY_NOT_FOUND';
      throw err;
    }
    const stat = fs.statSync(entry.absolute_path);
    if (stat.size > MAX_FILE_BYTES) {
      const err = new Error('file_too_large');
      (err as any).code = 'FILE_TOO_LARGE';
      throw err;
    }
    const content = fs.readFileSync(entry.absolute_path, 'utf-8');
    return {
      strategy_key: strategyKey,
      filename: entry.filename,
      file_path: entry.relative_path,
      content,
      byte_size: stat.size,
    };
  }

  /**
   * 测试 / 调试用：列出所有可读 strategy_key（不返回内容，仅元数据）。
   */
  listAvailableStrategyKeys(): Array<{
    strategy_key: string;
    filename: string;
    file_path: string;
  }> {
    const sourceMap = getSourceMap();
    return Array.from(sourceMap.entries())
      .map(([key, entry]) => ({
        strategy_key: key,
        filename: entry.filename,
        file_path: entry.relative_path,
      }))
      .sort((a, b) => a.strategy_key.localeCompare(b.strategy_key));
  }
}

export const quantStrategySourceService = new QuantStrategySourceService();
