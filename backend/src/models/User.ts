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
    field: 'avatar_url',
  })
  declare avatar_url: string;

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
    field: 'password_hash',
  })
  declare password_hash: string;

  @Column({
    type: DataType.STRING(50),
    defaultValue: 'user',
  })
  declare role: string;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
  })
  declare is_active: boolean;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {
      stop_loss_percent: 5,
      take_profit_percent: 10,
      enableVolumeAlert: true,
      enableTechnicalAlert: true,
    },
    field: 'risk_config',
    comment: '用户自定义的风控阈值配置',
  })
  declare risk_config: any;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  @HasMany(() => BacktestResult)
  declare backtest_results: BacktestResult[];

  @HasMany(() => PaperTradingPortfolio)
  declare portfolios: PaperTradingPortfolio[];

  @HasMany(() => RiskAlert)
  declare risk_alerts: RiskAlert[];

  @HasMany(() => TradingJournal)
  declare trading_journals: TradingJournal[];

  @BeforeCreate
  @BeforeUpdate
  static async hashPassword(instance: User) {
    if (instance.changed('password_hash')) {
      const salt = await bcrypt.genSalt(10);
      instance.password_hash = await bcrypt.hash(instance.password_hash, salt);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password_hash);
  }

  toJSON() {
    const values = Object.assign({}, this.get());
    delete values.password_hash;
    return values;
  }
}
