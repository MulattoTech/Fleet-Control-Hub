'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'../packages/mjobs-controller');
const health=require(path.join(root,'remote/public/analytics/source-status.js'));
const now=Date.parse('2026-11-05T20:00:00Z'),iso=value=>new Date(value).toISOString();
const observation={generatedAt:iso(now),source:{available:true},summary:{executing:7,outputTokens:123}};
const status={schemaVersion:1,checkedAt:iso(now),staleAfterSeconds:90,available:true,reasonCode:'OK',lastSuccessAt:iso(now)};

test('live requires a fresh matching successful collector receipt and observation',()=>{
 assert.equal(health.assess(observation,status,now).live,true);
 for(const value of [null,{}, {...status,available:'true'}, {...status,reasonCode:'UNKNOWN'}, {...status,reasonCode:{}}, {...status,lastSuccessAt:null}, {...status,available:false}]){
  assert.equal(health.assess(observation,value,now).live,false);
 }
 assert.equal(health.assess(observation,{...status,lastSuccessAt:iso(now-1000)},now).live,false);
 assert.equal(health.assess({...observation,source:{available:false}},status,now).live,false);
 assert.equal(health.assess(observation,status,now,true).live,false);
});

test('offline and changed-source checks never turn old counts into live data or zeros',()=>{
 const original=JSON.stringify(observation);
 const offline={...status,available:false,reasonCode:'NATIVE_ROSTER_OFFLINE',message:'<script>PRIVATE_PATH</script>'};
 const view=health.assess(observation,offline,now);
 assert.equal(view.live,false);assert.equal(view.label,'NATIVE SOURCE OFFLINE');
 assert.match(view.message,/historical/);assert.doesNotMatch(view.message,/script|PRIVATE_PATH/);
 assert.match(health.assess(observation,{...offline,reasonCode:'SOURCE_IDENTITY_CHANGED'},now).message,/identity changed/);
 assert.equal(JSON.stringify(observation),original);
 assert.equal(health.normalize({...offline,privateToken:'PRIVATE_TOKEN'}).privateToken,undefined);
});

test('stale and future source checks fail closed even with a fresh observation',()=>{
 for(const offset of [-90001,10001])assert.equal(health.assess(observation,{...status,checkedAt:iso(now+offset)},now).label,'COLLECTOR OFFLINE');
 for(const offset of [-90001,10001])assert.equal(health.assess({...observation,generatedAt:iso(now+offset)},{...status,lastSuccessAt:iso(now+offset)},now).live,false);
});

function pageFixture({missingData=false,missingStatus=false,oversizedStatus=false}={}){
 const nodes=new Map(),calls=[],classes=new Map(),timers=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',className:'',disabled:false,open:false,value:id==='stateFilter'?'all':'',addEventListener(){}});return nodes.get(id);};
 const liveAt=Date.now(),sample={...observation,schemaVersion:1,generatedAt:iso(liveAt),agents:[],models:[],tokenSeries:[],dispatch:{enabled:false},summary:{...observation.summary,agents:0,queued:0,reserved:0,completedTurns:0,states:{}}};
 const receipt={...status,checkedAt:iso(liveAt),lastSuccessAt:sample.generatedAt,available:false,reasonCode:'NATIVE_ROSTER_OFFLINE'};
 vm.runInNewContext(fs.readFileSync(path.join(root,'remote/public/analytics/atlas.js'),'utf8'),{
  document:{hidden:false,getElementById:node,querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle:(name,value)=>classes.set(name,value)}}},
  location:{hostname:'127.0.0.1'},FleetAnalyticsStatus:health,AbortSignal,Date,Intl,
  setInterval:(fn,ms)=>timers.push({fn,ms}),
  fetch:async(url,options)=>{calls.push({url,options});return url==='./analytics.json'?{ok:!missingData,json:async()=>sample}:{ok:!missingStatus,text:async()=>oversizedStatus?'x'.repeat(4097):JSON.stringify(receipt)};}
 });
 return {nodes,calls,classes,timers,sample};
}

test('Atlas polls health and observations read-only and shows offline reason without changing old metrics',async()=>{
 const f=pageFixture();await new Promise(setImmediate);
 assert.equal(f.nodes.get('connection').textContent,'NATIVE SOURCE OFFLINE');
 assert.match(f.nodes.get('notice').textContent,/saved roster is historical/);
 assert.equal(f.nodes.get('executing').textContent,'7');
 assert.match(f.nodes.get('stateChart').innerHTML,/font-weight="650">0<\/text>/);
 assert.doesNotMatch(f.nodes.get('stateChart').innerHTML,/right now/);
 assert.match(f.nodes.get('guard').textContent,/not verified/);
 assert.equal(f.classes.get('stale-surface'),true);
 assert.deepEqual(f.calls.map(x=>x.url),['./analytics.json','./collector-status.json']);
 assert.ok(f.calls.every(x=>!x.options.method&&x.options.cache==='no-store'));
 assert.ok(f.timers.some(x=>x.ms===30000));
});

test('Atlas still explains source failure when no observation exists and rejects oversized health',async()=>{
 const empty=pageFixture({missingData:true});await new Promise(setImmediate);
 assert.equal(empty.nodes.get('connection').textContent,'NATIVE SOURCE OFFLINE');
 for(const options of [{missingStatus:true},{oversizedStatus:true}]){
  const f=pageFixture(options);await new Promise(setImmediate);
  assert.equal(f.nodes.get('connection').textContent,'SOURCE UNAVAILABLE');
  assert.equal(f.classes.get('stale-surface'),true);
 }
});

test('Grafana source health uses a fixed GET-only status file and retains observation freshness cutoff',()=>{
 const config=fs.readFileSync(path.join(root,'observability/data-nginx.conf'),'utf8');
 assert.match(config,/location = \/collector-status\.json \{ limit_except GET \{ deny all; \}/);
 assert.match(config,/location \/ \{ return 404; \}/);
 const dashboard=JSON.parse(fs.readFileSync(path.join(root,'observability/dashboards/fleet-atlas.json'),'utf8'));
 const source=dashboard.panels.find(x=>x.title==='Source health · last check');
 assert.ok(source);assert.equal(source.gridPos.y,3);
 assert.equal(source.targets[0].url,'http://fleet-analytics-data:8080/collector-status.json');
 assert.equal(source.targets[0].url_options.method,'GET');
 assert.match(source.targets[0].root_selector,/COLLECTOR OFFLINE/);
 assert.match(source.targets[0].root_selector,/90000/);
 assert.match(source.targets[0].root_selector,/\$type\(available\) = 'boolean'/);
 assert.match(source.targets[0].root_selector,/reasonCode = 'OK'/);
 assert.match(source.targets[0].root_selector,/\$sampleAge >= -10000 and \$sampleAge <= 90000/);
 for(const panel of dashboard.panels.filter(x=>x.targets?.[0]?.url.endsWith('/analytics.json')&&x.title!=='Freshness receipt'))assert.match(panel.targets[0].root_selector,/90000/);
 const html=fs.readFileSync(path.join(root,'remote/public/analytics/index.html'),'utf8');
 assert.ok(html.indexOf('source-status.js')<html.indexOf('atlas.js'));
});
