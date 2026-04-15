import { Sequelize } from 'sequelize-typescript';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { BacktestResult } from '../models/BacktestResult';
import { Trade } from '../models/Trade';
import { User } from '../models/User';
import { FavoriteStock } from '../models/FavoriteStock';
import { DataUpdateLog } from '../models/DataUpdateLog';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize({
  database: process.env.DB_NAME || 'stock_backtest',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  dialect: 'postgres',
  dialectOptions: {
    ssl: process.env.DB_SSL === 'true' ? {
      require: true,
      rejectUnauthorized: false,
    } : false,
  },
  models: [Stock, DailyBar, BacktestResult, Trade, User, FavoriteStock, DataUpdateLog],
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

export { sequelize };
export default sequelize;