import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { sequelize } from './config/database';
import authRoutes from './api/routes/auth.routes';
import stockRoutes from './api/routes/stock.routes';
import backtestRoutes from './api/routes/backtest.routes';
import strategyRoutes from './api/routes/strategy.routes';
import portfolioRoutes from './api/routes/portfolio.routes';
import marketRoutes from './api/routes/market.routes';
import './jobs/dataUpdateWorker'; // 初始化数据更新队列处理器

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Initialize database connection and start server
async function initializeApp() {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connection has been established successfully.');

    // Sync models in development environment
    if (process.env.NODE_ENV === 'development') {
      console.log('Syncing database models...');
      try {
        await sequelize.sync(); // 只创建缺失的表，不修改现有表结构
        console.log('Database models synced successfully');
      } catch (error) {
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

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    console.warn('Starting server without database connection. Some features may be limited.');

    // Start server even without database connection
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT} (without database connection)`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  }
}

initializeApp();

export default app;