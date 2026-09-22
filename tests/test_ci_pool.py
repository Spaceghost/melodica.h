"""Pool startup regressions. Shell tests execute; tmux tests need a real tmux."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ci_pool_broker', ROOT / 'scripts/ci-on-bak.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class PoolStartupTests(unittest.TestCase):
    def test_private_config_sets_retention_before_command(self):
        text = broker.pool_config(Path('/tmp/state'))
        for line in ('default-shell /bin/sh', 'destroy-unattached off',
                     'exit-unattached off', 'remain-on-exit on', '@melodica-ci-owner'):
            self.assertIn(line, text)
        self.assertEqual(broker.pool_tmux(Path('/tmp/state')),
                         ['tmux', '-L', broker.TMUX_SOCKET, '-f', '/tmp/state/tmux.conf'])

    def test_real_shell_entry_preserves_stderr_and_exit_status(self):
        with tempfile.TemporaryDirectory(prefix="pool ' ") as directory:
            state = Path(directory)
            log = state / 'pool.log'
            entry = state / 'start.sh'
            value = "spaces ' ; $(touch not-executed)"
            entry.write_text(broker.pool_entry(log, ['env', 'FIXTURE=' + value,
                '/bin/sh', '-c', 'printf "%s\\n" "$FIXTURE"; echo pool-exited >&2; exit 37']))
            result = subprocess.run(['/bin/sh', str(entry)], cwd=state, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 37)
            self.assertIn(value, log.read_text())
            self.assertIn('pool-exited', log.read_text())
            self.assertFalse((state / 'not-executed').exists())
            self.assertEqual(result.stderr, b'')

    def test_real_shell_missing_program_is_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            entry = state / 'start.sh'
            entry.write_text(broker.pool_entry(state / 'pool.log', ['/nonexistent/pool', 'argument']))
            result = subprocess.run(['/bin/sh', str(entry)], capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('/nonexistent/pool', (state / 'pool.log').read_text())

    def test_log_tail_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'pool.log').write_text('x' * 20000 + 'final error\n')
            tail = broker.pool_log_tail(state)
            self.assertLessEqual(len(tail), 8192)
            self.assertTrue(tail.endswith('final error\n'))

    def test_nonzero_command_reports_exit_without_stderr(self):
        with patch.object(broker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 17, '', '')):
            with self.assertRaisesRegex(RuntimeError, 'exit 17'):
                broker.command(['example'])

    def test_dead_pane_retains_both_error_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'pool.log').write_text('actual pool failure\n')
            with patch.object(broker, 'command', side_effect=['%7\t1\t37\n', 'terminal failure\n']):
                with self.assertRaisesRegex(RuntimeError, 'status 37') as failure:
                    broker.pool_state(['tmux'], '%7', state)
            self.assertIn('actual pool failure', str(failure.exception))
            self.assertIn('terminal failure', str(failure.exception))
            self.assertEqual((state / 'pool-pane.txt').read_text(), 'terminal failure\n')

    def test_multiple_panes_fail_closed(self):
        with patch.object(broker, 'command', return_value='%1\t0\t\n%2\t0\t\n'):
            with self.assertRaisesRegex(RuntimeError, 'one identifiable'):
                broker.pool_state(['tmux'], '=melodica-ci', Path('/tmp'))

    def test_start_uses_direct_argv_no_post_spawn_tagging(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            bundle = state / 'bundle'
            bundle.mkdir()
            seen = []
            def command(args):
                seen.append(args)
                if 'new-session' in args:
                    self.assertTrue((state / 'pool.log').exists())
                    self.assertIn('remain-on-exit on', (state / 'tmux.conf').read_text())
                    self.assertEqual(args[-2:], ['/bin/sh', str(bundle / 'start-pool.sh')])
                    return '$2 %3\n'
                self.assertIn('display-message', args)
                self.assertIn('%3', args)
                return '%3\t0\t\n'
            with patch.object(broker, 'command', side_effect=command), patch.object(broker.time, 'sleep'):
                base, pane = broker.start_pool(state, bundle, 'codex-workers', '/usr/bin:/bin')
            self.assertEqual(pane, '%3')
            self.assertIn('-L', base)
            self.assertFalse(any('set-option' in call for call in seen))
            self.assertTrue((state / 'pool-session.json').is_file())

    def test_creation_failure_prints_precreated_log(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            bundle = state / 'bundle'
            bundle.mkdir()
            with patch.object(broker, 'command', side_effect=RuntimeError('tmux configuration failed')):
                with self.assertRaisesRegex(RuntimeError, 'tmux configuration failed') as failure:
                    broker.start_pool(state, bundle, 'codex-workers', '/usr/bin:/bin')
            self.assertIn('preparing private tmux', str(failure.exception))
            self.assertTrue((state / 'pool.log').is_file())

    def test_owned_private_pool_is_reused(self):
        state = Path('/tmp/state')
        result = subprocess.CompletedProcess([], 0, broker.SESSION + '\n', '')
        with patch.object(broker.subprocess, 'run', return_value=result) as run, \
             patch.object(broker, 'command', side_effect=[broker.OWNER, str(state), '%3\t0\t\n']):
            self.assertEqual(broker.existing_pool(state)[1], '%3')
            self.assertEqual(run.call_count, 1)

    def test_unowned_private_pool_not_changed(self):
        result = subprocess.CompletedProcess([], 0, broker.SESSION + '\n', '')
        with patch.object(broker.subprocess, 'run', return_value=result), \
             patch.object(broker, 'command', side_effect=['someone-else', '/tmp/state']) as command:
            with self.assertRaisesRegex(RuntimeError, 'left untouched'):
                broker.existing_pool(Path('/tmp/state'))
            self.assertTrue(all('show-options' in call.args[0] for call in command.call_args_list))

    def test_legacy_pool_not_duplicated(self):
        missing = subprocess.CompletedProcess([], 1, '', 'no server')
        present = subprocess.CompletedProcess([], 0, '', '')
        with patch.object(broker.subprocess, 'run', side_effect=[missing, present]), \
             patch.object(broker, 'command', side_effect=[broker.OWNER, '%3\t0\t\n']):
            self.assertEqual(broker.existing_pool(Path('/tmp/state')), (['tmux'], '%3'))

    def test_empty_private_server_is_not_reconfigured(self):
        missing = subprocess.CompletedProcess([], 1, '', 'no session')
        empty_server = subprocess.CompletedProcess([], 0, 'someone-else', '')
        with patch.object(broker.subprocess, 'run', side_effect=[missing, missing, empty_server]):
            with self.assertRaisesRegex(RuntimeError, 'exists without its pool'):
                broker.existing_pool(Path('/tmp/state'))


@unittest.skipUnless(shutil.which('tmux'), 'real tmux is not installed')
class LiveTmuxTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='melodica-tmux-test-')
        self.state = Path(self.directory.name)
        self.bundle = self.state / 'bundle'
        (self.bundle / 'scripts').mkdir(parents=True)
        self.socket = 'ml-test-' + uuid.uuid4().hex
        self.socket_patch = patch.object(broker, 'TMUX_SOCKET', self.socket)
        self.socket_patch.start()

    def tearDown(self):
        # Only this test's unique server is removed. Never touch the user's server.
        subprocess.run(['tmux', '-L', self.socket, 'kill-server'], capture_output=True, timeout=5)
        self.socket_patch.stop()
        self.directory.cleanup()

    def test_immediate_failure_keeps_session_and_status(self):
        (self.bundle / 'scripts/run-pool.sh').write_text('echo real-pool-error >&2\nexit 37\n')
        with self.assertRaisesRegex(RuntimeError, 'status 37') as failure:
            broker.start_pool(self.state, self.bundle, 'codex-workers', os.environ['PATH'])
        self.assertIn('real-pool-error', str(failure.exception))
        self.assertIn('melodica-ci', broker.command(broker.pool_tmux(self.state) + ['list-sessions']))

    def test_custom_shell_and_user_config_are_not_used(self):
        home = self.state / 'home'
        home.mkdir()
        (home / '.tmux.conf').write_text('set -g default-shell /bin/false\nset -s exit-unattached on\n')
        (self.bundle / 'scripts/run-pool.sh').write_text('echo alive\nexec sleep 30\n')
        with patch.dict(os.environ, HOME=str(home), SHELL='/bin/false'):
            active = broker.start_pool(self.state, self.bundle, 'codex-workers', os.environ['PATH'])
            self.assertEqual(broker.existing_pool(self.state), active)
        self.assertIn('alive', (self.state / 'pool.log').read_text())


if __name__ == '__main__':
    unittest.main()
