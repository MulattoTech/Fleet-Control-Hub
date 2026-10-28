'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {createAdapters}=require('./adapters');
const root=path.join(__dirname,'..','public');

function makeServer({adapters=createAdapters(),port=Number(process.env.FLEET_HUB_PORT||4320)}={}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const token=randomBytes(32).toString('hex');
  const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host=req.headers.host;
    const allowed=['127.0.0.1:'+port,'localhost:'+port];
    function json(code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
    if(!allowed.includes(host)||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'Local origin required'});
    const url=new URL(req.url,'http://'+host);
    try {
      if(req.method==='GET') {
        if(url.pathname==='/api/session')return json(200,{token});
        if(url.pathname==='/api/status')return json(200,{observedAt:new Date().toISOString(),fleets:await Promise.all(['mjobs','babytracker'].map(adapters.status))});
        const file=files[url.pathname];if(!file)return json(404,{error:'Not found'});
        res.writeHead(200,{'Content-Type':file[1]});return res.end(fs.readFileSync(path.join(root,file[0])));
      }
      if(req.method!=='POST'||url.pathname!=='/api/pause')return json(405,{error:'Method not allowed'});
      if(!allowed.map(x=>'http://'+x).includes(req.headers.origin))return json(403,{error:'Same origin required'});
      const candidate=String(req.headers['x-fleet-hub']||'');
      if(candidate.length!==token.length||!timingSafeEqual(Buffer.from(candidate),Buffer.from(token)))return json(403,{error:'Invalid action token'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(415,{error:'JSON required'});
      let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>1024)return json(413,{error:'Request too large'});parts.push(part);}
      const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(!input||!['mjobs','babytracker'].includes(input.id)||Object.keys(input).length!==1)return json(400,{error:'Choose one known fleet'});
      return json(200,await adapters.pause(input.id));
    }catch(e){return json(502,{error:String(e.message).slice(0,200)});}
  });
  return server;
}
if(require.main===module){const server=makeServer();server.listen(Number(process.env.FLEET_HUB_PORT||4320),'127.0.0.1',()=>process.stdout.write('Fleet hub on http://127.0.0.1:'+server.address().port+'\n'));}
module.exports={makeServer};
