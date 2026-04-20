#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]

spawn ssh -o StrictHostKeyChecking=no -p 14126 root@103.242.3.87 "export PATH=/usr/local/bin:\$PATH && cd /opt/stocks/backend && (pm2 delete stock-backend || true) && NODE_ENV=production pm2 start dist/index.js --name stock-backend"
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}

spawn ssh -o StrictHostKeyChecking=no -p 14126 root@103.242.3.87 "export PATH=/usr/local/bin:\$PATH && cd /opt/stocks/frontend && (pm2 delete stock-frontend || true) && pm2 serve build 3001 --name stock-frontend --spa"
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}
