import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  BeforeCreate,
  BeforeUpdate,
  HasMany,
} from 'sequelize-typescript';
import bcrypt from 'bcrypt';
import { BacktestResult } from './BacktestResult';
import { PaperTradingPortfolio } from './PaperTradingPortfolio';
import { RiskAlert } from './RiskAlert';
import { TradingJournal } from './TradingJournal';

@Table({
  tableName: 'users',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['username'],
    },
    {
      unique: true,
      fields: ['email'],
    },
  ],
})
export class User extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    unique: true,
  })
  declare username: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true,
    },
  })
  declare email: string;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
  })
  declare avatarUrl: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
  })
  declare nickname: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
  })
  declare phone: string;

  @Column({
    type: DataType.STRING(255),
    allowNull: false,
  })
  declare passwordHash: string;

  @Column({
    type: DataType.STRING(50),
    defaultValue: 'user',
  })
  declare role: string;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
  })
  declare isActive: boolean;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {
      stopLossPercent: 5,
      takeProfitPercent: 10,
      enableVolumeAlert: true,
      enableTechnicalAlert: true,
    },
    comment: '用户自定义的风控阈值配置',
  })
  declare riskConfig: any;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @HasMany(() => BacktestResult)
  declare backtestResults: BacktestResult[];

  @HasMany(() => PaperTradingPortfolio)
  declare portfolios: PaperTradingPortfolio[];

  @HasMany(() => RiskAlert)
  declare riskAlerts: RiskAlert[];

  @HasMany(() => TradingJournal)
  declare tradingJournals: TradingJournal[];

  @BeforeCreate
  @BeforeUpdate
  static async hashPassword(instance: User) {
    if (instance.changed('passwordHash')) {
      const salt = await bcrypt.genSalt(10);
      instance.passwordHash = await bcrypt.hash(instance.passwordHash, salt);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.passwordHash);
  }

  toJSON() {
    const values = Object.assign({}, this.get());
    delete values.passwordHash;
    return values;
  }
}
