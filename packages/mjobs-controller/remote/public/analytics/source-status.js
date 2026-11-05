'use strict';
// Current collector health is separate from the timestamp of the last good data.
(()=>{
 const messages=Object.freeze({
  OK:'Native observations are current.',
  NATIVE_ROSTER_OFFLINE:'Native runtime is offline; the saved roster is historical.',
  NATIVE_ROSTER_STALE:'Native roster is stale or unavailable.',
  SOURCE_IDENTITY_CHANGED:'Native database identity changed; historical telemetry needs reconciliation.',
  COLLECTION_UNAVAILABLE:'Native telemetry collection is unavailable.',
  STATUS_PUBLICATION_FAILED:'Collector status could not be published.'
 });
 const timestamp=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
 function normalize(value){
  if(!value||value.schemaVersion!==1||value.staleAfterSeconds!==90||typeof value.available!=='boolean'||
   typeof value.reasonCode!=='string'||!Object.hasOwn(messages,value.reasonCode)||!timestamp(value.checkedAt)||
   (value.lastSuccessAt!==null&&!timestamp(value.lastSuccessAt))||
   value.available!==(value.reasonCode==='OK')||(value.available&&value.lastSuccessAt===null))return null;
  return {schemaVersion:1,checkedAt:value.checkedAt,staleAfterSeconds:90,available:value.available,
   reasonCode:value.reasonCode,message:messages[value.reasonCode],lastSuccessAt:value.lastSuccessAt};
 }
 function assess(data,value,now=Date.now(),refreshFailed=false){
  const status=normalize(value);
  const unavailable=(label,message)=>({live:false,label,message:message+' Historical values are not current activity.',checkedAt:status?.checkedAt||null});
  if(!status)return unavailable('SOURCE UNAVAILABLE','Current collector status is unavailable.');
  const age=now-Date.parse(status.checkedAt);
  if(!Number.isFinite(age)||age < -10000||age > 90000)return unavailable('COLLECTOR OFFLINE','Collector status is stale or has an invalid clock.');
  if(!status.available)return unavailable(status.reasonCode==='NATIVE_ROSTER_OFFLINE'?'NATIVE SOURCE OFFLINE':'SOURCE UNAVAILABLE',status.message);
  if(refreshFailed)return unavailable('REFRESH UNAVAILABLE','The latest observation could not be refreshed.');
  const observed=timestamp(data?.generatedAt)?Date.parse(data.generatedAt):NaN;
  if(!Number.isFinite(observed)||now-observed < -10000||now-observed > 90000)return unavailable('STALE / OFFLINE','The last successful observation is stale or unavailable.');
  if(data?.source?.available!==true||Date.parse(status.lastSuccessAt)!==observed)return unavailable('VERIFYING SOURCE','The source receipt does not match the displayed observation.');
  return {live:true,label:'NATIVE TELEMETRY LIVE',message:'Current observations are fresh. Running turns, queued tasks and reserved capacity are counted separately.',checkedAt:status.checkedAt};
 }
 const api={normalize,assess};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else globalThis.FleetAnalyticsStatus=api;
})();
