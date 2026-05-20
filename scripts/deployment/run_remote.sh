#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]
set cmd [lindex $argv 1]
set user [expr {[llength $argv] > 2 ? [lindex $argv 2] : [expr {[info exists env(SSH_USER)] ? $env(SSH_USER) : "deploy"}]}]
set host [expr {[info exists env(SSH_HOST)] ? $env(SSH_HOST) : "103.242.3.87"}]
set port [expr {[info exists env(SSH_PORT)] ? $env(SSH_PORT) : "14126"}]
spawn ssh -o StrictHostKeyChecking=no -p $port $user@$host $cmd
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}
