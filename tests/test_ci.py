"""Tests for CI failure handling. Synthetic benchmark output is test data only."""
import importlib.util
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shootout', ROOT / 'scripts/shootout.py')
shootout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shootout)


def output(value='100'):
    return '\n'.join(key + ' ' + value + (' Mreq/s' if key == 'station_request' else ' MiB/s')
                     for key in shootout.METRICS) + '\n'


class ScoreboardTests(unittest.TestCase):
    def test_exact_metrics(self):
        self.assertEqual(len(shootout.parse_output(output())), 5)

    def test_missing_metric(self):
        with self.assertRaises(ValueError):
            shootout.parse_output('\n'.join(output().splitlines()[:-1]))

    def test_duplicate(self):
        with self.assertRaises(ValueError):
            shootout.parse_output(output() + 'json_ascii 100 MiB/s\n')

    def test_bad_values(self):
        for value in ('0', '-1', 'nan', 'inf', '-inf', '1e999', 'garbage'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                shootout.parse_output(output(value))

    def test_units(self):
        with self.assertRaises(ValueError):
            shootout.parse_output(output().replace('Mreq/s', 'MiB/s'))

    def test_all_lanes_required(self):
        scores = {lane: shootout.parse_output(output()) for lane in shootout.LANES[:-1]}
        with self.assertRaises(ValueError):
            shootout.rank(scores)

    def test_normalization(self):
        scores = {lane: shootout.parse_output(output()) for lane in shootout.LANES}
        scores['nelua']['json_ascii'] = 80.0
        ratios, mean, worst = shootout.rank(scores)['nelua']
        self.assertAlmostEqual(mean, math.pow(0.8, 0.2))
        self.assertEqual(worst, 0.8)
        self.assertEqual(ratios[0], 0.8)

    def test_thresholds(self):
        for value in ('nan', 'inf', '-0.1', '1.1'):
            with patch.dict(os.environ, {'TEST_FLOOR': value}), self.assertRaises(ValueError):
                shootout.threshold('TEST_FLOOR')

    def test_failed_process_cannot_publish_standings(self):
        with tempfile.TemporaryDirectory() as temporary:
            build = Path(temporary)
            for lane in shootout.LANES:
                directory = build / lane
                directory.mkdir()
                executable = directory / 'bench'
                code = '#!' + sys.executable + '\nimport sys\nprint(' + repr(output()) + ')\n'
                code += 'sys.exit(' + ('7' if lane == 'nelua' else '0') + ')\n'
                executable.write_text(code)
                executable.chmod(0o700)
            target = build / 'shootout'
            target.mkdir()
            (target / 'standings.txt').write_text('stale success')
            environment = dict(os.environ, BUILD=str(build))
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/shootout.py')],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('benchmark exited 7', result.stderr)
            self.assertFalse((target / 'standings.txt').exists())
            self.assertFalse((target / 'scores.tsv').exists())

    def test_missing_executable_is_not_a_score(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/shootout.py')],
                                    env=dict(os.environ, BUILD=temporary), capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('no valid scoreboard', result.stderr)



def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


broker = load_script('ci-on-bak')
native = load_script('native-ci')


class BrokerTests(unittest.TestCase):
    def test_blob_pin_and_bytes_both_checked(self):
        import base64
        data = b'#!/bin/sh\nexit 0\n'
        expected = broker.blob_hash(data)
        payload = {'sha': expected, 'encoding': 'base64', 'content': base64.b64encode(data).decode()}
        self.assertEqual(broker.validate_blob(payload, expected), data)
        with self.assertRaises(ValueError):
            broker.validate_blob(dict(payload, sha='0' * 40), expected)
        with self.assertRaises(ValueError):
            broker.validate_blob(dict(payload, content=base64.b64encode(b'changed').decode()), expected)

    def test_runner_needs_all_repository_labels(self):
        def runner(names):
            return {'labels': [{'name': name} for name in names]}
        good = runner(broker.LABELS | {'incus'})
        wrong = runner(broker.LABELS - {'spaceghost-melodica.h'})
        self.assertEqual(broker.matching_runners({'runners': [wrong, good]}), [good])

    def test_project_autodetection_ignores_hardware(self):
        def query(*args):
            if args[0] == 'project':
                return [{'name': 'atlas-hardware'}, {'name': 'codex-workers'}]
            self.assertIn('codex-workers', args)
            return [{'name': broker.SOURCE, 'stateful': False}]
        with patch.object(broker, 'incus_json', side_effect=query):
            self.assertEqual(broker.select_project(None), 'codex-workers')

    def test_ambiguous_or_missing_snapshot_refused(self):
        for rows in ([], [{'name': broker.SOURCE, 'stateful': False}]):
            with self.subTest(rows=rows):
                def query(*args):
                    if args[0] == 'project':
                        return [{'name': 'runners'}, {'name': 'codex-workers'}]
                    return rows
                with patch.object(broker, 'incus_json', side_effect=query), self.assertRaises(RuntimeError):
                    broker.select_project(None)

    def definition(self, config=None, extra=None, root=None, nic=None):
        devices = {'root': root or {'type': 'disk', 'path': '/', 'pool': 'bak'},
                   'eth0': nic or {'type': 'nic', 'network': 'sandbox0', 'name': 'eth0'}}
        devices.update(extra or {})
        return {'profiles': ['default'], 'config': config or {}, 'devices': devices}

    def audit(self, snapshot, profile=None):
        documents = [{'type': 'container'}, snapshot, profile or {}]
        with patch.object(broker, 'incus_json', side_effect=documents):
            broker.audit_definition('codex-workers')

    def test_normal_snapshot_admitted(self):
        self.audit(self.definition())

    def test_privilege_and_raw_configuration_refused(self):
        for config in ({'security.privileged': 'true'}, {'security.nesting': '1'}, {'raw.lxc': 'x'}):
            with self.subTest(config=config), self.assertRaises(RuntimeError):
                self.audit(self.definition(config=config))
        with self.assertRaises(RuntimeError):
            self.audit(self.definition(), {'config': {'security.privileged': 'true'}})

    def test_devices_and_host_mounts_refused(self):
        for device in ({'type': 'unix-char', 'source': '/dev/ttyUSB0'},
                       {'type': 'disk', 'source': '/home', 'path': '/host'},
                       {'type': 'proxy', 'listen': 'tcp:0.0.0.0:22'}):
            with self.subTest(device=device), self.assertRaises(RuntimeError):
                self.audit(self.definition(extra={'extra': device}))

    def test_non_sandbox_network_refused(self):
        for nic in ({'type': 'nic', 'nictype': 'physical', 'parent': 'eth0'},
                    {'type': 'nic', 'network': 'LAN'},
                    {'type': 'nic', 'network': 'sandbox0', 'name': 'control0'}):
            with self.subTest(nic=nic), self.assertRaises(RuntimeError):
                self.audit(self.definition(nic=nic))

    def test_permission_failure_not_empty_inventory(self):
        def call(endpoint):
            if '/actions/runners' in endpoint:
                raise RuntimeError('403 forbidden')
            return {'workflow_runs': []}
        with patch.object(broker, 'api', side_effect=call):
            report = broker.diagnose('branch')
        self.assertIn('403', report['runner_read_error'])
        self.assertNotIn('matching_runners', report)


class NativeDriverTests(unittest.TestCase):
    def test_failed_lane_does_not_hide_remaining_lanes_or_publish_stale_scores(self):
        # These are orchestration mocks, not simulated language performance results.
        for failed_lane in native.LANES:
            with self.subTest(failed_lane=failed_lane), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / 'Makefile').write_text('# orchestration test fixture\n')
                (root / 'build/shootout').mkdir(parents=True)
                (root / 'build/shootout/standings.txt').write_text('stale success')
                attempts = []
                def run(command, log, timeout=900):
                    if command[:2] == ['make', '-B']:
                        target = command[2]
                        attempts.append(target)
                        lane = 'codin' if target == 'codin-check' else target.removeprefix('test-')
                        if lane == failed_lane:
                            raise RuntimeError('deliberate build failure')
                        directory = root / 'build' / lane
                        directory.mkdir(parents=True, exist_ok=True)
                        (directory / 'libmelodica.a').write_bytes(b'artifact-test-data')
                    elif command[:2] == ['ar', 'rcs']:
                        Path(command[2]).write_bytes(b'artifact-test-data')
                previous_cwd = Path.cwd()
                try:
                    with patch.object(native, 'ROOT', root), patch.object(native, 'run', side_effect=run), \
                         patch.object(native.platform, 'platform', return_value='mock-platform'), \
                         patch.dict(os.environ, {'BUILD': 'build', 'CFLAGS': '', 'LDFLAGS': '', 'GITHUB_STEP_SUMMARY': ''}), \
                         patch.object(native.subprocess, 'run') as external:
                        self.assertEqual(native.main(), 1)
                        external.assert_not_called()
                finally:
                    os.chdir(previous_cwd)
                self.assertEqual(attempts, ['test-c', 'test-odin', 'test-zig', 'test-nelua',
                                            'codin-check', 'test-codin-native'])
                self.assertFalse((root / 'build/shootout/standings.txt').exists())
                import json
                status_file = next((root / 'build/native-evidence').glob('*/status.json'))
                statuses = json.loads(status_file.read_text())
                self.assertEqual(statuses[failed_lane]['status'], 'failed')
                for lane in set(native.LANES) - {failed_lane}:
                    self.assertEqual(statuses[lane]['status'], 'passed')


if __name__ == '__main__':
    unittest.main()
