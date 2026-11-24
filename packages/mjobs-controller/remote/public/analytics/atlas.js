'use strict';
(()=>{
 const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=x=>typeof x==='number'&&Number.isFinite(x)?x:null,fmt=x=>num(x)===null?'—':new Intl.NumberFormat(undefined,{notation:x>=10000?'compact':'standard',maximumFractionDigits:1}).format(x);
 const clock=x=>Number.isFinite(Date.parse(x||''))?new Date(x).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
 const duration=x=>num(x)===null?'—':x<60?Math.round(x)+'s':x<3600?Math.floor(x/60)+'m '+Math.round(x%60)+'s':(x/3600).toFixed(1)+'h';
 const colors={executing:'#8bbcff',queued:'#82baff',dispatching:'#82baff',reserve:'#b49bff',ci_wait:'#edc67a',review_wait:'#b49bff',settling:'#edc67a',cooldown:'#edc67a',stopped:'#ff9da9',approval:'#ff9da9',primary_wait:'#ff9da9',paused:'#68686f',available:'#68686f',unknown:'#68686f',control_wait:'#edc67a',resource_wait:'#edc67a',quota_wait:'#ff9da9'};
 const labels={executing:'Executing',queued:'Queued',dispatching:'Submitted',reserve:'On-call reserve',ci_wait:'Waiting for CI',review_wait:'Waiting for change',settling:'Turn settling',cooldown:'Delivery backoff',stopped:'Stopped',approval:'Needs a decision',primary_wait:'Waiting for primary',paused:'Dispatch paused',available:'Awaiting useful work',unknown:'Unknown',control_wait:'Control hold',resource_wait:'Resource-limited',quota_wait:'Quota protection'};
 let data=null,collectorStatus=null,pending=false,selected=null,failed=false,projectRequest=0,publishedRequirements=null,syncing=false,repositoryRequest=0,repositorySyncing=false,customRepositories=[],trackedProjects=[];
 const reports=new Map(),set=(id,text)=>{$(id).textContent=text;};
 const readable=value=>value===null||value===undefined||value===''?'Unavailable':typeof value==='object'?JSON.stringify(value):String(value);
 function infoGrid(id,entries){const target=$(id);target.replaceChildren();for(const [label,value] of entries){const item=document.createElement('div');item.className='provenance-item';const key=document.createElement('small');key.textContent=label;const val=document.createElement('strong');val.textContent=readable(value);item.append(key,val);target.append(item);}}
 const acceptanceCounts=[['PASS','pass'],['PARTIAL','partial'],['NOT RUN','not_run'],['TOTAL','total']];
 const activityCounts=[['Recent sessions','session_count'],['Active processes','active_process_count'],
  ['Observed workspaces','workspace_count'],['Changed workspaces','changed_workspace_count']];
 function renderCounts(id,counts,fields=acceptanceCounts){const target=$(id);target.replaceChildren();for(const [label,key] of fields){const item=document.createElement('div');item.className='count-item';const number=document.createElement('strong');number.textContent=typeof counts?.[key]==='number'&&Number.isFinite(counts[key])?fmt(counts[key]):'Unavailable';const title=document.createElement('span');title.textContent=label;item.append(number,title);target.append(item);}}
 function addRow(container,title,detail,provenance){
  const item=document.createElement('article'),heading=document.createElement('strong'),text=document.createElement('span');
  item.className='campaign-item';heading.textContent=title;text.textContent=detail;item.append(heading,text);
  if(provenance){const note=document.createElement('small');note.textContent=provenance;item.append(note);}
  container.append(item);
 }
 function renderRequirements(){
  const list=$('requirements-list');list.replaceChildren();
  if(!$('requirements-detail').open)return;
  const query=$('requirements-filter').value.trim().toLowerCase();
  const rows=publishedRequirements?.filter(row=>[row.id,row.priority,row.area,row.status].join(' ').toLowerCase().includes(query));
  if(!rows?.length){
   list.textContent=rows?'No published requirements match this filter.':'Published requirements are unavailable.';
   return;
  }
  for(const row of rows.slice(0,50))addRow(list,row.id,[row.priority,row.area,row.status].filter(Boolean).join(' · '));
  if(rows.length>50)addRow(list,`Showing 50 of ${rows.length}`,'Filter by ID, area, priority, or status to narrow the list.');
 }
 function setStatus(id,status,observedAt,maxAgeSeconds){
  const node=$(id),reported=String(status||'UNAVAILABLE').toUpperCase();
  let state=reported;
  if(reported==='CURRENT'||reported==='FRESH'){
   const seconds=(Date.now()-Date.parse(observedAt))/1000;
   if(!Number.isFinite(seconds)||seconds< -10)state='UNAVAILABLE';
   else if(seconds>maxAgeSeconds)state='STALE';
  }
  node.textContent=state;
  const current=state==='CURRENT'||state==='FRESH';
  node.className='chip '+(current?'good':'warn');
  return current;
 }
 function renderProject(detail){const project=detail?.project||{},acceptance=detail?.published_acceptance,local=detail?.local_progress,activity=detail?.codex_activity;
  set('project-name',project.name||'Selected project');set('project-identity',[project.repository,project.branch].filter(Boolean).join(' · ')||'Repository identity unavailable');
  const publishedCurrent=setStatus('project-sync-status',acceptance?.status,acceptance?.last_success_at,300);set('project-sync-detail',acceptance?`${readable(acceptance.repository)} · ${readable(acceptance.branch)} · published ${readable(acceptance.published_commit)}`:'Published repository state is unavailable.');
  set('project-local-detail',local?`Local ${readable(local.status)} · ${readable(local.source)} · ${readable(local.observed_at)}`:'Local workspace progress is unavailable.');
  setStatus('acceptance-status',acceptance?.status,acceptance?.last_success_at,300);infoGrid('published-provenance',[
   ['Repository',acceptance?.repository],['Branch',acceptance?.branch],['Published commit',acceptance?.published_commit],['Last successful sync',acceptance?.last_success_at],['Checked at',acceptance?.checked_at],['Sync detail',acceptance?.reason]
  ]);renderCounts('original-counts',acceptance?.original);renderCounts('reference-counts',acceptance?.reference);
  publishedRequirements=Array.isArray(acceptance?.requirements)?acceptance.requirements:null;renderRequirements();
  setStatus('local-progress-status',local?.status,local?.observed_at,90);infoGrid('local-provenance',[
   ['Source',local?.source],['Observed at',local?.observed_at],['Workspace branch',local?.checkout_branch],['Workspace commit',local?.checkout_commit]
  ]);renderCounts('local-original-counts',local?.original);renderCounts('local-reference-counts',local?.reference);
  const campaigns=$('campaign-list');campaigns.replaceChildren();
  if(!Array.isArray(local?.campaigns)||!local.campaigns.length){
   const empty=document.createElement('p');empty.className='no-data';
   empty.textContent=Array.isArray(local?.campaigns)?'No campaign observations reported.':'Campaign observations are unavailable.';
   campaigns.append(empty);
  }else for(const row of local.campaigns){
   const score=row.scoreboard;
   const summary=score?`${fmt(score.verified_pass)}/${fmt(score.total)} verified · ${fmt(score.PARTIAL)} partial · ${fmt(score.NOT_RUN)} pending · ${fmt(score.FAIL)} failed · ${fmt(score.BLOCKED)} blocked`:'Status unavailable';
   addRow(campaigns,readable(row.requirement_id),summary,`Recorded ${readable(row.updated_at_utc)} · ${readable(row.source_revision)}`);
  }
  const activityCurrent=setStatus('codex-status',activity?.status,activity?.observed_at,activity?.max_age_seconds||30);
  infoGrid('codex-provenance',[
   ['Source',activity?.source],['Observed at',activity?.observed_at],['Latest activity',activity?.latest_activity_utc],['Freshness limit (seconds)',activity?.max_age_seconds],
   ['Coverage',activity?.coverage_partial===true?'Partial':activity?.coverage_partial===false?'Complete for the configured observer':null]
  ]);
  renderCounts('codex-counts',activity?.counts,activityCounts);
  const slices=$('codex-slices');slices.replaceChildren();
  if(Array.isArray(activity?.slices)&&activity.slices.length){
   for(const slice of activity.slices)addRow(slices,`${slice.role==='worker'?'Worker':'Coordinator'} ${slice.label}`,`Last observed activity ${readable(slice.latest_activity_utc)}`);
  }else slices.textContent=activityCurrent?'No recent slices reported.':'Slice observations are unavailable.';
  set('project-notice',!activityCurrent?'Codex activity is stale or unavailable.':!publishedCurrent?'Published acceptance sync is stale or unavailable.':activity?.counts?.session_count===0&&activity?.counts?.active_process_count===0?'No recent Codex sessions or active processes observed.':'');
 }
 function normalizeRepository(value){let input=String(value||'').trim();if(/^https?:\/\//i.test(input)){let url;try{url=new URL(input);}catch{return null;}if(url.protocol!=='https:'||url.hostname.toLowerCase()!=='github.com'||url.username||url.password||url.search||url.hash)return null;input=url.pathname.replace(/^\/+|\/+$/g,'');}input=input.replace(/\.git$/i,'');const match=/^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)$/.exec(input);return match?`${match[1]}/${match[2]}`:null;}
 function projectForRepository(repo){const key=String(repo||'').toLowerCase();return trackedProjects.find(project=>normalizeRepository(project.repository)?.toLowerCase()===key)||null;}
 function readBookmarks(){try{const rows=JSON.parse(localStorage.getItem('fleetHub.publicRepositories')||'[]');return Array.isArray(rows)?rows.map(normalizeRepository).filter((v,i,a)=>v&&a.indexOf(v)===i).slice(0,20):[];}catch{return [];}}
 function saveBookmarks(){try{localStorage.setItem('fleetHub.publicRepositories',JSON.stringify(customRepositories));return true;}catch{return false;}}
 function appendCustomOptions(select){for(const repo of customRepositories){if([...select.options].some(o=>o.value==='repo:'+repo))continue;const option=document.createElement('option');option.value='repo:'+repo;option.textContent=repo;select.append(option);}}
 function renderBookmarks(){const target=$('repository-bookmarks');target.replaceChildren();for(const repo of customRepositories){const row=document.createElement('div'),choose=document.createElement('button'),forget=document.createElement('button');row.className='repository-bookmark';choose.type='button';choose.textContent=repo;choose.setAttribute('aria-label',`Select ${repo}`);forget.type='button';forget.textContent='Forget';forget.setAttribute('aria-label',`Forget ${repo}`);choose.addEventListener('click',()=>selectRepository(repo,true));forget.addEventListener('click',()=>{customRepositories=customRepositories.filter(item=>item!==repo);saveBookmarks();[...$('project-select').options].find(item=>item.value==='repo:'+repo)?.remove();renderBookmarks();if(new URL(location.href).searchParams.get('repository')===repo){const url=new URL(location.href);url.searchParams.delete('repository');history.pushState({},'',url);const fallback=[...$('project-select').options].find(item=>item.value&&!item.value.startsWith('repo:'));if(fallback){$('project-select').value=fallback.value;setCustomSurface(false);loadProject(fallback.value,false);}}});row.append(choose,forget);target.append(row);}}
 function setCustomSurface(active){for(const id of ['requirements','campaign-progress','codex-activity'])$(id).hidden=active;$('repository-progress').hidden=false;}
 function showEstimate(result){const known=['ESTIMATED','UNAVAILABLE','STALE'].includes(String(result?.status||'').toUpperCase()),status=known?String(result.status).toUpperCase():'UNAVAILABLE';set('repository-progress-status',status);$('repository-progress-status').className='chip '+(status==='ESTIMATED'?'good':'warn');const counts=status==='ESTIMATED'?[['Total',result.total],['Done',result.done],['In progress',result.in_progress],['Not started',result.not_started],['Blocked',result.blocked],['Goal estimate',typeof result.percent==='number'?`${result.percent}%`:null]]:[];infoGrid('repository-progress-result',[
   ['Repository',result?.repository],['Branch',result?.branch],['Commit',result?.commit],['Method',result?.method],['Observed at',result?.observed_at],['Checked at',result?.checked_at],['Source path',result?.source_path],['Reason',result?.reason]
  ].concat(counts));const target=$('repository-progress-result');if(result?.source_url){try{const source=new URL(result.source_url);if(source.protocol==='https:'&&['github.com','raw.githubusercontent.com'].includes(source.hostname)){const item=document.createElement('div'),link=document.createElement('a');item.className='provenance-item';link.href=source.href;link.textContent='Open estimate source';link.target='_blank';link.rel='noopener noreferrer';item.append(link);target.append(item);}}catch{}}if(status==='UNAVAILABLE')set('repository-progress-status','UNAVAILABLE');}
 function clearMjobsProject(){publishedRequirements=null;for(const id of ['published-provenance','original-counts','reference-counts','requirements-list','local-provenance','local-original-counts','local-reference-counts','campaign-list','codex-provenance','codex-counts','codex-slices'])$(id).replaceChildren();for(const id of ['requirements-detail','codex-slices-detail'])$(id).open=false;set('project-name','Public repository');set('project-identity','Goal estimate · public GitHub data');set('project-sync-status','NOT APPLICABLE');$('project-sync-status').className='chip';set('project-sync-detail','Published MJobs acceptance does not apply to this repository.');set('project-local-detail','MJobs workspace and Codex activity are hidden for this repository.');set('acceptance-status','NOT APPLICABLE');set('local-progress-status','NOT APPLICABLE');set('codex-status','NOT APPLICABLE');set('project-notice','Showing a public repository task estimate. Fleet operational charts below remain fleet-wide and are not attributed to this repository.');}
 async function loadRepository(repo,refresh=false){const request=++repositoryRequest;++projectRequest;setCustomSurface(true);clearMjobsProject();set('repository-progress-status','LOADING');$('repository-progress-status').className='chip';set('repository-progress-result','Loading repository estimate…');try{const url='./api/repository-progress?repository='+encodeURIComponent(repo)+(refresh?'&refresh=1':'');const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});const result=await response.json();if(request!==repositoryRequest)return;if(normalizeRepository(result?.repository)!==repo)throw Error('Repository estimate scope changed');if(!response.ok&&result?.status!=='UNAVAILABLE')throw Error('Repository estimate unavailable');showEstimate(result);}catch{if(request!==repositoryRequest)return;showEstimate({status:'UNAVAILABLE',repository:repo,reason:'Repository progress could not be loaded. Retry to check again.'});}}
 function selectRepository(repo,push){const normalized=normalizeRepository(repo);if(!normalized)return;const select=$('project-select');const value='repo:'+normalized;if(![...select.options].some(option=>option.value===value)){const option=document.createElement('option');option.value=value;option.textContent=normalized;select.append(option);}select.value=value;if(push){const url=new URL(location.href);url.searchParams.delete('project');url.searchParams.set('repository',normalized);history.pushState({},'',url);}loadRepository(normalized,false);}
 function clearRepositoryEstimate(){set('repository-progress-status','NOT SELECTED');$('repository-progress-status').className='chip warn';$('repository-progress-result').replaceChildren();set('repository-input-status','');}
 async function loadProjects(){const select=$('project-select');if(!select||typeof select.replaceChildren!=='function')return;customRepositories=readBookmarks();try{const response=await fetch('./api/projects',{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Project list unavailable');const payload=await response.json(),projects=Array.isArray(payload.projects)?payload.projects:[];trackedProjects=projects;select.replaceChildren();for(const p of projects){const option=document.createElement('option');option.value=String(p.project_id);option.textContent=String(p.name||p.project_id);select.append(option);}appendCustomOptions(select);if(!projects.length)throw Error('No tracked projects are available');set('project-status',`${projects.length} tracked project${projects.length===1?'':'s'} · ${customRepositories.length} saved public repos`);const defaultId=projects.some(p=>p.project_id===payload.default_project_id)?payload.default_project_id:projects[0].project_id;const selectUrl=()=>{const params=new URL(location.href).searchParams,repo=normalizeRepository(params.get('repository')),known=repo&&projectForRepository(repo);if(known)return String(known.project_id);if(repo)return'repo:'+repo;const requested=params.get('project');return projects.some(p=>p.project_id===requested)?requested:defaultId;};const requested=selectUrl();if(requested.startsWith('repo:')&&![...select.options].some(option=>option.value===requested)){const option=document.createElement('option');option.value=requested;option.textContent=requested.slice(5);select.append(option);}select.value=requested;renderBookmarks();if(select.value.startsWith('repo:'))await loadRepository(select.value.slice(5));else await loadProject(select.value,false);select.addEventListener('change',()=>{if(select.value.startsWith('repo:'))selectRepository(select.value.slice(5),true);else{const url=new URL(location.href);url.searchParams.delete('repository');url.searchParams.set('project',select.value);history.pushState({},'',url);setCustomSurface(false);loadProject(select.value,false);}});window.addEventListener('popstate',()=>{const requested=selectUrl();if(requested.startsWith('repo:')&&![...select.options].some(option=>option.value===requested)){const option=document.createElement('option');option.value=requested;option.textContent=requested.slice(5);select.append(option);}select.value=requested;if(select.value.startsWith('repo:'))loadRepository(select.value.slice(5));else{setCustomSurface(false);loadProject(select.value,false);}});
  }catch{select.replaceChildren();const option=document.createElement('option');option.value='';option.textContent='Project list unavailable';select.append(option);set('project-status','Projects could not be loaded. Retry by refreshing the page.');set('project-notice','Project API is unavailable. Project-scoped acceptance and activity are not shown.');}}
 async function loadProject(id,push,forceSync=false){
  if(!id)return;
  ++repositoryRequest;clearRepositoryEstimate();
  const request=++projectRequest,previous=reports.get(id);
  if(push){
   const url=new URL(location.href);url.searchParams.set('project',id);history.pushState({},'',url);
   renderProject(previous||{});
   set('project-notice','Loading project observations…');
  }
  try{
   const url='./api/projects/'+encodeURIComponent(id)+(forceSync?'?refresh=1':'');
   const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Project details unavailable');
   const detail=await response.json();
   if(request!==projectRequest)return;
   if(detail.project?.project_id!==id)throw Error('Project scope changed');
   reports.set(id,detail);renderProject(detail);
   if(forceSync){
    if(detail.sync_requested!==true)set('project-notice','On-demand GitHub sync is unavailable for this project.');
    else if(detail.published_acceptance?.status==='CURRENT')set('project-notice','GitHub sync complete.');
    else set('project-notice','GitHub sync failed. Check the last successful sync time.');
   }
  }catch{
   if(request!==projectRequest)return;
   const stale=snapshot=>snapshot?.status&&snapshot.status.toUpperCase()!=='UNAVAILABLE'?{...snapshot,status:'STALE'}:snapshot;
   renderProject({project:previous?.project,published_acceptance:stale(previous?.published_acceptance),
    local_progress:stale(previous?.local_progress),codex_activity:stale(previous?.codex_activity)});
   set('project-notice',previous?'Project refresh failed. Showing the last observation.':'Project details are unavailable.');
  }
 }
 const availability=()=>FleetAnalyticsStatus.assess(data,collectorStatus,Date.now(),failed);
 const stale=()=>!availability().live;
 const countdown=(at,kind)=>{const t=Date.parse(at||'');if(!Number.isFinite(t))return 'Not predictable';if(stale())return 'Stale';const secs=Math.ceil((t-Date.now())/1000);return secs<=0?'Check due':(kind==='estimate'?'~':'')+duration(secs);};
 function svg(content,w=900,h=195){return '<svg viewBox="0 0 '+w+' '+h+'" role="img" xmlns="http://www.w3.org/2000/svg">'+content+'</svg>';}
 function lineChart(){const rows=data.tokenSeries||[],w=900,h=185,top=18,bottom=160,max=Math.max(1,...rows.map(x=>num(x.output)||0));let body='';
  for(let n=0;n<4;n++){const y=top+(bottom-top)*n/3;body+='<line x1="0" y1="'+y+'" x2="900" y2="'+y+'" stroke="#22364a" stroke-dasharray="3 6"/><text x="895" y="'+(y-5)+'" text-anchor="end" fill="#7893ad" font-size="10">'+esc(fmt(max*(1-n/3)))+'</text>';}
  const points=rows.map((x,i)=>[i*w/Math.max(1,rows.length-1),bottom-(num(x.output)||0)/max*(bottom-top)]),d=points.map((p,i)=>(i?'L':'M')+p.map(n=>n.toFixed(2)).join(',')).join(' ');
  if(points.length)body+='<path d="'+d+' L'+w+','+bottom+' L0,'+bottom+' Z" fill="#304b6b66"/><path d="'+d+'" fill="none" stroke="#8bbcff" stroke-width="2.4" stroke-linejoin="round"/>';
  $('tokenChart').innerHTML=svg('<title>Native output tokens by fifteen-minute bucket</title>'+body,w,h);
 }
 function states(){const entries=Object.entries(data.summary.states||{}).filter(([,n])=>n>0),count=num(data.summary.agents),total=Math.max(1,count??0),r=44,c=2*Math.PI*r;let offset=0,body='<circle cx="68" cy="63" r="44" fill="none" stroke="#1c3044" stroke-width="14"/>';
  for(const [state,n]of entries){const length=n/total*c;body+='<circle cx="68" cy="63" r="44" fill="none" stroke="'+(colors[state]||'#526e89')+'" stroke-width="14" stroke-dasharray="'+Math.max(0,length-3)+' '+(c-Math.max(0,length-3))+'" stroke-dashoffset="'+(-offset)+'" transform="rotate(-90 68 63)"/>';offset+=length;}
  body+='<text x="68" y="67" fill="#edf4fc" font-size="26" text-anchor="middle" font-weight="650">'+fmt(count)+'</text><text x="68" y="83" fill="#94a9be" font-size="8" text-anchor="middle" letter-spacing="1">AGENTS</text><text x="145" y="57" fill="#edf4fc" font-size="26" font-weight="650">'+(count===null?'—':Math.round((data.summary.executing||0)/total*100)+'%')+'</text><text x="145" y="80" fill="#94a9be" font-size="11">at last observation</text><text x="145" y="99" fill="#718ba3" font-size="10">On-call is not active work.</text>';
  $('stateChart').innerHTML=svg('<title>Agent workflow state at last observation</title>'+body,330,126);
  $('stateLegend').innerHTML=entries.map(([state,n])=>'<div><i class="dot '+esc(state)+'"></i>'+esc(labels[state]||state)+'<b>'+n+'</b></div>').join('');
 }
 function heatmap(){const agents=[...data.agents].sort((a,b)=>a.kind==='orchestrator'?-1:b.kind==='orchestrator'?1:a.id.localeCompare(b.id,undefined,{numeric:true}));
  $('heatmap').innerHTML=agents.map(a=>'<div class="heat-row"><button class="agent-name" data-agent="'+esc(a.id)+'" title="'+esc(a.name)+'">'+esc(a.name)+'</button><div class="heat-cells">'+(a.occupancy||[]).map((v,i)=>'<i class="heat-cell level-'+(v<=0?0:Math.min(4,Math.max(1,Math.ceil(v*4))))+'" title="'+esc(new Date(Date.parse(data.window.start)+i*900000).toLocaleString())+': '+Math.round(v*100)+'% completed-turn occupancy"></i>').join('')+'</div><div class="heat-number">'+fmt(a.usage?.output)+'</div></div>').join('');
 }
 function models(){const rows=(data.models||[]).slice(0,7),max=Math.max(1,...rows.map(m=>m.output||0)),palette=['#67e7bf','#82baff','#b49bff','#f5c878','#ff9ba9'];
  $('models').innerHTML=rows.length?rows.map((m,i)=>'<div class="model-row"><span title="'+esc(m.model)+'">'+esc(m.model)+'</span>'+svg('<rect x="0" y="0" width="100" height="7" rx="3" fill="#1b3044"/><rect x="0" y="0" width="'+Math.max(0,Math.min(100,m.output/max*100))+'" height="7" rx="3" fill="'+palette[i%palette.length]+'"/>',100,7)+'<b>'+fmt(m.output)+'</b></div>').join(''):'<p class="no-data">No native model-usage events in this window.</p>';
 }
 function queue(){const search=$('search').value.toLowerCase(),filter=$('stateFilter').value;const rows=data.agents.filter(a=>(filter==='all'||a.work?.state===filter)&&[a.name,a.id,a.role,a.configuredModel].join(' ').toLowerCase().includes(search));
  const rank=a=>a.work?.state==='executing'?0:a.work?.state==='queued'?1:2;rows.sort((a,b)=>rank(a)-rank(b)||(a.work?.queuePosition??999)-(b.work?.queuePosition??999)||a.id.localeCompare(b.id,undefined,{numeric:true}));
  $('queue').innerHTML=rows.map(a=>'<tr><td><button class="agent-name" data-agent="'+esc(a.id)+'">'+esc(a.name)+'</button><span class="secondary">'+esc(a.configuredModel||'Model not reported')+'</span></td><td><span class="workflow '+esc(a.work?.state||'unknown')+'">'+esc(a.work?.label||'Unknown')+'</span><span class="secondary">'+esc(a.work?.reason||'')+'</span></td><td class="task-text">'+esc(a.work?.assignedTask||'No current assignment')+'</td><td>'+esc(a.work?.queuePosition??'—')+'</td><td class="countdown" data-time="'+esc(a.work?.estimatedStartAt||'')+'" data-estimate="1">'+countdown(a.work?.estimatedStartAt,'estimate')+'</td><td class="countdown" data-time="'+esc(a.work?.nextEvaluationAt||'')+'">'+(a.work?.nextEvaluationAt?countdown(a.work.nextEvaluationAt):'Not scheduled')+'</td><td>'+fmt(a.turnsCompleted)+'</td></tr>').join('');
  if(!rows.length)$('queue').innerHTML='<tr><td colspan="7" class="no-data">No agents match these filters.</td></tr>';
 }
 function detail(id){const a=data?.agents.find(x=>x.id===id);if(!a)return;selected=id;set('agentTitle',a.name);set('agentRole',a.id+' / '+a.role);
  $('agentBody').innerHTML='<div class="detail-grid">'+[['Completed turns',fmt(a.turnsCompleted)],['Median turn',duration(a.medianTurnSeconds)],['95th percentile',duration(a.p95TurnSeconds)],['Output tokens',fmt(a.usage?.output)]].map(([k,v])=>'<div><small>'+esc(k)+'</small><strong>'+esc(v)+'</strong></div>').join('')+'</div><div class="detail-note"><p><strong>'+esc(a.work?.label||'Unknown')+'</strong> — '+esc(a.work?.reason||'')+'</p><p>Assigned / planned: '+esc(a.work?.assignedTask||'None')+'</p><p>Queue: '+esc(a.work?.queuePosition??'Not queued')+' · Start: '+esc(countdown(a.work?.estimatedStartAt,'estimate'))+' · Next evaluation: '+esc(a.work?.nextEvaluationAt?countdown(a.work.nextEvaluationAt):'Not scheduled')+'</p></div><p class="footnote">Configured model: '+esc(a.configuredModel||'Unknown')+' · Observed models: '+esc((a.observedModels||[]).join(', ')||'No usage data')+' · Cache reuse: '+(num(a.usage?.cacheFraction)===null?'Not available':Math.round(a.usage.cacheFraction*100)+'%')+'</p><div class="turn-title"><h3>Turn ledger</h3><span>Newest 30 · tokens shown only when attributable</span></div><div class="table-scroll"><table class="turn-table"><thead><tr><th>Start</th><th>Wall time</th><th>State</th><th>Input</th><th>Cached</th><th>Output</th><th>Attribution</th></tr></thead><tbody>'+(a.latestTurns||[]).map(t=>'<tr><td>'+esc(new Date(t.startedAt).toLocaleString())+'</td><td>'+duration(t.durationSeconds)+'</td><td>'+esc(t.state)+'</td><td>'+fmt(t.inputTokens)+'</td><td>'+fmt(t.cachedInputTokens)+'</td><td>'+fmt(t.outputTokens)+'</td><td><span class="secondary">'+(t.usageAttribution==='unavailable'?'Not available':'Time-correlated · '+t.usageEvents+' events')+'</span></td></tr>').join('')+'</tbody></table></div><p class="footnote">Per-turn usage is correlated only when a native conversation and a unique recorded turn interval match. “—” means unavailable, not zero. Turn wall time includes tools and waiting; it is not pure model compute time.</p><div class="turn-title"><h3>Tracked pull requests</h3></div><p>'+((a.prs||[]).map(p=>Number.isInteger(p.number)?'<a href="https://github.com/MulattoTech/MJobs/pull/'+p.number+'" target="_blank" rel="noopener noreferrer">#'+p.number+'</a> '+esc(p.state)+' · '+esc(p.ci):'').join(' &nbsp; · &nbsp; ')||'<span class="secondary">None tracked</span>')+'</p>';
  if(!$('agentDialog').open)$('agentDialog').showModal();
 }
 function freshness(){const health=availability(),old=!health.live;document.body.classList.toggle('stale-surface',old);$('connection').className='chip '+(old?'warn':'good');set('connection',health.label);
  if(old)set('guard','Quota protection is not verified by this historical observation.');
  $('notice').className='notice'+(old?' stale':'');const source=data?.source;
  set('notice',(health.live&&source?.usageWindowComplete===false?'Usage import is catching up; captured usage totals are incomplete.':health.message)+(health.checkedAt?' Source checked '+new Date(health.checkedAt).toLocaleString()+'.':''));
  for(const e of document.querySelectorAll('[data-time]'))e.textContent=e.dataset.time?countdown(e.dataset.time,e.dataset.estimate?'estimate':null):(e.dataset.estimate?'Not predictable':'Not scheduled');
 }
 function render(){const s=data.summary,quota=data.quota||{};set('updated','Observed '+new Date(data.generatedAt).toLocaleString());set('guard',quota.fresh?fmt(quota.remainingPercent)+'% allowance · '+(quota.armed?quota.thresholdPercent+'% stop armed':'guard not armed'):'Allowance telemetry unavailable');
  set('executing',fmt(s.executing));set('executingNote','of '+s.agents+' agents · target '+(data.dispatch.targetWorking??'unknown'));set('queued',fmt(s.queued));set('reserved',fmt(s.reserved));set('queueNote',data.dispatch.enabled?'Dispatcher enabled · '+(data.dispatch.blocked||'capacity and quota checks apply'):'Assignments are paused');
  set('outputTokens',fmt(s.outputTokens));set('inputNote',fmt(s.inputTokens)+' input · '+fmt(s.cachedInputTokens)+' cached');set('completedTurns',fmt(s.completedTurns));set('durationNote','Recent median '+duration(s.medianRecentTurnSeconds)+' · p95 '+duration(s.p95RecentTurnSeconds));set('cacheBadge','Cache '+(s.inputTokens?Math.round(s.cachedInputTokens/s.inputTokens*100)+'%':'not available'));
  $('capacityTrack').innerHTML=Array.from({length:s.agents},(_,i)=>'<i class="'+(i<s.executing?'on':'')+'"></i>').join('');
  const p=data.productivity||{};set('productiveMode',p.enabled?'PRODUCTIVE DISCOVERY ON':'DISCOVERY OFF');$('productiveMode').className='chip '+(p.enabled?'good':'warn');$('pipeline').innerHTML=[['Evidence-backed opportunities',p.catalogCount],['Assigned drafts',p.assigned],['Drafts ready for review',p.artifactsReady],['No new gap',p.noNewGap]].map(([label,value],i)=>'<div class="'+(i===2?'accent':'')+'"><strong>'+fmt(value)+'</strong><span>'+label+'</span></div>').join('');
  set('dispatchNote',data.dispatch.enabled?'Target '+data.dispatch.targetWorking+' concurrent turns · '+(data.dispatch.reserveWorkers||0)+' explicit reserves. Estimated starts assume unchanged capacity.':'Automatic assignments are paused. Start times are not predictable until dispatch is enabled.');
  const previous=$('stateFilter').value,values=[...new Set(data.agents.map(a=>a.work?.state||'unknown'))].sort();$('stateFilter').innerHTML='<option value="all">Every state</option>'+values.map(x=>'<option value="'+esc(x)+'">'+esc(labels[x]||x)+'</option>').join('');$('stateFilter').value=values.includes(previous)?previous:'all';
  lineChart();states();heatmap();models();queue();freshness();if(selected&&$('agentDialog').open)detail(selected);
 }
 async function readObservation(){const r=await fetch('./analytics.json',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Observation unavailable');const v=await r.json();if(v.schemaVersion!==1||!Array.isArray(v.agents)||!v.summary)throw Error('Invalid telemetry');return v;}
 async function readCollectorStatus(){const r=await fetch('./collector-status.json',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Collector status unavailable');const raw=await r.text();if(raw.length>4096)throw Error('Collector status exceeds limit');const status=FleetAnalyticsStatus.normalize(JSON.parse(raw));if(!status)throw Error('Invalid collector status');return status;}
 async function refresh(){if(pending)return;pending=true;$('refresh').disabled=true;try{const [observation,status]=await Promise.allSettled([readObservation(),readCollectorStatus()]);collectorStatus=status.status==='fulfilled'?status.value:null;if(observation.status==='fulfilled'){data=observation.value;failed=false;render();}else{failed=true;freshness();}}catch{failed=true;freshness();}finally{pending=false;$('refresh').disabled=false;}}
 async function refreshProject(forceSync=false){
  const id=$('project-select')?.value;if(!id||syncing)return;
  if(id.startsWith('repo:')){if(forceSync&&!repositorySyncing){repositorySyncing=true;try{await loadRepository(id.slice(5),true);}finally{repositorySyncing=false;}}return;}
  if(forceSync){syncing=true;set('project-notice','Checking GitHub for the selected project…');}
  try{await loadProject(id,false,forceSync);}finally{if(forceSync)syncing=false;}
 }
 $('repository-form').addEventListener('submit',event=>{event.preventDefault();const repo=normalizeRepository($('repository-input').value);if(!repo){set('repository-input-status','Enter a public GitHub URL or owner/name.');return;}const known=projectForRepository(repo);if(known){$('project-select').value=known.project_id;const url=new URL(location.href);url.searchParams.delete('repository');url.searchParams.set('project',known.project_id);history.pushState({},'',url);setCustomSurface(false);clearRepositoryEstimate();set('repository-input-status','Using the existing tracked project and its verified acceptance view.');loadProject(known.project_id,false);return;}customRepositories=[repo,...customRepositories.filter(item=>item!==repo)].slice(0,20);const saved=saveBookmarks();appendCustomOptions($('project-select'));renderBookmarks();set('repository-input-status',saved?'Saved in this browser.':'Browser storage is unavailable; this repository will not be remembered.');selectRepository(repo,true);});
 $('requirements-filter').addEventListener('input',renderRequirements);
 $('requirements-detail').addEventListener('toggle',renderRequirements);
 document.addEventListener('click',e=>{const a=e.target.closest('[data-agent]');if(a)detail(a.dataset.agent);});$('closeAgent').addEventListener('click',()=>{$('agentDialog').close();selected=null;});$('agentDialog').addEventListener('close',()=>{selected=null;});$('search').addEventListener('input',()=>data&&queue());$('stateFilter').addEventListener('change',()=>data&&queue());$('refresh').addEventListener('click',()=>{refresh();refreshProject(true);});document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();refreshProject();}});loadProjects();refresh();setInterval(()=>{if(!document.hidden)refresh();},30000);setInterval(()=>{if(!document.hidden)refreshProject();},15000);setInterval(freshness,1000);
})();
