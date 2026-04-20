#!/usr/bin/expect -f
set password [lindex $argv 0]
set cmd [lindex $argv 1]
spawn -noecho sh -c $cmd
expect {
    "*assword:*" { send "$password\r"; exp_continue }
    eof
}
