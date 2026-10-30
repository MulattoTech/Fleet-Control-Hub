'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {applyMarkup}=require('../scripts/mjobs-mode-markup');
const selector='          <div id="dispatchModeControl" role="group">\n            <div class="choices"><button id="dispatchModePaused">Paused</button><button id="dispatchModeSteady">Steady</button><button id="dispatchModeTurbo">Turbo</button></div>\n            <p>One mode runs at a time.</p>\n          </div>\n';
const quota='<section id="quotaSection"><input id="quotaMinimum" value="7"><div class="quota-guard-controls">Exposed guard, armed at 7%</div></section>';
const startup='<section id="startupSection" aria-label="Protected Startup"><button id="startupStart">Protected Startup</button></section>';
const scripts='<script defer src="/app.js"></script><script defer src="/startup-ui.js"></script><script defer src="/quota-ui.js"></script>';
const original='<!doctype html><html><head>'+scripts+'</head><body>\n'+quota+'\n'+startup+'\n<section id="turboSection" aria-label="Turbo Mode automation"><h2>Turbo Mode <span id="turboStatus">OFF</span></h2><button id="turboToggle" class="turbo-switch">Enable Turbo</button>\n          <div class="sustain-bar" id="sustainPanel" aria-label="Sustained production mode"><button id="sustainToggle">Start sustained mode</button></div>\n<p>Startup, Sustained, Turbo</p><p>enable Sustained automatically</p></section></body></html>';
const canonical='<html><head><script defer src="/run-ui.js"></script></head><body><section id="quotaSection"><input value="0"></section>\n'+selector+'</body></html>';
test('copies only selector and mode-specific text while preserving installed scripts, quota and protected startup',()=>{
 const value=applyMarkup(original,canonical);
 assert(value.includes(selector));assert(value.includes(quota));assert(value.includes(startup));assert(value.includes(scripts));assert(!value.includes('run-ui.js'));
 assert.deepEqual(value.match(/<script\b[^>]*>[\s\S]*?<\/script>/g),original.match(/<script\b[^>]*>[\s\S]*?<\/script>/g));
 assert(value.includes('id="turboToggle" hidden'));assert(value.includes('id="sustainToggle" hidden'));
 assert(value.includes('Startup, Steady, Turbo'));assert(value.includes('enable Steady automatically'));
 assert(value.includes('<h2>Automatic dispatch <span hidden id="turboStatus"'));
});
test('repeat application is byte-for-byte idempotent and replaces a selector in place without duplication',()=>{
 const once=applyMarkup(original,canonical),twice=applyMarkup(once,canonical);assert.equal(twice,once);
 assert.equal((twice.match(/id="dispatchModeControl"/g)||[]).length,1);assert(!twice.includes('hidden hidden'));
 const changed=applyMarkup(once,canonical.replace('One mode runs at a time.','Exactly one mode.'));
 assert(changed.includes('Exactly one mode.'));assert(!changed.includes('One mode runs at a time.'));assert(changed.includes(quota));assert(changed.includes(startup));
});
test('rejects missing or duplicate selector fragments and ignores markup inside comments and script strings',()=>{
 assert.throws(()=>applyMarkup(original,'<html></html>'),/missing/);
 assert.throws(()=>applyMarkup(original,selector+selector),/Duplicate/);
 assert.throws(()=>applyMarkup(selector+original+selector,canonical),/Duplicate/);
 const decorated='<!-- <div id="dispatchModeControl">comment</div> --><script>const fake="<div id=dispatchModeControl>text</div>";</script>'+canonical;
 assert.equal(applyMarkup(original,decorated),applyMarkup(original,canonical));
});
