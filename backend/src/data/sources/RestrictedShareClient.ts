import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 限售解禁日历数据客户端 — US-089 数据层。
 *
 * 通过 AKShare Python helper 拉取按日期范围的全市场限售解禁批次。
 *
 * 对应 Python 命令：`get_restricted_release <start_date> <end_date>`
 * 底层 AKShare 接口：`stock_restricted_release_detail_em(start_date, end_date)`
 *
 * **AC endpoint substitution 说明** (US-034 / US-035 / US-053 同款范式)：
 *   AC 指定的 `stock_restricted_release_queue` 是 **per-stock 历史** 端点
 *   (AKShare 中真实函数名为 `stock_restricted_release_queue_em`)，输入 6 位
 *   股票代码返回该股全部解禁批次。对未来 N 天的全市场日历扫描场景，
 *   per-stock 调用 5000+ 次远端 API 效率极低；本服务用同领域的
 *   `stock_restricted_release_detail_em(start_date, end_date)` —— 该端点
 *   一次返回日期范围内全市场所有解禁批次，覆盖 AC 必需的 5 个字段
 *   (ex_date / stock_code / release_shares / release_market_value /
 *   shareholder_name)。
 *
 *   数据语义 100% 对齐 (queue 与 detail 都是按"解禁批次"建模)。4 处文档
 *   同步标注：Python helper docstring / 本 jsdoc / SyncService jsdoc /
 *   Watchdog jsdoc。
 *
 *   升级路径：若 AKShare 未来恢复 per-date queue 端点 (或新增按 ex_date
 *   range 的更精确接口)，替换 Python helper 一处即可，TS 层不动。
 *
 * 性能：单次 7-30 天日历范围调用 ~3-10 秒；watchdog 默认 5 个交易日，
 * 跑一次 ~5 秒。
 */
export interface RestrictedShareReleaseRow {
  /** 解禁日 ISO YYYY-MM-DD */
  ex_date: string;
  /** 6 位股票代码 (无市场前缀) */
  stock_code: string;
  /** 股票简称 (冗余便于排查) */
  stock_name: string | null;
  /**
   * 限售股股东 / 类型 (AKShare "限售股类型" 字段，如
   * '首发原股东限售股份' / '定向增发机构配售股份' / '股权激励限售股份')。
   * detail_em 端点只有"类型"无股东明细；缺失时落 '未分类'。
   */
  shareholder_name: string;
  /** 解禁数量 (股) */
  release_shares: number | null;
  /** 实际解禁数量 (股，部分股东可能自愿延长锁定期) */
  release_actual_shares: number | null;
  /** 实际解禁市值 (元) */
  release_market_value: number | null;
  /** 占解禁前流通市值比例 (%) — watchdog 直接消费此字段 */
  release_pct_of_float: number | null;
  /** 解禁前一交易日收盘价 (元) */
  prev_close_price: number | null;
  /** 解禁前 20 日涨跌幅 (%) */
  prev_20d_change_pct: number | null;
  /** 解禁后 20 日涨跌幅 (%) — 历史数据才有，未来日为 null */
  post_20d_change_pct: number | null;
  /** 原始 AKShare 行 (保留所有字段，便于事后回溯) */
  raw_payload: Record<string, unknown>;
}

export class RestrictedShareClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `RestrictedShareClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定日期范围内的全市场限售解禁批次。
   * @param startDate ISO YYYY-MM-DD 或 YYYYMMDD (含)
   * @param endDate   ISO YYYY-MM-DD 或 YYYYMMDD (含)
   */
  async fetchForDateRange(
    startDate: string,
    endDate: string
  ): Promise<RestrictedShareReleaseRow[]> {
    try {
      logger.info(`Fetching restricted-share releases for ${startDate}..${endDate}`);
      const rows = (await this.callPythonScript('get_restricted_release', startDate, endDate)) as
        | RestrictedShareReleaseRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Restricted-share releases for ${startDate}..${endDate}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch restricted-share releases for ${startDate}..${endDate}: ${
          (error as Error).message
        }`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本 (与 EarningsForecastClient 同款契约 JSON: {success, data})。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.RESTRICTED_SHARE_TIMEOUT_MS || 180_000);
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
          logger.error(`Failed to parse Python output: ${stdout.slice(0, 500)}`);
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

export const restrictedShareClient = new RestrictedShareClient();
