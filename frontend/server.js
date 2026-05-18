const express = require('express');
const compression = require('compression');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// 启用 Gzip 压缩，这将极大减少 2MB 的 main.js 传输体积
app.use(compression());

// 托管 build 静态文件
app.use(express.static(path.join(__dirname, 'build')));

// 解决 React Router 的单页应用路由问题 (Express 5.x 语法)
app.get(/^(?!\/api).+/, (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(port, () => {
  console.log(`Frontend server is running on port ${port} with Gzip compression enabled.`);
});
