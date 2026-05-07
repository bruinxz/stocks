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
      logger.debug(`Executing ${this.clientName} Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        logger.error(`${this.clientName} Python script timeout for command: ${command}`);
        child.kill('SIGTERM');
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
            reject(new Error(result.error || `Unknown error from ${this.clientName} Python script`));
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
