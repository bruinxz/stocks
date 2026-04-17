import {
  Table,
  Column,
  Model,
  DataType,
  ForeignKey,
  BelongsTo,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { User } from './User';
import { Stock } from './Stock';

@Table({
  tableName: 'favorite_stocks',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['userId', 'stockId'],
      name: 'user_stock_unique',
    },
    {
      fields: ['userId'],
    },
    {
      fields: ['stockId'],
    },
    {
      fields: ['groupId'],
    },
  ],
})
export class FavoriteStock extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '用户ID',
  })
  declare userId: number;

  @ForeignKey(() => Stock)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '股票ID',
  })
  declare stockId: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: '自定义分组，如 "科技股"、"蓝筹股" 等',
  })
  groupId?: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '自定义标签',
  })
  tags?: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '备注',
  })
  notes?: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    defaultValue: 0,
    comment: '排序权重，越大越靠前',
  })
  sortOrder?: number;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  // 关联关系
  @BelongsTo(() => User)
  declare user: User;

  @BelongsTo(() => Stock)
  declare stock: Stock;
}
