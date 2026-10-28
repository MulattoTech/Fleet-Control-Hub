"use strict";
// Copies verified source only. Runtime data is neither copied nor removed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'..');
function safeRelative(name){
 if(typeof name!=='string'||!name||name.includes('\\')||path.isAbsolute(name)||name.split('/').some(x=>!x||x==='.'||x==='..')||/^[a-z]:/i.test(name))throw Error('Unsafe package path');
 if(/(^|\/)(\.env|controller\.json|dispatch-ledger\.json|restore-snapshot\.json|.*\.jsonl|.*\.db|.*\.sqlite)$/i.test(name))throw Error('Runtime/private file is forbidden');
 return name;
}
function verify(id){
 const manifest=JSON.parse(fs.readFileSync(path.join(repo,'controller-packages.json'),'utf8'));
 if(manifest.version!==1||!Object.hasOwn(manifest.packages,id))throw Error('Unknown controller package');
 const source=path.join(repo,'packages',id),rows=[];
 for(const [rel,expected]of Object.entries(manifest.packages[id])){
  safeRelative(rel);if(!/^[a-f0-9]{64}$/.test(expected))throw Error('Invalid source digest');
  const file=path.join(source,rel),stat=fs.lstatSync(file),real=fs.realpathSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!real.startsWith(fs.realpathSync(source)+path.sep))throw Error('Source redirected');
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)throw Error('Source changed: '+rel);
  rows.push({relative:rel,source:file,sha256:expected});
 }
 return rows;
}
function install(id,destination,apply=false){
 const rows=verify(id),dest=path.resolve(destination);
 if(dest===path.parse(dest).root||dest===repo||dest.startsWith(repo+path.sep))throw Error('Use a dedicated runtime directory outside source');
 if(!apply)return {apply:false,package:id,destination:dest,files:rows.length};
 fs.mkdirSync(dest,{recursive:true});
 if(fs.lstatSync(dest).isSymbolicLink())throw Error('Destination is redirected');
 for(const row of rows){
  const file=path.join(dest,row.relative);let current=dest;
  for(const part of row.relative.split('/').slice(0,-1)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Destination directory redirected');}
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('Destination file redirected');
 }
 // Callers must stop only the relevant controller after verifying dispatch is paused.
 for(const row of rows){const file=path.join(dest,row.relative);fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.migration-'+crypto.randomUUID()+'.tmp';fs.copyFileSync(row.source,tmp);fs.renameSync(tmp,file);}
 const receipt={package:id,installedAt:new Date().toISOString(),sourceRepository:'MulattoTech/Fleet-Control-Hub',files:rows.map(({relative,sha256})=>({relative,sha256}))};
 fs.writeFileSync(path.join(dest,'installed-source.json'),JSON.stringify(receipt,null,2));return {apply:true,package:id,destination:dest,files:rows.length};
}
if(require.main===module){try{const [command,id,destination,...flags]=process.argv.slice(2);if(command==='verify')console.log(JSON.stringify({package:id,verified:verify(id).length}));else if(command==='install'&&destination)console.log(JSON.stringify(install(id,destination,flags.includes('--apply'))));else throw Error('Usage: controller-package.js verify PACKAGE | install PACKAGE DESTINATION [--apply]');}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={safeRelative,verify,install};
