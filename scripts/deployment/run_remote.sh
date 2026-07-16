#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]
set cmd [lindex $argv 1]
set user [expr {[llength $argv] > 2 ? [lindex $argv 2] : [expr {[info exists env(SSH_USER)] ? $env(SSH_USER) : "deploy"}]}]
set host [expr {[info exists env(SSH_HOST)] ? $env(SSH_HOST) : "<legacy-prod-host>"}]
set port [expr {[info exists env(SSH_PORT)] ? $env(SSH_PORT) : "14126"}]
set timeout [expr {[info exists env(REMOTE_TIMEOUT_SEC)] ? $env(REMOTE_TIMEOUT_SEC) : "300"}]
set connect_timeout [expr {[info exists env(DEPLOY_SSH_CONNECT_TIMEOUT_SEC)] ? $env(DEPLOY_SSH_CONNECT_TIMEOUT_SEC) : "15"}]
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=$connect_timeout -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p $port $user@$host $cmd
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    timeout { puts stderr "ERROR: remote command timed out after $timeout seconds"; exit 124 }
    eof
}
catch wait result
exit [lindex $result 3]
