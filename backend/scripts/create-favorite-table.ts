import { sequelize } from '../src/config/database';

async function createFavoriteTable() {
  try {
    console.log('Creating favorite_stocks table if not exists...');

    // 检查表是否已存在
    const [results] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'favorite_stocks'
      )`
    );

    const tableExists = (results as any[])[0]?.exists || false;

    if (tableExists) {
      console.log('Table favorite_stocks already exists');
      process.exit(0);
    }

    // 创建表
    await sequelize.query(`
      CREATE TABLE favorite_stocks (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "stockId" INTEGER NOT NULL,
        "groupId" VARCHAR(50),
        tags VARCHAR(100),
        notes TEXT,
        "sortOrder" INTEGER DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("userId", "stockId")
      )
    `);

    // 创建索引
    await sequelize.query('CREATE INDEX "favorite_stocks_user_id" ON favorite_stocks ("userId")');
    await sequelize.query('CREATE INDEX "favorite_stocks_stock_id" ON favorite_stocks ("stockId")');
    await sequelize.query('CREATE INDEX "favorite_stocks_group_id" ON favorite_stocks ("groupId")');

    console.log('Table favorite_stocks created successfully');

    // 添加外键约束（可选）
    try {
      await sequelize.query(`
        ALTER TABLE favorite_stocks
        ADD CONSTRAINT "favorite_stocks_user_id_fkey"
        FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE
      `);
      await sequelize.query(`
        ALTER TABLE favorite_stocks
        ADD CONSTRAINT "favorite_stocks_stock_id_fkey"
        FOREIGN KEY ("stockId") REFERENCES stocks(id) ON DELETE CASCADE
      `);
      console.log('Foreign key constraints added');
    } catch (fkError) {
      console.warn('Could not add foreign key constraints:', fkError.message);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error creating table:', error);
    process.exit(1);
  }
}

createFavoriteTable();