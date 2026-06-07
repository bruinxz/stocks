import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 指数成份股数据客户端 — 通过 AKShare Python helper 拉取单个指数的当前成份股。
 *
 * 对应 Python 命令：`get_index_components <index_code> <trade_date>`
 * 底层 AKShare 接口：`index_stock_cons_sina` (主) / `index_stock_cons` (兜底) /
 * `index_stock_cons_weight_csindex` (权重最佳努力)
 *
 * **重要：AKShare 没有"历史日期 X 当日的指数成份股"的端点**——它只返回"当前"。
 * 我们用 `trade_date` 作为输出标签，让 CTA100MomentumStrategy 等下游策略能按
 * (trade_date, index_code) 查到当时同步快照。回填历史日期的语义是：把今天的成份
 * 作为该历史日的成份。指数月内成份变化稀少（仅季度调样），这是可接受的近似。
 *
 * 主流指数 6 位代码：
 *   - 000016 上证 50
 *   - 000300 沪深 300
 *   - 000852 中证 1000（US-020 CTA100 目标）
 *   - 000905 中证 500
 */
export interface IndexComponentRow {
  /** ISO 日期 YYYY-MM-DD（同步时的 trade_date 标签） */
  trade_date: string;
  /** 6 位指数代码，无后缀，如 "000852" */
  index_code: string;
  /** 指数中文名，如"中证1000"；缺失返回 null */
  index_name: string | null;
  /** 6 位成份股代码，无后缀 */
  stock_code: string;
  /** 成份股简称 */
  stock_name: string | null;
  /** 成份股权重 (%)；非 CSI 系列或 AKShare 缺权重时为 null */
  weight: number | null;
  /** 原始 AKShare 行（保留所有字段，便于以后回溯） */
  raw_payload: Record<string, unknown>;
}

export class IndexComponentClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `IndexComponentClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定指数的当前成份股，stamp 为指定 trade_date。
   * @param indexCode 6 位指数代码，例如 "000852"
   * @param tradeDate ISO YYYY-MM-DD 或 YYYYMMDD
   */
  async fetchComponents(indexCode: string, tradeDate: string): Promise<IndexComponentRow[]> {
    try {
      logger.info(`Fetching index components for ${indexCode} (stamp=${tradeDate})`);
      const rows = (await this.callPythonScript('get_index_components', indexCode, tradeDate)) as
        | IndexComponentRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Index components for ${indexCode} on ${tradeDate}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch index components for ${indexCode}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 AKShareClient 同样的契约 JSON: {success, data}）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      // 指数成份股 + 权重 + 兜底端点 ~3 次外部请求，60s 通常够；
      // CSI 权重接口偶发慢，留 90s 余量。
      const timeoutMs = Number(process.env.INDEX_COMPONENT_TIMEOUT_MS || 90_000);
      const timeout = setTimeout(() => {
        logger.error(`Python script timeout for command: ${command}`);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
        reject(new Error(`Python script timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          logger.error(`Python script failed with code ${code}: ${stderr}`);
          reject(new Error(`Python script failed: ${stderr}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(result.data);
          } else {
            reject(new Error(result.error || 'Unknown error from Python script'));
          }
        } catch (error) {
          logger.error(`Failed to parse Python output: ${stdout}`);
          reject(new Error(`Invalid JSON from Python script: ${(error as Error).message}`));
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        logger.error(`Failed to spawn Python process: ${error.message}`);
        reject(error);
      });
    });
  }
}

export const indexComponentClient = new IndexComponentClient();
