'use strict';
const http=require('node:http');
const host='127.0.0.1', port=18726;
const destination='http://127.0.0.1:18729';
const server=http.createServer((req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){
    res.writeHead(405,{'Allow':'GET, HEAD','Cache-Control':'no-store'});return res.end();
  }
  let path='/';
  try{
    const raw=req.url||'/';
    if(!raw.startsWith('/')||raw.startsWith('//')||raw.includes('\\')||/[%][0-9a-f]{2}/i.test(raw.slice(0,2)))throw Error('Unsupported path');
    const parsed=new URL(raw,destination);
    if(parsed.origin!==destination)throw Error('Other origin');
    path=parsed.pathname+parsed.search;
  }catch{res.writeHead(400,{'Cache-Control':'no-store'});return res.end('Invalid path');}
  res.writeHead(307,{'Location':destination+path,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end();
});
server.on('error',e=>{console.error('Mission port compatibility failed:',e.code);process.exitCode=1;});
server.listen(port,host,()=>console.log('Legacy Mission Control localhost port '+port+' forwards to '+destination));
