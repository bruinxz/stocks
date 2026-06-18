import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * SocialSentimentClient — Batch AH (2026-06-18).
 *
 * 调 Python helper `get_social_sentiment_snapshot` 拉 (东财人气榜 + 综合评分)
 * 横截面合并数据. 单次返回 ~comment_em 全市场 ~4000 行 (caller 必须传
 * stockCodes 过滤, 不传也行但服务层不应该这样用).
 *
 * 实时快照特性: AKShare 接口无 date 参数, trade_date 由 caller 服务层
 * 在盘后调度时贴上标签 (同 US-008 IndustryFlow 范式).
 */
export interface SocialSentimentRow {
  stock_code: string;
  stock_name: string | null;
  hot_rank_em: number | null;
  comment_score: number | null;
  institution_participation: number | null;
  retail_desire: number | null;
  focus_index: number | null;
  raw_payload: Record<string, unknown>;
}

export interface ConceptReverseRow {
  concept_name: string;
  related_codes: string[];
  total_heat: number;
}

export class SocialSentimentClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `SocialSentimentClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉东财人气榜 + 综合评分合并快照.
   * @param stockCodes 6 位代码列表 (caller 必须 limit ≤ 500, 推荐 200);
   *   undefined / 空 → 不过滤 (慎用, 4000+ 行)
   */
  async fetchSnapshot(stockCodes?: string[]): Promise<SocialSentimentRow[]> {
    const csv = stockCodes && stockCodes.length > 0 ? stockCodes.join(',') : '-';
    try {
      const rows = (await this.callPythonScript('get_social_sentiment_snapshot', csv)) as
        | SocialSentimentRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`SocialSentiment fetched: ${count} rows (universe=${stockCodes?.length ?? '*'})`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`SocialSentimentClient.fetchSnapshot failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 概念 → 关联股反向聚合. v1 暂不在 sync 流程使用 (plumbed for future).
   */
  async fetchConceptReverse(stockCodes: string[], perStockLimit = 3): Promise<ConceptReverseRow[]> {
    const csv = stockCodes.join(',');
    if (!csv) return [];
    try {
      const rows = (await this.callPythonScript(
        'get_concept_hot_keywords_reverse',
        csv,
        String(perStockLimit)
      )) as ConceptReverseRow[] | null;
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`SocialSentimentClient.fetchConceptReverse failed: ${(error as Error).message}`);
      return []; // 反向聚合非关键, 失败不抛
    }
  }

  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.SOCIAL_SENTIMENT_TIMEOUT_MS || 90_000);
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
        reject(error);
      });
    });
  }
}

export const socialSentimentClient = new SocialSentimentClient();
