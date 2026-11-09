import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { digest } from './model.mjs';
import { run, hostEnv } from './io.mjs';

const root = join(homedir(), '.local/share/melodica-release-runner');
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
const repo = 'Spaceghost/melodica-extension';
const name = 'fedora-melodica-release';
if (!(await readFile(join(root, '.runner')).catch(() => null))) {
  const downloads = JSON.parse(run('gh', ['api', `repos/${repo}/actions/runners/downloads`]));
  const build = downloads.find(x => x.os === 'linux' && x.architecture === 'x64');
  assert.ok(build?.sha256_checksum && build.download_url.startsWith('https://github.com/actions/runner/'));
  const archive = join(root, build.filename);
  let data = await readFile(archive).catch(() => null);
  if (!data || digest(data) !== build.sha256_checksum) {
    run('curl', ['-fsSL', '--retry', '3', build.download_url, '-o', archive]);
    data = await readFile(archive);
  }
  assert.equal(digest(data), build.sha256_checksum, 'Official runner archive checksum');
  run('nice', ['-n', '10', 'tar', '-xzf', archive], { cwd: root });
  run(join(root, 'bin/Runner.Listener'), ['--version']);
  const registration = JSON.parse(run('gh', ['api', '--method', 'POST', `repos/${repo}/actions/runners/registration-token`]));
  const result = spawnSync(join(root, 'config.sh'), ['--unattended', '--url', `https://github.com/${repo}`,
    '--token', registration.token, '--name', name, '--labels', 'fedora-release', '--work', 'work'],
  { cwd: root, env: hostEnv, encoding: 'utf8' });
  if (result.status !== 0) {
    const error = String(result.stderr || '').split(registration.token).join('[redacted]');
    throw new Error(`Release runner registration failed: ${error}`);
  }
}
const config = JSON.parse((await readFile(join(root, '.runner'), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(config.agentName, name, 'The publication service must use its dedicated runner');
const units = join(homedir(), '.config/systemd/user');
await mkdir(units, { recursive: true });
const escape = text => text.replaceAll('%', '%%').replaceAll('"', '\\"');
assert.ok(!/[\r\n]/.test(process.env.PATH));
const service = `[Unit]
Description=Melodica release publisher GitHub runner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${escape(root)}
ExecStart="${escape(join(root, 'run.sh'))}"
Environment="PATH=${escape(process.env.PATH)}"
Restart=always
RestartSec=5
UMask=0077
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
`;
await writeFile(join(units, 'melodica-release-runner.service'), service, { mode: 0o600 });
if (run('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']).trim() !== 'yes') {
  run('loginctl', ['--no-ask-password', 'enable-linger', userInfo().username]);
}
run('systemctl', ['--user', 'daemon-reload']);
run('systemctl', ['--user', 'enable', '--now', 'melodica-release-runner.service']);
console.log('Dedicated Fedora publication runner installed, enabled at boot, and using the existing local Cloudflare and GitHub logins.');
