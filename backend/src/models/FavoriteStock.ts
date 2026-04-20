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
      fields: ['user_id', 'stock_id'],
      name: 'user_stock_unique',
    },
    {
      fields: ['user_id'],
    },
    {
      fields: ['stock_id'],
    },
    {
      fields: ['group_id'],
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
    field: 'user_id',
    comment: '用户ID',
  })
  declare userId: number;

  @ForeignKey(() => Stock)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'stock_id',
    comment: '股票ID',
  })
  declare stockId: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'group_id',
    comment: '自定义分组，如 "科技股"、"蓝筹股" 等',
  })
  declare groupId?: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '自定义标签',
  })
  declare tags?: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '备注',
  })
  declare notes?: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    defaultValue: 0,
    field: 'sort_order',
    comment: '排序权重，越大越靠前',
  })
  declare sortOrder?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;

  // 关联关系
  @BelongsTo(() => User)
  declare user: User;

  @BelongsTo(() => Stock)
  declare stock: Stock;
}
