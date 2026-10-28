from pathlib import Path
root=Path(r'C:\Tools\AO-Fleet-Control')
for name in ['master-controls.js','restore-fleet.js','quota-guard.js','quota-control.js']:
 p=root/name;t=p.read_text(encoding='utf-8-sig')
 old="JSON.parse(fs.readFileSync(file,'utf8'))"
 new="JSON.parse(fs.readFileSync(file,'utf8').replace(/^\\uFEFF/,''))"
 if old in t:
  t=t.replace(old,new);p.write_text(t,encoding='utf8');print('BOM-SAFE',name)
p=root/'master-controls.js';t=p.read_text(encoding='utf8')
t=t.replace('if(this.latch.enabled)this.ensureWatchdog();','if(this.locked())this.ensureWatchdog();')
t=t.replace('if(!this.latch.enabled)return false;','if(!this.locked())return false;')
p.write_text(t,encoding='utf8')
p=root/'server.js';t=p.read_text(encoding='utf8')
old='isManualBusy:()=>mutationLock||!!sustain?.running,projectId'
new='isManualBusy:()=>mutationLock||!!sustain?.running||!!master?.locked()||!!master?.drainState.enabled||!!master?.restore.state.active,projectId'
assert old in t;t=t.replace(old,new,1)
old='isManualBusy:()=>mutationLock,projectId'
new='isManualBusy:()=>mutationLock||!!master?.locked()||!!master?.drainState.enabled||!!master?.restore.state.active,projectId'
assert old in t;t=t.replace(old,new,1)
p.write_text(t,encoding='utf8')
print('Offline latch and active recovery block automatic dispatch')
