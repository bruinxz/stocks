import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createObjectCsvWriter } from 'csv-writer';
import csvParser from 'csv-parser';
import { logger } from '../../utils/logger';

export interface LocalStock {
  id?: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  listing_date?: Date | null;
  delisting_date?: Date | null;
  is_listed?: boolean;
  type?: string;
}

export interface LocalDailyBar {
  time: Date;
  stock_id?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  adj_close?: number;
  turnover_rate?: number;
  change_percent?: number;
  amplitude?: number;
  pe?: number;
  pb?: number;
  ps?: number;
  is_trading_day?: boolean;
  is_suspended?: boolean;
}

export interface LocalBacktestResult {
  id: string;
  user_id: number;
  name: string;
  description?: string;
  strategy_config: any;
  start_date: Date;
  end_date: Date;
  initial_capital: number;
  final_capital: number;
  total_return: number;
  annualized_return?: number;
  sharpe_ratio?: number;
  sortino_ratio?: number;
  max_drawdown?: number;
  win_rate?: number;
  profit_loss_ratio?: number;
  total_trades: number;
  profit_trades: number;
  loss_trades: number;
  status: string;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
}

export interface LocalTrade {
  id: string;
  backtest_id: string;
  symbol: string;
  entry_date: Date;
  exit_date?: Date;
  direction: string;
  entry_price: number;
  exit_price?: number;
  quantity: number;
  pnl?: number;
  pnl_percent?: number;
  holding_days?: number;
  created_at: Date;
}

export interface LocalFavorite {
  id: string;
  user_id: number;
  symbol: string;
  group_id?: string;
  tags?: string;
  notes?: string;
  sort_order?: number;
  created_at: Date;
  updated_at: Date;
}

export interface LocalUser {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export class LocalDataStore {
  private dataDir: string;
  private stocksFile: string;
  private backtestsFile: string;
  private tradesFile: string;
  private favoritesFile: string;
  private usersFile: string;

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data', 'stocks');
    this.stocksFile = path.join(process.cwd(), 'data', 'stocks.json');
    this.backtestsFile = path.join(process.cwd(), 'data', 'backtests.json');
    this.tradesFile = path.join(process.cwd(), 'data', 'trades.json');
    this.favoritesFile = path.join(process.cwd(), 'data', 'favorites.json');
    this.usersFile = path.join(process.cwd(), 'data', 'users.json');
    this.ensureDirectories();
  }

  private ensureDirectories() {
    const mainDataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(mainDataDir)) {
      fs.mkdirSync(mainDataDir, { recursive: true });
    }
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // --- Utility ---
  private readJson<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      logger.error(`Error reading ${filePath}:`, e);
      return [];
    }
  }

  private writeJson<T>(filePath: string, data: T[]): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  // --- Stocks Management ---

  public async getStocks(): Promise<LocalStock[]> {
    if (!fs.existsSync(this.stocksFile)) {
      return [];
    }
    try {
      const data = fs.readFileSync(this.stocksFile, 'utf8');
      const stocks: LocalStock[] = JSON.parse(data);
      // Convert string dates to Date objects
      return stocks.map(s => ({
        ...s,
        listing_date: s.listing_date ? new Date(s.listing_date) : null,
        delisting_date: s.delisting_date ? new Date(s.delisting_date) : null,
      }));
    } catch (error) {
      logger.error('Error reading stocks file:', error);
      return [];
    }
  }

  public async getStock(symbol: string): Promise<LocalStock | null> {
    const stocks = await this.getStocks();
    return stocks.find(s => s.symbol === symbol) || null;
  }

  public async saveStock(stock: LocalStock): Promise<void> {
    const stocks = await this.getStocks();
    const index = stocks.findIndex(s => s.symbol === stock.symbol);
    if (index >= 0) {
      stocks[index] = { ...stocks[index], ...stock };
    } else {
      stocks.push({ ...stock, id: stocks.length + 1 });
    }
    fs.writeFileSync(this.stocksFile, JSON.stringify(stocks, null, 2), 'utf8');
  }

  // --- DailyBars Management ---

  private getStockCsvPath(symbol: string): string {
    return path.join(this.dataDir, `${symbol}.csv`);
  }

  public async getDailyBars(
    symbol: string,
    start_date?: Date,
    end_date?: Date
  ): Promise<LocalDailyBar[]> {
    const filePath = this.getStockCsvPath(symbol);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const results: LocalDailyBar[] = [];
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on('data', data => {
          const time = new Date(data.time);

          // Filter by date range if provided
          if (start_date && time < start_date) return;
          if (end_date && time > end_date) return;

          results.push({
            time,
            open: parseFloat(data.open),
            high: parseFloat(data.high),
            low: parseFloat(data.low),
            close: parseFloat(data.close),
            volume: parseFloat(data.volume),
            turnover: data.turnover ? parseFloat(data.turnover) : undefined,
            adj_close: data.adj_close ? parseFloat(data.adj_close) : undefined,
            turnover_rate: data.turnover_rate ? parseFloat(data.turnover_rate) : undefined,
            change_percent: data.change_percent ? parseFloat(data.change_percent) : undefined,
            amplitude: data.amplitude ? parseFloat(data.amplitude) : undefined,
            pe: data.pe ? parseFloat(data.pe) : undefined,
            pb: data.pb ? parseFloat(data.pb) : undefined,
            ps: data.ps ? parseFloat(data.ps) : undefined,
            is_trading_day: data.is_trading_day === 'true',
            is_suspended: data.is_suspended === 'true',
          });
        })
        .on('end', () => {
          // Sort ascending by time
          results.sort((a, b) => a.time.getTime() - b.time.getTime());
          resolve(results);
        })
        .on('error', error => {
          logger.error(`Error parsing CSV for ${symbol}:`, error);
          reject(error);
        });
    });
  }

  public async saveDailyBars(symbol: string, newBars: LocalDailyBar[]): Promise<void> {
    if (newBars.length === 0) return;

    // Load existing bars
    const existingBars = await this.getDailyBars(symbol);
    const barsMap = new Map<string, LocalDailyBar>();

    // Index existing by time
    existingBars.forEach(bar => {
      barsMap.set(bar.time.toISOString(), bar);
    });

    // Merge new bars
    newBars.forEach(bar => {
      barsMap.set(bar.time.toISOString(), bar);
    });

    // Convert back to array and sort
    const mergedBars = Array.from(barsMap.values()).sort(
      (a, b) => a.time.getTime() - b.time.getTime()
    );

    const filePath = this.getStockCsvPath(symbol);
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'time', title: 'time' },
        { id: 'open', title: 'open' },
        { id: 'high', title: 'high' },
        { id: 'low', title: 'low' },
        { id: 'close', title: 'close' },
        { id: 'volume', title: 'volume' },
        { id: 'turnover', title: 'turnover' },
        { id: 'adj_close', title: 'adj_close' },
        { id: 'turnover_rate', title: 'turnover_rate' },
        { id: 'change_percent', title: 'change_percent' },
        { id: 'amplitude', title: 'amplitude' },
        { id: 'pe', title: 'pe' },
        { id: 'pb', title: 'pb' },
        { id: 'ps', title: 'ps' },
        { id: 'is_trading_day', title: 'is_trading_day' },
        { id: 'is_suspended', title: 'is_suspended' },
      ],
    });

    const records = mergedBars.map(bar => ({
      ...bar,
      time: bar.time.toISOString(),
      is_trading_day: bar.is_trading_day ? 'true' : 'false',
      is_suspended: bar.is_suspended ? 'true' : 'false',
    }));

    await csvWriter.writeRecords(records);
  }

  // --- Backtests Management ---
  public async getBacktests(user_id?: number): Promise<LocalBacktestResult[]> {
    let backtests = this.readJson<LocalBacktestResult>(this.backtestsFile);

    // Parse dates back
    backtests = backtests.map(b => ({
      ...b,
      start_date: new Date(b.start_date),
      end_date: new Date(b.end_date),
      created_at: new Date(b.created_at),
      updated_at: new Date(b.updated_at),
    }));

    if (user_id !== undefined) {
      return backtests.filter(b => b.user_id === user_id);
    }
    return backtests;
  }

  public async getBacktest(id: string): Promise<LocalBacktestResult | null> {
    const backtests = await this.getBacktests();
    return backtests.find(b => b.id === id) || null;
  }

  public async saveBacktest(backtest: LocalBacktestResult): Promise<void> {
    const backtests = await this.getBacktests();
    const index = backtests.findIndex(b => b.id === backtest.id);
    if (index >= 0) {
      backtests[index] = { ...backtest, updated_at: new Date() };
    } else {
      backtests.push(backtest);
    }
    this.writeJson(this.backtestsFile, backtests);
  }

  public async deleteBacktest(id: string): Promise<boolean> {
    const backtests = await this.getBacktests();
    const initialLen = backtests.length;
    const filtered = backtests.filter(b => b.id !== id);
    if (filtered.length < initialLen) {
      this.writeJson(this.backtestsFile, filtered);

      // Cascading delete trades
      const trades = await this.getTrades(id);
      if (trades.length > 0) {
        const allTrades = this.readJson<LocalTrade>(this.tradesFile);
        const filteredTrades = allTrades.filter(t => t.backtest_id !== id);
        this.writeJson(this.tradesFile, filteredTrades);
      }
      return true;
    }
    return false;
  }

  // --- Trades Management ---
  public async getTrades(backtest_id: string): Promise<LocalTrade[]> {
    let trades = this.readJson<LocalTrade>(this.tradesFile);
    trades = trades.filter(t => t.backtest_id === backtest_id);

    return trades.map(t => ({
      ...t,
      entry_date: new Date(t.entry_date),
      exit_date: t.exit_date ? new Date(t.exit_date) : undefined,
      created_at: new Date(t.created_at),
    }));
  }

  public async saveTrades(newTrades: LocalTrade[]): Promise<void> {
    if (newTrades.length === 0) return;
    const allTrades = this.readJson<LocalTrade>(this.tradesFile);
    allTrades.push(...newTrades);
    this.writeJson(this.tradesFile, allTrades);
  }

  // --- Favorites Management ---
  public async getFavorites(user_id: number): Promise<LocalFavorite[]> {
    let favorites = this.readJson<LocalFavorite>(this.favoritesFile);
    favorites = favorites.filter(f => f.user_id === user_id);

    return favorites.map(f => ({
      ...f,
      created_at: new Date(f.created_at),
      updated_at: new Date(f.updated_at),
    }));
  }

  public async addFavorite(
    favorite: Omit<LocalFavorite, 'id' | 'created_at' | 'updated_at'>
  ): Promise<LocalFavorite> {
    const allFavorites = this.readJson<LocalFavorite>(this.favoritesFile);

    // Check if exists
    const existing = allFavorites.find(
      f => f.user_id === favorite.user_id && f.symbol === favorite.symbol
    );
    if (existing) {
      throw new Error('Already favorited');
    }

    const newFavorite: LocalFavorite = {
      ...favorite,
      id: randomUUID(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    allFavorites.push(newFavorite);
    this.writeJson(this.favoritesFile, allFavorites);
    return newFavorite;
  }

  public async removeFavorite(user_id: number, symbol: string): Promise<boolean> {
    const allFavorites = this.readJson<LocalFavorite>(this.favoritesFile);
    const initialLen = allFavorites.length;
    const filtered = allFavorites.filter(f => !(f.user_id === user_id && f.symbol === symbol));

    if (filtered.length < initialLen) {
      this.writeJson(this.favoritesFile, filtered);
      return true;
    }
    return false;
  }

  // --- Users Management ---
  public async getUsers(): Promise<LocalUser[]> {
    return this.readJson<LocalUser>(this.usersFile);
  }

  public async getUserById(id: number): Promise<LocalUser | null> {
    const users = await this.getUsers();
    return users.find(u => u.id === id) || null;
  }

  public async getUserByUsername(username: string): Promise<LocalUser | null> {
    const users = await this.getUsers();
    return users.find(u => u.username === username) || null;
  }

  public async saveUser(user: LocalUser): Promise<void> {
    const users = await this.getUsers();
    const index = users.findIndex(u => u.id === user.id);
    if (index >= 0) {
      users[index] = { ...user, updated_at: new Date() };
    } else {
      users.push({ ...user, id: users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1 });
    }
    this.writeJson(this.usersFile, users);
  }
}
