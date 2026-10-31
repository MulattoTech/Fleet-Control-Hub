'use strict';
// Deterministic, source-only synchronization. No installed runtime is touched.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),base=path.join(root,'packages/fleet-ui');
const read=p=>fs.readFileSync(path.join(base,p),'utf8');
const marker='/* BEGIN GENERATED FLEET UI */',end='/* END GENERATED FLEET UI */';
function generated(value){return marker+'\n'+value.trim()+'\n'+end+'\n';}
const check=process.argv.includes('--check');let bad=false;
function write(name,data){const p=path.join(root,name),current=fs.readFileSync(p,'utf8');if(current===data)return;if(check){console.error('Stale Fleet UI asset: '+name);bad=true;}else fs.writeFileSync(p,data);}
const power=generated(read('power-state.js'));
for(const name of ['public/app.js','packages/mjobs-controller/public/run-ui.js']){
 const p=path.join(root,name);let body=fs.readFileSync(p,'utf8');if(body.startsWith(marker)){const i=body.indexOf(end);if(i<0)throw Error('Invalid generated prefix');body=body.slice(i+end.length).replace(/^\s*\n/,'');}
 write(name,power+body);
}
write('public/style.css',generated(read('tokens.css')+'\n'+read('hub.css')));
write('packages/mjobs-controller/remote/public/style.css',generated(read('tokens.css')+'\n'+read('monitor.css')));
const name='packages/mjobs-controller/public/master.css',p=path.join(root,name);let body=fs.readFileSync(p,'utf8');const i=body.indexOf(marker);if(i>=0)body=body.slice(0,i);write(name,body.trimEnd()+'\n\n'+generated(read('tokens.css')+'\n'+read('native.css')));
if(bad)process.exitCode=1;else console.log('Fleet UI source assets '+(check?'verified':'synchronized'));
