'use strict';
const $=id=>document.getElementById(id);
let token=null;
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=String(text);return node;}
function count(x){return Number.isInteger(x)?x:'—';}
function metric(label,value){const node=el('div','metric');node.append(el('b','',count(value)),el('span','',label));return node;}
function render(fleets){const holder=$('fleets');holder.replaceChildren();let active=0;
  for(const fleet of fleets){if(Number.isInteger(fleet.total))active+=fleet.total;
    const row=el('article','fleet'+(fleet.online?'':' offline'));
    const title=el('div','fleet-title');title.append(el('h2','',fleet.name),el('span','state',fleet.online?'Controller online':'Controller unavailable'),el('p','',fleet.mode));
    const metrics=el('div','metrics');metrics.append(metric('Sessions',fleet.total),metric('Working',fleet.working),metric('Available',fleet.idle),metric('Needs attention',fleet.attention));
    const actions=el('div','fleet-actions');const open=el('a','action','Full controls');open.href=fleet.controlUrl;open.rel='noopener';
    const start=el('button','start','Start fleet');start.type='button';start.disabled=!fleet.online;start.addEventListener('click',()=>startFleet(fleet.id,fleet.name,start));
    const pause=el('button','','Pause dispatch');pause.type='button';pause.disabled=!fleet.online;pause.addEventListener('click',()=>controlFleet(fleet.id,fleet.name,'pause',pause));
    const stop=el('button','stop','Graceful stop');stop.type='button';stop.disabled=!fleet.online;stop.addEventListener('click',()=>controlFleet(fleet.id,fleet.name,'graceful-stop',stop));actions.append(start,pause,stop);if(['127.0.0.1','localhost'].includes(location.hostname))actions.append(open);
    const detail=el('div','detail');detail.append(el('strong','','Controls: '),document.createTextNode(safetyText(fleet.safety)),el('br'),el('strong','','Progress: '),document.createTextNode(progressText(fleet)+(fleet.detail?'  •  '+fleet.detail:'')));
    row.append(title,metrics,actions,detail);holder.append(row);
  }
  $('totals').replaceChildren(el('b','',active),el('span','','tracked sessions across both fleets'));
}
async function refresh(){const button=$('refresh');button.disabled=true;try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Hub returned '+r.status);const data=await r.json();render(data.fleets);$('notice').textContent='Observed '+new Date(data.observedAt).toLocaleTimeString()+'. Status reads do not dispatch work.';}catch(e){$('notice').textContent='Status unavailable: '+e.message;}finally{button.disabled=false;}}
function safetyText(s){if(!s)return 'Unavailable';return (s.emergency?'Emergency latched':s.gracefulStop?'Graceful stop in progress':s.dispatchEnabled?'Dispatch enabled':'Dispatch paused')+'; Codex remaining '+(s.codexQuotaFresh&&s.codexRemaining!=null?s.codexRemaining+'%':'unavailable');}
function progressText(fleet){const p=fleet.progress;if(!p?.available)return 'Evidence unavailable';if(fleet.id==='mjobs'){const l=p.lifecycle;return (l?.available?l.approved+' approved work items, '+l.leased+' leased, '+l.completed+' completed; ':'')+p.reviews.ready+' review results ready, '+p.reviews.unassessed+' unassessed; '+p.drafts.ready+' drafts ready, '+p.drafts.unreviewed+' unreviewed';}return p.tasks.proposed+' proposed, '+p.tasks.inFlight+' in flight, '+p.tasks.accepted+' accepted, '+p.tasks.unassessed+' unassessed';}
async function controlFleet(id,name,action,button){const prompt=action==='pause'?'Pause new dispatch for '+name+'? Existing turns may finish.':'Gracefully stop '+name+'? Idle sessions may exit and active sessions will receive a wind-down instruction.';if(!confirm(prompt))return;button.disabled=true;try{
  if(!token){const r=await fetch('/api/session');if(!r.ok)throw Error('Action session unavailable');token=(await r.json()).token;}
  const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify({id,action})});const data=await r.json();if(!r.ok)throw Error(data.error||'Control failed');$('notice').textContent=data.note;await refresh();
}catch(e){$('notice').textContent='Action outcome was not confirmed. Check the selected controller before retrying: '+e.message;button.disabled=false;}}
async function startFleet(id,name,button){button.disabled=true;try{
  const previewResponse=await fetch('/api/start-preview?id='+encodeURIComponent(id),{cache:'no-store'});const preview=await previewResponse.json();if(!previewResponse.ok)throw Error(preview.error||'Start preview unavailable');
  if(preview.blocked||!preview.quotaFresh){$('notice').textContent=(id==='mjobs'&&Number.isInteger(preview.targetCount)?'MJobs-only saved roster: '+preview.targetCount+' targets. ':'')+name+' cannot start: '+(preview.blockedReasons?.join('; ')||'current controller or quota state blocks Start')+'. Inspect the selected controller before retrying.';return;}
  const message=preview.note+'\nSaved or current sessions: '+count(preview.targetCount)+'. Codex quota remaining: '+(preview.quotaRemaining??'unknown')+'%.\nType '+preview.confirmation+' to request Start.';
  if(prompt(message)!==preview.confirmation)return;
  if(!token){const r=await fetch('/api/session');if(!r.ok)throw Error('Action session unavailable');token=(await r.json()).token;}
  const requestId=id==='mjobs'?(sessionStorage.getItem('mjobsStartRequestId')||crypto.randomUUID()):undefined;
  if(id==='mjobs')sessionStorage.setItem('mjobsStartRequestId',requestId);
  const r=await fetch('/api/start',{method:'POST',headers:{'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify({id,confirmation:preview.confirmation,requestId,manifestRevision:id==='mjobs'?preview.manifestRevision:undefined})});const result=await r.json();if(!r.ok)throw Error(result.error||'Start was refused');
  if(id==='mjobs')sessionStorage.removeItem('mjobsStartRequestId');
  $('notice').textContent=result.note;await refresh();
}catch(e){$('notice').textContent='Start outcome was not confirmed. Inspect the selected controller before retrying: '+e.message;}finally{button.disabled=false;}}
if(!['127.0.0.1','localhost'].includes(location.hostname))document.querySelectorAll('nav a[href^="http://127.0.0.1:"]').forEach(a=>a.remove());
$('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,15000);
