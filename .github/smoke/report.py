"""Write smoke-linux.json for the release smoke test (run with python3 -I)."""
import argparse
import json
import datetime

p = argparse.ArgumentParser()
p.add_argument('--out', required=True)
p.add_argument('--ok', required=True)
p.add_argument('--summary', required=True)
p.add_argument('--tuner', default='none')
p.add_argument('--evidence', default='{}')
p.add_argument('--failure', default='')
p.add_argument('--version', default='unknown')
p.add_argument('--steps', nargs='*', default=[])
a = p.parse_args()

try:
    evidence = json.loads(a.evidence) if a.evidence else {}
except json.JSONDecodeError:
    evidence = {'raw': a.evidence}

doc = {
    'ok': a.ok == 'true',
    'platform': 'linux',
    'summary': a.summary,
    'when': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
    'version': a.version,
    'steps': a.steps,
    'tuner': a.tuner,
}
if evidence:
    doc['tuner_evidence'] = evidence
if a.failure:
    doc['failure'] = a.failure
with open(a.out, 'w') as f:
    json.dump(doc, f, indent=2)
    f.write('\n')
