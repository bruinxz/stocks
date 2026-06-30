#!/usr/bin/env node
/**
 * 隔夜信号矩阵手动 sync CLI (PR-M1)
 *
 * Usage:
 *   npm run sync:overnight-signals
 *   node dist/scripts/sync-overnight-signals.js
 *
 * 调度建议: 默认走 cron `* /15 0-9,21-23 * * *`. 本 CLI 仅 ops 手动验证 /
 * 排障用.
 */

import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { overnightSignalSyncService } from '../services/OvernightSignalSyncService';

(async () => {
  try {
    await sequelize.authenticate();
    if (process.env.NODE_ENV !== 'production') {
      await sequelize.sync({ alter: true });
    }
    const r = await overnightSignalSyncService.syncAllSources();
    console.log(JSON.stringify(r, null, 2));
    if (r.error) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    logger.error(`sync-overnight-signals failed: ${err?.message || err}`);
    console.error(err);
    process.exit(1);
  }
})();
