'use strict';

// The full MJobs Fleet UI already runs at the local Mission Control service.
// Relay that exact guarded surface; never copy controller code, state or secrets.
const NATIVE_ORIGIN = 'http://127.0.0.1:18729';
const ASSETS = new Set([
  '', 'index.html', 'app.js', 'run-ui.js', 'startup-ui.js', 'startup.css',
  'style.css', 'turbo.css', 'turbo-ui.js', 'sustain-ui.js',
  'master-ui.js', 'master.css', 'restore-ui.js', 'restore.css',
  'quota-ui.js', 'quota.css', 'find-work-ui.js', 'find-work.css'
]);
const READS = new Set([
  'api/health', 'api/state', 'api/environment', 'api/quota', 'api/master',
  'api/preflight', 'api/providers', 'api/gemini-usage', 'api/agent-plan',
  'api/turbo', 'api/turbo/preview', 'api/turbo/all-hands/preview',
  'api/sustain', 'api/sustain/preview', 'api/find-work/preview',
  'api/find-work/status', 'api/master/restore/preview', 'api/startup',
  'api/run'
]);
const WRITES = new Set([
  'api/nudge', 'api/replace', 'api/retire', 'api/agent-plan',
  'api/agent-plan/apply', 'api/find-work', 'api/find-work/all',
  'api/quota/config', 'api/quota/arm', 'api/quota/disarm',
  'api/master/pause', 'api/master/drain', 'api/master/cancel-drain',
  'api/master/restore', 'api/master/restore/pause', 'api/master/emergency',
  'api/master/rearm', 'api/sustain/toggle', 'api/sustain/config',
  'api/sustain/tick', 'api/turbo/toggle', 'api/turbo/config',
  'api/turbo/run', 'api/turbo/all-hands', 'api/startup', 'api/startup/cancel',
  'api/startup/reconcile', 'api/orchestrator/open', 'api/run/start'
]);

function createNativeFleetBridge({fetcher=fetch}={}) {
  let inFlight=0;
  function send(res,code,data) {
    res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(data));
  }
  return async function nativeFleetBridge(req,res,{url,publicOrigin}) {
    if(url.pathname==='/fleet') {
      res.writeHead(307,{Location:'/fleet/'});
      return res.end();
    }
    if(!url.pathname.startsWith('/fleet/'))return send(res,404,{error:'Unknown native fleet path'});
    const tail=url.pathname.slice('/fleet/'.length);
    // No query parameters, encoded separators, path traversal, or arbitrary targets.
    if(url.search||tail.length>100||!(/^[A-Za-z0-9_./-]*$/).test(tail)||tail.split('/').includes('..'))
      return send(res,404,{error:'Unknown native fleet path'});
    const method=req.method,allow=method==='GET'?(ASSETS.has(tail)||READS.has(tail)):method==='POST'&&WRITES.has(tail);
    if(!allow)return send(res,404,{error:'Unknown native fleet route'});
    if(inFlight>=32)return send(res,429,{error:'Native fleet is busy; retry the read later'});
    const writing=method==='POST';
    if(writing) {
      const type=String(req.headers['content-type']||'').split(';')[0].toLowerCase();
      if(req.headers.origin!==publicOrigin||req.headers['sec-fetch-site']==='cross-site'||req.headers['x-ao-fleet']!=='1')
        return send(res,403,{error:'Same-origin native fleet action required'});
      if(type!=='application/json')return send(res,415,{error:'JSON action required'});
      if(Number(req.headers['content-length'])>65536)return send(res,413,{error:'Native fleet action is too large'});
    }
    let body;
    if(writing) {
      const chunks=[];let size=0;
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>65536)return send(res,413,{error:'Native fleet action is too large'});
        chunks.push(chunk);
      }
      body=Buffer.concat(chunks);
    }
    inFlight++;
    try {
      const headers={Host:'127.0.0.1:18729'};
      if(writing)Object.assign(headers,{'Content-Type':'application/json','X-AO-Fleet':'1',Origin:NATIVE_ORIGIN});
      const upstream=await fetcher(NATIVE_ORIGIN+'/fleet/'+tail,{
        method,headers,body,redirect:'manual',signal:AbortSignal.timeout(writing?95000:10000)
      });
      if(upstream.status>=300&&upstream.status<400)
        return send(res,502,{error:'Unexpected native redirect refused'});
      const bytes=Buffer.from(await upstream.arrayBuffer());
      if(bytes.length>2*1024*1024)return send(res,502,{error:'Native response exceeds safe size'});
      const type=upstream.headers.get('content-type')||'application/octet-stream';
      if(!/^(text\/html|text\/css|text\/plain|application\/(json|javascript)|text\/javascript)(;|$)/i.test(type))
        return send(res,502,{error:'Native response type refused'});
      const csp=upstream.headers.get('content-security-policy');
      if(csp)res.setHeader('Content-Security-Policy',csp);
      res.writeHead(upstream.status,{'Content-Type':type,'Cache-Control':'no-store'});
      return res.end(bytes);
    }catch {
      return send(res,503,{error:writing?'Native action outcome is unknown; inspect the local controller before retrying.':'Native MJobs Fleet is temporarily unavailable.'});
    }finally{inFlight--;}
  };
}
module.exports={createNativeFleetBridge,ASSETS,READS,WRITES,NATIVE_ORIGIN};
