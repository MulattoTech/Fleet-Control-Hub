'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAdapters}=require('../src/adapters');

test('emergency scope follows native evidence without changing dispatch or calling controls',async t=>{
  for(const [scope,expected] of [['fleet-owned','fleet-owned'],['machine','machine'],['all Codex processes across the host','machine'],[undefined,'unknown'],[null,'unknown'],['unexpected-private-value','unknown'],[{},'unknown']]){
    await t.test(expected+' from '+(typeof scope),async()=>{
      const calls=[];
      const fetcher=async(url,options={})=>{
        calls.push({url,options});
        assert.ok(!options.method||options.method==='GET');
        const route=new URL(url).pathname;
        const payloads={
          '/fleet/api/state':{projectId:'mjobs',sessions:[],summary:{total:0,working:0,idle:0,idlePending:0,ciAttention:0}},
          '/fleet/api/master':{dispatch:{sustainedEnabled:false,turboEnabled:false},emergency:{latched:false,scope},drain:{enabled:false}},
          '/fleet/api/sustain':{workItems:[],artifactReviews:{}},
          '/fleet/api/quota':{fresh:true,policy:{remainingPercent:25}},
          '/fleet/api/run':{projectId:'mjobs',phase:'idle',active:false,running:false,blockedReasons:[]}
        };
        assert.ok(Object.hasOwn(payloads,route));
        return {ok:true,json:async()=>payloads[route]};
      };
      const state=await createAdapters({fetcher,progressReader:()=>({available:false})}).status('mjobs');
      assert.equal(state.online,true);
      assert.equal(state.safety.emergencyScope,expected);
      assert.equal(state.safety.dispatchEnabled,false);
      assert.equal(state.safety.emergency,false);
      assert.equal(state.safety.codexRemaining,25);
      assert.equal(calls.length,5);
      assert.equal(JSON.stringify(state).includes('unexpected-private-value'),false);
    });
  }
});
