'use strict';
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
const binary='C:\\Tools\\AO-Fleet-Control\\codex-monitor\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const child=spawn(binary,['app-server','--listen','stdio://'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let done=false;
let err='';
const stop=(error,output)=>{
 if(done)return;
 done=true;clearTimeout(timeout);
 if(output)console.log(JSON.stringify(output,null,2));
 if(error){console.error(error);process.exitCode=1}
 try{child.kill()}catch{}
};
const timeout=setTimeout(()=>stop('App-server RPC probe timed out, error='+err.slice(-150)),15000);
child.stderr.on('data',x=>err+=(x.toString().slice(-220)));
child.on('error',e=>stop('Cannot start codex: '+e.message));
const send=x=>child.stdin.write(JSON.stringify(x)+'\n');
readline.createInterface({input:child.stdout}).on('line',line=>{
 let result;try{result=JSON.parse(line)}catch{return}
 if(result.id===1){
  if(result.error){stop('Initialize rejected: '+JSON.stringify(result.error));return}
  send({method:'initialized',params:{}});
  send({id:2,method:'account/rateLimits/read'});
 }
 if(result.id===2){
  if(result.error){stop('Rate limits rejected: '+JSON.stringify(result.error));return}
  const rates=result.result?.rateLimits;
  const many=result.result?.rateLimitsByLimitId;
  const extracted=(many&&Object.keys(many).length?many:rates?{default:rates}:{});
  const output=[];
  for(const [bucket,r] of Object.entries(extracted)){
   for(const [kind,w] of [['primary',r.primary],['secondary',r.secondary]]){
    if(!w||typeof w.usedPercent!=='number')continue;
    output.push({bucket,kind,usedPercent:w.usedPercent,windowMins:w.windowDurationMins,resetsAt:w.resetsAt});
   }
  }
  stop(null,{rates:output,count:output.length});
 }
});
send({id:1,method:'initialize',params:{clientInfo:{name:'mjobs_fleet_control_usage_monitor',title:'MJobs Fleet Control Usage Monitor',version:'1.0.0'},capabilities:{experimentalApi:true}}});
