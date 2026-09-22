#!/usr/bin/env python3
"""Strict scoreboard for the unchanged five-workload native benchmark."""
import math
import os
from pathlib import Path
import subprocess
import sys

LANES = ('c', 'odin', 'zig', 'nelua', 'codin')
METRICS = ('json_ascii', 'json_payload', 'url_ascii', 'url_mixed', 'station_request')


def parse_output(text):
    values = {}
    for line in text.splitlines():
        fields = line.split()
        if not fields or fields[0] not in METRICS:
            continue
        name = fields[0]
        if name in values:
            raise ValueError('duplicate metric: ' + name)
        if len(fields) < 3:
            raise ValueError('incomplete metric: ' + name)
        number = float(fields[1])
        if not math.isfinite(number) or number <= 0:
            raise ValueError('non-positive/non-finite metric: ' + name)
        expected_unit = 'Mreq/s' if name == 'station_request' else 'MiB/s'
        if fields[2] != expected_unit:
            raise ValueError('unexpected unit for ' + name + ': ' + fields[2])
        values[name] = number
    if set(values) != set(METRICS):
        raise ValueError('missing metrics: ' + ', '.join(sorted(set(METRICS) - set(values))))
    return values


def threshold(name):
    value = float(os.environ.get(name, '0'))
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(name + ' must be finite and between 0 and 1')
    return value


def rank(scores):
    if set(scores) != set(LANES):
        raise ValueError('all five lanes are required')
    for lane in LANES:
        if set(scores[lane]) != set(METRICS) or any(
                not math.isfinite(v) or v <= 0 for v in scores[lane].values()):
            raise ValueError('invalid or incomplete lane: ' + lane)
    leaders = {key: max(scores[lane][key] for lane in LANES) for key in METRICS}
    rows = {}
    for lane in LANES:
        ratios = [scores[lane][key] / leaders[key] for key in METRICS]
        # Work in logs before dividing, avoiding underflow for tiny finite ratios.
        logs = [math.log(scores[lane][key]) - math.log(leaders[key]) for key in METRICS]
        rows[lane] = (ratios, math.exp(sum(logs) / len(METRICS)), min(ratios))
    return rows


def main():
    root = Path(__file__).resolve().parents[1]
    build = root / os.environ.get('BUILD', 'build')
    output = build / 'shootout'
    output.mkdir(parents=True, exist_ok=True)
    # A failed attempt must not leave a previous successful scoreboard behind.
    for name in ('scores.tsv', 'standings.txt') + tuple(
            lane + suffix for lane in LANES for suffix in ('.txt', '.stderr.txt', '.error.txt')):
        (output / name).unlink(missing_ok=True)
    floor = threshold('SHOOTOUT_FLOOR')
    worst_floor = threshold('SHOOTOUT_WORST_FLOOR')
    scores, failures = {}, []
    for lane in LANES:
        try:
            result = subprocess.run([str(build / lane / 'bench')], text=True,
                                    capture_output=True, timeout=300, check=False)
            (output / (lane + '.txt')).write_text(result.stdout)
            (output / (lane + '.stderr.txt')).write_text(result.stderr)
            print(result.stdout, end='')
            if result.returncode != 0:
                raise ValueError('benchmark exited ' + str(result.returncode))
            scores[lane] = parse_output(result.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
            failures.append(lane + ': ' + str(exc))
            (output / (lane + '.error.txt')).write_text(str(exc) + '\n')
    if failures:
        raise ValueError('no valid scoreboard; ' + '; '.join(failures))
    rows = rank(scores)
    (output / 'scores.tsv').write_text(''.join(
        f'{lane}\t{key}\t{scores[lane][key]}\n' for lane in LANES for key in METRICS))
    lines = ['normalized standings (leader per workload = 100%)',
             f'{"lane":8s} ' + ' '.join(f'{key:>15s}' for key in METRICS) + '    geo mean       worst']
    failed = False
    for lane in LANES:
        ratios, mean, worst = rows[lane]
        lines.append(f'{lane:8s} ' + ' '.join(f'{ratio * 100:14.1f}%' for ratio in ratios) +
                     f' {mean * 100:10.1f}% {worst * 100:10.1f}%')
        failed |= mean < floor or worst < worst_floor
    if floor or worst_floor:
        lines.append(f'gate: geo mean >= {floor * 100:.1f}%, worst >= {worst_floor * 100:.1f}%')
    report = '\n'.join(lines) + '\n'
    (output / 'standings.txt').write_text(report)
    print(report, end='')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write('\n## Native serializers\n\n```text\n' + report + '```\n')
    return int(failed)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print('shootout: ' + str(error), file=sys.stderr)
        sys.exit(2)
