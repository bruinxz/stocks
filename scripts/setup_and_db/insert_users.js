const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');

dotenv.config({ path: '/opt/stocks/backend/.env' });

const sequelize = new Sequelize(
  process.env.DB_NAME || 'stock_backtest',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASSWORD || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    dialect: 'postgres',
    logging: false,
  }
);

const User = sequelize.define('User', {
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
  },
  email: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
  },
  passwordHash: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  role: {
    type: DataTypes.STRING(50),
    defaultValue: 'user',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'users',
  timestamps: true,
});

async function insertUsers() {
  try {
    await sequelize.authenticate();
    console.log('Connection has been established successfully.');

    const usersToInsert = [
      { username: 'lym', password: 'lym666', email: 'lym@example.com' },
      { username: 'xxz', password: 'xxz666', email: 'xxz@example.com' }
    ];

    for (const u of usersToInsert) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(u.password, salt);
      
      const [user, created] = await User.findOrCreate({
        where: { username: u.username },
        defaults: {
          username: u.username,
          email: u.email,
          passwordHash: hash,
          role: 'admin',
          isActive: true
        }
      });

      if (created) {
        console.log(`User ${u.username} created successfully.`);
      } else {
        await user.update({ passwordHash: hash });
        console.log(`User ${u.username} already exists. Password updated.`);
      }
    }
    
    console.log('All done.');
  } catch (error) {
    console.error('Unable to connect to the database or insert users:', error);
  } finally {
    await sequelize.close();
  }
}

insertUsers();
