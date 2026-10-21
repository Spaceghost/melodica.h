#!/usr/bin/env python3
"""Validate every API/playlist timing before publishing paired-host ratios."""
import json
import math
from pathlib import Path
import statistics
import sys

SUITES = ('piano', 'playlist', 'search', 'station_mutations', 'feedback', 'seed',
          'station_info', 'quickmix_genre', 'explain_bookmarks', 'settings', 'station_modes')
PLAYLIST = ('playlist_parse_4', 'playlist_parse_64', 'playlist_parse_256')


def parse(text, names, unit):
    values = {}
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            raise ValueError('unexpected blank benchmark line; fixture reports must be quiet')
        if fields[0] not in names:
            raise ValueError('unexpected benchmark line: ' + line)
        name = fields[0]
        if name in values or len(fields) != 5 or fields[2] != unit:
            raise ValueError('invalid/duplicate metric: ' + name)
        value = float(fields[1])
        if not math.isfinite(value) or value <= 0:
            raise ValueError('non-positive/non-finite metric: ' + name)
        if fields[3] != 'median_of=5' or not fields[4].startswith('iterations='):
            raise ValueError('benchmark sampling metadata missing: ' + name)
        iterations = int(fields[4].split('=', 1)[1])
        if iterations <= 0:
            raise ValueError('invalid iteration count: ' + name)
        values[name] = {'rate': value, 'iterations': iterations}
    if set(values) != set(names):
        raise ValueError('missing metrics: ' + ', '.join(sorted(set(names) - set(values))))
    return values


def report(directory):
    rows = []
    for league, names, unit in (('api', SUITES, 'suites/s'),
                                ('playlist', PLAYLIST, 'requests/s')):
        passes = {}
        for lane in ('reference', 'melodica'):
            passes[lane] = [parse((directory / f'{league}-{lane}-bench-{order}.txt').read_text(),
                                  names, unit) for order in (1, 2)]
        for name in names:
            counts = {sample[name]['iterations'] for lane in passes.values() for sample in lane}
            if len(counts) != 1:
                raise ValueError('different work counts for ' + name)
            reference = statistics.median(sample[name]['rate'] for sample in passes['reference'])
            candidate = statistics.median(sample[name]['rate'] for sample in passes['melodica'])
            rows.append({'league': league, 'workload': name, 'unit': unit,
                         'reference': reference, 'melodica': candidate,
                         'ratio': candidate / reference, 'iterations': counts.pop()})
    # All inputs are validated before creating either success artifact.
    lines = ['Same-host upstream / melodica C API comparison',
             'Two process passes in opposite order; each rate is a median of five timed rounds.',
             'API suites include init, fixture requests/responses, validation and owned-result destruction.',
             'Rates describe fixture suites, not individual API calls. No cross-language API ranking.',
             '', f'{"workload":24s} {"reference":>12s} {"melodica":>12s} {"ratio":>9s} unit']
    lines.extend(f'{row["workload"]:24s} {row["reference"]:12.3f} {row["melodica"]:12.3f} '
                 f'{row["ratio"]:8.3f}x {row["unit"]}' for row in rows)
    result = '\n'.join(lines) + '\n'
    (directory / 'performance.json').write_text(json.dumps({'schema': 1, 'rows': rows}, indent=2) + '\n')
    (directory / 'performance.txt').write_text(result)
    return result


if __name__ == '__main__':
    try:
        print(report(Path(sys.argv[1])), end='')
    except (IndexError, OSError, ValueError) as error:
        print('libpiano-report: ' + str(error), file=sys.stderr)
        sys.exit(1)
