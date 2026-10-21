const fault=(code,message,status)=>{throw Object.assign(new Error(message),{code,status});};
import {REVIEWED_CONTRACTS,EVENT_BUS_CONTRACT} from './reviewed-contracts.mjs';
import {chooseLocale,publisherText,CONSENT_STRINGS} from './localization.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),own=(value,key)=>object(value)&&Object.hasOwn(value,key);
const get=(value,key)=>own(value,key)?value[key]:undefined;
const invalid=()=>fault('invalid_request','This access request cannot be described.',400);
const effects={read:1,pure:1,write:2,destructive:3},categories=['personal-data','location','send-as-you','money','identity','public'],active=['send-as-you','money','identity','public'];
const known=value=>Array.isArray(value)?categories.filter(category=>value.includes(category)):[];
const union=(...values)=>categories.filter(category=>values.some(value=>value.includes(category)));
const plain=(value,max)=>typeof value==='string'?[...value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'')].slice(0,max).join(''):'';
const token=value=>{if(typeof value!=='string'||!value||[...value].length>128||/[\u0000-\u0020\u007f]/.test(value))invalid();return value;};
function url(value){try{if(typeof value!=='string'||value.length>2048)invalid();const parsed=new URL(value);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)invalid();return parsed;}catch{invalid();}}
function names(value,max=128){if(!Array.isArray(value)||!value.length||value.length>max||new Set(value).size!==value.length)invalid();return value.map(token);}
function risk(effect,cats,{floor=1,locale='en',missingEffect=false,reviewed=false}={}){
 const strings=CONSENT_STRINGS[locale],tier=Math.max(get(effects,effect)??2,floor,active.some(category=>cats.includes(category))?4:1),privateInfo=cats.some(category=>['personal-data','location'].includes(category)),keys=tier===4?active.filter(category=>cats.includes(category)): [tier===3?'destructive':tier===2?'write':privateInfo?'private':'read'];
 return {tier,privateInfo,keys,labels:keys.map(key=>strings.tiers[key]),label:keys.map(key=>strings.tiers[key]).join(' · '),icon:tier===4?'shield-alert':tier===3?'trash':tier===2?'pencil':privateInfo?'eye-dot':'eye',ruleWeight:tier>=3?'bold':tier===2||privateInfo?'medium':'normal',categories:cats,chips:cats.map(category=>({category,label:strings.chips[category]})),missingEffect,reviewed,confirmationRequired:tier>=3,expanded:tier>=3||privateInfo,preselected:reviewed&&!missingEffect&&tier<=2&&!privateInfo};
}
const catalogueText=(text,locale)=>({text,lang:locale,source:'catalogue',attribution:CONSENT_STRINGS[locale].catalogue});
const maxRisk=rows=>rows.reduce((highest,row)=>row.risk.tier>highest.tier||row.risk.tier===highest.tier&&row.risk.privateInfo&&!highest.privateInfo?row.risk:highest,rows[0].risk);
function snapshot(value){if(value instanceof Map)return Object.fromEntries([...value].map(([key,entry])=>[key,structuredClone(entry)]));return structuredClone(value??{});}

/** Pure, immutable composition. All metadata/review/reader facts are trusted
 * provider inputs, never fields in a consent request. See README.md. */
export function createConsentProvider({contracts={},manifests={},apps={},readers={},resources={},registrableDomain}={}){
 if(typeof registrableDomain!=='function')throw new TypeError('consent requires a registrableDomain resolver');
 const pins=snapshot(contracts),fragments=snapshot(manifests),directory=snapshot(apps),currentReaders=snapshot(readers),descriptors=snapshot(resources);
 const appOf=id=>{const host=url(id).hostname,record=get(directory,id);return {id,host,reviewed:record?.reviewed===true};};
 const selfPublished=(publisher,app)=>{
  if(publisher===app.host)return true;
  const left=registrableDomain(publisher),right=registrableDomain(app.host);
  // No heuristic last-two-label calculation: an unknown suffix fails closed.
  if(typeof left!=='string'||typeof right!=='string'||!left||!right)invalid();
  return left.toLowerCase()===right.toLowerCase();
 };
 const attribution=(publisher,app,locale)=>{const self=selfPublished(publisher,app);return {host:publisher,selfPublished:self,text:self?CONSENT_STRINGS[locale].ownPublisher:CONSENT_STRINGS[locale].publisher(publisher)};};
 const context=input=>{if(!object(input))invalid();const locale=chooseLocale(input.locale);return {locale,strings:CONSENT_STRINGS[locale],app:appOf(input.app)};};
 function methodRow(contract,name,ctx){
  const host=url(contract).hostname;token(name);
  const pin=get(pins,contract),schema=pin?.schema,metadata=get(schema?.['x-methods'],name)??{},entry=get(REVIEWED_CONTRACTS,contract),digest=typeof pin?.digest==='string'?pin.digest.replace(/^sha256-/,''):null;
  const reviewed=entry&&schema?.$id===contract&&digest===entry.digest.slice(7)?get(entry.methods,name):null;
  // A reviewed floor survives publisher omissions. Extra publisher categories
  // and stronger effects can only raise it. Subscription bookkeeping is read.
  const subscription=contract===EVENT_BUS_CONTRACT&&reviewed&&['subscribe','unsubscribe'].includes(name),claimed=subscription?'read':metadata.effect;
  const effect=reviewed&&(get(effects,reviewed.effect)??2)>=(get(effects,claimed)??(claimed===undefined?1:2))?reviewed.effect:claimed;
  const cats=union(known(reviewed?.categories),known(metadata.categories)),missingEffect=!reviewed&&!own(effects,claimed),source=attribution(host,ctx.app,ctx.locale);
  const trustedRisk=!!reviewed&&cats.every(category=>reviewed.categories.includes(category))&&(get(effects,effect)??2)===(get(effects,reviewed.effect)??2);
  const classified=risk(effect,cats,{locale:ctx.locale,missingEffect,reviewed:trustedRisk,floor:!reviewed&&source.selfPublished?2:1});
  const publisher=!reviewed&&publisherText(metadata.summary,ctx.locale),text=reviewed?catalogueText(reviewed.text[ctx.locale],ctx.locale):publisher?{...publisher,source:'publisher',attribution:source.text,host}: {text:ctx.strings.fallback[classified.keys[0]],lang:ctx.locale,source:'fallback',attribution:null};
  return {kind:'method',contract,method:name,risk:classified,text,warnings:[...!reviewed?[ctx.strings.unreviewed]:[],...!reviewed&&classified.tier>=2?[ctx.strings.writeWarning]:[],...text.source==='fallback'?[ctx.strings.noDescription]:[]],publisher:source};
 }
 function allowed(rows,ctx){if(!ctx.app.reviewed&&rows.some(row=>row.risk.tier===4))fault('invalid_request','Unreviewed apps cannot request this access.',400);return rows;}
 function card(input,rows,ctx,extra={}){
  allowed(rows,ctx);const sorted=rows.map((row,index)=>({...row,index})).sort((a,b)=>b.risk.tier-a.risk.tier||Number(b.risk.privateInfo)-Number(a.risk.privateInfo)||a.index-b.index).map(({index,...row})=>row),highest=maxRisk(sorted),aggregate=risk(highest.tier===3?'destructive':highest.tier>=2?'write':'read',union(...rows.map(row=>row.risk.categories)),{locale:ctx.locale,floor:highest.tier,reviewed:rows.every(row=>row.risk.reviewed),missingEffect:rows.some(row=>row.risk.missingEffect)});
  const summary=sorted.every(row=>row.text.source==='catalogue')&&!sorted.some(row=>row.risk.tier===4)?ctx.strings.summary([...new Set(sorted.map(row=>row.risk.tier===3?'destructive':row.risk.tier===2?'write':'read'))].sort().join(',')):null;
  return {id:input.id===undefined?null:token(input.id),kind:input.kind??'contract',risk:aggregate,rows:sorted,summary:summary??ctx.strings.details(rows.length),preselected:sorted.every(row=>row.risk.preselected),expanded:sorted.some(row=>row.risk.expanded),label:input.label===undefined?null:{text:plain(input.label,40),dir:'auto',isolate:true,quoted:true},purpose:claim(input.purpose,ctx),...extra};
 }
 function claim(value,ctx){return typeof value==='string'&&value.trim()?{text:plain(value,200),label:ctx.strings.claim(ctx.app.host),host:ctx.app.host,source:'app-claim',lang:null,dir:'auto',isolate:true}:null;}
 function contractCard(input,ctx){return card(input,names(input.methods).map(name=>methodRow(input.contract,name,ctx)),ctx,{contract:input.contract});}
 function fragment(input){url(input.fragment);const pin=get(fragments,input.fragment);if(!pin?.schema||pin.schema.id!==input.fragment)invalid();return pin.schema;}
 function busCard(input,ctx){
  if(!['read','write','readwrite'].includes(input.mode))invalid();const schema=fragment(input),bus=schema.slot?.bus;if(bus?.v!==1)invalid();
  const host=url(input.fragment).hostname,source=attribution(host,ctx.app,ctx.locale),cats=known(bus.categories),modes=input.mode==='readwrite'?['read','write']:[input.mode];
  const downstream=[];if(modes.includes('write'))for(const reader of get(currentReaders,input.fragment)??[]){
   const app=appOf(reader.app),rows=(reader.capabilities??[]).map(capability=>methodRow(capability.contract,capability.method,{...ctx,app}));
   const readerCats=union(known(reader.categories),...rows.filter(row=>row.risk.tier===4).map(row=>row.risk.categories));
   if(active.some(category=>readerCats.includes(category)))downstream.push({host:app.host,categories:readerCats});
  }
  const rows=modes.map(mode=>{
   const allCats=mode==='write'?union(cats,...downstream.map(reader=>reader.categories)):cats,classified=risk(mode==='read'?'read':'write',allCats,{locale:ctx.locale,floor:source.selfPublished?2:1});
   const description=publisherText(bus.effects?.[mode],ctx.locale,200);
   return {kind:'bus',mode,risk:classified,text:catalogueText(ctx.strings.bus[mode],ctx.locale),publisher:source,publisherDescription:description?{...description,source:'publisher',host,attribution:source.text}:null,warnings:[ctx.strings.unreviewed,...mode==='write'?[ctx.strings.writeWarning]:[],...!description?[ctx.strings.noDescription]:[]],readerEffects:mode==='write'?downstream.map(reader=>({host:reader.host,categories:reader.categories,text:ctx.strings.reader(reader.host,risk('read',reader.categories,{locale:ctx.locale}).label)})):[]};
  });
  return card({...input,kind:'bus'},rows,ctx,{fragment:input.fragment,publisher:source});
 }
 function settingsCard(input,ctx,resource=false){
  const schema=fragment(input),host=url(input.fragment).hostname,source=attribution(host,ctx.app,ctx.locale),fields=names(input.fields).map(name=>{const field=get(schema.fields,name);if(!field||(resource?field.type!=='resource':field.type==='resource'))invalid();return {name,title:{text:plain(field.title??name,40),dir:'auto',isolate:true},categories:known(field.categories)};}),cats=union(...fields.map(field=>field.categories));
  const row={kind:resource?'reference':'settings',risk:risk('read',cats,{locale:ctx.locale,reviewed:false}),text:catalogueText(resource?ctx.strings.resourceReference:ctx.strings.settings,ctx.locale),fields,publisher:source,warnings:[]};
  return card({...input,kind:resource?'reference':'settings'},[row],ctx,{fragment:input.fragment,publisher:source});
 }
 function grantCard(input,ctx){if(!object(input))invalid();let result;if(input.kind==='contract')result=contractCard(input,ctx);else if(input.kind==='bus')result=busCard(input,ctx);else if(input.kind==='settings')result=settingsCard(input,ctx);else if(input.kind==='reference')result=settingsCard(input,ctx,true);else invalid();const origin=get(descriptors,input.resource)?.brokerOrigin;if(origin!==undefined)result.broker={host:url(origin).host,text:ctx.strings.broker(url(origin).host)};return result;}
 return Object.freeze({
  method(input){const ctx=context(input);return allowed([methodRow(input.contract,input.method,ctx)],ctx)[0];},
  contract(input){const ctx=context(input);return contractCard(input,ctx);},
  bus(input){const ctx=context(input);return busCard(input,ctx);},
  grant(input){const ctx=context(input);return grantCard(input,ctx);},
  model(input){const ctx=context(input);if(!Array.isArray(input.grants)||input.grants.length>128)invalid();const grants=input.grants.map((grant,index)=>({...grantCard(grant,ctx),index})).sort((a,b)=>b.risk.tier-a.risk.tier||a.index-b.index).map(({index,...grant})=>grant);return {locale:ctx.locale,app:ctx.app,grants,reason:claim(input.reason,ctx)};},
 });
}
