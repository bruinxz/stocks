import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 行业资金流数据客户端 — 通过 AKShare Python helper 拉取行业板块当日资金流
 * 与板块强度快照（含每个行业的当日龙头股识别）。
 *
 * Python 端会做以下处理：
 *  - 拉 `stock_sector_fund_flow_rank('今日', '行业资金流')` 取主力净流入与涨跌幅
 *  - 拉 `stock_board_industry_name_em()` 取 板块名称 → 板块代码 (BKxxxx) 映射
 *  - 对每个行业拉 `stock_board_industry_cons_em(symbol=name)`，挑当日涨幅最大
 *    且非一字板的成份股作为龙头
 *  - `raw_payload = {fund_flow_row, board_row, leader_row}` 三层保留便于审计
 *
 * 注意：AKShare 的 fund_flow / name / cons 接口都是**实时快照**而非历史；
 * 同步逻辑只能在「当日盘后」执行，TS 层根据传入的 `date` 打 trade_date 标签。
 * 历史回填只能保留 trade_date 的"标签语义"，不可重现历史快照。
 *
 * 单日量级 ~86 行（申万一级行业数）+ 86 次成份股 fetch；timeout 默认 240s
 * （cons fetch 是 AKShare 限速主因）。
 */
export interface IndustryFlowRow {
  /** ISO 日期 YYYY-MM-DD（即传入的 date） */
  trade_date: string;
  /** 行业板块代码（东财，例如 BK1027；找不到时回退 "FALLBACK-<name>"） */
  industry_code: string;
  /** 行业板块名称 */
  industry_name: string;
  /** 板块当日涨跌幅 (%) */
  change_pct: number | null;
  /** 主力净流入（元） */
  main_inflow: number | null;
  /** 主力净流入-净占比 (%) */
  main_inflow_ratio: number | null;
  /** 行业当日龙头股代码（非一字板，可空） */
  leader_stock_code: string | null;
  /** 行业当日龙头股简称 */
  leader_stock_name: string | null;
  /** 行业当日龙头股涨跌幅 (%) */
  leader_stock_change_pct: number | null;
  /** 板块成份股内上涨家数 */
  advancing_count: number | null;
  /** 板块成份股内下跌家数 */
  declining_count: number | null;
  /** 原始 AKShare 行（含 fund_flow_row / board_row / leader_row 三层） */
  raw_payload: Record<string, unknown>;
}

export class IndustryFlowClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `IndustryFlowClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定日期的行业资金流快照（含板块代码与龙头股）。
   *
   * AKShare 的板块资金流是实时快照，调用方应在当日盘后调用。
   * 历史日期的语义只是 trade_date 标签，无法重现历史快照。
   *
   * @param date ISO 日期 (YYYY-MM-DD) 或 8 位 (YYYYMMDD)
   */
  async fetchDailySnapshot(date: string): Promise<IndustryFlowRow[]> {
    try {
      logger.info(`Fetching industry flow snapshot stamped ${date}`);
      const rows = (await this.callPythonScript('get_industry_flow', date)) as
        | IndustryFlowRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Industry flow snapshot stamped ${date}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch industry flow stamped ${date}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 AKShareClient / NorthboundDataClient / LimitUpClient
   * 同样的 {success,data} 契约）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      // 默认 240s：86 个行业 × 1 次 cons fetch 加 AKShare 限速，60s 远远不够
      const timeoutMs = Number(process.env.INDUSTRY_FLOW_TIMEOUT_MS || 240_000);
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

export const industryFlowClient = new IndustryFlowClient();
