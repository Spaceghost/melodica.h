"""Report regressions use synthetic samples only, never performance evidence."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = load('libpiano-report')
shootout = load('shootout')
native_piano = load('native-piano')


def fixture(names, rate=100, unit='suites/s', iterations=100):
    return ''.join(f'{name} {rate} {unit} median_of=5 iterations={iterations}\n' for name in names)


class ApiEvidenceTests(unittest.TestCase):
    def test_rejects_missing_duplicate_invalid_values_units_and_sampling(self):
        good = fixture(api.SUITES)
        invalid = [good.split('\n', 1)[1], good + good.splitlines()[0] + '\n',
                   good.replace('100 suites/s', 'nan suites/s'),
                   good.replace('suites/s', 'requests/s'), good.replace('median_of=5', 'median_of=1'),
                   good.replace('iterations=100', 'iterations=0'), good + 'unexpected output\n',
                   '\n' + good, good + '\n']
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                api.parse(value, api.SUITES, 'suites/s')

    def inputs(self, directory):
        for league, names, unit in (('api', api.SUITES, 'suites/s'),
                                    ('playlist', api.PLAYLIST, 'requests/s')):
            for lane, rate in (('reference', 100), ('melodica', 125)):
                for order in (1, 2):
                    (directory / f'{league}-{lane}-bench-{order}.txt').write_text(
                        fixture(names, rate, unit))

    def test_report_requires_every_family_and_equal_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.inputs(directory)
            path = directory / 'api-melodica-bench-2.txt'
            path.write_text(path.read_text().replace('iterations=100', 'iterations=99'))
            with self.assertRaisesRegex(ValueError, 'different work counts'):
                api.report(directory)
            self.assertFalse((directory / 'performance.json').exists())
            self.assertFalse((directory / 'performance.txt').exists())

    def test_report_includes_all_fourteen_measured_workloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.inputs(directory)
            text = api.report(directory)
            rows = json.loads((directory / 'performance.json').read_text())['rows']
            self.assertEqual(len(rows), 14)
            self.assertTrue(all(row['ratio'] == 1.25 for row in rows))
            self.assertIn('not individual API calls', text)


class NativeSamplingTests(unittest.TestCase):
    def test_all_lanes_run_twice_in_opposite_order(self):
        text = ''.join(name + ' 100 ' + ('Mreq/s' if name == 'station_request' else 'MiB/s')
                       + '\n' for name in shootout.METRICS)
        with tempfile.TemporaryDirectory() as temporary:
            seen = []
            def run(command, **kwargs):
                seen.append(Path(command[0]).parent.name)
                return subprocess.CompletedProcess(command, 0, text, '')
            with patch.dict(os.environ, {'BUILD': temporary, 'SHOOTOUT_FLOOR': '0',
                                          'SHOOTOUT_WORST_FLOOR': '0', 'GITHUB_STEP_SUMMARY': ''}), \
                 patch.object(shootout.platform, 'platform', return_value='fixture-platform'), \
                 patch.object(shootout.subprocess, 'run', side_effect=run):
                self.assertEqual(shootout.main(), 0)
            self.assertEqual(seen, list(shootout.LANES) + list(reversed(shootout.LANES)))
            samples = json.loads((Path(temporary) / 'shootout/samples.json').read_text())
            self.assertTrue(all(len(values) == 2 for values in samples.values()))


class NativePianoBaselineTests(unittest.TestCase):
    def setUp(self):
        compiler = patch.object(native_piano, 'compiler_version', return_value='fixture-cc 1.0')
        compiler.start()
        self.addCleanup(compiler.stop)

    def inputs(self, root, complete=True):
        build = root / 'build'
        baseline = build / 'libpiano-evidence'
        baseline.mkdir(parents=True, exist_ok=True)
        for name, text in (('Makefile', '# fixture\n'), ('compat/piano.c', 'fixture source\n'),
                           ('include/piano.h', 'fixture ABI\n'),
                           ('tests/reference/pianobar.rev', 'a' * 40 + '\n')):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        names = ['libpiano-evidence/libpiano-reference.a', 'compat/libpiano.a']
        names += [f'libpiano-evidence/{probe}-reference.txt' for probe in native_piano.PROBES]
        if complete:
            names += [f'libpiano-evidence/{league}-{lane}'
                      for league in ('api', 'playlist') for lane in ('reference', 'melodica')]
            names += [f'libpiano-evidence/api-{probe}-melodica.o' for probe in native_piano.SUITES]
        artifacts = {}
        for name in names:
            path = build / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'orchestration fixture, never benchmark evidence\n')
            artifacts[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest = {'schema': 1, 'reference': 'a' * 40, 'compiler': 'fixture-cc',
                    'compiler_version': 'fixture-cc 1.0',
                    'phase': 'complete' if complete else 'correctness',
                    'sources': native_piano.baseline_inputs(root), 'artifacts': artifacts}
        (baseline / 'baseline-manifest.json').write_text(json.dumps(manifest))
        (baseline / 'status.txt').write_text('passed' if complete else
                                           'correctness passed; benchmarks not requested')
        return build

    def test_correctness_evidence_does_not_claim_benchmark_harness_exists(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, CC='fixture-cc'):
            root = Path(temporary)
            build = self.inputs(root, complete=False)
            self.assertIsNone(native_piano.baseline_problem(root, build, False))
            self.assertIn('benchmark harness', native_piano.baseline_problem(root, build, True))

    def test_changed_sources_pin_and_artifacts_invalidate_baseline(self):
        for change, expected in (('source', 'inputs changed'), ('pin', 'pin changed'),
                                  ('compiler', 'compiler version changed'),
                                  ('artifact', 'artifact is missing or changed')):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary, \
                 patch.dict(os.environ, CC='fixture-cc'):
                root = Path(temporary)
                build = self.inputs(root)
                self.assertIsNone(native_piano.baseline_problem(root, build, True))
                if change == 'compiler':
                    with patch.object(native_piano, 'compiler_version', return_value='fixture-cc 2.0'):
                        self.assertIn(expected, native_piano.baseline_problem(root, build, True))
                    continue
                path = {'source': root / 'compat/piano.c',
                        'pin': root / 'tests/reference/pianobar.rev',
                        'artifact': build / 'compat/libpiano.a'}[change]
                path.write_text('changed fixture')
                self.assertIn(expected, native_piano.baseline_problem(root, build, True))

    def test_missing_benchmark_object_invalidates_complete_manifest(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, CC='fixture-cc'):
            root = Path(temporary)
            build = self.inputs(root)
            (build / 'libpiano-evidence/api-search-melodica.o').unlink()
            self.assertIsNotNone(native_piano.baseline_problem(root, build, True))

    def test_refresh_sets_exact_build_directory_and_requested_phase(self):
        for benchmark in (False, True):
            with self.subTest(benchmark=benchmark), tempfile.TemporaryDirectory() as temporary, \
                 patch.dict(os.environ, CC='fixture-cc'):
                root = Path(temporary)
                build = root / 'build'
                def refresh(command, log):
                    self.assertIn('BUILD_DIR=' + str(build), command)
                    self.assertIn('LIBPIANO_CORRECTNESS_ONLY=' + ('0' if benchmark else '1'), command)
                    self.inputs(root, complete=benchmark)
                with patch.object(native_piano, 'run', side_effect=refresh) as run:
                    native_piano.prepare_baseline(root, build, benchmark, io.StringIO())
                run.assert_called_once()

    def test_failed_baseline_records_phase_and_withholds_stale_rankings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'build/native-piano-evidence'
            output.mkdir(parents=True)
            (output / 'standings.txt').write_text('stale success')
            with patch.dict(os.environ, {'BUILD_DIR': str(root / 'build'), 'PIANO_LANES': 'odin'}), \
                 patch.object(native_piano, 'ROOT', root), \
                 patch.object(native_piano.subprocess, 'check_output', return_value=''), \
                 patch.object(native_piano, 'prepare_baseline', side_effect=RuntimeError('fixture baseline failed')):
                with self.assertRaisesRegex(RuntimeError, 'fixture baseline failed'):
                    native_piano.main()
            state = json.loads((output / 'run-status.json').read_text())
            self.assertEqual(state['status'], 'failed')
            self.assertEqual(state['phase'], 'baseline')
            self.assertIn('fixture baseline failed', state['error'])
            self.assertFalse((output / 'standings.txt').exists())


if __name__ == '__main__':
    unittest.main()
