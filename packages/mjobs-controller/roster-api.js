'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
class RosterApi {
 constructor({root,roster,busy=()=>false}){
  Object.assign(this,{roster,busy});this.tokenFile=path.join(root,'.roster-token');
  try{fs.writeFileSync(this.tokenFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=fs.lstatSync(this.tokenFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==64)throw Error('Roster authorization token unavailable');
  this.token=fs.readFileSync(this.tokenFile,'utf8');
  if(!/^[a-f0-9]{64}$/.test(this.token))throw Error('Roster authorization token invalid');
 }
 authorize(req){
  const header=req.headers?.authorization;
  const actual=Buffer.from(typeof header==='string'?header:''),expected=Buffer.from('Bearer '+this.token);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Roster authorization required');
 }
 read(req){this.authorize(req);return {profile:this.roster.read()};}
 update(req,changes){this.authorize(req);if(this.busy())throw Error('A controller operation is running');return {profile:this.roster.update(changes)};}
}
module.exports={RosterApi};
