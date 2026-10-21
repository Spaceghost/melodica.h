"""One-job controller scope checks; no real GitHub or Incus changes occur."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ci_once', ROOT / 'scripts/ci-once-bak.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


def definition():
    return {'type': 'container', 'expanded_config': {}, 'config': {},
            'expanded_devices': {'root': {'type': 'disk', 'path': '/', 'pool': 'bak'},
                                 'eth0': {'type': 'nic', 'network': 'sandbox0'}}}


class OneJobControllerTests(unittest.TestCase):
    def test_source_rejects_privilege_host_mounts_and_credential_environment(self):
        controller.audit_definition(definition())
        for config in ({'security.privileged': 'true'}, {'security.nesting': '1'},
                       {'raw.lxc': 'unsafe'}, {'environment.GH_TOKEN': 'fixture-secret'}):
            item = definition()
            item['expanded_config'] = config
            with self.subTest(config=config), self.assertRaises(ValueError):
                controller.audit_definition(item)
        item = definition()
        item['expanded_devices']['host'] = {'type': 'disk', 'path': '/host', 'source': '/home'}
        with self.assertRaisesRegex(ValueError, 'host mount'):
            controller.audit_definition(item)

    def test_worker_cleanup_cannot_remove_an_unowned_container(self):
        with patch.object(controller, 'instance', return_value=definition()), \
             patch.object(controller, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
                controller.cleanup('bak:fixture', 'fixture-owner', None)
            command.assert_not_called()

    def test_runner_cleanup_checks_both_id_and_name(self):
        result = subprocess.CompletedProcess([], 0, json.dumps({'id': 9, 'name': 'existing-user-runner'}), '')
        with patch.object(controller.subprocess, 'run', return_value=result), \
             patch.object(controller, 'api') as api:
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                controller.remove_runner({'id': 9, 'name': 'fixture-owned-runner'})
            api.assert_not_called()

    def test_runner_release_requires_official_url_and_verified_digest(self):
        valid = {'tag_name': 'v2.999.0', 'assets': [{
            'name': 'actions-runner-linux-x64-2.999.0.tar.gz', 'digest': 'sha256:' + 'a' * 64,
            'browser_download_url': 'https://github.com/actions/runner/releases/download/v2.999.0/archive.tar.gz'}]}
        with patch.object(controller, 'api', return_value=valid):
            self.assertEqual(controller.runner_release()['sha256'], 'a' * 64)
        for field, value in (('digest', 'unverified'), ('browser_download_url', 'https://example.com/runner.tar.gz')):
            invalid = json.loads(json.dumps(valid))
            invalid['assets'][0][field] = value
            with self.subTest(field=field), patch.object(controller, 'api', return_value=invalid), \
                 self.assertRaises(ValueError):
                controller.runner_release()

    def test_queue_refuses_jobs_for_another_commit(self):
        run = {'id': 1, 'head_sha': 'b' * 40}
        job = {'id': 2, 'name': 'fixture', 'status': 'queued', 'labels': list(controller.LABELS)}
        with patch.object(controller, 'api', side_effect=[{'workflow_runs': [run]}, {'jobs': [job]}]):
            with self.assertRaisesRegex(RuntimeError, 'Another commit'):
                controller.queued_jobs('a' * 40)


if __name__ == '__main__':
    unittest.main()
