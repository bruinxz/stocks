import dotenv from 'dotenv';
// Load environment variables immediately to ensure config is available for imports
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import cookieParser from 'cookie-parser';
import { sequelize } from './config/database';
import authRoutes from './api/routes/auth.routes';
import stockRoutes from './api/routes/stock.routes';
import backtestRoutes from './api/routes/backtest.routes';
import strategyRoutes from './api/routes/strategy.routes';
import portfolioRoutes from './api/routes/portfolio.routes';
import marketRoutes from './api/routes/market.routes';
import aiRoutes from './api/routes/ai.routes';
import taskRoutes from './api/routes/task.routes';
import paperTradingRoutes from './api/routes/paperTrading.routes';
import riskAlertRoutes from './api/routes/riskAlert.routes';
import journalRoutes from './api/routes/journal.routes';
import userRoutes from './api/routes/user.routes';
import logRoutes from './api/routes/log.routes';
import internalRoutes from './api/routes/internal.routes';
import './jobs/dataUpdateWorker'; // 初始化数据更新队列处理器
import { schedulerService } from './services/SchedulerService';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // 允许任何来源访问，配合 credentials: true 会动态反射 Origin
    callback(null, true);
  },
  credentials: true, // Allow cookies to be sent
}));
app.use(helmet({ crossOriginResourcePolicy: false })); // Allow cross-origin for static files
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files (like avatars)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'A-Share Stock Backtesting API', version: '1.0.0' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/backtests', backtestRoutes);
app.use('/api/strategies', strategyRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/paper-trading', paperTradingRoutes);
app.use('/api/risk-alerts', riskAlertRoutes);
app.use('/api/journals', journalRoutes);
app.use('/api/users', userRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/internal', internalRoutes); // 给TradingAgents预留的安全数据接口

import { User } from './models/User';
import bcrypt from 'bcrypt';

// Initialize database connection and start server
async function initializeApp() {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connection has been established successfully.');

    // Initialize scheduler
    await schedulerService.initialize();

    // Sync models in development environment
    if (process.env.NODE_ENV === 'development') {
      console.log('Syncing database models...');
      try {
        await sequelize.sync({ alter: true }); // 创建缺失的表并修改现有表结构
        console.log('Database models synced successfully with alter: true');
        
        const lymCount = await User.count({ where: { username: 'lym' } });
        if (lymCount === 0) {
          await User.create({
            username: 'lym',
            password_hash: '666',
            email: 'lym@example.com',
            role: 'admin',
            is_active: true,
          });
          console.log('Default admin user "lym" created successfully');
        }
      } catch (error: any) {
        console.warn('Database sync failed, continuing with existing schema:', error.message);
        console.warn('Error details:', error);

        // 尝试单独同步DataUpdateLog表（重要表）
        try {
          console.log('Attempting to sync DataUpdateLog table separately...');
          const DataUpdateLogModel = sequelize.models.DataUpdateLog;
          if (DataUpdateLogModel) {
            await DataUpdateLogModel.sync();
            console.log('DataUpdateLog table synced successfully');
          }
        } catch (logSyncError) {
          console.warn('Failed to sync DataUpdateLog table:', logSyncError.message);
        }
      }
    }

    app.listen(Number(PORT), '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    console.warn('Starting server without database connection. Some features may be limited.');

    // Start server even without database connection
    app.listen(Number(PORT), '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT} (without database connection)`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  }
}

initializeApp();

export default app;
