import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 龙虎榜数据客户端 — 通过 AKShare Python helper 拉取单日营业部明细。
 *
 * 对应 Python 命令：`get_dragon_tiger_detail <date>`
 * 底层 AKShare 接口组合：
 *   - `stock_lhb_detail_em` — 当日上榜股票清单（含上榜原因）
 *   - `stock_lhb_stock_detail_em` — 每只股票的买/卖营业部席位明细
 *
 * Python 端做了 buyer × seller 的笛卡尔展开，TS 端拿到的是
 * (trade_date, stock_code, buyer_seat, seller_seat) 复合键的行。
 *
 * 由于每只 LHB 股票要打 2 次额外接口（买/卖各一次），一日数据量级 ~20-100 只
 * 股票，总请求数最多 ~200，按 AKShare 自带限速 30s+ 是合理的。
 * 因此默认 timeout 设置为 180s，可通过 `DRAGON_TIGER_TIMEOUT_MS` 覆盖。
 */
export interface DragonTigerBoardRow {
  /** ISO 日期 YYYY-MM-DD */
  trade_date: string;
  /** 6 位代码 */
  stock_code: string;
  /** 中文股票简称（可空） */
  stock_name: string | null;
  /** 上榜原因（可空） */
  reason: string | null;
  /** 买方营业部全称（可能是空串，表示当日无买方席位记录） */
  buyer_seat: string;
  /** 卖方营业部全称（可能是空串） */
  seller_seat: string;
  /** 买方营业部当日合计买入金额（元，可空） */
  buy_amount: number | null;
  /** 卖方营业部当日合计卖出金额（元，可空） */
  sell_amount: number | null;
  /** 该买/卖席位组合的净额（元，可空） */
  net_amount: number | null;
  /** 原始 AKShare 行（含 list_row / buyer_row / seller_row 三层） */
  raw_payload: Record<string, unknown>;
}

export class DragonTigerClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `DragonTigerClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定日期的龙虎榜营业部明细（买方席位 × 卖方席位 已笛卡尔展开）。
   * @param date ISO 日期 (YYYY-MM-DD) 或 8 位 (YYYYMMDD)
   */
  async fetchDailyDetail(date: string): Promise<DragonTigerBoardRow[]> {
    try {
      logger.info(`Fetching dragon-tiger detail for ${date}`);
      const rows = (await this.callPythonScript('get_dragon_tiger_detail', date)) as
        | DragonTigerBoardRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Dragon-tiger detail for ${date}: ${count} seat-pair rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch dragon-tiger detail for ${date}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 AKShareClient / NorthboundDataClient 同样的 {success,data} 契约）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.DRAGON_TIGER_TIMEOUT_MS || 180_000);
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

export const dragonTigerClient = new DragonTigerClient();
