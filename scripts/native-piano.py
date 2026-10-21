#!/usr/bin/env python3
"""Compare independent native piano archives with the untouched upstream pin.

The C harness objects contain fixtures and assertions only. Every implementation
supplies its own public ABI symbols; no C protocol adapter is linked into a native
lane. json-c/libgcrypt dependencies are included in the recorded link commands.
"""
import difflib
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from importlib.util import spec_from_file_location, module_from_spec

_spec = spec_from_file_location('piano_report', ROOT / 'scripts/libpiano-report.py')
_report = module_from_spec(_spec)
_spec.loader.exec_module(_report)
SUITES = _report.SUITES
PROBES = SUITES + ('coercion', 'abi', 'login')
PLAYLIST = _report.PLAYLIST
LANES = ('odin', 'zig', 'nelua', 'codin')


def compiler_version():
    return subprocess.check_output(shlex.split(os.environ.get('CC', 'cc')) + ['--version'],
                                   text=True).splitlines()[0]


def baseline_inputs(root):
    """Inputs affecting the reference fixtures, C behavior or benchmark policy."""
    paths = [root / 'Makefile', root / 'scripts/libpiano-differential.sh',
             root / 'scripts/libpiano-report.py']
    for directory in ('compat', 'include', 'tests/reference'):
        paths.extend(path for path in (root / directory).rglob('*') if path.is_file())
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(set(paths)) if path.is_file() and '__pycache__' not in path.parts}


def baseline_problem(root, build, benchmark):
    """Reject stale, incomplete or tampered baseline evidence before comparisons."""
    baseline = build / 'libpiano-evidence'
    try:
        manifest = json.loads((baseline / 'baseline-manifest.json').read_text())
        if manifest.get('schema') != 1:
            return 'baseline manifest schema is unsupported'
        if manifest.get('reference') != (root / 'tests/reference/pianobar.rev').read_text().strip():
            return 'baseline reference pin changed'
        if manifest.get('compiler') != os.environ.get('CC', 'cc'):
            return 'baseline compiler selection changed'
        if manifest.get('compiler_version') != compiler_version():
            return 'baseline compiler version changed'
        expected = baseline_inputs(root)
        recorded = {name: digest for name, digest in manifest.get('sources', {}).items()
                    if name in ('Makefile', 'scripts/libpiano-differential.sh',
                                'scripts/libpiano-report.py') or
                    name.startswith(('compat/', 'include/', 'tests/reference/'))}
        if recorded != expected:
            return 'baseline source or fixture inputs changed'
        status = (baseline / 'status.txt').read_text().strip()
        if status not in ('passed', 'correctness passed; benchmarks not requested'):
            return 'baseline did not complete successfully'
        required = ['libpiano-evidence/libpiano-reference.a', 'compat/libpiano.a']
        required += [f'libpiano-evidence/{probe}-reference.txt' for probe in PROBES]
        if benchmark:
            if manifest.get('phase') != 'complete':
                return 'baseline benchmark harness has not been built'
            required += [f'libpiano-evidence/{league}-{lane}'
                         for league in ('api', 'playlist') for lane in ('reference', 'melodica')]
            required += [f'libpiano-evidence/api-{probe}-melodica.o' for probe in SUITES]
        for name in required:
            path = build / name
            recorded = manifest.get('artifacts', {}).get(name)
            if not recorded or hashlib.sha256(path.read_bytes()).hexdigest() != recorded:
                return 'baseline artifact is missing or changed: ' + name
    except (OSError, ValueError, TypeError, AttributeError, subprocess.CalledProcessError) as error:
        return 'baseline evidence unavailable: ' + str(error)
    return None


def prepare_baseline(root, build, benchmark, log):
    reason = baseline_problem(root, build, benchmark)
    if reason is not None:
        print('Refreshing pinned C baseline: ' + reason, flush=True)
        run(['env', 'BUILD_DIR=' + str(build),
             'LIBPIANO_CORRECTNESS_ONLY=' + ('0' if benchmark else '1'),
             'sh', 'scripts/libpiano-differential.sh'], log)
        reason = baseline_problem(root, build, benchmark)
        if reason is not None:
            raise ValueError('rebuilt baseline is invalid: ' + reason)


def run(command, log, *, timeout=600):
    log.write('$ ' + shlex.join(map(str, command)) + '\n')
    log.flush()
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True,
                            timeout=timeout, check=False)
    log.write(result.stdout)
    log.write(result.stderr)
    log.flush()
    if result.returncode:
        raise RuntimeError(f'{shlex.join(map(str, command))}: exit {result.returncode}\n{result.stderr[-4000:]}')
    return result.stdout


def run_status(output, **changes):
    path = output / 'run-status.json'
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        state = {}
    state.update(changes)
    path.write_text(json.dumps(state, indent=2) + '\n')


def execute():
    build = Path(os.environ.get('BUILD_DIR', ROOT / 'build')).resolve()
    baseline = build / 'libpiano-evidence'
    output = build / 'native-piano-evidence'
    output.mkdir(parents=True, exist_ok=True)
    for name in ('standings.txt', 'performance.json'):
        (output / name).unlink(missing_ok=True)
    lanes = tuple(os.environ.get('PIANO_LANES', ' '.join(LANES)).split())
    if not lanes or len(set(lanes)) != len(lanes) or set(lanes) - set(LANES):
        raise ValueError('PIANO_LANES must select distinct native implementation names')
    (output / 'status.json').write_text(json.dumps({'status': 'incomplete', 'lanes': lanes}) + '\n')
    cc = shlex.split(os.environ.get('CC', 'cc'))
    deps = shlex.split(subprocess.check_output(['pkg-config', '--libs', 'json-c', 'libgcrypt'], text=True))
    status = {}
    with (output / 'build.log').open('w') as log:
        prepare_baseline(ROOT, build, os.environ.get('PIANO_VERIFY_ONLY') != '1', log)
        env = run(['uname', '-a'], log) + run(cc + ['--version'], log)
        env += run(['pkg-config', '--modversion', 'json-c', 'libgcrypt'], log)
        for path, command in (('odin', [os.environ.get('ODIN', 'odin'), 'version']),
                              ('zig', [os.environ.get('ZIG', 'zig'), 'version']),
                              ('nelua', [os.environ.get('NELUA', 'nelua'), '--version'])):
            if path in lanes:
                env += run(command, log)
        (output / 'environment.txt').write_text(env)
        hashes = {}
        for folder in ('impl', 'include', 'tests/reference', 'scripts', 'mk'):
            for path in sorted((ROOT / folder).rglob('*')):
                if path.is_file() and '__pycache__' not in path.parts:
                    hashes[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
        (output / 'sources.json').write_text(json.dumps(hashes, indent=2, sort_keys=True) + '\n')
        run_status(output, phase='correctness')
        for lane in lanes:
            try:
                archive = build / lane / 'libpiano.a'
                if not archive.is_file():
                    raise ValueError('missing independent archive: ' + str(archive))
                undefined = run(['nm', '-u', str(archive)], log)
                if 'melodica_piano_' in undefined or 'melodica_json_' in undefined:
                    raise ValueError(lane + ' unexpectedly imports C compatibility internals')
                (output / (lane + '-symbols.txt')).write_text(
                    run(['nm', '-g', '--defined-only', str(archive)], log) + undefined)
                run(['size', '-A', str(archive)], log)
                layout = output / f'native-abi-{lane}'
                run(cc + ['-O2', '-std=c99', '-pedantic-errors', '-Wall', '-Wextra', '-Werror',
                          '-Iinclude', 'tests/reference/native_abi_probe.c', str(archive)] +
                    deps + ['-lm', '-ldl', '-lpthread', '-o', str(layout)], log)
                (output / f'native-abi-{lane}.txt').write_text(run([str(layout)], log))
                for probe in PROBES:
                    binary = output / f'{probe}-{lane}'
                    run(cc + ['-O2', '-std=c99', '-pedantic-errors', '-Wall', '-Wextra', '-Werror',
                              '-Iinclude', str(ROOT / f'tests/reference/{probe}_probe.c'),
                              str(archive)] + deps + ['-lm', '-ldl', '-lpthread', '-o', str(binary)], log)
                    actual = run([str(binary)], log)
                    (output / f'{probe}-{lane}.txt').write_text(actual)
                    expected = (baseline / f'{probe}-reference.txt').read_text()
                    difference = ''.join(difflib.unified_diff(expected.splitlines(True),
                                        actual.splitlines(True), fromfile='reference', tofile=lane))
                    (output / f'{probe}-{lane}.diff').write_text(difference)
                    if difference:
                        raise ValueError(f'{lane}/{probe} differs:\n{difference[:6000]}')
                status[lane] = {'status': 'passed', 'archive_bytes': archive.stat().st_size,
                                'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                                'probes': list(PROBES)}
                print(f'{lane}: all {len(PROBES)} pinned protocol comparisons identical', flush=True)
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                status[lane] = {'status': 'failed', 'error': str(error)}
                print(f'{lane}: {error}', file=sys.stderr, flush=True)
        (output / 'status.json').write_text(json.dumps(status, indent=2) + '\n')
        if any(row['status'] != 'passed' for row in status.values()):
            print('Native protocol rankings withheld: a selected lane failed.', file=sys.stderr)
            return 1
        if os.environ.get('PIANO_VERIFY_ONLY') == '1':
            return 0
        run_status(output, phase='benchmark')
        objects = [str(baseline / f'api-{probe}-melodica.o') for probe in SUITES]
        for lane in lanes:
            run(cc + ['-O2', '-std=c99', '-pedantic-errors', '-Wall', '-Wextra', '-Werror',
                      str(ROOT / 'tests/reference/api_bench.c')] + objects +
                [str(build / lane / 'libpiano.a')] + deps +
                ['-lm', '-ldl', '-lpthread', '-o', str(output / f'api-{lane}')], log)
            (output / (lane + '-dependencies.txt')).write_text(run(['ldd', str(output / f'api-{lane}')], log))
        # Measure all lanes on this host in both process orders. Do not benchmark
        # until correctness of every selected native artifact has been established.
        measured = ('reference', 'c') + lanes
        samples = {lane: {'api': [], 'playlist': []} for lane in measured}
        for order in (1, 2):
            for lane in (measured if order == 1 else measured[::-1]):
                source = baseline if lane in ('reference', 'c') else output
                suffix = 'melodica' if lane == 'c' else lane
                api = run([str(source / f'api-{suffix}')], log)
                playlist = run([str(source / f'playlist-{suffix}'), '--bench'], log)
                (output / f'api-{lane}-bench-{order}.txt').write_text(api)
                (output / f'playlist-{lane}-bench-{order}.txt').write_text(playlist)
                samples[lane]['api'].append(_report.parse(api, SUITES, 'suites/s'))
                samples[lane]['playlist'].append(_report.parse(playlist, PLAYLIST, 'requests/s'))
        rows = []
        for league, names, unit in (('api', SUITES, 'suites/s'), ('playlist', PLAYLIST, 'requests/s')):
            for name in names:
                iterations = {s[name]['iterations'] for lane in measured for s in samples[lane][league]}
                if len(iterations) != 1:
                    raise ValueError('different fixture work counts for ' + name)
                rates = {lane: statistics.median(s[name]['rate'] for s in samples[lane][league]) for lane in measured}
                rows.append({'league': league, 'workload': name, 'unit': unit, 'rates': rates,
                             'iterations': iterations.pop()})
        lines = ['Independent native libpiano protocol shootout',
                 'Each process pass: median of five rounds; two opposite execution orders.',
                 'C has no json-c/gcrypt runtime dependencies; native lanes use both.',
                 'API rates count complete fixture suites, not individual calls.', '']
        lines.append(f'{"workload":24s}' + ''.join(f'{lane:>14s}' for lane in measured) + ' unit')
        for row in rows:
            lines.append(f'{row["workload"]:24s}' + ''.join(f'{row["rates"][lane]:14.3f}' for lane in measured) + ' ' + row['unit'])
        lines.extend(['', 'Normalized against the fastest independent implementation per workload:'])
        independent = ('c',) + lanes
        for lane in independent:
            ratios = [row['rates'][lane] / max(row['rates'][peer] for peer in independent) for row in rows]
            mean = math.exp(statistics.mean(math.log(ratio) for ratio in ratios))
            lines.append(f'{lane:8s} geometric mean {mean * 100:6.1f}%  worst {min(ratios) * 100:6.1f}%')
        report = '\n'.join(lines) + '\n'
        (output / 'performance.json').write_text(json.dumps({'schema': 1, 'lanes': measured, 'rows': rows}, indent=2) + '\n')
        (output / 'standings.txt').write_text(report)
        print(report, end='')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write('\n## Native piano API\n\n```text\n' + report + '```\n')
    return 0


def main():
    output = Path(os.environ.get('BUILD_DIR', ROOT / 'build')).resolve() / 'native-piano-evidence'
    output.mkdir(parents=True, exist_ok=True)
    run_status(output, status='running', phase='baseline', error=None)
    try:
        result = execute()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        run_status(output, status='failed', error=str(error))
        raise
    run_status(output, status='passed' if result == 0 else 'failed')
    return result


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print('native-piano: ' + str(error), file=sys.stderr)
        sys.exit(1)
