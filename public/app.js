'use strict';
const $=id=>document.getElementById(id);
let token=null;
const openReviews=new Map();
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
    const stop=el('button','stop','Graceful stop');stop.type='button';stop.disabled=!fleet.online;stop.addEventListener('click',()=>controlFleet(fleet.id,fleet.name,'graceful-stop',stop));
    const reviews=el('button','','Review queue');reviews.type='button';reviews.disabled=!fleet.online;reviews.addEventListener('click',()=>{if(openReviews.has(fleet.id)){openReviews.delete(fleet.id);reviewPanel.replaceChildren();}else{openReviews.set(fleet.id,0);loadReviewQueue(fleet.id,reviewPanel,0);}});
    actions.append(start,pause,stop,reviews);if(['127.0.0.1','localhost'].includes(location.hostname))actions.append(open);
    const detail=el('div','detail');detail.append(el('strong','','Controls: '),document.createTextNode(safetyText(fleet.safety)),el('br'),el('strong','','Progress: '),document.createTextNode(progressText(fleet)+(fleet.detail?'  •  '+fleet.detail:'')));
    const reviewPanel=el('section','review-panel');reviewPanel.setAttribute('aria-label',fleet.name+' review candidates');
    row.append(title,metrics,actions,detail,reviewPanel);holder.append(row);
    if(openReviews.has(fleet.id))loadReviewQueue(fleet.id,reviewPanel,openReviews.get(fleet.id));
  }
  $('totals').replaceChildren(el('b','',active),el('span','','tracked sessions across both fleets'));
}
async function refresh(){const button=$('refresh');button.disabled=true;try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Hub returned '+r.status);const data=await r.json();render(data.fleets);$('notice').textContent='Observed '+new Date(data.observedAt).toLocaleTimeString()+'. Status reads do not dispatch work.';}catch(e){$('notice').textContent='Status unavailable: '+e.message;}finally{button.disabled=false;}}
function safetyText(s){if(!s)return 'Unavailable';const scope=s.emergencyScope==='machine'?'machine-wide Codex/AO':s.emergencyScope==='project'?'project sessions':'unknown';return (s.emergency?'Emergency latched':s.gracefulStop?'Graceful stop in progress':s.dispatchEnabled?'Dispatch enabled':'Dispatch paused')+'; Codex remaining '+(s.codexQuotaFresh&&s.codexRemaining!=null?s.codexRemaining+'%':'unavailable')+'; emergency scope: '+scope;}
function progressText(fleet){const p=fleet.progress;if(!p?.pipeline?.available)return 'Work stage unavailable';
  const fields=[['proposed','proposed'],['approved','approved'],['active','active'],['completed','completed'],['accepted','accepted'],['blocked','blocked'],['unassessed','unassessed']];
  const stages=fields.filter(([key])=>Number.isInteger(p.pipeline[key])).map(([key,label])=>p.pipeline[key]+' '+label).join(', ');
  const review=p.reviewDecisions?.available?' Reviews: '+p.reviewDecisions.awaitingAssessment+' awaiting assessment'+(Number.isInteger(p.reviewDecisions.accepted)?', '+p.reviewDecisions.accepted+' accepted':'')+(Number.isInteger(p.reviewDecisions.revisionRequested)?', '+p.reviewDecisions.revisionRequested+' revision requested':'')+(Number.isInteger(p.reviewDecisions.rejected)?', '+p.reviewDecisions.rejected+' rejected':'')+'.':'';
  if(fleet.id==='mjobs'&&p.available)return stages+'; '+p.reviews.ready+' review results ready, '+p.drafts.ready+' drafts ready and '+p.drafts.unreviewed+' unreviewed.'+review;
  return stages+'.'+review;}
async function loadReviewQueue(id,panel,offset){panel.replaceChildren(el('p','','Loading review candidates…'));try{
  const r=await fetch('/api/review-candidates?id='+encodeURIComponent(id)+'&offset='+offset,{cache:'no-store'}),data=await r.json();if(!r.ok)throw Error(data.error||'Review queue unavailable');
  panel.replaceChildren();if(!data.supported){panel.append(el('p','',data.reason||'Native review assessment unavailable'));return;}
  panel.append(el('p','','Review candidates '+(data.total?offset+1:0)+'–'+Math.min(offset+data.candidates.length,data.total)+' of '+data.total+'. Inspect source evidence before recording a decision.'));
  for(const candidate of data.candidates){const line=el('div','review-row');line.append(el('code','',id==='mjobs'?candidate.id:'Requirement #'+candidate.issue+' · '+candidate.id));if(candidate.outcome)line.append(el('span','',candidate.outcome));
    if(['127.0.0.1','localhost'].includes(location.hostname)){const assess=el('button','','Assess');assess.type='button';assess.addEventListener('click',()=>assessCandidate(id,candidate,assess));line.append(assess);}panel.append(line);}
  const paging=el('div','review-paging');if(offset>0){const previous=el('button','','Previous');previous.addEventListener('click',()=>{openReviews.set(id,Math.max(0,offset-50));loadReviewQueue(id,panel,openReviews.get(id));});paging.append(previous);}
  if(offset+50<data.total){const next=el('button','','Next');next.addEventListener('click',()=>{openReviews.set(id,offset+50);loadReviewQueue(id,panel,openReviews.get(id));});paging.append(next);}panel.append(paging);
}catch(e){panel.replaceChildren(el('p','','Review queue unavailable: '+e.message));}}
async function assessCandidate(id,candidate,button){
  const decision=prompt('Decision for '+(id==='mjobs'?candidate.id:'BabyTracker requirement #'+candidate.issue)+': accepted, revision_requested, or rejected. Review the underlying evidence first.');
  if(!['accepted','revision_requested','rejected'].includes(decision))return;
  let prNumber,reviewId;if(id==='babytracker'){const pr=prompt('Verified BabyTracker-App PR number (inspect its review and changed files in GitHub first):'),review=prompt('Independent GitHub review ID on that PR:');if(!/^[1-9]\d*$/.test(pr||'')||!/^[1-9]\d*$/.test(review||'')){ $('notice').textContent='Positive PR and review IDs are required.';return;}prNumber=Number(pr);reviewId=Number(review);}
  if(!confirm('I inspected the underlying review evidence and current source revision for this exact candidate. Record '+decision+'?'))return;
  const confirmation='ASSESS '+(id==='mjobs'?'MJobs':'BabyTracker');if(prompt('Type '+confirmation+' to record the decision:')!==confirmation)return;
  button.disabled=true;try{if(!token){const r=await fetch('/api/session');if(!r.ok)throw Error('Action session unavailable');token=(await r.json()).token;}
    const r=await fetch('/api/review-assessment',{method:'POST',headers:{'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify({id,candidateId:candidate.id,decision,confirmation,evidenceReviewed:true,prNumber,reviewId})});const result=await r.json();if(!r.ok)throw Error(result.error||'Assessment refused');$('notice').textContent=result.note;await refresh();
  }catch(e){$('notice').textContent='Assessment outcome was not confirmed. Check the native controller before retrying: '+e.message;button.disabled=false;}}
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
