"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {safeRelative,verify,install}=require('../scripts/controller-package');
test('controller paths reject traversal, absolute paths and runtime secrets',()=>{
 for(const name of ['../state.json','/tmp/a','C:/tmp/a','x\\y','x//y','.env','state/controller.json','audit.jsonl','data.db'])assert.throws(()=>safeRelative(name));
 assert.equal(safeRelative('public/app.js'),'public/app.js');
});
test('both maintained controller trees match the source-only manifest',()=>{
 assert(verify('babytracker-controller').length>30);assert(verify('mjobs-controller').length>150);assert.throws(()=>verify('../other'));
});
test('install preview never writes and cannot target the source checkout',()=>{
 const result=install('babytracker-controller',require('node:path').join(require('node:os').tmpdir(),'fleet-preview-only'));
 assert.equal(result.apply,false);assert(result.files>30);assert.throws(()=>install('babytracker-controller',require('node:path').resolve(__dirname,'..')));
});

test("source package text has canonical LF bytes on every platform",()=>{
 const fs=require("node:fs");for(const id of ["babytracker-controller","mjobs-controller"])for(const row of verify(id)){const bytes=fs.readFileSync(row.source);if(!bytes.includes(0))assert(!bytes.includes(Buffer.from("\r\n")),row.relative);}
});
