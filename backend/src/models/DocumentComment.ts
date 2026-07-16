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
 * DocumentComment — 文档评论系统 (飞书式)
 *
 * 一行 = 一条评论 (可以是根评论或某评论的回复).
 * 支持:
 *   - 锚定到文档具体位置 (heading path + snippet)
 *   - Thread 回复 (parent_id + thread_root_id)
 *   - 状态: open / resolved
 *   - 软删除 (deleted_at)
 *
 * 锚定策略:
 *   anchor_type = 'heading' 时, anchor_key = "H2:全局约束 > H3:0.1 正确性优先"
 *   anchor_type = 'line' 时, anchor_key = "L120"  (行号, 不稳但简单)
 *   anchor_type = 'paragraph' 时, anchor_key = paragraph 内容 hash
 *   anchor_snippet = 被评论文本的前 100 字, 用于 heading 消失时 fuzzy match 恢复位置
 *
 * Thread 结构:
 *   parent_id = null → 根评论
 *   parent_id = X   → X 的回复
 *   thread_root_id  → thread 顶层, 用于 group by 一次查完整 thread
 */
@Table({
  tableName: 'document_comments',
  timestamps: true,
  underscored: true,
  paranoid: true, // 软删除 (deleted_at)
  indexes: [
    { fields: ['doc_path', 'status', 'created_at'], name: 'idx_doc_comments_path_status' },
    { fields: ['doc_path', 'anchor_key'], name: 'idx_doc_comments_anchor' },
    { fields: ['thread_root_id', 'created_at'], name: 'idx_doc_comments_thread' },
    { fields: ['user_id'], name: 'idx_doc_comments_user' },
  ],
})
export class DocumentComment extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.STRING(500),
    allowNull: false,
    field: 'doc_path',
    comment: '文档相对路径 (docs/ 内), 例如 "SIGNAL_FIRST_PLAN.md"',
  })
  declare doc_path: string;

  @Column({
    type: DataType.ENUM('heading', 'line', 'paragraph', 'doc'),
    allowNull: false,
    field: 'anchor_type',
    comment:
      '锚定类型: heading (推荐, 稳定) / line (简单但不稳) / paragraph (paragraph hash) / doc (整文档级)',
  })
  declare anchor_type: 'heading' | 'line' | 'paragraph' | 'doc';

  @Column({
    type: DataType.STRING(500),
    allowNull: false,
    field: 'anchor_key',
    comment: '锚定 key, 例如 "H2:全局约束 > H3:0.1 正确性优先" / "L120" / paragraph hash',
  })
  declare anchor_key: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'anchor_snippet',
    comment: '被评论文本的前 100 字, 用于 heading 消失时 fuzzy 恢复位置 + 前端预览',
  })
  declare anchor_snippet: string | null;

  @ForeignKey(() => DocumentComment)
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'parent_id',
    comment: '父评论 id (null = 根评论); 回复某评论时填对方 id',
  })
  declare parent_id: number | null;

  @BelongsTo(() => DocumentComment, { foreignKey: 'parent_id', as: 'parent' })
  declare parent?: DocumentComment;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'thread_root_id',
    comment: 'thread 顶层评论 id (自己是根时 = 自己 id); 用于 group by 一次查完整 thread',
  })
  declare thread_root_id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '评论者 user id',
  })
  declare user_id: number;

  @BelongsTo(() => User, { foreignKey: 'user_id', as: 'user' })
  declare user?: User;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'content',
    comment: '评论文本 (支持 markdown)',
  })
  declare content: string;

  @Column({
    type: DataType.ENUM('open', 'resolved'),
    allowNull: false,
    defaultValue: 'open',
    field: 'status',
    comment: 'open (未解决) / resolved (已标记解决, 通常发生在 thread 根评论上)',
  })
  declare status: 'open' | 'resolved';

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'resolved_by',
    comment: '标记 resolved 的用户 id (与 resolved_at 一起)',
  })
  declare resolved_by: number | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'resolved_at',
    comment: '标记 resolved 的时间',
  })
  declare resolved_at: Date | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'human',
    field: 'author_kind',
    comment: '作者类型: human (人工) / ai (Claude 等 AI); 用于 UI 区分显示头像/图标',
  })
  declare author_kind: 'human' | 'ai';

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'deleted_at',
  })
  declare deleted_at: Date | null;
}
