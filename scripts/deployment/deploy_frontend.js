const fs = require('fs');
const Client = require('ssh2-sftp-client');
const path = require('path');

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
    
    const localDir = path.join(__dirname, 'frontend/src');
    const remoteDir = path.posix.join(config.remotePath, 'frontend/src');
    
    console.log(`Uploading from ${localDir} to ${remoteDir}`);
    await sftp.uploadDir(localDir, remoteDir);
    console.log('Frontend code uploaded successfully!');
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    sftp.end();
  }
}

main();
