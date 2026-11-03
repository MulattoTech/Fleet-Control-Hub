'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function sample(){return {available:true,stale:false,syncedAt:'2026-11-03T06:00:00Z',sourceSha:'a'.repeat(40),catalogAsOf:'2026-11-03T05:00:00Z',
  epicUrl:'https://github.com/MulattoTech/MJobs/issues/904',coverage:{routes:{exercised:0,identified:3},journeys:{exercised:0,identified:1}},harStatus:'BLOCKED',
  discoveryCounts:{OBSERVED:0,'PUBLICLY CLAIMED':1},blockers:['FULL_HAR_TOOL_UNAVAILABLE'],workstreams:[],
  features:[{id:'MJ-TH-001',title:'<img src=x onerror=alert(1)>',priority:'P1',discovery:'PUBLICLY CLAIMED',implementation:'PARTIAL',dependencies:[],
    issues:[{number:26,state:'closed',url:'https://github.com/MulattoTech/MJobs/issues/26'}],pulls:[],claims:[]}]};}
function fixture(){
  const nodes=[],calls=[],timers=[];let failure=false,pending=false,release;
  function node(tag){const item={tag,children:[],attrs:{},handlers:{},textContent:'',disabled:false,
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(name,value){this.attrs[name]=value;},addEventListener(name,fn){this.handlers[name]=fn;}};
    Object.defineProperty(item,'innerHTML',{set(){throw Error('HTML injection forbidden');}});nodes.push(item);return item;}
  const root=node('section');
  const context={document:{getElementById:id=>id==='parity'?root:null,createElement:node},AbortController,setTimeout,clearTimeout,
    setInterval:fn=>timers.push(fn),fetch:async(url,options)=>{calls.push({url,options});if(pending)await new Promise(resolve=>{release=resolve;});if(failure)throw Error('offline');return {ok:true,json:async()=>sample()};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/parity.js'),'utf8'),context);
  const text=()=>nodes.map(n=>n.textContent).join('\n');
  return {nodes,root,calls,timers,text,fail:v=>{failure=v;},hold:v=>{pending=v;},release:()=>release(),button:()=>nodes.find(n=>n.tag==='button')};
}
test('roadmap renders qualified coverage, keyboard table and unverified delivery through text nodes',async()=>{
  const f=fixture();await new Promise(setImmediate);
  assert.equal(f.calls[0].url,'/api/parity');assert.ok(f.text().includes('0/3 routes exercised'));
  assert.ok(f.text().includes('0 observed'));assert.ok(f.text().includes('Merge, deployment and parity acceptance not verified'));
  assert.ok(f.text().includes('<img src=x onerror=alert(1)>'));assert.equal(f.nodes.some(n=>n.tag==='img'),false);
  assert.ok(f.nodes.some(n=>n.attrs['aria-label']==='Scrollable capability table'&&n.tabIndex===0));
  assert.ok(f.nodes.some(n=>n.tag==='caption'));assert.ok(f.nodes.filter(n=>n.tag==='th').every(n=>n.scope==='col'));
  assert.equal(f.root.attrs['aria-busy'],'false');assert.equal(f.button().disabled,false);
});
test('manual refresh coalesces duplicate clicks and never sends a fleet action',async()=>{
  const f=fixture();await new Promise(setImmediate);f.hold(true);
  const first=f.button().handlers.click();await f.button().handlers.click();await new Promise(setImmediate);
  assert.equal(f.calls.filter(x=>x.url==='/api/parity?refresh=1').length,1);f.hold(false);f.release();await first;
  assert.ok(f.calls.every(x=>!x.options.method||x.options.method==='GET'));assert.equal(f.button().disabled,false);
});
test('failed refresh labels retained evidence stale and restores the refresh control',async()=>{
  const f=fixture();await new Promise(setImmediate);f.fail(true);await f.button().handlers.click();
  assert.ok(f.text().includes('Any displayed evidence is stale'));assert.equal(f.button().disabled,false);assert.equal(f.root.attrs['aria-busy'],'false');
});
