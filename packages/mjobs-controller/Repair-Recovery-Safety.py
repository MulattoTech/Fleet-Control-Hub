from pathlib import Path
import datetime, shutil

root=Path(r'C:\Tools\AO-Fleet-Control')
bk=root/'backups'/('safety-patch-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
bk.mkdir(parents=True)

def patch(name,changes):
    p=root/name
    text=p.read_text(encoding='utf-8-sig')
    for old,new in changes:
        if text.count(old)!=1:
            raise RuntimeError(f'{name}: expected exactly one match, found {text.count(old)}: {old[:80]}')
        text=text.replace(old,new,1)
    shutil.copy2(p,bk/name)
    tmp=p.with_suffix(p.suffix+'.safe-tmp')
    tmp.write_text(text,encoding='utf-8')
    tmp.replace(p)
    print('PATCHED',name)

patch('master-controls.js',[
    ("  this.quota?.disarm();\n  const before=await this.restore.preview();", "  // Preserve the user's armed quota safety cutoff during restoration.\n  const quota=this.quota?.status();\n  if(quota?.config?.autoKillArmed && (!quota.fresh || quota.selectedRemainingPercent===null))\n   throw Error('Quota protection is armed but usage is stale. Wait for fresh telemetry before restoring.');\n  if(quota?.config?.autoKillArmed && quota.selectedRemainingPercent<=quota.config.thresholdPercent)\n   throw Error('Usage is at the automatic-stop threshold. Restore is blocked to preserve the cutoff.');\n  const before=await this.restore.preview();"),
    ("  this.disableAutomaticDispatch();\n  this.quota?.disarm();\n  this.audit('master_emergency_rearmed',{});", "  this.disableAutomaticDispatch();\n  // Re-arming the emergency latch must not silently disable an armed quota guard.\n  this.audit('master_emergency_rearmed',{});"),
    ("  const pid=this.spawnWatchdog();\n  const status={active:true,phase:'starting',startedAt:new Date().toISOString(),watchdogPid:pid,remainingTotal:null,dashboardPreserved:true};\n  write(this.statusPath,status);\n  return true;", "  // Publish starting state before launching; never overwrite the child's newer heartbeat.\n  write(this.statusPath,{active:true,phase:'starting',startedAt:new Date().toISOString(),watchdogPid:null,remainingTotal:null,dashboardPreserved:true});\n  const pid=this.spawnWatchdog();\n  const observed=read(this.statusPath,{});\n  if(observed.phase==='starting'&&!observed.checkedAt)write(this.statusPath,{...observed,watchdogPid:pid});\n  return true;")
])

patch('restore-fleet.js',[
    ("   const pending=[];\n   const tally=", "   const pending=[];\n   const readyNow=new Set();\n   const tally="),
    ("     delete this.state.inflight[s.id];tally.ready++;continue;", "     delete this.state.inflight[s.id];\n     delete this.state.errors[s.id];\n     readyNow.add(s.id);tally.ready++;continue;"),
    ("    const attempts=this.state.errors[s.id]?.attempts||0;", "    delete this.state.restored[s.id];\n    let attempts=this.state.errors[s.id]?.attempts||0;"),
    ("      delete this.state.inflight[s.id];this.state.errors[s.id]={attempts:attempts+1,message:'Resume result was not confirmed after 35 seconds',at:nowIso()};", "      delete this.state.inflight[s.id];\n      attempts++;\n      this.state.errors[s.id]={attempts,message:'Resume result was not confirmed after 35 seconds',at:nowIso()};\n      if(attempts>=this.config.maxAttempts){tally.failed++;continue;}"),
    ("   const rootsPending=pending.filter(x=>x.source.kind==='orchestrator');\n   if(rootsPending.length){", "   const rootsPending=pending.filter(x=>x.source.kind==='orchestrator');\n   const unresolvedRoots=first.filter(s=>!readyNow.has(s.id));\n   if(unresolvedRoots.length&&!rootsPending.length){\n    this.state.phase=tally.failed||tally.conflict||tally.missing?'partial':'verifying';\n    this.state.lastError='Workers held until primary controllers are healthy: '+unresolvedRoots.map(s=>s.id).join(', ');\n    this.state.stats={tally};this.save();\n    return {waiting:true,tally,blockedRoots:unresolvedRoots.map(s=>s.id)};\n   }\n   if(rootsPending.length){"),
    ("    const {source:s,current}=job;", "    if(!this.state.active||this.locked())break;\n    const {source:s,current}=job;")
])

patch('Emergency-Stop-Codex.ps1',[
    ("[System.IO.File]::WriteAllText($tmp,$json,[System.Text.Encoding]::UTF8)", "[System.IO.File]::WriteAllText($tmp,$json,[System.Text.UTF8Encoding]::new($false))"),
    ("if (!(Is-Latched)) { Write-Output 'Emergency latch is not set; no processes terminated.'; exit 1 }", "if (!(Is-Latched)) {\n  Save-Json $StatusPath @{active=$false;phase='disarmed';checkedAt=(Get-Date).ToUniversalTime().ToString('o');watchdogPid=$PID;dashboardPreserved=$true;reason='Latch released before watchdog started'}\n  Write-Output 'Emergency latch is not set; no processes terminated.'\n  exit 0\n}")
])

# Prevent the standard launcher from producing malformed TOML through replacement backreferences.
p=root/'Start-Orchestrator-Standard.ps1'
text=p.read_text(encoding='utf-8-sig')
lines=text.splitlines()
found=[i for i,line in enumerate(lines) if '$newBody=' in line]
if len(found)!=1: raise RuntimeError('Expected exactly one standard-launcher replacement')
i=found[0]
if '.Replace(' in lines[i]:
    shutil.copy2(p,bk/p.name)
    lines[i]="        $newBody=[regex]::Replace($body,'(?m)^(\\s*daemon_auto_start\\s*=\\s*)false', [Text.RegularExpressions.MatchEvaluator]{param($m) $m.Groups[1].Value + 'true'})"
    p.write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print('PATCHED',p.name)
print('BACKUP',bk)
