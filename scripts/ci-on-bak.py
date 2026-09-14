#!/usr/bin/env python3
"""Diagnose CI; --apply starts a repo-scoped Incus runner pool using existing gh auth.

No host package installation, host mounts, privileged workers, HIL access, billing
changes, repository visibility changes, or reusable credentials in worker images.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, urlsplit

REPO = 'Spaceghost/melodica.h'
INFRA = 'Spaceghost/atlas-infra'
INFRA_REV = 'e53704e06f62e47ea60b27a56fee0f406f518c1a'
SOURCE = 'runner-ubuntu-base/sealed-v2.336.0'
SESSION = 'melodica-ci'
OWNER = 'melodica-ci-v1'
FILES = {
    'scripts/run-one-ubuntu.sh': '5d050ae2c598377b24e3a5f42eddae98d29dca23',
    'scripts/run-pool.sh': '84756d353436e7bb0d40288d97507436bd67a419',
    'scripts/audit-runner-base.sh': 'cd27dec18f510ad3c9f48c4148407391e8674c5a',
    'config/runner-classes.tsv': '80e0a5e6afff0dc41c52e2459a943ab73bb2ab16',
}
LABELS = {'self-hosted', 'Linux', 'X64', 'ubuntu-tiny', 'spaceghost-melodica.h'}


def command(args, timeout=60, capture=True):
    result = subprocess.run(args, text=True, capture_output=capture, timeout=timeout, check=False)
    if result.returncode:
        detail = (result.stderr or '').strip() if capture else ''
        raise RuntimeError(shlex.join(args) + ': ' + (detail or 'exit ' + str(result.returncode)))
    return result.stdout if capture else ''


def api(endpoint):
    return json.loads(command(['gh', 'api', endpoint]))


def blob_hash(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def validate_blob(payload, expected):
    if payload.get('sha') != expected or payload.get('encoding') != 'base64':
        raise ValueError('source blob does not match the reviewed pin')
    data = base64.b64decode(''.join(payload['content'].split()), validate=True)
    if blob_hash(data) != expected:
        raise ValueError('decoded source blob hash mismatch')
    return data


def matching_runners(payload):
    return [runner for runner in payload.get('runners', [])
            if LABELS.issubset({label['name'] for label in runner.get('labels', [])})]


def diagnose(ref):
    report = {'repository': REPO, 'ref': ref, 'runs': []}
    try:
        payload = api('repos/' + REPO + '/actions/runners?per_page=100')
        report['matching_runners'] = [
            {key: runner.get(key) for key in ('id', 'name', 'status', 'busy')}
            for runner in matching_runners(payload)]
        report['runner_listing_truncated'] = payload.get('total_count', 0) > 100
    except (RuntimeError, ValueError) as error:
        report['runner_read_error'] = str(error)
    runs = api('repos/' + REPO + '/actions/runs?branch=' + quote(ref, safe='') + '&per_page=5')
    for run in runs.get('workflow_runs', []):
        entry = {key: run.get(key) for key in ('id', 'name', 'status', 'conclusion', 'head_sha')}
        entry['jobs'] = []
        jobs = api('repos/' + REPO + '/actions/runs/' + str(run['id']) + '/jobs?per_page=100')
        for job in jobs.get('jobs', []):
            item = {key: job.get(key) for key in ('name', 'status', 'conclusion', 'runner_id', 'runner_name')}
            item['steps'] = len(job.get('steps') or [])
            check_url = job.get('check_run_url', '')
            endpoint = urlsplit(check_url).path.lstrip('/')
            prefix = 'repos/' + REPO + '/check-runs/'
            if endpoint.lower().startswith(prefix.lower()) and endpoint[len(prefix):].isdigit():
                try:
                    annotations = api(endpoint + '/annotations?per_page=100')
                    item['annotations'] = [{key: row.get(key) for key in ('title', 'message', 'annotation_level')}
                                           for row in annotations]
                except (RuntimeError, ValueError) as error:
                    item['annotation_read_error'] = str(error)
            entry['jobs'].append(item)
        report['runs'].append(entry)
    return report


def incus_json(*args):
    return json.loads(command(['incus', '--force-local', *args]))


def select_project(requested):
    instance, snapshot = SOURCE.split('/')
    projects = [requested] if requested else [row['name'] for row in incus_json('project', 'list', '--format=json')
        if row['name'] in ('codex-workers', 'atlas-workers', 'runners')]
    matches = []
    for project in projects:
        try:
            rows = incus_json('snapshot', 'list', instance, '--project', project, '--format=json')
        except RuntimeError:
            continue
        if any(row['name'].split('/')[-1] == snapshot and not row.get('stateful', False) for row in rows):
            matches.append(project)
    if len(matches) != 1:
        raise RuntimeError('Expected one existing stateless ' + SOURCE + ' source, found projects ' +
                           repr(matches) + '. Supply --project for an existing ordinary runner project; no base is created or replaced.')
    return matches[0]


def audit_definition(project):
    instance, snapshot = SOURCE.split('/')
    query = '?project=' + quote(project, safe='')
    base = incus_json('query', '/1.0/instances/' + instance + query)
    if base.get('type') != 'container':
        raise RuntimeError('The runner base must be a container, not a VM')
    snap = incus_json('query', '/1.0/instances/' + instance + '/snapshots/' + snapshot + query)
    config, devices = {}, {}
    for profile in snap.get('profiles', []):
        document = incus_json('query', '/1.0/profiles/' + quote(profile, safe='') + query)
        config.update(document.get('config', {})); devices.update(document.get('devices', {}))
    config.update(snap.get('config', {})); devices.update(snap.get('devices', {}))
    if any(str(config.get(key, '')).lower() in ('true', '1') for key in ('security.privileged', 'security.nesting')):
        raise RuntimeError('Refusing a privileged/nested runner base')
    if any(key.startswith('raw.') and value for key, value in config.items()):
        raise RuntimeError('Refusing raw host/guest configuration overrides')
    roots = 0
    nics = 0
    for device in devices.values():
        if device.get('type') == 'nic':
            if device.get('network') != 'sandbox0' and not (
                    device.get('nictype') == 'bridged' and device.get('parent') == 'sandbox0'):
                raise RuntimeError('Only the existing sandbox0 runner network is admitted')
            if device.get('name', 'eth0') != 'eth0':
                raise RuntimeError('The runner network must be eth0')
            nics += 1
            continue
        if (device.get('type') == 'disk' and device.get('path') == '/' and
                device.get('pool') == 'bak' and not device.get('source')):
            roots += 1
            continue
        raise RuntimeError('Refusing non-root mounts or device passthrough: ' + repr(device))
    if roots != 1 or nics != 1:
        raise RuntimeError('Expected one bak-backed root disk and one sandbox0 NIC')


def stage_bundle(state):
    bundle = Path(tempfile.mkdtemp(prefix='broker-', dir=state))
    for name, expected in FILES.items():
        payload = api('repos/' + INFRA + '/contents/' + name + '?ref=' + INFRA_REV)
        destination = bundle / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(validate_blob(payload, expected))
        destination.chmod(0o700 if name.startswith('scripts/') else 0o600)
    # The isolated broker serves this one explicitly requested repository only.
    # Existing Atlas allowlists, pools and host services remain untouched.
    (bundle / 'config/repositories.txt').write_text(REPO + '\n')
    (bundle / 'config/repository-runners.tsv').write_text('# Uses the reviewed ubuntu-tiny source.\n')
    (bundle / 'manifest.json').write_text(json.dumps({'upstream': INFRA_REV, 'blobs': FILES}, indent=2) + '\n')
    bindir = bundle / 'bin'
    bindir.mkdir()
    # Scope the unchanged launcher to the local socket without changing CLI defaults.
    wrapper = bindir / 'incus'
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(str(Path(shutil.which('incus')).resolve())) +
                       ' --force-local "$@"\n')
    wrapper.chmod(0o700)
    return bundle


def apply(state, project, ref):
    for program in ('gh', 'incus', 'tmux', 'sh'):
        if not shutil.which(program):
            raise RuntimeError(program + ' is required on bak; no packages are installed on the host')
    command(['gh', 'auth', 'status', '--hostname', 'github.com'])
    # Permissions failures are not an empty runner inventory.
    api('repos/' + REPO + '/actions/runners?per_page=1')
    session = subprocess.run(['tmux', 'has-session', '-t', '=' + SESSION], capture_output=True)
    if session.returncode == 0:
        owner = command(['tmux', 'show-options', '-v', '-t', '=' + SESSION, '@melodica-ci-owner']).strip()
        if owner != OWNER:
            raise RuntimeError('An unrelated tmux session already owns the name ' + SESSION)
        print('Existing owned runner pool retained.')
    else:
        project = select_project(project)
        audit_definition(project)
        bundle = stage_bundle(state)
        environment = dict(os.environ, INCUS_PROJECT=project,
                           PATH=str(bundle / 'bin') + os.pathsep + os.environ.get('PATH', ''))
        result = subprocess.run(['sh', str(bundle / 'scripts/audit-runner-base.sh'), SOURCE], env=environment, check=False)
        if result.returncode:
            raise RuntimeError('Credential-free base audit failed; no registration token was requested')
        launcher = ['env', 'INCUS_PROJECT=' + project, 'RUNNER_SOURCE=' + SOURCE,
                    'RUNNER_CLASS=ubuntu-tiny', 'RUNNER_SLOTS=1', 'RUNNER_RETRY_DELAY=30',
                    'RUNNER_OWNER=' + OWNER, 'PATH=' + environment['PATH'],
                    'sh', str(bundle / 'scripts/run-pool.sh')]
        shell = 'exec ' + shlex.join(launcher) + ' >>' + shlex.quote(str(state / 'pool.log')) + ' 2>&1'
        command(['tmux', 'new-session', '-d', '-s', SESSION, shell])
        command(['tmux', 'set-option', '-t', '=' + SESSION, '@melodica-ci-owner', OWNER])
        print('Started one repository-scoped ephemeral Incus runner slot in ' + project + '.')
    head = api('repos/' + REPO + '/commits/' + quote(ref, safe=''))['sha']
    runs = api('repos/' + REPO + '/actions/runs?branch=' + quote(ref, safe='') + '&per_page=100')['workflow_runs']
    for workflow in ('libpiano-differential.yml', 'compare.yml'):
        pending = [run for run in runs if run['head_sha'] == head and
                   run['path'].endswith('/' + workflow) and run['status'] in ('queued', 'in_progress', 'waiting')]
        if pending:
            print(workflow + ': current-head run already pending: ' + str(pending[0]['id']))
        else:
            command(['gh', 'workflow', 'run', workflow, '--repo', REPO, '--ref', ref, '-f', 'runner=self-hosted'])
            print(workflow + ': dispatched for ' + head)
    print('Pool log: ' + str(state / 'pool.log'))
    print('CI completion is not implied by starting the listener. Inspect gh run list -R ' + REPO)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='audit base, start owned pool and dispatch current CI')
    parser.add_argument('--project', help='existing ordinary Incus runner project')
    parser.add_argument('--ref', default='libpiano-playlist-completeness')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', args.ref) or '..' in args.ref:
        raise ValueError('Invalid ref')
    if args.project and args.project not in ('codex-workers', 'atlas-workers', 'runners'):
        raise ValueError('Only ordinary runner projects are admitted; no HIL/controller project')
    if not shutil.which('gh'):
        raise RuntimeError('Run on bak with its existing authenticated gh CLI')
    os.umask(0o077)
    state = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'melodica-ci'
    state.mkdir(parents=True, exist_ok=True)
    report = diagnose(args.ref)
    text = json.dumps(report, indent=2) + '\n'
    (state / 'diagnosis.json').write_text(text)
    print(text, end='')
    if args.apply:
        with (state / 'apply.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            apply(state, args.project, args.ref)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print('melodica-ci: ' + str(error), file=sys.stderr)
        sys.exit(1)
