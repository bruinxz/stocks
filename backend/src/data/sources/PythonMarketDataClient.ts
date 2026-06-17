import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

export class PythonMarketDataClient {
  protected pythonPath: string;
  protected scriptPath: string;
  protected clientName: string;

  constructor(clientName: string, pythonPath?: string) {
    this.clientName = clientName;
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/market_data_helper.py');
  }

  protected async callPythonScript(command: string, ...args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(
        `Executing ${this.clientName} Python: ${this.pythonPath} ${processArgs.join(' ')}`
      );

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        logger.error(`${this.clientName} Python script timeout for command: ${command}`);
        // Batch T (2026-06-17, P1-10 fix): 双段 kill - SIGTERM 后 1s 仍未退出再 SIGKILL.
        // Python AKShare 内可能阻塞在 urllib.request.urlopen 同步调用忽略 SIGTERM,
        // 不补 SIGKILL 会让 child 残留占 fd + 外部连接, 长期累积 EAGAIN/EMFILE.
        // 抄 AKShareClient.callPythonScript 同款.
        child.kill('SIGTERM');
        const killTimeout = setTimeout(() => {
          if (!child.killed) {
            logger.warn(
              `${this.clientName} Python child 未响应 SIGTERM, 强制 SIGKILL: command=${command}`
            );
            try {
              child.kill('SIGKILL');
            } catch (killErr: any) {
              logger.error(
                `${this.clientName} SIGKILL 失败 (子进程可能已退): ${killErr?.message || killErr}`
              );
            }
          }
        }, 1000);
        (killTimeout as any).unref?.();
        reject(new Error(`${this.clientName} Python script timeout (120s)`));
      }, 120000);

      child.stdout.on('data', data => {
        stdout += data.toString();
      });

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          logger.error(`${this.clientName} Python script failed with code ${code}: ${stderr}`);
          reject(new Error(`${this.clientName} Python script failed: ${stderr || stdout}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(result.data);
          } else {
            reject(
              new Error(result.error || `Unknown error from ${this.clientName} Python script`)
            );
          }
        } catch (error: any) {
          logger.error(`Failed to parse ${this.clientName} Python output: ${stdout}`);
          reject(new Error(`Invalid JSON from ${this.clientName} Python script: ${error.message}`));
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        logger.error(`Failed to spawn ${this.clientName} Python process: ${error.message}`);
        reject(error);
      });
    });
  }

  getBaseStatus() {
    return {
      pythonPath: this.pythonPath,
      scriptPath: this.scriptPath,
    };
  }
}
