'use strict';
// Update only the dispatch-mode fragment of an installed page. Runtime HTML may
// intentionally differ from repository HTML in scripts, quota and startup UI.
function tags(html) {
 const pattern=/<!--[\s\S]*?-->|<\/?([a-z][a-z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
 const result=[];let match;
 while((match=pattern.exec(html))){
  if(!match[1])continue;
  const name=match[1].toLowerCase(),text=match[0],closing=/^<\//.test(text);
  result.push({name,text,start:match.index,end:pattern.lastIndex,closing});
  // Ignore markup-looking text inside raw-text elements.
  if(!closing&&['script','style','textarea','title'].includes(name)){
   const end=new RegExp('</'+name+'\\s*>','gi');end.lastIndex=pattern.lastIndex;
   const found=end.exec(html);if(found)pattern.lastIndex=end.lastIndex;
  }
 }
 return result;
}
function idOf(tag){const match=tag.text.match(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);return match&&(match[1]??match[2]??match[3]);}
function elementRange(html,id){
 const list=tags(html),starts=list.map((tag,index)=>({tag,index})).filter(({tag})=>!tag.closing&&idOf(tag)===id);
 if(starts.length>1)throw Error('Duplicate '+id+' elements; refuse an ambiguous markup update');
 if(!starts.length)return null;
 const {tag:first,index}=starts[0];let depth=0,end=null;
 for(const tag of list.slice(index)){
  if(tag.name!==first.name)continue;
  depth+=tag.closing?-1:1;if(depth===0){end=tag.end;break;}
 }
 if(end===null)throw Error('Unclosed '+id+' element');
 let start=first.start;const line=html.lastIndexOf('\n',start-1)+1;
 if(/^[ \t]*$/.test(html.slice(line,start)))start=line;
 if(html.slice(end,end+2)==='\r\n')end+=2;else if(html[end]==='\n')end++;
 return {start,end,text:html.slice(start,end)};
}
function hideLegacyButton(html,id){
 const candidates=tags(html).filter(tag=>!tag.closing&&tag.name==='button'&&idOf(tag)===id);
 if(candidates.length>1)throw Error('Duplicate '+id+' buttons');
 if(!candidates.length)return html;
 const tag=candidates[0];if(/\shidden(?:\s|=|>)/i.test(tag.text))return html;
 const hidden=tag.text.replace(/(\sid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))/i,'$1 hidden');
 return html.slice(0,tag.start)+hidden+html.slice(tag.end);
}
function applyMarkup(originalHTML,canonicalHTML){
 if(typeof originalHTML!=='string'||typeof canonicalHTML!=='string')throw TypeError('Both HTML inputs must be strings');
 const fragment=elementRange(canonicalHTML,'dispatchModeControl');
 if(!fragment)throw Error('Canonical dispatchModeControl fragment is missing');
 if(tags(fragment.text).some(tag=>tag.name==='script'||idOf(tag)==='quotaSection'||idOf(tag)==='startupSection'))throw Error('Canonical selector contains unrelated page content');
 let html=hideLegacyButton(hideLegacyButton(originalHTML,'turboToggle'),'sustainToggle');
 const copy=[
  ['aria-label="Turbo Mode automation"','aria-label="Automatic dispatch mode"'],
  ['<h2>Turbo Mode <span id="turboStatus"','<h2>Automatic dispatch <span hidden id="turboStatus"'],
  ['Keep agents supplied with the next safe task. Resolve CI blockers and coordinate PR reviews without duplicating work.','Choose how the fleet keeps working. Switching modes preserves running agents and your saved limits.'],
  ['No ten-minute button resets, no arbitrary 18-per-hour dispatch cutoff.','Your configured capacity and resource limits still apply.'],
  ['Sustained production mode','Steady mode activity'],
  ['<h3>Keep agents working <span id="sustainBadge"','<h3>Steady activity <span id="sustainBadge"'],
  ['>Preview dispatch</button>','>Preview Turbo plan</button>'],
  ['>Run cycle now</button>','>Run Turbo cycle</button>'],
  ['<span>Operating envelope</span>','<span>Turbo settings</span>'],
  ['Startup, Sustained, Turbo','Startup, Steady, Turbo'],
  ['enable Sustained automatically','enable Steady automatically'],
 ];
 for(const [before,after]of copy)html=html.replaceAll(before,after);
 const existing=elementRange(html,'dispatchModeControl');
 if(existing)return html.slice(0,existing.start)+fragment.text+html.slice(existing.end);
 const anchor=tags(html).find(tag=>!tag.closing&&idOf(tag)==='sustainPanel');
 if(!anchor)throw Error('Installed sustainPanel insertion anchor is missing');
 let offset=anchor.start;const line=html.lastIndexOf('\n',offset-1)+1;
 if(/^[ \t]*$/.test(html.slice(line,offset)))offset=line;
 return html.slice(0,offset)+fragment.text+html.slice(offset);
}
module.exports={applyMarkup};
