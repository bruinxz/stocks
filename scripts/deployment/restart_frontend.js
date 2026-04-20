const { Client } = require('ssh2');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./.vscode/sftp.json', 'utf8'));

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('cd /home/lym/stocks/frontend && npm run build && pm2 restart frontend', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      console.log('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password
});
