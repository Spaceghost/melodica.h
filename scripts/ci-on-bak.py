#!/usr/bin/env python3
"""Diagnose CI; --apply starts a repo-scoped Incus runner pool using existing gh auth."""
import argparse, base64, fcntl, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import quote, urlsplit
REPO='Spaceghost/melodica.h'; INFRA='Spaceghost/atlas-infra'; INFRA_REV='e53704e06f62e47ea60b27a56fee0f406f518c1a'
SOURCE='runner-ubuntu-base/sealed-v2.336.0'; SESSION='melodica-ci'; OWNER='melodica-ci-v1'
FILES={'scripts/run-one-ubuntu.sh':'5d050ae2c598377b24e3a5f42eddae98d29dca23','scripts/run-pool.sh':'84756d353436e7bb0d40288d97507436bd67a419','scripts/audit-runner-base.sh':'cd27dec18f510ad3c9f48c4148407391e8674c5a','config/runner-classes.tsv':'80e0a5e6afff0dc41c52e2459a943ab73bb2ab16'}
LABELS={'self-hosted','Linux','X64','ubuntu-tiny','spaceghost-melodica.h'}
def command(args,timeout=60,capture=True):
 r=subprocess.run(args,text=True,capture_output=capture,timeout=timeout,check=False)
 if r.returncode: raise RuntimeError(shlex.join(args)+': '+((((r.stderr or '').strip()) if capture else '') or 'exit '+str(r.returncode)))
 return r.stdout if capture else ''
def api(endpoint): return json.loads(command(['gh','api',endpoint]))
def metadata(d): return d.get('metadata',d) if isinstance(d,dict) else d
def blob_hash(data): return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def validate_blob(payload,expected):
 if payload.get('sha')!=expected or payload.get('encoding')!='base64': raise ValueError('source blob does not match reviewed pin')
 data=base64.b64decode(''.join(payload['content'].split()),validate=True)
 if blob_hash(data)!=expected: raise ValueError('decoded source blob hash mismatch')
 return data
def matching_runners(payload): return [r for r in payload.get('runners',[]) if LABELS.issubset({l['name'] for l in r.get('labels',[])})]
def diagnose(ref):
 report={'repository':REPO,'ref':ref,'runs':[]}
 try:
  payload=api('repos/'+REPO+'/actions/runners?per_page=100'); report['matching_runners']=[{k:r.get(k) for k in ('id','name','status','busy')} for r in matching_runners(payload)]; report['runner_listing_truncated']=payload.get('total_count',0)>100
 except (RuntimeError,ValueError) as e: report['runner_read_error']=str(e)
 runs=api('repos/'+REPO+'/actions/runs?branch='+quote(ref,safe='')+'&per_page=5')
 for run in runs.get('workflow_runs',[]):
  entry={k:run.get(k) for k in ('id','name','status','conclusion','head_sha')}; entry['jobs']=[]
  jobs=api('repos/'+REPO+'/actions/runs/'+str(run['id'])+'/jobs?per_page=100')
  for job in jobs.get('jobs',[]):
   item={k:job.get(k) for k in ('name','status','conclusion','runner_id','runner_name')}; item['steps']=len(job.get('steps') or [])
   endpoint=urlsplit(job.get('check_run_url','')).path.lstrip('/'); prefix='repos/'+REPO+'/check-runs/'
   if endpoint.lower().startswith(prefix.lower()) and endpoint[len(prefix):].isdigit():
    try: item['annotations']=[{k:x.get(k) for k in ('title','message','annotation_level')} for x in api(endpoint+'/annotations?per_page=100')]
    except (RuntimeError,ValueError) as e: item['annotation_read_error']=str(e)
   entry['jobs'].append(item)
  report['runs'].append(entry)
 return report
def incus_json(*args): return metadata(json.loads(command(['incus','--force-local',*args])))
def select_project(requested):
 instance,snapshot=SOURCE.split('/'); projects=[requested] if requested else [x['name'] for x in incus_json('project','list','--format=json') if x['name'] in ('codex-workers','atlas-workers','runners')]; matches=[]
 for project in projects:
  try: rows=incus_json('snapshot','list',instance,'--project',project,'--format=json')
  except RuntimeError: continue
  if any(x['name'].split('/')[-1]==snapshot and not x.get('stateful',False) for x in rows): matches.append(project)
 if len(matches)!=1: raise RuntimeError('expected exactly one existing stateless '+SOURCE+' source; found '+repr(matches))
 return matches[0]
def audit_definition(project):
 instance,snapshot=SOURCE.split('/'); q='?project='+quote(project,safe=''); base=incus_json('query','/1.0/instances/'+instance+q)
 if base.get('type')!='container': raise RuntimeError('runner base must be a container')
 snap=incus_json('query','/1.0/instances/'+instance+'/snapshots/'+snapshot+q); config={}; devices={}
 for profile in snap.get('profiles',[]):
  d=incus_json('query','/1.0/profiles/'+quote(profile,safe='')+q); config.update(d.get('config',{})); devices.update(d.get('devices',{}))
 config.update(snap.get('config',{})); devices.update(snap.get('devices',{}))
 if any(str(config.get(k,'')).lower() in ('true','1') for k in ('security.privileged','security.nesting')) or any(k.startswith('raw.') and v for k,v in config.items()): raise RuntimeError('refusing privileged/nested/raw runner base')
 roots=nics=0
 for dev in devices.values():
  if dev.get('type')=='nic':
   if dev.get('network')!='sandbox0' and not (dev.get('nictype')=='bridged' and dev.get('parent')=='sandbox0'): raise RuntimeError('only sandbox0 is admitted')
   if dev.get('name','eth0')!='eth0': raise RuntimeError('runner NIC must be eth0')
   nics+=1
  elif dev.get('type')=='disk' and dev.get('path')=='/' and dev.get('pool')=='bak' and not dev.get('source'): roots+=1
  else: raise RuntimeError('refusing non-root mount or device passthrough: '+repr(dev))
 if roots!=1 or nics!=1: raise RuntimeError('expected one bak root disk and one sandbox0 NIC')
def stage_bundle(state):
 bundle=Path(tempfile.mkdtemp(prefix='broker-',dir=state))
 for name,expected in FILES.items():
  dest=bundle/name; dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(validate_blob(api('repos/'+INFRA+'/contents/'+name+'?ref='+INFRA_REV),expected)); dest.chmod(0o700 if name.startswith('scripts/') else 0o600)
 (bundle/'config/repositories.txt').write_text(REPO+'\n'); (bundle/'config/repository-runners.tsv').write_text('# reviewed ubuntu-tiny default\n'); (bundle/'manifest.json').write_text(json.dumps({'upstream':INFRA_REV,'blobs':FILES},indent=2)+'\n')
 bindir=bundle/'bin'; bindir.mkdir(); wrapper=bindir/'incus'; wrapper.write_text('#!/bin/sh\nexec '+shlex.quote(str(Path(shutil.which('incus')).resolve()))+' --force-local "$@"\n'); wrapper.chmod(0o700)
 return bundle
# This server is deliberately separate from interactive tmux and its hooks/shell.
TMUX_SOCKET = 'melodica-ci-v2'


def pool_tmux(state):
    return ['tmux', '-L', TMUX_SOCKET, '-f', str(state / 'tmux.conf')]


def pool_config(state):
    return ("set-option -g default-shell /bin/sh\n"
            "set-option -g default-command ''\n"
            "set-option -g destroy-unattached off\n"
            "set-option -s exit-unattached off\n"
            "set-window-option -g remain-on-exit on\n"
            "set-option -g @melodica-ci-owner " + OWNER + "\n"
            "set-option -g @melodica-ci-state " + shlex.quote(str(state)) + "\n")


def pool_entry(log, launcher):
    # Open logging before exec. Keep the pool as the pane's direct process so its
    # existing signal/cleanup traps still receive tmux's hangup on shutdown.
    return ("#!/bin/sh\numask 077\nexec >>" + shlex.quote(str(log)) + " 2>&1\n"
            "printf '%s\\n' 'melodica-ci: entering runner pool'\n"
            "exec " + shlex.join(launcher) + "\n")


def pool_log_tail(state):
    log = state / 'pool.log'
    if not log.exists():
        return 'pool.log does not exist; the pool entry point was not reached.'
    # Bound diagnostic reads even after a long-lived pool has accumulated output.
    with log.open('rb') as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - 8192))
        return stream.read().decode('utf-8', errors='replace')


def pool_state(tmux, target, state):
    fmt = '#{pane_id}\t#{pane_dead}\t#{pane_dead_status}'
    if target.startswith('%'):
        output = command(tmux + ['display-message', '-p', '-t', target, fmt]).strip()
    else:
        output = command(tmux + ['list-panes', '-s', '-t', target, '-F', fmt]).strip()
    rows = output.splitlines()
    fields = rows[0].split('\t') if len(rows) == 1 else []
    if len(fields) < 2 or not re.fullmatch(r'%[0-9]+', fields[0]):
        raise RuntimeError('Expected one identifiable pool pane; refusing to start a duplicate')
    pane, dead = fields[:2]
    if dead not in ('0', '1'):
        raise RuntimeError('Unrecognized pool pane state: ' + repr(output))
    if dead == '1':
        status = fields[2] if len(fields) > 2 else 'unknown'
        # Save terminal output too, including errors before shell redirection.
        captured = command(tmux + ['capture-pane', '-p', '-t', pane, '-S', '-80'])
        (state / 'pool-pane.txt').write_text(captured)
        raise RuntimeError('Runner pool exited (status ' + status + '). Pane retained; '
                           'not starting another worker.\n' + pool_log_tail(state) +
                           '\nRetained pane output:\n' + captured)
    return pane


def existing_pool(state):
    private = pool_tmux(state)
    result = subprocess.run(private + ['list-sessions', '-F', '#{session_name}'],
                            capture_output=True, text=True, timeout=10, check=False)
    if result.returncode == 0:
        owner = command(private + ['show-options', '-gqv', '@melodica-ci-owner']).strip()
        location = command(private + ['show-options', '-gqv', '@melodica-ci-state']).strip()
        if owner != OWNER or location != str(state) or result.stdout.splitlines() != [SESSION]:
            raise RuntimeError('Private tmux socket is not the expected owned pool; left untouched')
        return private, pool_state(private, '=' + SESSION, state)
    # Do not duplicate a running pool left by the previous launcher on the
    # default server. Never kill or reconfigure the user's interactive server.
    legacy = subprocess.run(['tmux', 'has-session', '-t', '=' + SESSION],
                            capture_output=True, text=True, timeout=10, check=False)
    if legacy.returncode == 0:
        owner = command(['tmux', 'show-options', '-qv', '-t', '=' + SESSION,
                         '@melodica-ci-owner']).strip()
        if owner != OWNER:
            raise RuntimeError('An unowned legacy tmux session already uses ' + SESSION)
        return ['tmux'], pool_state(['tmux'], '=' + SESSION, state)
    # A live but empty/unowned private server must not inherit our commands.
    server = subprocess.run(private + ['show-options', '-gqv', '@melodica-ci-owner'],
                            capture_output=True, text=True, timeout=10, check=False)
    if server.returncode == 0:
        raise RuntimeError('Private tmux server exists without its pool; inspect it before restarting')
    return None


def start_pool(state, bundle, project, path):
    log = state / 'pool.log'
    with log.open('a') as stream:
        stream.write('\nmelodica-ci: preparing private tmux launch\n')
    (state / 'tmux.conf').write_text(pool_config(state))
    launcher = ['env', 'INCUS_PROJECT=' + project, 'RUNNER_SOURCE=' + SOURCE,
                'RUNNER_CLASS=ubuntu-tiny', 'RUNNER_SLOTS=1', 'RUNNER_RETRY_DELAY=30',
                'RUNNER_OWNER=' + OWNER, 'PATH=' + path, '/bin/sh',
                str(bundle / 'scripts/run-pool.sh')]
    entry = bundle / 'start-pool.sh'
    entry.write_text(pool_entry(log, launcher))
    entry.chmod(0o700)
    tmux = pool_tmux(state)
    # Two command arguments are executed directly, NOT through default-shell -c.
    # The dedicated config enables remain-on-exit and ownership before this
    # command starts. There is no post-spawn set-option race.
    try:
        identity = command(tmux + ['new-session', '-d', '-P', '-F',
                           '#{session_id} #{pane_id}', '-s', SESSION, '-c', str(state),
                           '/bin/sh', str(entry)]).strip()
        if not re.fullmatch(r'\$[0-9]+ %[0-9]+', identity):
            raise RuntimeError('Unexpected tmux identity: ' + repr(identity))
        session, pane = identity.split()
        (state / 'pool-session.json').write_text(json.dumps(
            {'socket': TMUX_SOCKET, 'session': session, 'pane': pane,
             'bundle': str(bundle), 'project': project}, indent=2) + '\n')
        time.sleep(0.25)
        pool_state(tmux, pane, state)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        # Includes tmux/config errors even before the shell can write pool.log.
        raise RuntimeError(str(error) + '\nPool log: ' + str(log) + '\n' + pool_log_tail(state)) from error
    return tmux, pane


def apply(state, project):
    state = state.resolve()
    for program in ('gh', 'incus', 'tmux', 'sh'):
        if not shutil.which(program):
            raise RuntimeError(program + ' is required on bak; no host packages are installed')
    command(['gh', 'auth', 'status', '--hostname', 'github.com'])
    api('repos/' + REPO + '/actions/runners?per_page=1')
    active = existing_pool(state)
    if active is None:
        project = select_project(project)
        audit_definition(project)
        bundle = stage_bundle(state)
        env = dict(os.environ, INCUS_PROJECT=project,
                   PATH=str(bundle / 'bin') + os.pathsep + os.environ.get('PATH', ''))
        result = subprocess.run(['/bin/sh', str(bundle / 'scripts/audit-runner-base.sh'), SOURCE],
                                env=env, check=False)
        if result.returncode:
            raise RuntimeError('credential-free base audit failed')
        active = start_pool(state, bundle, project, env['PATH'])
    print('Runner pool process is alive; this does not yet prove GitHub job pickup.')
    print('Inspect pane: ' + shlex.join(active[0] + ['capture-pane', '-p', '-t', active[1]]))
    print('Pool log: ' + str(state / 'pool.log'))
    print(pool_log_tail(state), end='')
    try:
        runners = matching_runners(api('repos/' + REPO + '/actions/runners?per_page=100'))
        online = sum(runner.get('status') == 'online' for runner in runners)
        print('Matching online GitHub runners: ' + str(online) +
              ('; listener registration still pending.' if not online else '.'))
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print('Runner pickup unverified: ' + str(error), file=sys.stderr)

def main():
 p=argparse.ArgumentParser(); p.add_argument('--apply',action='store_true'); p.add_argument('--project'); p.add_argument('--ref',default='libpiano-playlist-completeness'); a=p.parse_args()
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*',a.ref) or '..' in a.ref: raise ValueError('invalid ref')
 if a.project and a.project not in ('codex-workers','atlas-workers','runners'): raise ValueError('only ordinary runner projects are admitted')
 if not shutil.which('gh'): raise RuntimeError('run on bak with its existing authenticated gh CLI')
 os.umask(0o077); state=Path(os.environ.get('XDG_STATE_HOME',str(Path.home()/'.local/state')))/'melodica-ci'; state.mkdir(parents=True,exist_ok=True); text=json.dumps(diagnose(a.ref),indent=2)+'\n'; (state/'diagnosis.json').write_text(text); print('GitHub diagnosis: '+str(state/'diagnosis.json') if a.apply else text, end='\n' if a.apply else '')
 if a.apply:
  with (state/'apply.lock').open('w') as lock: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); apply(state,a.project)
 return 0
if __name__=='__main__':
 try: sys.exit(main())
 except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as e: print('melodica-ci: '+str(e),file=sys.stderr); sys.exit(1)
