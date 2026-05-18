const bcrypt = require('bcrypt');

async function generateSQL() {
  const users = [
    { username: 'lym', password: 'lym666', email: 'lym@example.com' },
    { username: 'xxz', password: 'xxz666', email: 'xxz@example.com' }
  ];

  for (const u of users) {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(u.password, salt);
    console.log(`INSERT INTO users (username, email, "passwordHash", role, "isActive", "createdAt", "updatedAt") VALUES ('${u.username}', '${u.email}', '${hash}', 'admin', true, NOW(), NOW()) ON CONFLICT (username) DO UPDATE SET "passwordHash" = '${hash}';`);
  }
}

generateSQL();
