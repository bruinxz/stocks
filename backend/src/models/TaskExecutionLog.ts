import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'task_execution_logs',
  timestamps: true,
})
export class TaskExecutionLog extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
  })
  declare task_id: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
  })
  declare task_name: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
  })
  declare status: string; // PENDING, IN_PROGRESS, COMPLETED, FAILED, SKIPPED

  @Column({
    type: DataType.INTEGER,
    defaultValue: 0,
  })
  declare total_items: number;

  @Column({
    type: DataType.INTEGER,
    defaultValue: 0,
  })
  declare completed_items: number;

  @Column({
    type: DataType.INTEGER,
    defaultValue: 0,
  })
  declare failed_items: number;

  @Column({
    type: DataType.TEXT,
  })
  declare error_message: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
  })
  declare result_summary: Record<string, any>;

  @Column({
    type: DataType.DATE,
  })
  declare started_at: Date;

  @Column({
    type: DataType.DATE,
  })
  declare completed_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
