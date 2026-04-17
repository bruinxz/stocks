#!/usr/bin/expect -f
set timeout -1
set password [lindex $argv 0]
set cmd [lindex $argv 1]
spawn ssh -o StrictHostKeyChecking=no lym@47.93.224.109 $cmd
expect {
    "*yes/no*" { send "yes\r"; exp_continue }
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}