"""One-job controller scope checks; no real GitHub or Incus changes occur."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
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
    def test_runner_upload_creates_persistent_directory_and_resolves_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            package = state / 'runner.tar.gz'
            package.write_bytes(b'fixture archive, never executed\n')
            alias = state / 'runner-alias.tar.gz'
            alias.symlink_to(package)
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                if args[:3] == ['incus', 'file', 'push']:
                    raise RuntimeError('fixture stopped after upload')
                return ''
            with patch.object(controller, 'command', side_effect=command), \
                 patch.object(controller, 'instance', return_value=definition()), \
                 patch.object(controller, 'cleanup') as cleanup, patch.object(controller, 'api') as api:
                with self.assertRaisesRegex(RuntimeError, 'fixture stopped after upload'):
                    controller.one_job('bak:melodica-complete-fixture', 'b' * 32,
                                       1, alias, state, 60, [])
                cleanup.assert_called_once()
                api.assert_not_called()
            upload_index = next(i for i, args in enumerate(calls) if args[:3] == ['incus', 'file', 'push'])
            mkdir_index = next(i for i, args in enumerate(calls)
                               if args[-3:] == ['mkdir', '-p', '/opt/melodica-runner'])
            self.assertLess(mkdir_index, upload_index)
            self.assertEqual(calls[upload_index][3], str(package.resolve()))
            self.assertTrue(calls[upload_index][4].endswith('/opt/melodica-runner/actions-runner.tar.gz'))

    def test_registration_identity_accepts_official_utf8_bom(self):
        with tempfile.TemporaryDirectory() as temporary:
            identity = Path(temporary) / '.runner'
            identity.write_bytes(b'\xef\xbb\xbf' + json.dumps(
                {'agentId': 9, 'agentName': 'fixture-owned-runner'}).encode())
            original_read = Path.read_text
            def read_fixture(path, *args, **kwargs):
                return original_read(identity, *args, **kwargs)
            payload = json.dumps({'token': 'fixture-token', 'url': 'https://github.com/' + controller.REPO,
                                  'name': 'fixture-owned-runner', 'labels': ','.join(controller.LABELS)})
            result = subprocess.CompletedProcess([], 0, '')
            with patch.object(Path, 'read_text', autospec=True, side_effect=read_fixture), \
                 patch.object(controller.subprocess, 'run', return_value=result), \
                 patch('sys.stdin', io.StringIO(payload)), patch('sys.stdout', new_callable=io.StringIO) as output:
                exec(controller.CONFIGURE, {})
            self.assertEqual(json.loads(output.getvalue()), {'id': 9, 'name': 'fixture-owned-runner'})

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

    def test_queue_handles_unfinished_states_and_refuses_another_commit(self):
        for state in ('queued', 'pending', 'requested', 'waiting'):
            run = {'id': 1, 'head_sha': 'b' * 40}
            job = {'id': 2, 'name': 'fixture', 'status': state, 'labels': list(controller.LABELS)}
            with self.subTest(state=state, commit='other'), patch.object(controller, 'api',
                    side_effect=[{'workflow_runs': [run]}, {'jobs': [job]}]):
                with self.assertRaisesRegex(RuntimeError, 'Another commit'):
                    controller.queued_jobs('a' * 40)
            run['head_sha'] = 'a' * 40
            def api(endpoint):
                if '/jobs?' in endpoint:
                    return {'jobs': [job]}
                # Return the same run twice to exercise a status transition.
                return {'workflow_runs': [run]} if 'status=queued&' in endpoint or \
                    'status=' + state + '&' in endpoint else {'workflow_runs': []}
            with self.subTest(state=state, commit='selected'), patch.object(controller, 'api', side_effect=api):
                if state == 'waiting':
                    with self.assertRaisesRegex(RuntimeError, 'deployment protection'):
                        controller.queued_jobs('a' * 40)
                else:
                    self.assertEqual(controller.queued_jobs('a' * 40),
                                     [{'run_id': 1, 'job_id': 2, 'name': 'fixture'}])


if __name__ == '__main__':
    unittest.main()
