#!/bin/sh
# Make a server listening on 127.0.0.1:<port> answer on port 80 of the host's
# loopback, so the Android emulator (whose 10.0.2.2 is the host loopback) can
# reach it as http://www.pandora.com/ once /etc/hosts in the emulator maps the
# name to 10.0.2.2. Needs sudo (GitHub-hosted runners have it).
set -eu
port=${1:?usage: host-port80.sh <port>}
sudo iptables -t nat -A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports "$port"
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports "$port" 2>/dev/null || true
echo "port 80 -> 127.0.0.1:$port"
