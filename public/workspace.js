/* Fleet workspace catalog and read-only Mission Control evidence. No agent writes. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const node=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n;};
  const repositoryLink=(repo)=>{
    const a=node('a','project-repo',repo);a.href='https://github.com/'+repo;a.rel='noopener noreferrer';a.target='_blank';return a;
  };
  const builtins=[{name:'MJobs',repository:'MulattoTech/MJobs',link:'/fleet/',description:'Installed project controller · native MJobs Fleet'},
    {name:'BabyTracker',repository:'MulattoTech/BabyTracker',link:'/babytracker/',description:'Installed project controller · same owner-authenticated native view locally and online'}];
  const isLocal=['127.0.0.1','localhost'].includes(location.hostname);

  function renderProjects(projects){
    const holder=$('tracked-list'),openWorkspaces=new Set();let focusedWorkspace=null;
    for(const details of holder.querySelectorAll('details.workspace-paths')){
      if(details.open)openWorkspaces.add(details.dataset.repository);
      if(details.querySelector('summary')===document.activeElement)focusedWorkspace=details.dataset.repository;
    }
    holder.replaceChildren();
    for(const p of [...builtins,...projects]){
      const card=node('article','tracked-card'),header=node('div','tracked-card-header');
      const name=node('h3','',p.name),badge=node('span','tracked-mode',p.kind==='read-only'?'Tracking only':'Controller installed');header.append(name,badge);
      const description=node('p','',p.description||'GitHub repository tracked without automatic agent execution.');
      const links=node('div','tracked-card-links');links.append(repositoryLink(p.repository));
      if(p.link){
        const open=node('a','action',p.name==='MJobs'?'Fleet controls':'BabyTracker controls');open.href=p.link;links.append(open);
      }
      card.append(header,description,links);
      if(p.kind==='read-only'){
        const count=Number.isInteger(p.workspaceCount)?p.workspaceCount:0;
        card.append(node('p','fd-footnote',count+' registered workspace'+(count===1?'':'s')+' · no controller adapter yet'));
        if(isLocal&&Array.isArray(p.workspaces)&&p.workspaces.length){
          const details=node('details','workspace-paths'),summary=node('summary','','Local workspace paths');
          details.dataset.repository=p.repository.toLowerCase();details.open=openWorkspaces.has(details.dataset.repository);details.append(summary);
          const list=node('ul');for(const item of p.workspaces)list.append(node('li','',item));details.append(list);card.append(details);
        }
      }
      holder.append(card);
      const details=card.querySelector('details.workspace-paths');
      if(details&&details.dataset.repository===focusedWorkspace)details.querySelector('summary').focus({preventScroll:true});
    }
  }
  let loadingProjects=false;
  async function refreshProjects(){
    if(loadingProjects)return;loadingProjects=true;
    try{const response=await fetch('/api/projects',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      const data=await response.json();if(!response.ok||!Array.isArray(data.projects))throw Error('Registry unavailable');
      renderProjects(data.projects);$('projects-freshness').textContent=data.projects.length+' additional repo'+(data.projects.length===1?'':'s')+' registered';
    }catch{$('projects-freshness').textContent='Project registry unavailable';}
    finally{loadingProjects=false;}
  }
  async function registerProject(event){
    event.preventDefault();const form=event.currentTarget,submit=$('add-project-submit'),feedback=$('project-feedback');
    if(submit.disabled)return;
    const values=new FormData(form),workspaceText=String(values.get('workspaces')||'');
    const body={repository:String(values.get('repository')||'').trim(),name:String(values.get('name')||'').trim(),workspaces:workspaceText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)};
    submit.disabled=true;feedback.textContent='Registering metadata only. No code or agents will be started.';
    try{
      const session=await fetch('/api/session',{cache:'no-store'});if(!session.ok)throw Error('Action session unavailable');
      const actionToken=(await session.json()).token;
      const response=await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json','x-fleet-hub':actionToken},body:JSON.stringify(body)});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Registration was refused');
      feedback.textContent=data.registered.name+' registered for read-only tracking. Add a reviewed controller adapter to enable actions.';
      form.reset();await refreshProjects();
    }catch(e){feedback.textContent='Registration not confirmed: '+e.message+'. Review the current list before retrying.';}
    finally{submit.disabled=false;}
  }

  const metric=(title,value,detail)=>{const item=node('div','mission-metric');item.append(node('span','',title),node('strong','fd-num',value),node('small','',detail));return item;};
  let loadingMission=false;
  async function refreshMission(){
    if(loadingMission)return;loadingMission=true;
    try{
      const response=await fetch('/api/mission-status',{cache:'no-store',signal:AbortSignal.timeout(6000)});
      const data=await response.json();if(!response.ok)throw Error('Status unavailable');
      const holder=$('mission-metrics'),areaHolder=$('mission-areas'),previousDetails=areaHolder.querySelector('details.mission-area-details');
      const areaOpen=previousDetails?.open===true,areaFocused=previousDetails?.querySelector('summary')===document.activeElement;
      holder.replaceChildren();areaHolder.replaceChildren();
      if(!data.available){$('mission-freshness').textContent='Offline / not verified';$('mission-warning').textContent=data.reason||'Mission Control is unavailable. No acceptance counts are inferred.';return;}
      for(const [label,row] of [['Original acceptance',data.original],['Reference gaps',data.reference]]){
        holder.append(metric(label,row.pass+' / '+row.total+' PASS',row.partial+' partial · '+row.notRun+' not run'));
      }
      const p1=Array.isArray(data.priorities)?data.priorities.find(p=>p.name==='P1'):null;
      if(p1)holder.append(metric('P1 requirements',p1.pass+' / '+p1.total+' PASS',p1.partial+' partial · '+p1.notRun+' not run'));
      holder.append(metric('Release readiness',data.releaseReadiness,data.checkpointCurrent?'Local checkpoint current':'Local checkpoint not verified'));
      const gitStatus=data.githubSynced===true?'Checkout matches GitHub':data.githubSynced===false?'Checkout differs from GitHub':'Checkout match unknown';
      holder.append(metric('Checkout revision',gitStatus,data.githubMainSha?'GitHub main '+data.githubMainSha.slice(0,12)+' · counts are a local snapshot':'GitHub SHA unavailable'));
      if(Array.isArray(data.areas)&&data.areas.length){
        const details=node('details','mission-area-details'),summary=node('summary','','Requirement area breakdown · '+data.areas.length+' areas');details.open=areaOpen;details.append(summary);
        for(const area of data.areas){
          const row=node('div','mission-area'),name=node('span','',area.name),progress=node('meter');
          progress.min=0;progress.max=area.total||1;progress.value=area.pass;
          progress.setAttribute('aria-label',area.name+' fully accepted requirements');
          row.append(name,progress,node('small','',area.pass+' / '+area.total+' PASS · '+area.partial+' partial'));details.append(row);
        }
        areaHolder.append(details);
        if(areaFocused)summary.focus({preventScroll:true});
      }
      $('mission-freshness').textContent='Observed '+(data.observedAt?new Date(data.observedAt).toLocaleTimeString():'recently');
      $('mission-warning').textContent=data.warning||'Acceptance means verified PASS in the canonical matrices, not merely an open or merged PR.';
    }catch{$('mission-metrics').replaceChildren();$('mission-areas').replaceChildren();$('mission-freshness').textContent='Status unavailable';$('mission-warning').textContent='Mission Control could not be contacted; no previous acceptance metrics are presented as current.';}
    finally{loadingMission=false;}
  }

  const babyNav=document.querySelector('aside nav a[href="http://127.0.0.1:4319/"]');
  if(babyNav){babyNav.href='/babytracker/';babyNav.classList.remove('local-only');}
  if(!isLocal)document.querySelectorAll('.local-only').forEach(n=>{n.hidden=true;});
  $('add-project-form').addEventListener('submit',registerProject);
  refreshProjects();refreshMission();setInterval(refreshProjects,15000);setInterval(refreshMission,5000);
})();
