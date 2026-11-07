#!/usr/bin/env python3
"""Tiny DNS server for the emulator smoke test.

The Android emulator guest ignores a hosts file placed over /system/etc/hosts
(its resolver still asked real DNS in run 42278354776), so instead the
emulator is started with `-dns-server <host ip>` and this resolver answers on
that address: the mapped names get an A record for 10.0.2.2 (the host as seen
from the guest), everything else is forwarded to the host's own resolver.

  sudo python3 tools/smoke-dns.py --serve --bind 10.1.0.4 --answer 10.0.2.2 \
       --names www.pandora.com,tuner.pandora.com
  python3 tools/smoke-dns.py --query www.pandora.com --server 10.1.0.4
"""
import argparse, socket, struct, sys, time


def parse_name(buf, off):
    labels = []
    while True:
        n = buf[off]
        if n == 0:
            return ".".join(labels), off + 1
        if n & 0xC0 == 0xC0:
            ptr = struct.unpack("!H", buf[off:off + 2])[0] & 0x3FFF
            tail, _ = parse_name(buf, ptr)
            labels.append(tail)
            return ".".join(labels), off + 2
        labels.append(buf[off + 1:off + 1 + n].decode("ascii", "replace"))
        off += 1 + n


def encode_name(name):
    out = b""
    for label in name.rstrip(".").split("."):
        if label:
            out += bytes([len(label)]) + label.encode("ascii")
    return out + b"\x00"


def build_query(name, qtype=1):
    header = struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0)
    return header + encode_name(name) + struct.pack("!HH", qtype, 1)


def answers(resp):
    """A/AAAA addresses and CNAMEs in a response, in order."""
    qd, an = struct.unpack("!HH", resp[4:8])
    off = 12
    for _ in range(qd):
        _, off = parse_name(resp, off)
        off += 4
    out = []
    for _ in range(an):
        _, off = parse_name(resp, off)
        rtype, _, _, rdlen = struct.unpack("!HHIH", resp[off:off + 10])
        off += 10
        rdata = resp[off:off + rdlen]
        off += rdlen
        if rtype == 1 and rdlen == 4:
            out.append(socket.inet_ntoa(rdata))
        elif rtype == 28 and rdlen == 16:
            out.append(socket.inet_ntop(socket.AF_INET6, rdata))
        elif rtype == 5:
            out.append("CNAME " + parse_name(resp, off - rdlen)[0])
    return out


def upstreams():
    servers = []
    try:
        for line in open("/etc/resolv.conf"):
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "nameserver" and ":" not in parts[1]:
                servers.append(parts[1])
    except OSError:
        pass
    for s in ("127.0.0.53", "8.8.8.8", "1.1.1.1"):
        if s not in servers:
            servers.append(s)
    return servers


def forward(data, servers):
    for server in servers:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3)
            s.sendto(data, (server, 53))
            resp, _ = s.recvfrom(4096)
            s.close()
            if resp[:2] == data[:2]:
                return resp
        except OSError:
            continue
    return None


def serve(args):
    names = {n.strip().lower().rstrip(".") for n in args.names.split(",") if n.strip()}
    addr = socket.inet_aton(args.answer)
    servers = upstreams()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.bind, args.port))
    print(f"smoke-dns: listening on {args.bind}:{args.port}; {sorted(names)} -> {args.answer}; upstream {servers}", flush=True)
    while True:
        try:
            data, peer = sock.recvfrom(4096)
        except OSError as e:
            print(f"smoke-dns: recv error {e}", flush=True)
            continue
        if len(data) < 17:
            continue
        try:
            qname, off = parse_name(data, 12)
            qtype, qclass = struct.unpack("!HH", data[off:off + 4])
        except (IndexError, struct.error):
            continue
        key = qname.lower().rstrip(".")
        stamp = time.strftime("%H:%M:%S")
        if key in names:
            flags = 0x8400 | (struct.unpack("!H", data[2:4])[0] & 0x0100) | 0x0080  # QR AA RD RA
            question = data[12:off + 4]
            if qtype == 1:
                rr = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + addr
                resp = data[:2] + struct.pack("!HHHHH", flags, 1, 1, 0, 0) + question + rr
            else:
                resp = data[:2] + struct.pack("!HHHHH", flags, 1, 0, 0, 0) + question
            print(f"{stamp} {peer[0]} {qname} type{qtype} -> {args.answer if qtype == 1 else 'no data'}", flush=True)
        else:
            resp = forward(data, servers)
            if resp is None:
                resp = data[:2] + struct.pack("!HHHHH", 0x8182, 1, 0, 0, 0) + data[12:off + 4]
                print(f"{stamp} {peer[0]} {qname} type{qtype} -> SERVFAIL (upstream)", flush=True)
            else:
                print(f"{stamp} {peer[0]} {qname} type{qtype} -> {answers(resp) or 'rcode %d' % (resp[3] & 0xF)}", flush=True)
        try:
            sock.sendto(resp, peer)
        except OSError:
            pass


def query(args):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(5)
    s.sendto(build_query(args.query, 28 if args.aaaa else 1), (args.server, args.port))
    resp, _ = s.recvfrom(4096)
    for a in answers(resp):
        print(a)
    return 0 if resp[3] & 0xF == 0 else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--serve", action="store_true")
    p.add_argument("--bind", default="0.0.0.0")
    p.add_argument("--port", type=int, default=53)
    p.add_argument("--answer", default="10.0.2.2")
    p.add_argument("--names", default="www.pandora.com,tuner.pandora.com,internal-tuner.pandora.com")
    p.add_argument("--query")
    p.add_argument("--aaaa", action="store_true")
    p.add_argument("--server", default="127.0.0.1")
    a = p.parse_args()
    if a.serve:
        serve(a)
    elif a.query:
        sys.exit(query(a))
    else:
        p.print_help()
        sys.exit(2)
