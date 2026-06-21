import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { User } from './User';

/**
 * UserFeedback — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环.
 *
 * 一行 = 单个用户提交的一条反馈 (标题 + 描述 + 多张图片). FEEDBACK_REVIEW_SWEEP cron
 * (每 30min) 拿出 status='pending' 且 (reviewed_at IS NULL OR reviewed_at < NOW() - 6h)
 * 的行, 跑启发式分类器把 ai_classification / ai_priority / ai_summary 写回; admin 通过
 * POST /api/admin/feedbacks/:id/resolve 标记 status='resolved' + resolution_note +
 * resolution_commit_hash / pr_number 可选关联.
 *
 * status 四态:
 *   - 'pending'     — 已提交未处理 (默认)
 *   - 'in_progress' — admin 已认领开始处理 (本 story 不直接暴露 admin 流转 endpoint, 留枚举)
 *   - 'resolved'    — 已解决 (admin resolve 时写; 前端绿底回复块展示 resolution_note)
 *   - 'dismissed'   — 已忽略 (admin 主动忽略, 不解决也不再 review)
 *
 * **绝不让 cron 自动 resolve** — cron 只分类 / 摘要, 真正 resolve 必须 admin 手工触发,
 * 避免误判 user 反馈被静默关闭.
 *
 * 不在此 model 加 `user` 反向 hasMany — 减少 model 间循环依赖, 用户列表查询 service 自己 join.
 */
@Table({
  tableName: 'user_feedbacks',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id', 'status', 'created_at'], name: 'idx_user_feedbacks_user_status' },
    { fields: ['status', 'reviewed_at'], name: 'idx_user_feedbacks_status_reviewed' },
  ],
})
export class UserFeedback extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '所属用户 ID',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    field: 'title',
    comment: '反馈标题 (≤ 200 字, 前端 input 限长)',
  })
  declare title: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'description',
    comment: '反馈描述 (textarea)',
  })
  declare description: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'image_urls',
    defaultValue: [],
    comment: '上传图片 URL 数组 (相对路径, 前端通过 /uploads/feedback/<user>/<file> 取)',
  })
  declare image_urls: string[];

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    field: 'status',
    defaultValue: 'pending',
    comment: 'pending / in_progress / resolved / dismissed',
  })
  declare status: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'resolution_note',
    comment: 'admin 解决说明 (绿底回复块展示)',
  })
  declare resolution_note: string | null;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'resolution_commit_hash',
    comment: '关联 commit hash (可选)',
  })
  declare resolution_commit_hash: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'resolution_pr_number',
    comment: '关联 PR 号 (可选)',
  })
  declare resolution_pr_number: number | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'resolved_at',
    comment: '解决时刻',
  })
  declare resolved_at: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'reviewed_at',
    comment: '上次 FEEDBACK_REVIEW_SWEEP cron 跑的时刻; NULL = 未跑过',
  })
  declare reviewed_at: Date | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'ai_classification',
    comment: 'bug / feature_request / question / praise / other',
  })
  declare ai_classification: string | null;

  @Column({
    type: DataType.SMALLINT,
    allowNull: true,
    field: 'ai_priority',
    comment: '1 (最低) .. 5 (最高); 启发式给出',
  })
  declare ai_priority: number | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'ai_summary',
    comment: 'heuristic 摘要 (≤ 200 字, service 截断)',
  })
  declare ai_summary: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment: '预留 (user_agent / ip / 提交端等)',
  })
  declare metadata: Record<string, unknown>;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updated_at: Date;
}

export default UserFeedback;
