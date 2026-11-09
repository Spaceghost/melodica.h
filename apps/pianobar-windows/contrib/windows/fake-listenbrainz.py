#!/usr/bin/env python3
"""Fake ListenBrainz server for client tests.

  fake_lb.py PORT LOG.jsonl [--token T] [--fail N] [--prefix /scrobble]

Serves {prefix}/1/validate-token and {prefix}/1/submit-listens. Accepts only
"Authorization: Token T". --fail N answers the first N submit-listens with 503 (to test
the offline queue). Every request is appended to LOG.jsonl as
{path, status, listen_type, payload} (the token is never written).
Validation follows melodica-scrobble src/data.js closely enough for clients:
listen_type, payload count, listened_at for single/import, artist/track required.
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

args = sys.argv[1:]
port, log = int(args[0]), args[1]
opt = dict(zip(args[2::2], args[3::2]))
TOKEN = opt.get('--token', 'sgs_testtoken')
FAIL = [int(opt.get('--fail', '0'))]
PREFIX = opt.get('--prefix', '').rstrip('/')

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, path, extra=None):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        rec = {'t': time.time(), 'method': self.command, 'path': path, 'status': code}
        rec.update(extra or {})
        with open(log, 'a') as f:
            f.write(json.dumps(rec) + '\n')
    def authed(self):
        return self.headers.get('Authorization', '') == 'Token ' + TOKEN
    def route(self):
        p = self.path.split('?')[0]
        return p[len(PREFIX):] if p.startswith(PREFIX + '/') else None
    def do_GET(self):
        p = self.route()
        if p == '/1/validate-token':
            if self.authed():
                return self.send(200, {'code': 200, 'message': 'Token valid.', 'valid': True, 'user_name': 'fake'}, p)
            return self.send(200, {'code': 200, 'message': 'Token invalid.', 'valid': False}, p)
        self.send(404, {'code': 404, 'error': 'not found'}, self.path)
    def do_POST(self):
        p = self.route()
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n)
        if p != '/1/submit-listens':
            return self.send(404, {'code': 404, 'error': 'not found'}, self.path)
        if not self.authed():
            return self.send(401, {'code': 401, 'error': 'Invalid authorization token.'}, p)
        try:
            body = json.loads(raw)
        except Exception:
            return self.send(400, {'code': 400, 'error': 'bad json'}, p, {'raw': raw.decode('utf8', 'replace')[:500]})
        if FAIL[0] > 0:
            FAIL[0] -= 1
            return self.send(503, {'code': 503, 'error': 'try later'}, p, {'listen_type': body.get('listen_type'), 'payload': body.get('payload')})
        lt, pl = body.get('listen_type'), body.get('payload')
        err = None
        if lt not in ('single', 'import', 'playing_now'): err = 'listen_type'
        elif not isinstance(pl, list) or not pl or len(pl) > 100 or (lt != 'import' and len(pl) != 1): err = 'payload'
        else:
            for e in pl:
                m = e.get('track_metadata') or {}
                if not m.get('artist_name') or not m.get('track_name'): err = 'metadata'
                if lt == 'playing_now' and 'listened_at' in e: err = 'playing_now listened_at'
                if lt != 'playing_now' and not isinstance(e.get('listened_at'), int): err = 'listened_at'
        if err:
            return self.send(400, {'code': 400, 'error': err}, p, {'listen_type': lt, 'payload': pl})
        self.send(200, {'status': 'ok'}, p, {'listen_type': lt, 'payload': pl})

ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
