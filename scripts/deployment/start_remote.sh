#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]
set user [expr {[llength $argv] > 1 ? [lindex $argv 1] : [expr {[info exists env(SSH_USER)] ? $env(SSH_USER) : "deploy"}]}]
set host [expr {[info exists env(SSH_HOST)] ? $env(SSH_HOST) : "<legacy-prod-host>"}]
set port [expr {[info exists env(SSH_PORT)] ? $env(SSH_PORT) : "14126"}]

spawn ssh -o StrictHostKeyChecking=no -p $port $user@$host "cd /opt/stocks/current/backend && npm run build"
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}
