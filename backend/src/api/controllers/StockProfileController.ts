import { Request, Response } from 'express';
import { DataSyncService } from '../../data/services/DataSyncService';
import { logger } from '../../utils/logger';

const dataSyncService = new DataSyncService();

export class StockProfileController {
  syncProfiles = async (req: Request, res: Response) => {
    try {
      const { symbols, limit = 30 } = req.body || {};
      if (!Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ success: false, message: 'symbols 不能为空' });
      }

      const result = await dataSyncService.syncStockProfiles(symbols, Math.min(Number(limit) || 30, 50));
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('补全股票画像失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}

export const stockProfileController = new StockProfileController();
