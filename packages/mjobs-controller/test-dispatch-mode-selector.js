'use strict';
// Execute the shipped selector against inert DOM/HTTP fixtures; never contact agents.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const target=process.argv[2]||(fs.existsSync(path.join(__dirname,'public/turbo-ui.js'))?path.join(__dirname,'public/turbo-ui.js'):path.join(__dirname,'fleet-mode-selector.js'));
const full=fs.readFileSync(target,'utf8'),marker='// Unified automatic dispatch mode.';
assert(full.includes(marker),'Shipped selector is missing');
const source=full.slice(full.indexOf(marker));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(initial='steady'){
 const nodes=new Map(),requests=[],timers=[],toasts=[];let mode=initial,failWrite=false,failRead=false,deferRead=false,pendingRead=null,delayWrite=false,finishWrite=null,uncertainWrite=false;
 const el=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:'',attrs:{},events:{},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.events[k]=v;}});return nodes.get(id);};
 const health=()=>({turboEnabled:mode==='turbo',sustainedEnabled:mode==='steady',dispatchBlockedReason:null});
 const context=vm.createContext({document:{getElementById:el,hidden:false},window:{},toast:(m,e)=>toasts.push({m,e}),setInterval:fn=>timers.push(fn),api:async(route,body)=>{
  requests.push({route,body});
  if(route==='/api/health'){
   if(failRead)throw Error('Disconnected');
   const state=health();if(deferRead){deferRead=false;return new Promise(resolve=>{pendingRead=()=>resolve(state);});}return state;
  }
  if(failWrite)throw Error('Fresh quota guard required');
  if(delayWrite){delayWrite=false;await new Promise(resolve=>{finishWrite=resolve;});}
  if(route==='/api/master/pause')mode='paused';else if(route==='/api/turbo/toggle')mode='turbo';else if(route==='/api/sustain/toggle')mode='steady';else throw Error('Unexpected write');
  if(uncertainWrite)throw Error('Timed out after delivery');
  return {ok:true};
 }});
 vm.runInContext(source,context);
 return {el,requests,timers,toasts,context,get mode(){return mode;},setMode:v=>{mode=v;},failWrite:v=>{failWrite=v;},failRead:v=>{failRead=v;},uncertainWrite:v=>{uncertainWrite=v;},deferRead:()=>{deferRead=true;},resolveRead:()=>{assert(pendingRead);pendingRead();},delayWrite:()=>{delayWrite=true;},finishWrite:()=>{assert(finishWrite);finishWrite();},refresh:()=>context.window.FleetDispatchModeUI.refresh(),click:async mode=>{const node=el('dispatchMode'+mode);assert.equal(node.disabled,false,'Button must be available: '+mode);return node.events.click();}};
}
test('Steady -> Turbo -> Steady -> Paused -> Turbo uses one selector and one write per change',async()=>{
 const f=fixture();await flush();assert.equal(f.el('dispatchModeSteady').attrs['aria-pressed'],'true');
 for(const mode of ['Turbo','Steady','Paused','Turbo']){await f.click(mode);assert.equal(f.el('dispatchMode'+mode).attrs['aria-pressed'],'true');assert.equal(f.el('dispatchModeTurbo').disabled,false);}
 assert.deepEqual(f.requests.filter(r=>r.body).map(r=>r.route),['/api/turbo/toggle','/api/sustain/toggle','/api/master/pause','/api/turbo/toggle']);
 assert.equal(f.mode,'turbo');
});
test('a blocked switch reconciles the current mode and releases every control',async()=>{
 const f=fixture();await flush();f.failWrite(true);await f.click('Turbo');
 assert.equal(f.mode,'steady');assert.equal(f.el('dispatchModeSteady').attrs['aria-pressed'],'true');assert.equal(f.el('dispatchModeTurbo').disabled,false);assert.match(f.el('dispatchModeNotice').textContent,/Fresh quota guard/);
 f.failWrite(false);await f.click('Turbo');assert.equal(f.mode,'turbo');
});
test('a stale pre-switch poll cannot overwrite the verified new mode',async()=>{
 const f=fixture();await flush();f.deferRead();const pending=f.refresh();await flush();await f.click('Turbo');f.resolveRead();await pending;
 assert.equal(f.el('dispatchModeTurbo').attrs['aria-pressed'],'true');assert.equal(f.el('dispatchModeBadge').textContent,'TURBO');
});
test('rapid repeat selection cannot send a second write while the switch is pending',async()=>{
 const f=fixture();await flush();f.delayWrite();const pending=f.click('Turbo');await flush();
 assert.equal(f.el('dispatchModeSteady').disabled,true);await f.context.window.FleetDispatchModeUI.select('steady');assert.equal(f.requests.filter(r=>r.body).length,1);
 f.finishWrite();await pending;assert.equal(f.mode,'turbo');assert.equal(f.el('dispatchModeSteady').disabled,false);
});
test('an uncertain write is read back, never blindly repeated',async()=>{
 const f=fixture();await flush();f.uncertainWrite(true);await f.click('Turbo');
 assert.equal(f.mode,'turbo');assert.equal(f.el('dispatchModeTurbo').attrs['aria-pressed'],'true');assert.equal(f.requests.filter(r=>r.body).length,1);assert.match(f.el('dispatchModeNotice').textContent,/Timed out/);
});
test('offline status blocks new-work selections but allows pause and recovers on refresh',async()=>{
 const f=fixture();await flush();f.failRead(true);await f.refresh();assert.equal(f.el('dispatchModeTurbo').disabled,true);assert.equal(f.el('dispatchModePaused').disabled,false);
 f.failRead(false);await f.refresh();assert.equal(f.el('dispatchModeTurbo').disabled,false);assert.equal(f.el('dispatchModeSteady').attrs['aria-pressed'],'true');
});
test('external controller mode changes appear on the next authoritative poll',async()=>{
 const f=fixture('turbo');await flush();f.setMode('paused');await f.refresh();assert.equal(f.el('dispatchModePaused').attrs['aria-pressed'],'true');assert.equal(f.requests.filter(r=>r.body).length,0);
});
