"""Summarise a melodica-tuner /__tuner/log dump (run with python3 -I).

Prints one line per request (time, protocol, method, status, code) followed
by a final JSON line with counts per JSON method and audio requests, plus the
MPRIS status/position handed in on the command line.
"""
import json
import sys
from collections import Counter

path, mpris_status, mpris_pos = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        doc = json.load(f)
except (OSError, json.JSONDecodeError) as e:
    print('could not read tuner log: {}'.format(e))
    doc = []

entries = []
def walk(x):
    if isinstance(x, dict):
        if 'method' in x or 'protocol' in x:
            entries.append(x)
        else:
            for v in x.values():
                walk(v)
    elif isinstance(x, list):
        for v in x:
            walk(v)
walk(doc)

methods = Counter()
audio = 0
for e in entries:
    proto = str(e.get('protocol', ''))
    method = str(e.get('method', '') or e.get('path', '') or e.get('query', ''))
    if proto == 'audio' or '/audio/' in method:
        audio += 1
    elif e.get('method'):
        methods[str(e['method'])] += 1
    print('{} {} {} status={} code={}'.format(
        e.get('time', e.get('when', '')), proto, method, e.get('status', ''), e.get('code', '')))

out = dict(methods)
out['audio_requests'] = audio
out['requests_logged'] = len(entries)
out['mpris_status'] = mpris_status
out['mpris_position_us'] = mpris_pos
print(json.dumps(out, sort_keys=True))
