#!/usr/bin/env python3
"""Tiny DNS resolver for the Android emulator smoke test (no dependencies).

Answers A queries for the names in OVERRIDE_NAMES with OVERRIDE_IP (the emulator's
alias for the host loopback, 10.0.2.2) and forwards everything else to UPSTREAM.
Usage: dns.py <bind-ip>[,<bind-ip>...] [port]
"""
import socket, struct, sys, threading

OVERRIDE_NAMES = {"www.pandora.com", "tuner.pandora.com", "internal-tuner.pandora.com"}
OVERRIDE_IP = "10.0.2.2"
UPSTREAM = ("8.8.8.8", 53)


def parse_qname(data):
    i, labels = 12, []
    while True:
        n = data[i]
        if n == 0:
            return ".".join(labels), i + 1
        labels.append(data[i + 1:i + 1 + n].decode("ascii", "replace"))
        i += 1 + n


def serve(sock):
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            name, qend = parse_qname(data)
            qtype = struct.unpack("!H", data[qend:qend + 2])[0]
            if name.lower() in OVERRIDE_NAMES and qtype in (1, 255):
                hdr = data[:2] + b"\x81\x80" + b"\x00\x01\x00\x01\x00\x00\x00\x00"
                question = data[12:qend + 4]
                answer = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 30, 4) + socket.inet_aton(OVERRIDE_IP)
                sock.sendto(hdr + question + answer, addr)
                print(f"dns: {name} {qtype} -> {OVERRIDE_IP} (override) for {addr[0]}", flush=True)
            elif name.lower() in OVERRIDE_NAMES:
                # AAAA etc. for an overridden name: answer "no records" so the client falls back to A.
                hdr = data[:2] + b"\x81\x80" + b"\x00\x01\x00\x00\x00\x00\x00\x00"
                sock.sendto(hdr + data[12:qend + 4], addr)
            else:
                up = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                up.settimeout(3)
                try:
                    up.sendto(data, UPSTREAM)
                    resp, _ = up.recvfrom(4096)
                    sock.sendto(resp, addr)
                except Exception as e:  # noqa: BLE001
                    print(f"dns: {name} {qtype} forward failed: {e}", flush=True)
                finally:
                    up.close()
        except Exception as e:  # noqa: BLE001
            print(f"dns: error {e}", flush=True)


def main():
    ips = sys.argv[1].split(",") if len(sys.argv) > 1 else ["127.0.0.1"]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 53
    threads = []
    for ip in ips:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((ip, port))
        print(f"dns: listening on {ip}:{port}; {sorted(OVERRIDE_NAMES)} -> {OVERRIDE_IP}", flush=True)
        t = threading.Thread(target=serve, args=(s,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
