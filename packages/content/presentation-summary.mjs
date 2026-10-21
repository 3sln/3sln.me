import {parseFragment} from 'parse5';
import {digest,strictText} from '../core/records.mjs';
const omit=new Set(['script','style','template','noscript','footer','nav','input','textarea','select','option','svg','math','iframe','object']);
const clean=(text,max)=>Array.from(String(text||'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim()).slice(0,max).join('');
const attrs=node=>Object.fromEntries((node.attrs||[]).map(a=>[a.name,a.value]));
const children=node=>node.childNodes||[];
const hidden=node=>{const a=attrs(node);return 'hidden'in a||'inert'in a||a['aria-hidden']?.trim().toLowerCase()==='true'||['details','dialog'].includes(node.tagName)&&!('open'in a)||/display\s*:\s*none|visibility\s*:\s*(hidden|collapse)|opacity\s*:\s*0(?:\D|$)/i.test(a.style||'');};
const urlAt=(value,origin)=>{try{const u=new URL(value,origin);return u.protocol==='https:'&&!u.username&&!u.password&&u.origin===origin&&u.href.length<=2048;}catch{return false;}};
/** Presentation heuristics only. Locators are advisory: renderer reparses and
 * reviews the retained source. No selector/URL/fields are dispatch authority. */
export async function messagePresentationSummary(record){
 const sourceDigest=await digest(crypto,record.bytes),subject=clean(record.senderMetadata?.subject,120),base={version:1,sourceDigest,title:subject||'New message',text:'',actions:[],approximate:true};
 if(!['text/plain','text/html'].includes(record.mimeType))return base;
 if(record.bytes.length>65536)return {...base,truncated:true};
 const text=strictText(record.bytes);if(record.mimeType==='text/plain')return {...base,text:clean(text,240)};
 const tree=parseFragment(text),all=[],stack=[tree];while(stack.length){const n=stack.pop();all.push(n);if(all.length>8192)return {...base,truncated:true};stack.push(...children(n).slice().reverse());}
 const textOf=node=>{let out='';const todo=[node];while(todo.length){const n=todo.pop();if(omit.has(n.tagName)||hidden(n))continue;if(n.nodeName==='#text')out+=' '+n.value;else todo.push(...children(n).slice().reverse());}return out;};
 // Stylesheets can hide arbitrary descendants. Without layout computation,
 // avoid claiming those descendants are visible or exposing them on a lockscreen.
 if(all.some(n=>Object.hasOwn(attrs(n),'style')||n.tagName==='style'||n.tagName==='link'&&attrs(n).rel?.toLowerCase().split(/\s+/).includes('stylesheet')))return {...base,truncated:true};
 const visible=[],visit=[tree];while(visit.length){const n=visit.pop();if(omit.has(n.tagName)||hidden(n))continue;visible.push(n);visit.push(...children(n).slice().reverse());}
 const heading=visible.find(n=>/^h[1-3]$/.test(n.tagName||''));base.title=subject||clean(heading&&textOf(heading),120)||'New message';base.text=clean(textOf(tree),240);
 const origin=record.appNotification?.origin; if(typeof origin!=='string'||!origin.startsWith('https://'))return base;
 const forms=all.filter(n=>n.tagName==='form'),links=all.filter(n=>n.tagName==='a');
 for(const form of forms){if(base.actions.length>=2)break;if(!visible.includes(form))continue;const a=attrs(form);if(!urlAt(a.action||'',origin))continue;const descendants=[],todo=[form];while(todo.length){const n=todo.pop();descendants.push(n);todo.push(...children(n).slice().reverse());}
  if(descendants.some(n=>['textarea','select'].includes(n.tagName)||n.tagName==='input'&&!['hidden','submit','button','reset'].includes((attrs(n).type||'text').toLowerCase())||'contenteditable'in attrs(n)))continue;
  const buttons=descendants.filter(n=>n.tagName==='button'||n.tagName==='input'&&['submit','button','reset'].includes((attrs(n).type||'text').toLowerCase()));
  for(const [buttonIndex,b]of buttons.entries()){if(base.actions.length>=2)break;const ba=attrs(b);if(!visible.includes(b)||hidden(b)||'disabled'in ba||(ba.type||'submit').toLowerCase()!=='submit'||ba.formaction&&!urlAt(ba.formaction,origin))continue;const label=clean(b.tagName==='input'?ba.value:textOf(b),80);if(label)base.actions.push({kind:'form',formId:forms.indexOf(form),buttonId:buttonIndex,label,reviewRequired:true});}
 }
 for(const [linkIndex,n]of links.entries()){if(base.actions.length>=2)break;const a=attrs(n),label=clean(textOf(n),80);if(Object.hasOwn(a,'data-bindle-action')&&visible.includes(n)&&label&&typeof a.href==='string'&&urlAt(a.href,origin))base.actions.push({kind:'link',linkId:linkIndex,label,reviewRequired:true});}
 return base;
}
