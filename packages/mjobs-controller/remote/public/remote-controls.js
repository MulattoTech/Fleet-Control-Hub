(function(){
 'use strict';
 // Navigation only: this publisher remains read-only and never proxies commands.
 function start(doc){
  const panel=doc.getElementById('remote-controls');if(panel){
   const copy=doc.createElement('div'),heading=doc.createElement('h2');heading.textContent='Ready to work on a project?';
   const note=doc.createElement('p');note.className='control-note';note.textContent='Open the protected control dashboard, then press Start on your project. This activity monitor never launches agents.';
   copy.append(heading,note);
   const home=doc.createElement('a');home.href='https://fleet.m-techlabs.com';home.textContent='Open Fleet Control';home.className='fd-power';
   panel.replaceChildren(copy,home);
  }
  return {available:()=>false,refresh:()=>{},request:async()=>{throw Error('Remote commands are not enabled on this read-only monitor. Open the protected Fleet Control dashboard.');}};
 }
 if(typeof module==='object'&&module.exports)module.exports={start};else globalThis.FleetRemoteControls={start};
})();
