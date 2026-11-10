'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {createAdapters}=require('./adapters');
const {configuredRemote,createRemoteAuth}=require('./remote-auth');
const {createServiceLaunchpad}=require('./service-launchpad');
const {createParityTracker}=require('./parity');
const {createNativeFleetBridge}=require('./native-fleet-bridge');
const {createBabyTrackerBridge}=require('./babytracker-bridge');
const {createProjectRegistry}=require('./project-registry');
const {createMissionStatus}=require('./mission-status');
const {createGitHubDelivery}=require('./github-delivery');
const {createMJobsDevelopment,defaultHistoryFile}=require('./mjobs-development');
const root=path.join(__dirname,'..','public');

function makeServer({adapters=createAdapters(),services=createServiceLaunchpad(),parity=createParityTracker(),nativeFleetBridge=createNativeFleetBridge(),babyTrackerBridge=createBabyTrackerBridge(),registry=createProjectRegistry(),mission=createMissionStatus(),delivery=createGitHubDelivery(),development=createMJobsDevelopment({historyFile:null}),port=Number(process.env.FLEET_HUB_PORT||4320),remote=configuredRemote(),verifyRemote=remote?createRemoteAuth(remote):null}={}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const token=randomBytes(32).toString('hex');
  const serviceNonces=new Map();
  const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/parity.js':['parity.js','text/javascript; charset=utf-8'],'/parity.css':['parity.css','text/css; charset=utf-8'],'/workspace.js':['workspace.js','text/javascript; charset=utf-8']};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host=req.headers.host;
    const allowed=['127.0.0.1:'+port,'localhost:'+port];
    function json(code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
    const remoteRequest=!!remote&&host===remote.hostname;
    if((!allowed.includes(host)&&!remoteRequest)||(req.method!=='GET'&&req.headers['sec-fetch-site']==='cross-site'))return json(403,{error:'Origin unavailable'});
    if(remoteRequest){try{if(!verifyRemote)throw Error('Remote verification unavailable');await verifyRemote(req.headers['cf-access-jwt-assertion']);}catch{return json(403,{error:'Verified owner Access session required'});}}
    const url=new URL(req.url,'http://'+host);
    try {
      if(url.pathname==='/fleet'||url.pathname.startsWith('/fleet/'))
        return await nativeFleetBridge(req,res,{url,publicOrigin:remoteRequest?'https://'+remote.hostname:'http://'+host});
      if(url.pathname==='/babytracker'||url.pathname.startsWith('/babytracker/'))
        return await babyTrackerBridge(req,res,{url,publicOrigin:remoteRequest?'https://'+remote.hostname:'http://'+host});
      if(req.method==='GET') {
        if(url.pathname==='/api/session')return json(200,{token});
        if(url.pathname==='/api/status')return json(200,{observedAt:new Date().toISOString(),fleets:await Promise.all(['mjobs','babytracker'].map(adapters.status))});
        if(url.pathname==='/api/projects')return json(200,{projects:registry.list({includeLocalPaths:!remoteRequest}),observedAt:new Date().toISOString(),controllerRegistration:'explicit-adapter-required'});
        if(url.pathname==='/api/mission-status')return json(200,await mission.status());
        if(url.pathname==='/api/delivery')return json(200,await delivery.status());
        if(url.pathname==='/api/development')return json(200,await development.status());
        if(url.pathname==='/api/parity')return json(200,await parity.status({refresh:url.searchParams.get('refresh')==='1'}));
        if(url.pathname==='/api/services')return json(200,await services.status());
        if(url.pathname==='/api/services/nonce'){
          for(const [key,expires] of serviceNonces)if(expires<Date.now())serviceNonces.delete(key);
          if(serviceNonces.size>=64)return json(429,{error:'Too many pending actions'});
          const nonce=randomBytes(24).toString('hex');serviceNonces.set(nonce,Date.now()+60000);return json(200,{nonce});
        }
        if(url.pathname==='/api/start-preview'&&['mjobs','babytracker'].includes(url.searchParams.get('id')))return json(200,await adapters.startPreview(url.searchParams.get('id')));
          if(url.pathname==='/api/bounded-start-preview'&&url.searchParams.get('id')==='mjobs')return json(200,await adapters.boundedStartPreview('mjobs'));
        if(url.pathname==='/api/limits'&&['mjobs','babytracker'].includes(url.searchParams.get('id')))return json(200,await adapters.limits(url.searchParams.get('id')));
        if(url.pathname==='/api/review-candidates'&&['mjobs','babytracker'].includes(url.searchParams.get('id')))return json(200,await adapters.reviewCandidates(url.searchParams.get('id'),Number(url.searchParams.get('offset')||0)));
        const file=files[url.pathname];if(!file)return json(404,{error:'Not found'});
        res.writeHead(200,{'Content-Type':file[1]});return res.end(fs.readFileSync(path.join(root,file[0])));
      }
        if(req.method!=='POST'||!['/api/pause','/api/control','/api/start','/api/bounded-start','/api/limits','/api/review-assessment','/api/services/action','/api/projects'].includes(url.pathname))return json(405,{error:'Method not allowed'});
      if(![...allowed.map(x=>'http://'+x),...(remoteRequest?['https://'+remote.hostname]:[])].includes(req.headers.origin))return json(403,{error:'Same origin required'});
      const candidate=String(req.headers['x-fleet-hub']||'');
      if(candidate.length!==token.length||!timingSafeEqual(Buffer.from(candidate),Buffer.from(token)))return json(403,{error:'Invalid action token'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(415,{error:'JSON required'});
      const maxBytes=url.pathname==='/api/projects'?8192:1024;
      let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>maxBytes)return json(413,{error:'Request too large'});parts.push(part);}
      const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(url.pathname==='/api/projects'){
        try{return json(201,{registered:registry.add(input),controllerInstalled:false});}
        catch(e){return json(400,{error:String(e.message).slice(0,200)});}
      }
      if(url.pathname==='/api/services/action'){
        if(!input||!['plex-start','rustdesk-restart','tailscale-restart','docker-start','docker-restart','monai-start'].includes(input.action)||input.confirmation!=='RUN '+input.action||typeof input.nonce!=='string'||Object.keys(input).some(k=>!['action','confirmation','nonce'].includes(k)))return json(400,{error:'Invalid service action'});
        const expiry=serviceNonces.get(input.nonce);if(!expiry||expiry<Date.now())return json(409,{error:'Action nonce expired or already used'});
        serviceNonces.delete(input.nonce);
        return json(202,await services.act(input.action));
      }
      if(url.pathname==='/api/start'){
        if(!input||!['mjobs','babytracker'].includes(input.id)||typeof input.confirmation!=='string'||Object.keys(input).some(k=>!['id','confirmation','requestId','manifestRevision'].includes(k)))return json(400,{error:'Invalid start request'});
        return json(202,await adapters.start(input.id,input.confirmation,input.requestId,input.manifestRevision));
      }
        if(url.pathname==='/api/bounded-start'){
          if(!input||input.id!=='mjobs'||typeof input.confirmation!=='string'||Object.keys(input).some(k=>!['id','confirmation','requestId','manifestRevision','primaryId'].includes(k)))return json(400,{error:'Invalid one-session start request'});
          return json(202,await adapters.boundedStart(input.id,input.confirmation,input.requestId,input.manifestRevision,input.primaryId));
        }
      if(url.pathname==='/api/limits'){
        if(!input||!['mjobs','babytracker'].includes(input.id)||typeof input.profile!=='string'||typeof input.confirmation!=='string'||Object.keys(input).some(k=>!['id','profile','values','expected','confirmation'].includes(k)))return json(400,{error:'Invalid limits request'});
        return json(200,await adapters.saveLimits(input.id,input.profile,input.values,input.expected,input.confirmation));
      }
      if(url.pathname==='/api/review-assessment'){
        if(remoteRequest)return json(403,{error:'Review assessment requires local evidence access'});
        if(!input||!['mjobs','babytracker'].includes(input.id)||typeof input.candidateId!=='string'||!['accepted','revision_requested','rejected'].includes(input.decision)||typeof input.confirmation!=='string'||input.evidenceReviewed!==true||Object.keys(input).some(k=>!['id','candidateId','decision','confirmation','evidenceReviewed','prNumber','reviewId'].includes(k)))return json(400,{error:'Invalid review assessment request'});
        return json(200,await adapters.assessReview(input.id,input.candidateId,input.decision,input.confirmation,input.evidenceReviewed,input.prNumber,input.reviewId));
      }
      const action=url.pathname==='/api/pause'?'pause':input?.action;
      if(!input||!['mjobs','babytracker'].includes(input.id)||!['pause','graceful-stop'].includes(action)||Object.keys(input).some(k=>!['id','action'].includes(k)))return json(400,{error:'Choose one known fleet and control action'});
      return json(200,await adapters.control(input.id,action));
    }catch(e){return json(502,{error:String(e.message).slice(0,200),definitive:e.definitive===true});}
  });
  return server;
}
if(require.main===module){const server=makeServer({development:createMJobsDevelopment({historyFile:defaultHistoryFile()})});server.listen(Number(process.env.FLEET_HUB_PORT||4320),'127.0.0.1',()=>process.stdout.write('Fleet hub on http://127.0.0.1:'+server.address().port+'\n'));}
module.exports={makeServer};
