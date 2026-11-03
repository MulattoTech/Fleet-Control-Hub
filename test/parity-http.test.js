'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {makeServer}=require('../src/server');
function request(server,path,{method='GET',host='127.0.0.1:48724',headers={}}={}){
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host,...headers}},res=>{
    let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);req.end();});
}
async function withServer(options,fn){const server=makeServer({port:48724,adapters:{status:()=>{throw Error('native access forbidden');}},services:{status:()=>{throw Error('service access forbidden');}},...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await fn(server);}finally{await new Promise(resolve=>server.close(resolve));}}
test('parity read inherits host/auth protection and exposes no write or fleet action',async()=>{
  const calls=[];
  await withServer({parity:{status:async options=>{calls.push(options);return {available:false,stale:true};}},remote:null},async server=>{
    assert.equal((await request(server,'/api/parity',{host:'evil.invalid'})).status,403);
    assert.equal((await request(server,'/api/parity',{method:'POST'})).status,405);assert.equal(calls.length,0);
    const result=await request(server,'/api/parity?refresh=1');assert.equal(result.status,200);assert.deepEqual(calls,[{refresh:true}]);
    assert.equal(result.headers['cache-control'],'no-store');assert.ok(result.headers['content-security-policy'].includes("default-src 'none'"));
    for(const asset of ['/parity.js','/parity.css'])assert.equal((await request(server,asset)).status,200);
  });
});
test('remote parity requests still require the owner Access verifier',async()=>{
  let reads=0;
  await withServer({parity:{status:async()=>{reads++;return {available:false};}},remote:{hostname:'fleet.fixture.invalid'},
    verifyRemote:async value=>{if(value!=='fixture-approved')throw Error('denied');}},async server=>{
    assert.equal((await request(server,'/api/parity',{host:'fleet.fixture.invalid'})).status,403);assert.equal(reads,0);
    assert.equal((await request(server,'/api/parity',{host:'fleet.fixture.invalid',headers:{'cf-access-jwt-assertion':'fixture-approved'}})).status,200);assert.equal(reads,1);
  });
});
