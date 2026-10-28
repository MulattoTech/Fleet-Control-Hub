import json, urllib.request, datetime, shutil
from pathlib import Path
root=Path(r'C:\Tools\AO-Fleet-Control')
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def save(p,v):
 t=p.with_suffix(p.suffix+'.reconcile');t.write_text(json.dumps(v,indent=2),encoding='utf-8');t.replace(p)
state=read(root/'restore-state.json')
if state.get('active'):raise RuntimeError('Pause restore before reconciliation')
with urllib.request.urlopen('http://127.0.0.1:3001/api/v1/sessions',timeout=8) as r: sessions=json.load(r)['sessions']
records=[s for s in sessions if s.get('projectId')=='mjobs-luna' and not s.get('isTerminated')]
roots=[s for s in records if s.get('kind')=='orchestrator']
assert len(records)==29, f'Unexpected MJobs session count {len(records)}'
assert len(roots)==1 and roots[0]['id']=='mjobs-luna-36' and roots[0]['model']=='gpt-5.6-sol', 'Unexpected primary'
assert any(s['id']=='mjobs-luna-35' and s['isTerminated'] for s in sessions), 'Old primary not retired'
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
manifest=[]
for s in records:
 observed=s.get('activity',{}).get('state','unknown')
 manifest.append(dict(id=s['id'],projectId=s['projectId'],kind=s['kind'],harness=s.get('harness','codex'),displayName=s.get('displayName',s['id']),model=s.get('model',''),mode=s.get('mode','tui'),branch=s.get('branch'),isTerminated=False,activity='restore-requested',observedActivity=observed,observedAt=now))
snap={'at':now,'kind':'explicit-MJobs-recovery-v2','scope':'MJobs existing 29 session IDs; other projects unchanged','sessions':manifest,'restorableCount':len(manifest),'replacesRetiredPrimary':{'oldId':'mjobs-luna-35','newId':'mjobs-luna-36'}}
save(root/'restore-snapshot.json',snap)
state.update(active=False,phase='paused',desiredIds=[s['id'] for s in manifest],source={'snapshotAt':now,'targets':manifest},restored={},inflight={},errors={},skipped={},lastError=None,allowDispatchAfter=False)
save(root/'restore-state.json',state)
save(root/'primary-session.json',{'oldId':'mjobs-luna-35','newId':'mjobs-luna-36','newMode':'chat','verifiedAt':now,'reason':'Native recovered primary health turn verified; old root archived'})
print(json.dumps({'targets':len(manifest),'primary':roots[0]['id'],'otherProjectsUntouched':True,'recoveryPaused':True}))
