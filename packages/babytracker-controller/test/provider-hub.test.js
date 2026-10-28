'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validCodexModels, sanitizeUsage, createSharedProviders } = require('../multi-provider');
const { createProjectHub } = require('../project-hub');
const fakeResponse = body => ({ ok: true, json: async () => body });

test('shared Codex catalog only permits verified model IDs and supported effort options', () => {
  const models = validCodexModels({ providers: [{ id: 'codex', available: true, models: [
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low','medium','high'], defaultEffort: 'medium' },
    { id: '--evil', name: 'Bad', efforts: ['medium'] },
    { id: 'bad', name: 'Bad', efforts: ['unbounded'] }
  ] }] });
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low','medium','high'], defaultEffort: 'medium', effortMode: 'flag' });
});

test('AGY native usage is client-observed and stale values never become fresh percentages', () => {
  const now = Date.parse('2026-10-27T23:00:00.000Z');
  const native = { providers: [{ id: 'agy', fresh: true, remainingPercent: 25,
    observedAt: new Date(now - 10000).toISOString(), windows: [{ bucket:'gemini', remainingPercent:25 }] }] };
  const fresh = sanitizeUsage(native, now);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.remainingPercent, 25);
  assert.equal(fresh.autoCutoffVerified, false);
  assert.equal(sanitizeUsage(native, now + 180000).remainingPercent, null);
  assert.equal(sanitizeUsage({}, now).fresh, false);
});

test('shared provider reader is read-only and combines local AGY with MJobs Codex catalog', async () => {
  const called = [], fetcher = async url => {
    called.push(url);
    if (url.endsWith('/api/providers')) return fakeResponse({ providers: [{ id:'codex', available:true,
      models:[{ id:'gpt-6-luna', name:'Luna', efforts:['medium'], defaultEffort:'medium' }] }] });
    return fakeResponse({providers:[]});
  };
  const own = { get: async () => ({ providers: [{ id:'codex', available:false, models:[] }, { id:'agy', available:true, models:[{id:'gemini-3.8-flash-low',name:'Gemini Low',efforts:['low'],defaultEffort:'low',effortMode:'model-id'}] }, {id:'gemini',available:false,models:[]}] }) };
  const providers = createSharedProviders({codexExe:process.execPath,codexModels:[]},{fetcher,local:own});
  const result = await providers.get();
  assert.equal(result.providers.find(p=>p.id==='codex').available, true);
  assert.equal(result.providers.find(p=>p.id==='agy').models[0].id, 'gemini-3.8-flash-low');
  assert.equal(result.providers.find(p=>p.id==='gemini').available, false);
  assert.ok(called.every(u=>u.startsWith('http://127.0.0.1:8787/api/')));
});

test('project hub gives a consistent read-only cross-project view without sending mutation', async () => {
  const calls = [];
  const result = createProjectHub({aoPath:'fake',repoPath:'fake',daemonUrl:'http://127.0.0.1:3001'},
    {snapshot: async () => ({mode:'paused',runtime:{online:true},summary:{total:1,working:0,available:1},quota:{fresh:true,remainingPercent:50},capabilities:{explicitAgentProvisioning:true}})},
    {runner: async (exe,args) => {calls.push(args);return {stdout:JSON.stringify({projects:[
      {id:'babytracker',name:'BabyTracker',kind:'single_repo'},
      {id:'mjobs-luna',name:'MJobs',kind:'single_repo'},
      {id:'mterm-cli',name:'MTerm CLI',kind:'single_repo'}]})};},
     fetcher: async url => {calls.push(url);return url.includes('8787')?
       fakeResponse({projectId:'mjobs-luna',sessions:[{id:'mjobs-1',busy:true},{id:'mjobs-2',busy:false}]}) :
       fakeResponse({sessions:[{id:'baby-1',projectId:'babytracker',activity:{state:'idle'},isTerminated:false},
         {id:'mjobs-1',projectId:'mjobs-luna',activity:{state:'active'},isTerminated:false}]});}
    });
  const value = await result();
  assert.equal(value.projects.length,3);
  assert.equal(value.projects.find(x=>x.id==='babytracker').controlUrl,'/');
  assert.equal(value.projects.find(x=>x.id==='mjobs-luna').controlUrl,'http://127.0.0.1:8787');
  assert.equal(value.projects.find(x=>x.id==='mterm-cli').controlUrl,null);
  assert.equal(value.projects.find(x=>x.id==='mjobs-luna').working,1);
  assert.ok(calls.every(x=>Array.isArray(x)||typeof x==='string'));
});

test('unreachable AO gives unavailable projects, never fictional zero agents', async () => {
  const overview = createProjectHub({aoPath:'missing',repoPath:'missing'}, { snapshot: async () => {throw Error('unexpected');} },
    {runner: async () => {throw Error('offline');} });
  const result = await overview();
  assert.equal(result.aoOnline,false);
  assert.deepEqual(result.projects,[]);
});
