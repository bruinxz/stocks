import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 公司公告数据客户端 — US-059.
 *
 * 通过 AKShare Python helper 拉取 `stock_notice_report(symbol, date=YYYYMMDD)`
 * 东方财富网 沪深京 A 股每日公告列表 (~1000-3000 行/活跃交易日).
 *
 * AC 字段 (PRD US-059) → AKShare 字段:
 *   - announce_date     公告日期 → 已 ISO 化 (YYYY-MM-DD)
 *   - stock_code        代码     → 6-digit 纯代码 (无 sh./sz. 前缀, 与 NorthboundHolding/LimitUpStock 一致)
 *   - original_title    公告标题
 *   - announcement_type 公告类型 (实际数据 50+ 种细分类型, e.g. "三季度报告全文" / "提供/对外担保公告")
 *   - url               网址 (东财详情页, 用户点击可查 PDF)
 *
 * **dumb fetcher 分工** (US-006 LimitUp 同款):
 *   - Python: 拉数据 + 字段映射 + dedup;
 *   - TS NLP (AnnouncementNLPService): 调 AI 抽 summary + sentiment + key_amounts/topics;
 *   - TS Sync (AnnouncementSyncService): 调 client + 调 nlp + bulkCreate upsert.
 *
 * **symbol 参数**: 默认 '全部' 拉所有类型. 也支持东财内置 7 大类:
 *   '重大事项' / '财务报告' / '融资公告' / '风险提示' / '资产重组' / '信息变更' / '持股变动'.
 *   注意: 这 7 个分类是**接口入参的粒度** (服务端预过滤), 与每行 `announcement_type`
 *   字段返回的细分类型 (~50 种) 不同; 后者粒度更细 (e.g. '半年度报告' / '关联交易公告').
 */
export interface AnnouncementReportRow {
  announce_date: string; // YYYY-MM-DD
  stock_code: string; // 6-digit pure code
  stock_name: string | null;
  original_title: string;
  announcement_type: string | null;
  url: string | null;
  raw_payload: Record<string, unknown>;
}

export type AnnouncementSymbol =
  | '全部'
  | '重大事项'
  | '财务报告'
  | '融资公告'
  | '风险提示'
  | '资产重组'
  | '信息变更'
  | '持股变动';

export class AnnouncementClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `AnnouncementClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定日期的全市场公告列表.
   * @param date YYYY-MM-DD 或 YYYYMMDD; Python 层会自动归一化
   * @param symbol 东财预过滤类型 (默认 '全部')
   */
  async fetchAnnouncements(
    date: string,
    symbol: AnnouncementSymbol = '全部'
  ): Promise<AnnouncementReportRow[]> {
    try {
      logger.info(`Fetching announcements (date=${date}, symbol=${symbol})`);
      const rows = (await this.callPythonScript('get_announcement_report', date, symbol)) as
        | AnnouncementReportRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Announcements for ${date} (symbol=${symbol}): ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch announcements for ${date}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本 ({success,data} 契约).
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.ANNOUNCEMENT_TIMEOUT_MS || 180_000);
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

export const announcementClient = new AnnouncementClient();
