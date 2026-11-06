import json, pathlib, datetime, re, shutil, os, uuid, sys
root=pathlib.Path(r'C:\Tools\AO-Fleet-Control')
dash=root/'observability'/'dashboards'/'fleet-atlas.json'
source=pathlib.Path(r'C:\Tools\Dev\MTechLabs-Hub\site\mission-control\analytics')
now=datetime.datetime.now(datetime.timezone.utc)
def age(value):
 try:return (now-datetime.datetime.fromisoformat(value.replace('Z','+00:00'))).total_seconds()
 except (ValueError,AttributeError,TypeError):return float('inf')
status=json.loads((source/'collector-status.json').read_text('utf-8'))
data=json.loads((source/'analytics.json').read_text('utf-8'))
if status.get('available') is not True or status.get('reasonCode')!='OK' or age(status.get('checkedAt'))>90 or age(data.get('generatedAt'))>90 or age(data.get('generatedAt')) < -10:
 print(json.dumps({'status':'skipped','reason':'Telemetry not fresh and available'}));sys.exit(0)
if not isinstance(data.get('agents'),list) or data.get('schemaVersion')!=1:raise RuntimeError('Unexpected analytics source schema')
ids=sorted({a.get('id') for a in data['agents'] if isinstance(a,dict) and re.fullmatch(r'mjobs-[0-9]+',str(a.get('id','')))},key=lambda x:int(x.split('-')[1]))
if not ids or len(ids)>100:raise RuntimeError('Invalid or oversized agent choices')
if 'mjobs-16' in ids:ids.remove('mjobs-16');ids.insert(0,'mjobs-16')
if not dash.is_file() or dash.is_symlink():raise RuntimeError('Unsafe Grafana dashboard path')
d=json.loads(dash.read_text('utf-8'))
variables=[v for v in d.get('templating',{}).get('list',[]) if v.get('name')=='agent' and v.get('type')=='custom']
if len(variables)!=1:raise RuntimeError('Grafana agent selector identity changed')
v=variables[0];previous=v.get('current',{}).get('value')
chosen=previous if previous in ids else ('mjobs-16' if 'mjobs-16' in ids else ids[0])
new_query=','.join(ids)
new_options=[{'text':a,'value':a,'selected':a==chosen} for a in ids]
if v.get('query')==new_query and v.get('current')=={'text':chosen,'value':chosen} and v.get('options')==new_options:
 print(json.dumps({'status':'already_current','options':len(ids),'selected':chosen}));sys.exit(0)
v['query']=new_query;v['options']=new_options;v['current']={'text':chosen,'value':chosen}
out=json.dumps(d,indent=2,ensure_ascii=False)+'\n'
assert json.loads(out)['templating']['list'][0]['current']['value']==chosen
backup=root/'backups'/('grafana-agent-choices-'+now.strftime('%Y%m%dT%H%M%SZ')+'.json')
shutil.copy2(dash,backup)
temp=dash.with_name(dash.name+'.'+uuid.uuid4().hex+'.tmp')
try:temp.write_text(out,encoding='utf-8',newline='\n');os.replace(temp,dash)
finally:
 if temp.exists():temp.unlink()
print(json.dumps({'status':'updated','options':len(ids),'selected':chosen,'backup':str(backup)}))
