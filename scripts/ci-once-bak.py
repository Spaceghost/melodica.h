#!/usr/bin/env python3
"""Run at most three repository CI jobs in separately owned Bak containers.

The controller runs wherever gh and the Bak Incus remote already work. It never
installs host packages, copies host credentials, or changes existing runners.
Registration tokens travel through stdin and are never written to local state.
Without --apply, only the source definition and queued jobs are inspected.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid

REPO = 'Spaceghost/melodica.h'
LABELS = ('self-hosted', 'Linux', 'X64', 'ubuntu-tiny', 'spaceghost-melodica.h')
OWNER_KEY = 'user.melodica-ci.once'


def command(args, *, input=None, timeout=120, secrets=()):
    result = subprocess.run(args, input=input, text=True, capture_output=True,
                            timeout=timeout, check=False)
    if result.returncode:
        message = result.stderr.strip() or 'exit ' + str(result.returncode)
        for secret in secrets:
            message = message.replace(secret, '<redacted>')
        raise RuntimeError(args[0] + ': ' + message)
    return result.stdout


def api(endpoint, method='GET'):
    text = command(['gh', 'api', '--method', method, endpoint])
    return json.loads(text) if text.strip() else {}


def instance(target):
    remote, name = target.split(':', 1)
    document = json.loads(command(['incus', 'query', remote + ':/1.0/instances/' + name]))
    return document.get('metadata', document)


def audit_definition(document):
    if document.get('type') != 'container':
        raise ValueError('CI source must be an Incus container')
    config = document.get('expanded_config', document.get('config', {}))
    if any(str(config.get(key, '')).lower() in ('true', '1')
           for key in ('security.privileged', 'security.nesting')):
        raise ValueError('CI source must be unprivileged and must not enable nesting')
    if any(key.startswith('raw.') and value for key, value in config.items()):
        raise ValueError('CI source contains raw host configuration')
    if any(key.startswith('environment.') and value and
           re.search(r'TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|SSH_AUTH_SOCK', key, re.I)
           for key, value in config.items()):
        raise ValueError('CI source contains a credential-bearing environment setting')
    roots = nics = 0
    for device in document.get('expanded_devices', {}).values():
        if device.get('type') == 'disk' and device.get('path') == '/' and device.get('pool') \
                and not device.get('source'):
            roots += 1
        elif device.get('type') == 'nic' and device.get('network') and not device.get('parent'):
            nics += 1
        else:
            raise ValueError('CI source contains a host mount or passthrough device')
    if roots != 1 or nics != 1:
        raise ValueError('CI source must have exactly one root disk and one managed NIC')


SOURCE_CREDENTIAL_AUDIT = r'''
from pathlib import Path
homes = [Path('/root')] + list(Path('/home').glob('*'))
for home in homes:
    paths = [home / '.config/gh/hosts.yml', home / '.git-credentials',
             home / '.aws/credentials', home / '.netrc']
    paths += [p for p in (home / '.ssh').glob('id_*') if p.suffix != '.pub']
    if any(path.exists() for path in paths):
        raise SystemExit('Source contains an account credential file; refusing to clone')
for directory in ('/opt', '/work'):
    for path in Path(directory).rglob('.credentials*'):
        raise SystemExit('Source contains an existing runner credential; refusing to clone')
for path in Path('/work').rglob('.git/config'):
    text = path.read_text(errors='replace').lower()
    if 'extraheader' in text or re.search(r'https?://[^/\s]+@', text):
        raise SystemExit('Source git configuration contains authentication material')
print('Source credential-path audit passed')
'''.replace('from pathlib import Path', 'from pathlib import Path\nimport re')


def queued_jobs(sha):
    selected = []
    for status in ('queued', 'in_progress'):
        payload = api(f'repos/{REPO}/actions/runs?status={status}&per_page=100')
        if payload.get('total_count', 0) > 100:
            raise RuntimeError('CI queue inventory is truncated; inspect it before creating workers')
        for run in payload.get('workflow_runs', []):
            jobs = api(f'repos/{REPO}/actions/runs/{run["id"]}/jobs?per_page=100')
            if jobs.get('total_count', 0) > 100:
                raise RuntimeError('CI job inventory is truncated')
            for job in jobs.get('jobs', []):
                if job.get('status') != 'queued' or not set(LABELS).issubset(job.get('labels', [])):
                    continue
                if run.get('head_sha') != sha:
                    raise RuntimeError('Another commit has a matching queued job; inspect run ' + str(run['id']))
                selected.append({'run_id': run['id'], 'job_id': job['id'], 'name': job['name']})
    return selected


def runner_release():
    release = api('repos/actions/runner/releases/latest')
    version = release['tag_name'].removeprefix('v')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('Unexpected official runner release tag')
    name = 'actions-runner-linux-x64-' + version + '.tar.gz'
    assets = [asset for asset in release.get('assets', []) if asset['name'] == name]
    if len(assets) != 1:
        raise ValueError('Official Linux x64 runner archive not found')
    asset = assets[0]
    digest = asset.get('digest') or ''
    if digest.startswith('sha256:'):
        digest = digest[7:]
    else:
        match = re.search(re.escape(name) + r'\W+([0-9a-f]{64})', release.get('body', ''))
        digest = match.group(1) if match else ''
    url = asset['browser_download_url']
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not url.startswith(
            'https://github.com/actions/runner/releases/download/'):
        raise ValueError('Official runner URL or SHA256 is missing')
    return {'version': version, 'filename': name, 'sha256': digest, 'url': url}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def archive(release, state):
    path = state / release['filename']
    if path.exists() and sha256(path) == release['sha256']:
        return path
    partial = path.with_suffix('.part')
    with urllib.request.urlopen(release['url'], timeout=60) as source, partial.open('wb') as output:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            output.write(block)
    if sha256(partial) != release['sha256']:
        raise ValueError('Official runner archive SHA256 mismatch')
    partial.replace(path)
    return path


CONFIGURE = r'''
import json, os, subprocess, sys
from pathlib import Path
payload = json.load(sys.stdin)
token = payload.pop('token')
environment = dict(os.environ, RUNNER_ALLOW_RUNASROOT='1')
result = subprocess.run(['./config.sh', '--unattended', '--ephemeral',
    '--url', payload['url'], '--token', token, '--name', payload['name'],
    '--labels', payload['labels'], '--work', '_work'], cwd='/opt/melodica-runner',
    env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
if result.returncode:
    print(result.stdout.replace(token, '<redacted>'), file=sys.stderr)
    raise SystemExit(result.returncode)
identity = json.loads(Path('/opt/melodica-runner/.runner').read_text())
print(json.dumps({'id': identity['agentId'], 'name': identity['agentName']}))
'''


def remove_runner(identity):
    endpoint = f'repos/{REPO}/actions/runners/{identity["id"]}'
    result = subprocess.run(['gh', 'api', endpoint], text=True, capture_output=True, check=False)
    if result.returncode and 'HTTP 404' in result.stderr:
        return
    if result.returncode:
        raise RuntimeError('Could not inspect the exact owned runner for cleanup')
    actual = json.loads(result.stdout)
    if actual.get('id') != identity['id'] or actual.get('name') != identity['name']:
        raise RuntimeError('Runner identity changed; refusing to remove it')
    api(endpoint, method='DELETE')


def cleanup(worker, owner, identity):
    errors = []
    if identity:
        try:
            remove_runner(identity)
        except (OSError, RuntimeError, ValueError) as error:
            errors.append(str(error))
    try:
        document = instance(worker)
        if document.get('config', {}).get(OWNER_KEY) != owner:
            raise RuntimeError('Worker ownership changed; refusing to delete it')
        command(['incus', 'delete', worker, '--force'], timeout=120)
    except (OSError, RuntimeError, ValueError) as error:
        errors.append(str(error))
    if errors:
        raise RuntimeError('; '.join(errors))


def one_job(source, owner, number, package, state, timeout, pending):
    worker = 'bak:melodica-ci-' + owner[:12] + '-' + str(number)
    identity = None
    created = False
    result = {'worker': worker, 'status': 'incomplete'}
    path = state / f'job-{number}.json'
    try:
        command(['incus', 'copy', source, worker, '--stateless', '--instance-only',
                 '--allow-inconsistent', '--config', OWNER_KEY + '=' + owner], timeout=600)
        created = True
        audit_definition(instance(worker))
        command(['incus', 'start', worker])
        command(['incus', 'file', 'push', str(package), worker + '/tmp/actions-runner.tar.gz'], timeout=300)
        command(['incus', 'exec', worker, '--', 'mkdir', '-p', '/opt/melodica-runner'])
        command(['incus', 'exec', worker, '--', 'tar', '-xzf', '/tmp/actions-runner.tar.gz',
                 '-C', '/opt/melodica-runner'], timeout=300)
        # Exercise the bundled .NET runtime before creating a registration. A
        # missing ICU/OpenSSL dependency must not leave a GitHub runner behind.
        result['runner_runtime'] = command(['incus', 'exec', worker, '--', 'env',
            'RUNNER_ALLOW_RUNASROOT=1', '/opt/melodica-runner/bin/Runner.Listener',
            '--version']).strip()
        registration = api(f'repos/{REPO}/actions/runners/registration-token', method='POST')
        token = registration['token']
        payload = {'token': token, 'url': 'https://github.com/' + REPO,
                   'name': worker.split(':', 1)[1], 'labels': ','.join(LABELS)}
        response = command(['incus', 'exec', worker, '--', 'python3', '-c', CONFIGURE],
                           input=json.dumps(payload), timeout=180, secrets=(token,))
        identity = json.loads(response)
        result['runner'] = identity
        path.write_text(json.dumps(result, indent=2) + '\n')
        # Neither registration payload nor account credentials enter state/log files.
        del token, payload, registration
        print('Listening for one job: ' + identity['name'], flush=True)
        with (state / f'job-{number}-listener.log').open('w') as log:
            process = subprocess.Popen(['incus', 'exec', worker, '--', 'env',
                'RUNNER_ALLOW_RUNASROOT=1', 'sh', '-c', 'cd /opt/melodica-runner && exec ./run.sh'],
                stdout=log, stderr=subprocess.STDOUT, text=True)
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    process.terminate()
                    raise RuntimeError('One-job listener exceeded the configured timeout')
                time.sleep(10)
            if process.returncode:
                raise RuntimeError('One-job listener exited ' + str(process.returncode))
        deadline = time.monotonic() + 60
        while True:
            completed = []
            for run_id in sorted({job['run_id'] for job in pending}):
                payload = api(f'repos/{REPO}/actions/runs/{run_id}/jobs?per_page=100')
                completed += [job for job in payload.get('jobs', [])
                              if job.get('runner_id') == identity['id']]
            if len(completed) == 1 and completed[0].get('status') == 'completed':
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(5)
        if len(completed) != 1 or completed[0].get('status') != 'completed':
            raise RuntimeError('Listener exit did not prove completion of exactly one selected job')
        job = completed[0]
        result['job'] = {key: job.get(key) for key in
                         ('id', 'name', 'status', 'conclusion', 'html_url', 'runner_id', 'runner_name')}
        result['status'] = job.get('conclusion')
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        raise
    finally:
        if not created:
            # Copy can fail after the server creates the destination. The owner
            # marker is applied atomically by copy, so recovery cannot claim an
            # unrelated existing instance with the same name.
            try:
                created = instance(worker).get('config', {}).get(OWNER_KEY) == owner
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                pass
        if created:
            if identity is None:
                # Configuration can time out after registration succeeds. Read only
                # the secret-free runner identity, never its credential files.
                try:
                    identity = json.loads(command(['incus', 'exec', worker, '--', 'python3', '-c',
                        "import json; from pathlib import Path; p=json.loads(Path('/opt/melodica-runner/.runner').read_text()); "
                        "print(json.dumps({'id':p['agentId'],'name':p['agentName']}))"]))
                except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                    pass
            try:
                cleanup(worker, owner, identity)
                result['cleanup'] = 'exact owned runner and worker removed'
            except (OSError, RuntimeError, ValueError) as error:
                result['cleanup'] = 'failed: ' + str(error)
                path.write_text(json.dumps(result, indent=2) + '\n')
                raise
        path.write_text(json.dumps(result, indent=2) + '\n')
    return result['status'] == 'success'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--sha', required=True, help='Exact queued repository commit')
    parser.add_argument('--source', default='bak:melodica-complete-20261020')
    parser.add_argument('--jobs', type=int, default=3)
    parser.add_argument('--job-timeout', type=int, default=3600)
    parser.add_argument('--state', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.sha) or not 1 <= args.jobs <= 3:
        raise ValueError('Use a full commit SHA and one to three jobs')
    if not re.fullmatch(r'bak:melodica-complete-[a-z0-9-]+', args.source):
        raise ValueError('Only the task-owned Bak builder can be a source')
    if not 60 <= args.job_timeout <= 7200:
        raise ValueError('job-timeout must be between 60 and 7200 seconds')
    audit_definition(instance(args.source))
    command(['incus', 'exec', args.source, '--', 'python3', '-c', SOURCE_CREDENTIAL_AUDIT])
    pending = queued_jobs(args.sha)
    print(json.dumps({'source': args.source, 'sha': args.sha, 'queued_jobs': pending,
                      'apply': args.apply}, indent=2), flush=True)
    if not args.apply or not pending:
        return 0
    os.umask(0o077)
    owner = uuid.uuid4().hex
    state = args.state or Path.home() / '.local/state/melodica-ci-once' / owner
    state.mkdir(parents=True, exist_ok=False)
    release = runner_release()
    (state / 'plan.json').write_text(json.dumps({'owner': owner, 'source': args.source,
        'repository': REPO, 'sha': args.sha, 'runner_release': release}, indent=2) + '\n')
    package = archive(release, state)
    passed = True
    executed = 0
    for number in range(1, args.jobs + 1):
        pending = queued_jobs(args.sha)
        if not pending:
            break
        passed &= one_job(args.source, owner, number, package, state, args.job_timeout, pending)
        executed += 1
    remaining = queued_jobs(args.sha)
    (state / 'result.json').write_text(json.dumps({'sha': args.sha, 'jobs_executed': executed,
        'status': 'passed' if passed and not remaining else 'incomplete' if remaining else 'failed',
        'remaining_jobs': remaining}, indent=2) + '\n')
    if remaining:
        print('Controller job limit reached; matching jobs remain queued.', file=sys.stderr)
    print('Controller evidence: ' + str(state), flush=True)
    return 0 if passed and not remaining else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        print('ci-once-bak: ' + str(error), file=sys.stderr)
        sys.exit(1)
