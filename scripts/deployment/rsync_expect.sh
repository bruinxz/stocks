#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]
set src [lindex $argv 1]
set dest [lindex $argv 2]
set port [expr {[llength $argv] > 3 ? [lindex $argv 3] : [expr {[info exists env(SSH_PORT)] ? $env(SSH_PORT) : "14126"}]}]

spawn rsync -avz -e "ssh -p $port -o StrictHostKeyChecking=no" --exclude 'node_modules' --exclude '.git' --exclude 'data' $src $dest
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}
