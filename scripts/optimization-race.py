#!/usr/bin/env python3
"""Paired before/after protocol race. Run on the same Fedora builder.

Requires frozen before/after trees with native archives and canonical API harness
objects. Never changes those archives. Records raw processes, RSS, heap and calls.
"""
import hashlib
import json
import os
from pathlib import Path
import random
import re
import statistics
import subprocess
import sys

workspace = Path(sys.argv[1]).resolve()
out = workspace / 'evidence'
out.mkdir(exist_ok=True)
lanes = ('c', 'odin', 'zig', 'nelua', 'codin')
suites = ('piano', 'playlist', 'search', 'station_mutations', 'feedback', 'seed',
          'station_info', 'quickmix_genre', 'explain_bookmarks', 'settings', 'station_modes')
commands, archives, inputs = [], {}, {}
affinity = sorted(os.sched_getaffinity(0))
os.sched_setaffinity(0, {affinity[0]})

def run(args, name, cwd=None):
    commands.append(list(map(str, args)))
    with (out / name).open('w') as stream:
        subprocess.run(list(map(str, args)), cwd=cwd, stdout=stream,
                       stderr=subprocess.STDOUT, check=True, timeout=600)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

deps = subprocess.check_output(['pkg-config', '--libs', 'json-c', 'libgcrypt'], text=True).split()
for phase in ('before', 'after'):
    root = workspace / phase
    inputs[phase] = {str(p.relative_to(root)): sha(p) for d in ('impl', 'compat', 'include', 'bench', 'tests/reference')
                     for p in (root / d).rglob('*') if p.is_file()}
    for lane in lanes:
        key = phase + '-' + lane
        lib = root / 'build' / ('compat' if lane == 'c' else lane) / 'libpiano.a'
        archives[key] = {'sha256': sha(lib), 'bytes': lib.stat().st_size}
        libraries = [] if lane == 'c' else deps + ['-lm', '-ldl', '-lpthread']
        run(['cc', '-O2', '-g', '-Iinclude', 'bench/race.c', lib] + libraries + ['-o', out / key], key + '-build.log', root)
        objects = [root / 'build/libpiano-evidence' / ('api-' + suite + '-melodica.o') for suite in suites]
        run(['cc', '-O2', 'tests/reference/api_bench.c'] + objects + [lib] + libraries + ['-o', out / (key + '-api')], key + '-api-build.log', root)

rows = []
rng = random.Random(20261118)
for trial in range(6):
    order = list(lanes)
    rng.shuffle(order)
    for lane in order:
        phases = ('before', 'after') if trial % 2 == 0 else ('after', 'before')
        for phase in phases:
            key = phase + '-' + lane
            workloads = [('playlist', 4, 2000), ('playlist', 64, 100), ('playlist', 256, 20),
                         ('playlist', 4096, 2), ('search', 64, 100), ('search', 256, 20), ('search', 4096, 2)]
            for workload, size, iterations in workloads:
                name = f'{key}-{workload}-{size}-{trial}'
                run(['/usr/bin/time', '-v', '-o', out / (name + '.rss'), out / key,
                     workload, size, iterations], name + '.txt')
                fields = (out / (name + '.txt')).read_text().strip().split()
                if len(fields) != 5 or fields[0] != f'{workload}_parse_{size}' or fields[3] != 'median_of=5':
                    raise ValueError('Invalid benchmark: ' + name)
                rows.append({'phase': phase, 'lane': lane, 'workload': fields[0], 'trial': trial, 'rate': float(fields[1])})
            name = f'{key}-api-{trial}'
            run([out / (key + '-api')], name + '.txt')
            for line in (out / (name + '.txt')).read_text().splitlines():
                fields = line.split()
                if len(fields) != 5 or fields[0] not in suites:
                    raise ValueError('Invalid API benchmark: ' + name)
                rows.append({'phase': phase, 'lane': lane, 'workload': 'api_' + fields[0], 'trial': trial, 'rate': float(fields[1])})
    print('paired pass', trial + 1, 'of 6', flush=True)
    (out / 'samples.json').write_text(json.dumps(rows, indent=2) + '\n')

for phase in ('before', 'after'):
    for lane in lanes:
        key = phase + '-' + lane
        run(['valgrind', '--tool=massif', '--time-unit=B', '--massif-out-file=' + str(out / (key + '.massif')),
             out / key, 'playlist', 256, 2], key + '-heap.log')
        run(['valgrind', '--tool=callgrind', '--callgrind-out-file=' + str(out / (key + '.callgrind')),
             out / key, 'playlist', 256, 2], key + '-calls.log')
        run(['callgrind_annotate', '--inclusive=yes', '--tree=both', '--threshold=95', out / (key + '.callgrind')], key + '-calltree.txt')

results = []
for lane in lanes:
    for workload in sorted({row['workload'] for row in rows}):
        samples = {phase: [r['rate'] for r in rows if r['phase'] == phase and r['lane'] == lane and r['workload'] == workload]
                   for phase in ('before', 'after')}
        if any(len(v) != 6 for v in samples.values()):
            raise ValueError('Incomplete samples')
        before, after = (statistics.median(samples[p]) for p in ('before', 'after'))
        paired = [a / b for a, b in zip(samples['after'], samples['before'])]
        results.append({'lane': lane, 'workload': workload, 'before': before, 'after': after,
                        'ratio': after / before, 'paired_ratios': paired,
                        'paired_min': min(paired), 'paired_max': max(paired)})
run(['lscpu'], 'cpu.txt')
run(['cc', '--version'], 'compiler.txt')
run(['pkg-config', '--modversion', 'json-c', 'libgcrypt'], 'dependencies.txt')
(out / 'summary.json').write_text(json.dumps({'baseline_revision': 'c548cbf', 'results': results,
    'method': '6 paired process passes, seeded lane shuffle, alternating before/after; each rate median of 5 timed rounds after warmup; one CPU affinity',
    'affinity': [affinity[0]], 'original_affinity': affinity, 'archives': archives, 'sources': inputs, 'commands': commands}, indent=2) + '\n')
print('complete', flush=True)
