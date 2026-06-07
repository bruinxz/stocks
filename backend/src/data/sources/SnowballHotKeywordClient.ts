import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 雪球热词 / 全市场关注度榜数据客户端 — US-058.
 *
 * 通过 AKShare Python helper 拉取 `stock_hot_follow_xq(symbol='最热门')` 雪球关注度
 * 排行榜 (~5600 行,默认截取前 200 名)。
 *
 * **代理范式 (US-034 / US-056 同款)**: AKShare 中无任何"话题"维度 endpoint,
 * 故 `keyword` 映射为雪球关注排行榜中的股票简称。详见
 * `models/SnowballHotKeyword.ts` 与 `python/akshare_helper.py:get_snowball_hot_keywords`
 * 的文档说明。
 *
 * **实时快照特性**: 接口当下时刻无日期参数,trade_date 仅为 caller 服务层
 * 在盘后调用时贴上的标签,与 US-008 IndustryFlowClient 同款 "real-time-only" 形态。
 */
export interface SnowballHotKeywordRow {
  trade_date: string | null;
  keyword: string;
  stock_code: string;
  stock_name: string;
  heat_score: number;
  latest_price: number | null;
  rank: number;
  source: string;
  raw_payload: Record<string, unknown>;
}

export type SnowballSymbol = '最热门' | '本周新增' | 'tweet' | 'deal';

export class SnowballHotKeywordClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `SnowballHotKeywordClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取雪球关注度排行榜.
   * @param tradeDate ISO 日期 (YYYY-MM-DD) — 仅用作标签贴在每行上, AKShare 接口无日期参数
   * @param symbol '最热门' (默认) / '本周新增' / 'tweet' / 'deal'
   * @param limit 返回行数上限 (默认 200)
   */
  async fetchKeywords(
    tradeDate: string,
    symbol: SnowballSymbol = '最热门',
    limit = 200
  ): Promise<SnowballHotKeywordRow[]> {
    try {
      logger.info(
        `Fetching snowball hot keywords (symbol=${symbol}, trade_date=${tradeDate}, limit=${limit})`
      );
      const rows = (await this.callPythonScript(
        'get_snowball_hot_keywords',
        symbol,
        tradeDate || '-',
        String(limit)
      )) as SnowballHotKeywordRow[] | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Snowball hot keywords for ${tradeDate} (symbol=${symbol}): ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch snowball hot keywords for ${tradeDate}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本 (与 LimitDownClient 等同款 {success,data} 契约).
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.SNOWBALL_KEYWORD_TIMEOUT_MS || 120_000);
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

export const snowballHotKeywordClient = new SnowballHotKeywordClient();
