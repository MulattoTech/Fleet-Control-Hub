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
    const pause=el('button','','Pause dispatch');pause.type='button';pause.disabled=!fleet.online;pause.addEventListener('click',()=>pauseFleet(fleet.id,fleet.name,pause));actions.append(pause,open);
    const detail=el('div','detail');detail.append(el('strong','','Review: '),document.createTextNode(fleet.review+'  •  Pending: '+count(fleet.pending)+(fleet.detail?'  •  '+fleet.detail:'')));
    row.append(title,metrics,actions,detail);holder.append(row);
  }
  $('totals').replaceChildren(el('b','',active),el('span','','active sessions across both fleets'));
}
async function refresh(){const button=$('refresh');button.disabled=true;try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Hub returned '+r.status);const data=await r.json();render(data.fleets);$('notice').textContent='Observed '+new Date(data.observedAt).toLocaleTimeString()+'. Status reads do not dispatch work.';}catch(e){$('notice').textContent='Status unavailable: '+e.message;}finally{button.disabled=false;}}
async function pauseFleet(id,name,button){if(!confirm('Pause new dispatch for '+name+'? Existing turns may finish.'))return;button.disabled=true;try{
  if(!token){const r=await fetch('/api/session');if(!r.ok)throw Error('Action session unavailable');token=(await r.json()).token;}
  const r=await fetch('/api/pause',{method:'POST',headers:{'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify({id})});const data=await r.json();if(!r.ok)throw Error(data.error||'Pause failed');$('notice').textContent=data.note;await refresh();
}catch(e){$('notice').textContent='Pause was not confirmed: '+e.message;button.disabled=false;}}
$('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,15000);
