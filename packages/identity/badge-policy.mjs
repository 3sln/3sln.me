import {parseFragment} from 'parse5';
import {RESERVED_HANDLES,BOOT_HANDLE,normalizeHandle,isFreeHandle} from './handles.mjs';
import {isUUID as uuid} from '../core/primitives.mjs';
const object=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=(code='host_name_policy_unavailable')=>{throw Object.assign(new Error(code==='badge_policy_unavailable'?'Local badge definitions are not configured correctly.':'Host name policy is not configured correctly.'),{code,status:503});};
const text=(value,max)=>typeof value==='string'&&value.trim()===value&&value.length>0&&Array.from(value).length<=max&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value);
const slug=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export function validateHostAlias(value){const name=normalizeHandle(value);if(isFreeHandle(name))throw new TypeError('A named account alias is required.');return name;}
function names(value){if(!Array.isArray(value)||value.length>256||new Set(value).size!==value.length)fail();for(const name of value)try{if(validateHostAlias(name)!==name)fail();}catch{fail();}return [...value];}
function parsed(value,max=32768,code){if(typeof value==='string'){if(new TextEncoder().encode(value).length>max)fail(code);try{return JSON.parse(value);}catch{fail(code);}}return value;}
export function configuredNamePolicy(config={}){
 let raw=config.HOST_NAME_POLICY===''?undefined:parsed(config.HOST_NAME_POLICY);
 if(raw===undefined)raw={version:1,reserved:[...RESERVED_HANDLES],onboarding:names(parsed(config.ONBOARDING_NAMES??[]))};
 if(!exact(raw,['version','reserved','onboarding'])||raw.version!==1)fail();
 const policy={version:1,reserved:names(raw.reserved),onboarding:names(raw.onboarding)};if(policy.onboarding.includes(BOOT_HANDLE))fail();
 if(new TextEncoder().encode(JSON.stringify(policy)).length>32768)fail();return freeze(policy);
}
export function configuredReservedName(config,input){const policy=configuredNamePolicy(config);let name;try{name=validateHostAlias(input);}catch{return false;}return name===BOOT_HANDLE||policy.reserved.includes(name)||policy.onboarding.includes(name);}
export const configuredTokenNames=config=>[...configuredNamePolicy(config).onboarding];

const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const defaults=[{id:'system',name:'System account',description:'An account designated by this host operator.',svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2 L21 6 V12 C21 18 12 22 12 22 C12 22 3 18 3 12 V6 Z"/><path d="M8 12 L11 15 L16 9"/></svg>'}];
const shapeAttributes={g:[],path:['d','pathLength'],circle:['cx','cy','r','pathLength'],ellipse:['cx','cy','rx','ry','pathLength'],rect:['x','y','width','height','rx','ry','pathLength'],line:['x1','y1','x2','y2','pathLength'],polyline:['points','pathLength'],polygon:['points','pathLength']};
const shared=['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','transform'];
const number=value=>/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value))&&Math.abs(Number(value))<=65536;
const numbers=value=>value.trim().split(/[\s,]+/).every(number);
function attribute(name,value){
 if(value.length>8192||/[\u0000-\u001f\u007f]/.test(value))return false;
 if(name==='d')return value.length>0&&/^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\-\s]+$/.test(value)&&[...value.matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g)].every(match=>number(match[0]));
 if(name==='points')return numbers(value)&&value.trim().split(/[\s,]+/).length%2===0;
 if(name==='transform')return value.length<=1024&&/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+.,\-\s]+\)\s*)+$/.test(value)&&[...value.matchAll(/\(([^)]+)\)/g)].every(match=>numbers(match[1]));
 if(name==='fill'||name==='stroke')return /^(?:none|currentColor|black|white|transparent|#[a-fA-F0-9]{3,4}|#[a-fA-F0-9]{6}|#[a-fA-F0-9]{8})$/.test(value);
 if(name==='stroke-linecap')return ['butt','round','square'].includes(value);
 if(name==='stroke-linejoin')return ['miter','round','bevel'].includes(value);
 if(name==='fill-rule'||name==='clip-rule')return ['nonzero','evenodd'].includes(value);
 if(['opacity','fill-opacity','stroke-opacity'].includes(name))return number(value)&&Number(value)>=0&&Number(value)<=1;
 return number(value)&&(!['r','rx','ry','width','height','pathLength','stroke-width','stroke-miterlimit'].includes(name)||Number(value)>=0);
}
function safeSymbol(source,id,name,description){
 if(typeof source!=='string'||new TextEncoder().encode(source).length>16384)fail('badge_policy_unavailable');
 const errors=[],fragment=parseFragment(source,{onParseError:error=>errors.push(error.code)}),roots=fragment.childNodes.filter(node=>node.nodeName!=='#text'||node.value.trim());
 if(errors.length||roots.length!==1||roots[0].tagName!=='svg'||roots[0].namespaceURI!=='http://www.w3.org/2000/svg')fail('badge_policy_unavailable');
 let count=0;const root=roots[0],view=root.attrs.find(attr=>attr.name==='viewBox')?.value;
 const bounds=view?.trim().split(/[\s,]+/);if(!bounds||bounds.length!==4||!bounds.every(number)||Number(bounds[2])<=0||Number(bounds[3])<=0)fail('badge_policy_unavailable');
 const walk=(node,depth=0)=>{
  if(++count>512||depth>12)fail('badge_policy_unavailable');
  if(node.nodeName==='#text'){if(node.value.trim())fail('badge_policy_unavailable');return '';}
  if(node.namespaceURI!=='http://www.w3.org/2000/svg'||!Object.hasOwn(shapeAttributes,node.tagName)&&node!==root)fail('badge_policy_unavailable');
  const allowed=node===root?[...shared,'viewBox','xmlns','width','height']:shared.concat(shapeAttributes[node.tagName]);
  const attrs=[];for(const attr of node.attrs){if(attr.namespace&&!(node===root&&attr.name==='xmlns')||attr.prefix||!allowed.includes(attr.name))fail('badge_policy_unavailable');if(attr.name==='xmlns'){if(attr.value!=='http://www.w3.org/2000/svg')fail('badge_policy_unavailable');continue;}if(attr.name==='viewBox')continue;if(!attribute(attr.name,attr.value))fail('badge_policy_unavailable');if(node===root&&['width','height'].includes(attr.name))continue;attrs.push(` ${attr.name}="${escape(attr.value)}"`);}
  const children=(node.childNodes??[]).map(child=>walk(child,depth+1)).join('');return `<${node===root?'g':node.tagName}${attrs.join('')}>${children}</${node===root?'g':node.tagName}>`;
 };
 return `<symbol id="${id}" viewBox="${bounds.map(Number).join(' ')}"><title>${escape(name)}</title><desc>${escape(description)}</desc>${walk(root)}</symbol>`;
}
// One process-local entry bounds memory and avoids parser/digest work on the
// common unchanged host policy. Content keys detect in-place object changes.
let cachedDefinitions;
function compiledRecord(config={}){
 const input=config.BADGE_DEFINITIONS===undefined||config.BADGE_DEFINITIONS===''?defaults:config.BADGE_DEFINITIONS;
 let key;try{key=typeof input==='string'?input:JSON.stringify(input);}catch{fail('badge_policy_unavailable');}
 if(typeof key!=='string'||new TextEncoder().encode(key).length>262144)fail('badge_policy_unavailable');
 if(cachedDefinitions?.key===key)return cachedDefinitions;
 const raw=parsed(key,262144,'badge_policy_unavailable');
 if(!Array.isArray(raw)||raw.length>32||Object.keys(raw).length!==raw.length)fail('badge_policy_unavailable');
 const output=raw.map(value=>{if(!exact(value,['id','name','description','svg'])||!slug(value.id)||!text(value.name,48)||!text(value.description,240))fail('badge_policy_unavailable');return {id:value.id,name:value.name,description:value.description,svg:safeSymbol(value.svg,value.id,value.name,value.description)};});
 if(new Set(output.map(value=>value.id)).size!==output.length)fail('badge_policy_unavailable');
 const svg='<svg xmlns="http://www.w3.org/2000/svg">'+output.map(value=>value.svg).join('')+'</svg>';
 if(new TextEncoder().encode(svg).length>524288)fail('badge_policy_unavailable');
 return cachedDefinitions={key,definitions:freeze(output),svg,sprite:null};
}
const compiledDefinitions=config=>compiledRecord(config).definitions;
export const configuredBadgeDefinitions=config=>compiledDefinitions(config);
export const configuredBadgeIDs=config=>compiledDefinitions(config).map(value=>value.id);
export function publicBadgePolicy(config){try{return {path:'/api/badges/sprite.svg',definitions:compiledDefinitions(config).map(({id,name,description})=>({id,name,description}))};}catch(error){if(error.code==='badge_policy_unavailable')return {path:null,definitions:[]};throw error;}}
export async function compileBadgeSprite(config){
 const record=compiledRecord(config);
 if(!record.sprite)record.sprite=(async()=>{const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(record.svg)))].map(value=>value.toString(16).padStart(2,'0')).join('');return freeze({svg:record.svg,digest,ids:record.definitions.map(value=>value.id),definitions:record.definitions.map(({id,name,description})=>({id,name,description}))});})();
 return record.sprite;
}
export function projectAccountBadges(account,config,resolvedIds){
 let known;try{known=configuredBadgeIDs(config);}catch(error){if(error.code==='badge_policy_unavailable')return [];throw error;}
 if(!account||!uuid(account.id)||!['pending','recovering','active'].includes(account.status))return [];
 try{if(normalizeHandle(account.handle)!==account.handle)return [];}catch{return [];}
 if(!Array.isArray(resolvedIds)||resolvedIds.length>4||new Set(resolvedIds).size!==resolvedIds.length||resolvedIds.some(id=>!slug(id)))return [];
 return resolvedIds.filter(id=>known.includes(id));
}
export function defaultBadgeResolver(account){return Array.isArray(account?.badgeIds)?[...account.badgeIds]:[];}
export function accountBadges(account,config){return projectAccountBadges(account,config,defaultBadgeResolver(account));}
