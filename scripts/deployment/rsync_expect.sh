#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]
set src [lindex $argv 1]
set dest [lindex $argv 2]
set port [expr {[llength $argv] > 3 ? [lindex $argv 3] : [expr {[info exists env(SSH_PORT)] ? $env(SSH_PORT) : "14126"}]}]
set rsync_timeout [expr {[llength $argv] > 4 ? [lindex $argv 4] : [expr {[info exists env(DEPLOY_RSYNC_TIMEOUT_SEC)] ? $env(DEPLOY_RSYNC_TIMEOUT_SEC) : "240"}]}]
set connect_timeout [expr {[llength $argv] > 5 ? [lindex $argv 5] : [expr {[info exists env(DEPLOY_SSH_CONNECT_TIMEOUT_SEC)] ? $env(DEPLOY_SSH_CONNECT_TIMEOUT_SEC) : "15"}]}]
set timeout [expr {$rsync_timeout + 45}]

spawn rsync -avz --timeout=$rsync_timeout -e "ssh -p $port -o StrictHostKeyChecking=no -o ConnectTimeout=$connect_timeout -o ServerAliveInterval=15 -o ServerAliveCountMax=3" --exclude 'node_modules' --exclude '.git' --exclude 'data' $src $dest
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    timeout { puts stderr "ERROR: rsync timed out after $timeout seconds"; exit 124 }
    eof
}
catch wait result
exit [lindex $result 3]
