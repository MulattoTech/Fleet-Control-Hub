'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {createAdapters}=require('./adapters');
const {configuredRemote,createRemoteAuth}=require('./remote-auth');
const root=path.join(__dirname,'..','public');

function makeServer({adapters=createAdapters(),port=Number(process.env.FLEET_HUB_PORT||4320),remote=configuredRemote(),verifyRemote=remote?createRemoteAuth(remote):null}={}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const token=randomBytes(32).toString('hex');
  const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
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
      if(req.method==='GET') {
        if(url.pathname==='/api/session')return json(200,{token});
        if(url.pathname==='/api/status')return json(200,{observedAt:new Date().toISOString(),fleets:await Promise.all(['mjobs','babytracker'].map(adapters.status))});
        if(url.pathname==='/api/start-preview'&&['mjobs','babytracker'].includes(url.searchParams.get('id')))return json(200,await adapters.startPreview(url.searchParams.get('id')));
        if(url.pathname==='/api/review-candidates'&&['mjobs','babytracker'].includes(url.searchParams.get('id')))return json(200,await adapters.reviewCandidates(url.searchParams.get('id'),Number(url.searchParams.get('offset')||0)));
        const file=files[url.pathname];if(!file)return json(404,{error:'Not found'});
        res.writeHead(200,{'Content-Type':file[1]});return res.end(fs.readFileSync(path.join(root,file[0])));
      }
      if(req.method!=='POST'||!['/api/pause','/api/control','/api/start','/api/review-assessment'].includes(url.pathname))return json(405,{error:'Method not allowed'});
      if(![...allowed.map(x=>'http://'+x),...(remoteRequest?['https://'+remote.hostname]:[])].includes(req.headers.origin))return json(403,{error:'Same origin required'});
      const candidate=String(req.headers['x-fleet-hub']||'');
      if(candidate.length!==token.length||!timingSafeEqual(Buffer.from(candidate),Buffer.from(token)))return json(403,{error:'Invalid action token'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(415,{error:'JSON required'});
      let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>1024)return json(413,{error:'Request too large'});parts.push(part);}
      const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(url.pathname==='/api/start'){
        if(!input||!['mjobs','babytracker'].includes(input.id)||typeof input.confirmation!=='string'||Object.keys(input).some(k=>!['id','confirmation','requestId','manifestRevision'].includes(k)))return json(400,{error:'Invalid start request'});
        return json(202,await adapters.start(input.id,input.confirmation,input.requestId,input.manifestRevision));
      }
      if(url.pathname==='/api/review-assessment'){
        if(remoteRequest)return json(403,{error:'Review assessment requires local evidence access'});
        if(!input||!['mjobs','babytracker'].includes(input.id)||typeof input.candidateId!=='string'||!['accepted','revision_requested','rejected'].includes(input.decision)||typeof input.confirmation!=='string'||input.evidenceReviewed!==true||Object.keys(input).some(k=>!['id','candidateId','decision','confirmation','evidenceReviewed','prNumber','reviewId'].includes(k)))return json(400,{error:'Invalid review assessment request'});
        return json(200,await adapters.assessReview(input.id,input.candidateId,input.decision,input.confirmation,input.evidenceReviewed,input.prNumber,input.reviewId));
      }
      const action=url.pathname==='/api/pause'?'pause':input?.action;
      if(!input||!['mjobs','babytracker'].includes(input.id)||!['pause','graceful-stop'].includes(action)||Object.keys(input).some(k=>!['id','action'].includes(k)))return json(400,{error:'Choose one known fleet and control action'});
      return json(200,await adapters.control(input.id,action));
    }catch(e){return json(502,{error:String(e.message).slice(0,200)});}
  });
  return server;
}
if(require.main===module){const server=makeServer();server.listen(Number(process.env.FLEET_HUB_PORT||4320),'127.0.0.1',()=>process.stdout.write('Fleet hub on http://127.0.0.1:'+server.address().port+'\n'));}
module.exports={makeServer};
