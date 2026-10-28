'use strict';
function configuredRemote(env=process.env){
  const hostname=env.FLEET_HUB_REMOTE_HOST;
  if(!hostname)return null;
  if(!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(hostname)||hostname==='localhost')throw Error('Invalid remote hostname');
  const issuer=env.CF_ACCESS_TEAM_DOMAIN;
  const audience=env.CF_ACCESS_AUD;
  const ownerEmail=env.CF_ACCESS_OWNER_EMAIL;
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(issuer||'')||!/^[a-f0-9]{64}$/i.test(audience||'')||!/^\S+@\S+\.\S+$/.test(ownerEmail||''))throw Error('Remote Access configuration is incomplete');
  return {hostname:hostname.toLowerCase(),issuer,audience,ownerEmail:ownerEmail.toLowerCase()};
}
function createRemoteAuth(config=configuredRemote()){
  if(!config)return null;
  let keysPromise;
  return async function verify(token){
    if(typeof token!=='string'||token.length>10000||token.split('.').length!==3)throw Error('Cloudflare Access token required');
    const {createRemoteJWKSet,jwtVerify}=await import('jose');
    if(!keysPromise)keysPromise=Promise.resolve(createRemoteJWKSet(new URL(config.issuer+'/cdn-cgi/access/certs')));
    const keys=await keysPromise;
    const {payload}=await jwtVerify(token,keys,{issuer:config.issuer,audience:config.audience,algorithms:['RS256']});
    if(payload.type!=='app'||String(payload.email||'').toLowerCase()!==config.ownerEmail)throw Error('Owner Access token required');
    return true;
  };
}
module.exports={configuredRemote,createRemoteAuth};
