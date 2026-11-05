'use strict';
// Owner-authenticated Hub path to the same native BabyTracker controller.
// No new controller, credentials, workspace access or background dispatch.
const ORIGIN='http://127.0.0.1:4319';
const ASSETS=new Set(['','app.js','projects','projects.js','mjobs-style.css','babytracker.css','fleet-theme.css']);
const READS=new Set(['api/health','api/session','api/state','api/providers','api/projects']);
const WRITES=new Set(['api/action']);
// api/action multiplexes native operations: a route allowlist alone would
// expose every future action, including the Hub's local-evidence-only review.
const REMOTE_ACTIONS=new Set([
  'reconcile-bootstrap','simpleStart','start','pause','drain','emergency','release',
  'nudge','find-work','add-agent','reconcile-agent','all-hands','turbo','limits',
  'quota-policy','concurrency-policy','task','assign','model-change','model-cancel',
  'model-reconcile','model-resume','restart'
]);

function createBabyTrackerBridge({fetcher=fetch}={}){
  let inFlight=0;
  function send(res,code,value){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
  return async function bridge(req,res,{url,publicOrigin}){
    if(url.pathname==='/babytracker'){res.writeHead(307,{Location:'/babytracker/'});return res.end();}
    if(!url.pathname.startsWith('/babytracker/'))return send(res,404,{error:'Unknown BabyTracker route'});
    const tail=url.pathname.slice('/babytracker/'.length);
    if(url.search||tail.length>100||!/^[A-Za-z0-9_./-]*$/.test(tail)||tail.split('/').includes('..'))
      return send(res,404,{error:'Unknown BabyTracker route'});
    const writing=req.method==='POST';
    if(!(writing?WRITES.has(tail):req.method==='GET'&&(ASSETS.has(tail)||READS.has(tail))))
      return send(res,404,{error:'Unknown BabyTracker route'});
    if(inFlight>=24)return send(res,429,{error:'BabyTracker controller is busy'});
    if(writing){
      const type=String(req.headers['content-type']||'').split(';')[0].toLowerCase();
      if(req.headers.origin!==publicOrigin||req.headers['sec-fetch-site']==='cross-site'||
         !/^[a-f0-9]{64}$/.test(String(req.headers['x-babytracker-fleet']||'')))
        return send(res,403,{error:'Same-origin BabyTracker action and native token required'});
      if(type!=='application/json')return send(res,415,{error:'JSON action required'});
      if(Number(req.headers['content-length'])>20000)return send(res,413,{error:'Action too large'});
    }
    let body;
    if(writing){
      let size=0;const parts=[];
      for await(const chunk of req){size+=chunk.length;if(size>20000)return send(res,413,{error:'Action too large'});parts.push(chunk);}
      body=Buffer.concat(parts);
      const remote=!['127.0.0.1','localhost'].includes(new URL(publicOrigin).hostname);
      if(remote){
        let input;
        try{input=JSON.parse(body.toString('utf8'));}catch{return send(res,400,{error:'Action object required'});}
        if(!input||Array.isArray(input)||typeof input!=='object')return send(res,400,{error:'Action object required'});
        if(input.action==='assess-task')return send(res,403,{error:'Review assessment requires local evidence access'});
        if(!REMOTE_ACTIONS.has(input.action))return send(res,403,{error:'BabyTracker action is not enabled for remote access'});
      }
    }
    inFlight++;
    try{
      const headers={Host:'127.0.0.1:4319'};
      if(writing)Object.assign(headers,{'Content-Type':'application/json','Origin':ORIGIN,
        'X-BabyTracker-Fleet':req.headers['x-babytracker-fleet']});
      const upstream=await fetcher(ORIGIN+'/'+tail,{method:req.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(writing?70000:10000)});
      if(upstream.status>=300&&upstream.status<400)return send(res,502,{error:'Unexpected native redirect refused'});
      const bytes=Buffer.from(await upstream.arrayBuffer());
      if(bytes.length>2*1024*1024)return send(res,502,{error:'Native response too large'});
      const type=upstream.headers.get('content-type')||'application/octet-stream';
      if(!/^(text\/(html|css|plain|javascript)|application\/(json|javascript))(;|$)/i.test(type))
        return send(res,502,{error:'Native response type refused'});
      const csp=upstream.headers.get('content-security-policy');
      if(csp)res.setHeader('Content-Security-Policy',csp);
      res.writeHead(upstream.status,{'Content-Type':type,'Cache-Control':'no-store'});
      return res.end(bytes);
    }catch{return send(res,503,{error:writing?'Native action result is unknown; inspect BabyTracker locally before retrying.':'Native BabyTracker is unavailable.'});}
    finally{inFlight--;}
  };
}
module.exports={createBabyTrackerBridge,ASSETS,READS,WRITES,REMOTE_ACTIONS,ORIGIN};
