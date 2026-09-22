#!/usr/bin/env python3
"""Rebuild and test each independent native lane; never rank a failed build."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import subprocess
import sys
import time

LANES = ('c', 'odin', 'zig', 'nelua', 'codin')
ROOT = Path(__file__).resolve().parents[1]


def run(command, log, timeout=900):
    log.write('$ ' + shlex.join(command) + '\n')
    log.flush()
    result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f'{shlex.join(command)} exited {result.returncode}')


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if os.environ.get('BUILD', 'build') != 'build':
        raise ValueError('native-ci currently requires BUILD=build (Codin uses that directory)')
    if any(os.environ.get(key) for key in ('CFLAGS', 'LDFLAGS')):
        raise ValueError('use the pinned Makefile lane flags, not ambient CFLAGS/LDFLAGS')
    os.chdir(ROOT)
    evidence = ROOT / 'build' / 'native-evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    run_id = str(time.time_ns())
    evidence = evidence / run_id
    evidence.mkdir()
    compiler = shlex.split(os.environ.get('CC', 'cc'))
    statuses = {}
    # A failed fresh build cannot leave an earlier ranking looking current.
    for name in ('scores.tsv', 'standings.txt'):
        (ROOT / 'build/shootout' / name).unlink(missing_ok=True)
    with (evidence / 'environment.txt').open('w') as log:
        log.write(platform.platform() + '\n')
        log.write('build policy: Makefile flags; no additional LTO/native CPU options\n')
        for command in (['git', 'rev-parse', 'HEAD'], ['git', 'status', '--short'],
                        ['uname', '-a'], ['lscpu'], compiler + ['--version'],
                        ['clang', '--version'], [os.environ.get('ODIN', 'odin'), 'version'],
                        [os.environ.get('ZIG', 'zig'), 'version'],
                        [os.environ.get('NELUA', 'nelua'), '--version']):
            try:
                run(command, log, timeout=30)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                log.write('unavailable: ' + str(error) + '\n')
    source_hashes = {}
    for directory in ('include', 'impl', 'bench', 'tests', 'scripts'):
        for path in sorted((ROOT / directory).rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts:
                source_hashes[str(path.relative_to(ROOT))] = sha256(path)
    source_hashes['Makefile'] = sha256(ROOT / 'Makefile')
    (evidence / 'sources.json').write_text(json.dumps(source_hashes, indent=2) + '\n')
    for lane in LANES:
        with (evidence / (lane + '.log')).open('w') as log:
            try:
                if lane == 'codin':
                    run(['make', '-B', 'codin-check'], log)
                    library = ROOT / 'build/codin/libmelodica.a'
                    # Compare archives with archives; preserve the compiler's object too.
                    library.unlink(missing_ok=True)
                    run(['ar', 'rcs', str(library), 'build/codin/melodica.gcc.o'], log)
                else:
                    run(['make', '-B', 'test-' + lane, 'build/' + lane + '/bench'], log)
                    library = ROOT / ('build/' + lane + '/libmelodica.a')
                extra = ['-lm', '-ldl', '-lpthread'] if lane == 'odin' else []
                conformance = ROOT / ('build/' + lane + '/conformance')
                run(compiler + ['-O2', '-std=c99', '-pedantic-errors', '-Wall', '-Wextra',
                                '-Werror', '-Iinclude', 'tests/conformance.c', str(library)] +
                    extra + ['-o', str(conformance)], log)
                run([str(conformance)], log, timeout=120)
                statuses[lane] = {'status': 'passed', 'artifact': str(library.relative_to(ROOT)),
                                  'bytes': library.stat().st_size, 'sha256': sha256(library)}
                for command in (['size', '-A', str(library)], ['nm', '-g', '--defined-only', str(library)],
                                ['nm', '-u', str(library)], ['ldd', str(conformance)]):
                    run(command, log, timeout=30)
                print(lane + ': smoke + shared conformance passed', flush=True)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                statuses[lane] = {'status': 'failed', 'error': str(error)}
                log.write('\nFAILED: ' + str(error) + '\n')
                print(lane + ': FAILED (' + str(error) + ')', file=sys.stderr, flush=True)
    # Native Codin is an Odin control, not a sixth winner-eligible lane.
    with (evidence / 'codin-native-control.log').open('w') as log:
        try:
            run(['make', '-B', 'test-codin-native'], log)
            statuses['codin-native-control'] = {'status': 'passed'}
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            statuses['codin-native-control'] = {'status': 'failed', 'error': str(error)}
    (evidence / 'status.json').write_text(json.dumps(statuses, indent=2) + '\n')
    summary = '\n'.join(name + ': ' + result['status'] for name, result in statuses.items())
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as log:
            log.write('\n## Native correctness\n\n```text\n' + summary + '\n```\n')
    print('evidence: ' + str(evidence.relative_to(ROOT)))
    if any(result['status'] != 'passed' for result in statuses.values()):
        print('Benchmark rankings withheld: at least one lane/control failed.', file=sys.stderr)
        return 1
    # All benchmarks execute serially on this host, with the unchanged fixtures.
    return subprocess.run(['sh', 'scripts/shootout.sh'], cwd=ROOT, check=False).returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print('native-ci: ' + str(error), file=sys.stderr)
        sys.exit(2)
