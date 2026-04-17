import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import csvParser from 'csv-parser';
import { logger } from '../../utils/logger';

export interface LocalStock {
  id?: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  listingDate?: Date | null;
  delistingDate?: Date | null;
  isListed?: boolean;
  type?: string;
}

export interface LocalDailyBar {
  time: Date;
  stockId?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  adjClose?: number;
  turnoverRate?: number;
  changePercent?: number;
  amplitude?: number;
  pe?: number;
  pb?: number;
  ps?: number;
  isTradingDay?: boolean;
  isSuspended?: boolean;
}

export interface LocalBacktestResult {
  id: string;
  userId: number;
  name: string;
  description?: string;
  strategyConfig: any;
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  annualizedReturn?: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
  maxDrawdown?: number;
  winRate?: number;
  profitLossRatio?: number;
  totalTrades: number;
  profitTrades: number;
  lossTrades: number;
  status: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocalTrade {
  id: string;
  backtestId: string;
  symbol: string;
  entryDate: Date;
  exitDate?: Date;
  direction: string;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  pnlPercent?: number;
  holdingDays?: number;
  createdAt: Date;
}

export interface LocalFavorite {
  id: string;
  userId: number;
  symbol: string;
  groupId?: string;
  tags?: string;
  notes?: string;
  sortOrder?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocalUser {
  id: number;
  username: string;
  email: string;
  passwordHash: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
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
        listingDate: s.listingDate ? new Date(s.listingDate) : null,
        delistingDate: s.delistingDate ? new Date(s.delistingDate) : null,
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
    startDate?: Date,
    endDate?: Date
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
          if (startDate && time < startDate) return;
          if (endDate && time > endDate) return;

          results.push({
            time,
            open: parseFloat(data.open),
            high: parseFloat(data.high),
            low: parseFloat(data.low),
            close: parseFloat(data.close),
            volume: parseFloat(data.volume),
            turnover: data.turnover ? parseFloat(data.turnover) : undefined,
            adjClose: data.adjClose ? parseFloat(data.adjClose) : undefined,
            turnoverRate: data.turnoverRate ? parseFloat(data.turnoverRate) : undefined,
            changePercent: data.changePercent ? parseFloat(data.changePercent) : undefined,
            amplitude: data.amplitude ? parseFloat(data.amplitude) : undefined,
            pe: data.pe ? parseFloat(data.pe) : undefined,
            pb: data.pb ? parseFloat(data.pb) : undefined,
            ps: data.ps ? parseFloat(data.ps) : undefined,
            isTradingDay: data.isTradingDay === 'true',
            isSuspended: data.isSuspended === 'true',
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
        { id: 'adjClose', title: 'adjClose' },
        { id: 'turnoverRate', title: 'turnoverRate' },
        { id: 'changePercent', title: 'changePercent' },
        { id: 'amplitude', title: 'amplitude' },
        { id: 'pe', title: 'pe' },
        { id: 'pb', title: 'pb' },
        { id: 'ps', title: 'ps' },
        { id: 'isTradingDay', title: 'isTradingDay' },
        { id: 'isSuspended', title: 'isSuspended' },
      ],
    });

    const records = mergedBars.map(bar => ({
      ...bar,
      time: bar.time.toISOString(),
      isTradingDay: bar.isTradingDay ? 'true' : 'false',
      isSuspended: bar.isSuspended ? 'true' : 'false',
    }));

    await csvWriter.writeRecords(records);
  }

  // --- Backtests Management ---
  public async getBacktests(userId?: number): Promise<LocalBacktestResult[]> {
    let backtests = this.readJson<LocalBacktestResult>(this.backtestsFile);

    // Parse dates back
    backtests = backtests.map(b => ({
      ...b,
      startDate: new Date(b.startDate),
      endDate: new Date(b.endDate),
      createdAt: new Date(b.createdAt),
      updatedAt: new Date(b.updatedAt),
    }));

    if (userId !== undefined) {
      return backtests.filter(b => b.userId === userId);
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
      backtests[index] = { ...backtest, updatedAt: new Date() };
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
        const filteredTrades = allTrades.filter(t => t.backtestId !== id);
        this.writeJson(this.tradesFile, filteredTrades);
      }
      return true;
    }
    return false;
  }

  // --- Trades Management ---
  public async getTrades(backtestId: string): Promise<LocalTrade[]> {
    let trades = this.readJson<LocalTrade>(this.tradesFile);
    trades = trades.filter(t => t.backtestId === backtestId);

    return trades.map(t => ({
      ...t,
      entryDate: new Date(t.entryDate),
      exitDate: t.exitDate ? new Date(t.exitDate) : undefined,
      createdAt: new Date(t.createdAt),
    }));
  }

  public async saveTrades(newTrades: LocalTrade[]): Promise<void> {
    if (newTrades.length === 0) return;
    const allTrades = this.readJson<LocalTrade>(this.tradesFile);
    allTrades.push(...newTrades);
    this.writeJson(this.tradesFile, allTrades);
  }

  // --- Favorites Management ---
  public async getFavorites(userId: number): Promise<LocalFavorite[]> {
    let favorites = this.readJson<LocalFavorite>(this.favoritesFile);
    favorites = favorites.filter(f => f.userId === userId);

    return favorites.map(f => ({
      ...f,
      createdAt: new Date(f.createdAt),
      updatedAt: new Date(f.updatedAt),
    }));
  }

  public async addFavorite(
    favorite: Omit<LocalFavorite, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<LocalFavorite> {
    const allFavorites = this.readJson<LocalFavorite>(this.favoritesFile);

    // Check if exists
    const existing = allFavorites.find(
      f => f.userId === favorite.userId && f.symbol === favorite.symbol
    );
    if (existing) {
      throw new Error('Already favorited');
    }

    const newFavorite: LocalFavorite = {
      ...favorite,
      id: Math.random().toString(36).substring(2, 15),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    allFavorites.push(newFavorite);
    this.writeJson(this.favoritesFile, allFavorites);
    return newFavorite;
  }

  public async removeFavorite(userId: number, symbol: string): Promise<boolean> {
    const allFavorites = this.readJson<LocalFavorite>(this.favoritesFile);
    const initialLen = allFavorites.length;
    const filtered = allFavorites.filter(f => !(f.userId === userId && f.symbol === symbol));

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
      users[index] = { ...user, updatedAt: new Date() };
    } else {
      users.push({ ...user, id: users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1 });
    }
    this.writeJson(this.usersFile, users);
  }
}
