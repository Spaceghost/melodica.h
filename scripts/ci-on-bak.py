#!/usr/bin/env python3
"""Diagnose CI; --apply starts a repo-scoped Incus runner pool using existing gh auth."""
import argparse, base64, fcntl, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit
REPO='Spaceghost/melodica.h'; INFRA='Spaceghost/atlas-infra'; INFRA_REV='e53704e06f62e47ea60b27a56fee0f406f518c1a'
SOURCE='runner-ubuntu-base/sealed-v2.336.0'; SESSION='melodica-ci'; OWNER='melodica-ci-v1'
FILES={'scripts/run-one-ubuntu.sh':'5d050ae2c598377b24e3a5f42eddae98d29dca23','scripts/run-pool.sh':'84756d353436e7bb0d40288d97507436bd67a419','scripts/audit-runner-base.sh':'cd27dec18f510ad3c9f48c4148407391e8674c5a','config/runner-classes.tsv':'80e0a5e6afff0dc41c52e2459a943ab73bb2ab16'}
LABELS={'self-hosted','Linux','X64','ubuntu-tiny','spaceghost-melodica.h'}
def command(args,timeout=60,capture=True):
 r=subprocess.run(args,text=True,capture_output=capture,timeout=timeout,check=False)
 if r.returncode: raise RuntimeError(shlex.join(args)+': '+(((r.stderr or '').strip()) if capture else '') or 'exit '+str(r.returncode))
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
def apply(state,project):
 for p in ('gh','incus','tmux','sh'):
  if not shutil.which(p): raise RuntimeError(p+' is required on bak; no host packages are installed')
 command(['gh','auth','status','--hostname','github.com']); api('repos/'+REPO+'/actions/runners?per_page=1')
 existing=subprocess.run(['tmux','has-session','-t','='+SESSION],capture_output=True)
 if existing.returncode==0:
  if command(['tmux','show-options','-v','-t','='+SESSION,'@melodica-ci-owner']).strip()!=OWNER: raise RuntimeError('unrelated tmux session owns '+SESSION)
  print('Existing owned runner pool retained.'); return
 project=select_project(project); audit_definition(project); bundle=stage_bundle(state); env=dict(os.environ,INCUS_PROJECT=project,PATH=str(bundle/'bin')+os.pathsep+os.environ.get('PATH',''))
 if subprocess.run(['sh',str(bundle/'scripts/audit-runner-base.sh'),SOURCE],env=env,check=False).returncode: raise RuntimeError('credential-free base audit failed')
 launcher=['env','INCUS_PROJECT='+project,'RUNNER_SOURCE='+SOURCE,'RUNNER_CLASS=ubuntu-tiny','RUNNER_SLOTS=1','RUNNER_RETRY_DELAY=30','RUNNER_OWNER='+OWNER,'PATH='+env['PATH'],'sh',str(bundle/'scripts/run-pool.sh')]
 shell='exec '+shlex.join(launcher)+' >>'+shlex.quote(str(state/'pool.log'))+' 2>&1'; command(['tmux','new-session','-d','-s',SESSION,shell]); command(['tmux','set-option','-t','='+SESSION,'@melodica-ci-owner',OWNER]); print('Started one repository-scoped ephemeral Incus runner slot in '+project+'.'); print('Pool log: '+str(state/'pool.log'))
def main():
 p=argparse.ArgumentParser(); p.add_argument('--apply',action='store_true'); p.add_argument('--project'); p.add_argument('--ref',default='libpiano-playlist-completeness'); a=p.parse_args()
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*',a.ref) or '..' in a.ref: raise ValueError('invalid ref')
 if a.project and a.project not in ('codex-workers','atlas-workers','runners'): raise ValueError('only ordinary runner projects are admitted')
 if not shutil.which('gh'): raise RuntimeError('run on bak with its existing authenticated gh CLI')
 os.umask(0o077); state=Path(os.environ.get('XDG_STATE_HOME',str(Path.home()/'.local/state')))/'melodica-ci'; state.mkdir(parents=True,exist_ok=True); text=json.dumps(diagnose(a.ref),indent=2)+'\n'; (state/'diagnosis.json').write_text(text); print(text,end='')
 if a.apply:
  with (state/'apply.lock').open('w') as lock: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); apply(state,a.project)
 return 0
if __name__=='__main__':
 try: sys.exit(main())
 except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as e: print('melodica-ci: '+str(e),file=sys.stderr); sys.exit(1)
