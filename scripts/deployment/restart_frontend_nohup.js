const { Client } = require('ssh2');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./.vscode/sftp.json', 'utf8'));

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('cd /home/lym/stocks/frontend && nohup npm run build > build.log 2>&1 &', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Build command started in background.');
      conn.end();
    });
  });
}).connect({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password
});
