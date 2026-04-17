const fs = require('fs');
const Client = require('ssh2-sftp-client');

async function main() {
  const config = JSON.parse(fs.readFileSync('./.vscode/sftp.json', 'utf8'));
  const sftp = new Client();
  
  try {
    console.log('Connecting to SFTP...');
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 10000
    });
    console.log('Connected successfully!');
    
    // We'll just test the connection for now to see if it works with ssh2-sftp-client
    const list = await sftp.list(config.remotePath);
    console.log('Remote directory listed successfully');
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    sftp.end();
  }
}

main();
