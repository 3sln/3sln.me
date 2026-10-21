// Durable activity state over one account's transactional metadata store (DO ctx.storage, Node SqliteMetadata).
// Every mutation is one transaction that re-checks the live app connection, the replay receipt, limits and the
// item's revision before writing, so it is correct without relying on the account gate around it. Signing and
// digests run before the transaction: the DO storage transaction only awaits storage.
//
// Records (all owner-scoped through core `key`):
//   activity-item/<owner>/<id>/              item summary, recipient state and pending-event pointer
//   activity-rev/<owner>/<id>/<rev>/          one signed revision: content (null for a retraction) plus evidence
//   activity-receipt/<owner>/<lane>/<app>/<scope>/<op>/  replay receipt {fingerprint, result, expiresAt}; lane a|r
//   activity-usage/<owner>/<app>/             one app's share of items and bytes
//   activity-budget/<owner>/<lane>/           fixed-window admission counters
//   activity-tags/<owner>/<principal>/        remembered app tag IDs (bounded, never recycled)
//   activity-event/<owner>/<group>/           pending notification work, coalesced by collapse scope
//   activity-usage/<owner>/                   live items and bytes
import {canonical} from '../core/primitives.mjs';
import {key,digest} from '../core/records.mjs';
import {ACTIVITY_LIMITS as L,activityInput,checkExpiry,qualifiedTag,principalOf,fail} from './model.mjs';
import {admissionEvidence,attest} from './evidence.mjs';
import {activityFromAppMessage} from './legacy.mjs';

const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const rows=async(tx,prefix,limit)=>[...(await tx.list({prefix,...limit?{limit}:{}})).entries()];
const expired=(item,now)=>item.expiresAt!==null&&now>=item.expiresAt;
export const activityState=(item,now)=>item.state!=='active'?item.state:expired(item,now)?'expired':'active';
/** The replay/collapse scope: issuer, account, app principal and connection incarnation. */
export const activityScope=actor=>digest(crypto,canonical(['activity-scope-v1',actor.issuer,actor.owner,actor.app.clientId,actor.connection.id,actor.connection.generation]));
// The app-chosen collapse key never appears verbatim in pending-work records (ACT-2 may forward group names).
const groupOf=async(id,collapseKey,scope)=>collapseKey===null?`i.${id}`:`c.${await digest(crypto,canonical(['activity-collapse-v1',scope,collapseKey]))}`;
/** Live rows under a prefix, deleting expired ones until the count is exact or exceeds `limit`. */
async function liveCount(tx,prefix,limit,now){
 for(let pass=0;pass<16;pass++){const listed=await rows(tx,prefix,limit+1);let live=0,pruned=0;for(const [path,row]of listed){if(!Number.isSafeInteger(row?.expiresAt))fail('activity_unavailable','Activity admission is unavailable.',503);if(row.expiresAt<=now){await tx.delete(path);pruned++;}else live++;}if(!pruned||listed.length<=limit)return live;}
 return limit+1;
}

/** The same live test as v1 app messages, inside the admitting transaction: an active bindle app connection of this
 * owner and client, at the authorized incarnation, origin and admission generation. */
export async function liveConnection(tx,actor){
 const r=await tx.get('resource/'+actor.connection.id);
 return r?.owner===actor.owner&&r.kind==='app-connection'&&r.provider==='app'&&r.transport==='bindle'&&r.status==='active'&&r.clientId===actor.app.clientId&&r.appOrigin===actor.app.origin&&r.generation===actor.connection.generation&&r.notifications?.enabled===true&&r.notifications.generation===actor.connection.admissionGeneration;
}
function window(record,limits,now,label){
 const minute=Math.floor(now/60000),day=Math.floor(now/86400000);
 if(record!==undefined&&(!plain(record)||![record.minute,record.day,record.minuteCount,record.dayCount].every(Number.isSafeInteger)||record.minute>minute||record.day>day))fail('activity_unavailable','Activity admission is unavailable.',503);
 const minuteCount=record?.minute===minute?record.minuteCount:0,dayCount=record?.day===day?record.dayCount:0;
 if(minuteCount>=limits.minute||dayCount>=limits.day)fail('rate_limited',`${label} has reached its activity limit.`,429,Math.ceil(((dayCount>=limits.day?(day+1)*86400000:(minute+1)*60000)-now)/1000));
 return {minute,day,minuteCount:minuteCount+1,dayCount:dayCount+1};
}
async function charge(tx,owner,principal,retract,now){
 const app=key('activity-budget',owner,(retract?'retract:':'admit:')+principal),account=key('activity-budget',owner,retract?'@retract':'@admit');
 const next=[[app,window(await tx.get(app),retract?L.retract:L.app,now,'This app')],[account,window(await tx.get(account),retract?L.accountRetract:L.account,now,'This account')]];
 for(const [path,value]of next)await tx.put(path,value);
}
async function rememberTags(tx,owner,principal,tags){
 const path=key('activity-tags',owner,principal),record=await tx.get(path)??{ids:[]},fresh=tags.filter(t=>!record.ids.includes(t));
 if(!fresh.length)return;if(record.ids.length+fresh.length>L.rememberedTags)fail('tag_limit','This app has reached its tag limit.',429);
 await tx.put(path,{ids:[...record.ids,...fresh]});
}
async function usage(tx,owner,app){const value=await tx.get(app?key('activity-usage',owner,app):key('activity-usage',owner))??{items:0,bytes:0};if(!plain(value)||![value.items,value.bytes].every(n=>Number.isSafeInteger(n)&&n>=0))fail('activity_unavailable','Activity storage is unavailable.',503);return value;}
async function join(tx,owner,name,item,now){
 const path=key('activity-event',owner,name),event=await tx.get(path)??{group:name,members:[],createdAt:now};
 const members=[...event.members.filter(m=>m.item!==item.id),{item:item.id,revision:item.revision}].slice(-L.eventMembers);
 for(const dropped of event.members.filter(m=>!members.some(n=>n.item===m.item))){const other=await tx.get(key('activity-item',owner,dropped.item));if(other?.eventGroup===name)await tx.put(key('activity-item',owner,dropped.item),{...other,eventGroup:null});}
 await tx.put(path,{...event,members,updatedAt:now});return name;
}
async function leave(tx,owner,item){
 if(!item.eventGroup)return null;const path=key('activity-event',owner,item.eventGroup),event=await tx.get(path);
 if(event){const members=event.members.filter(m=>m.item!==item.id);if(members.length)await tx.put(path,{...event,members});else await tx.delete(path);}
 return null;
}
function summary(item,now){
 const app={principal:principalOf(item.app),clientId:item.app.clientId,origin:item.app.origin,name:item.app.name};
 return {id:item.id,app,subject:item.subject,revision:item.revision,receivedAt:item.createdAt,updatedAt:item.updatedAt,tags:item.tags.map(id=>qualifiedTag(item.app,id)),priority:item.priority,expiresAt:item.expiresAt,state:activityState(item,now),read:item.read,archived:item.archived};
}
const revisionKey=(owner,id,revision)=>key('activity-rev',owner,id,String(revision).padStart(3,'0'));
const OWNER_QUERY=['app','tag','archived','unread','state','limit','cursor'];

export class ActivityStore{
 constructor({accountStore,clock,random}){Object.assign(this,{accountStore,clock,random});}
 transaction(operation){return this.accountStore.transaction(operation);}
 /** One app mutation (create | replace | retract). `actor` is the verified app authority; `keys` the issuer signer. */
 async admit(actor,kind,raw,keys,{operationId}={}){
  const now=this.clock.now(),operation=activityInput(kind,raw,{now,operationId}),scope=await activityScope(actor),owner=actor.owner,principal=principalOf({issuer:actor.issuer,clientId:actor.app.clientId});
  const id=kind==='create'?this.random.uuid():operation.item,revision=kind==='create'?1:operation.expectedRevision+1,appKey=await digest(crypto,canonical(['activity-app-v1',principal]));
  const nextGroup=operation.content?await groupOf(id,operation.content.collapseKey,scope):null,lane=kind==='retract'?'r':'a';
  const fingerprint=await digest(crypto,canonical({kind,item:operation.item??null,expectedRevision:operation.expectedRevision??null,createdAt:operation.createdAt,content:operation.content??null}));
  const evidence=await admissionEvidence({actor,item:id,revision,operation,admittedAt:now,previousRevision:kind==='create'?null:operation.expectedRevision}),attestation=await attest(keys,evidence);
  return this.transaction(async tx=>{
   const bound=await tx.get('owner');if(bound!==undefined&&bound!==owner)fail('forbidden','Account owner mismatch.',403);
   // Live authorization first: it also guards cached outcomes.
   if(!await liveConnection(tx,actor))fail('forbidden','Activity from this app is disabled or needs fresh consent.',403);
   // Dedup scope is issuer/account/app/incarnation; both lanes are checked so a reused ID conflicts across kinds.
   const receiptPath=key('activity-receipt',owner,lane,appKey,scope,operation.operationId);
   for(const path of [key('activity-receipt',owner,'a',appKey,scope,operation.operationId),key('activity-receipt',owner,'r',appKey,scope,operation.operationId)]){const prior=await tx.get(path);if(prior&&prior.expiresAt>now){if(prior.fingerprint!==fingerprint)fail('tx_conflict','The operation identifier was already used for another request.',409);return prior.result;}}
   const full=()=>fail('rate_limited','Retained activity operations are full.',429,3600);
   if(kind==='retract'){if(await liveCount(tx,key('activity-receipt',owner,'r'),L.retractReceipts,now)>=L.retractReceipts)full();}
   else if(await liveCount(tx,key('activity-receipt',owner,'a',appKey),L.appReceipts,now)>=L.appReceipts||await liveCount(tx,key('activity-receipt',owner,'a'),L.liveReceipts,now)>=L.liveReceipts)full();
   if(operation.content)checkExpiry(operation.content.expiresAt,now);
   let item=kind==='create'?null:await tx.get(key('activity-item',owner,id));
   if(kind!=='create'){
    // Another app, another account, or a replaced connection incarnation cannot learn that the item exists.
    if(!item||item.scope!==scope)fail('not_found','Activity item not found.',404);
    if(item.state!=='active')fail('terminal','This activity item was retracted.',409);
    if(expired(item,now))fail('expired','This activity item has expired.',409);
    if(item.revision!==operation.expectedRevision)fail('stale_revision','The activity item changed. Use its current revision.',409);
    if(kind==='replace'&&item.revisions>=L.revisions-1)fail('revision_limit','This activity item has reached its revision limit; it can still be retracted.',409);
   }
   const record={revision,kind,content:operation.content??null,evidence,attestation},bytes=new TextEncoder().encode(JSON.stringify(record)).byteLength,total=await usage(tx,owner),share=await usage(tx,owner,appKey);
   // One app gets at most a quarter of the account's activity storage, so it cannot exhaust it for the others.
   if(kind==='create'&&(total.items>=L.items||share.items>=L.appItems)||kind!=='retract'&&(total.bytes+bytes>L.bytes||share.bytes+bytes>L.appBytes))fail('capacity_exceeded','Activity storage for this app or account is full.',429,3600);
   if(operation.content)await rememberTags(tx,owner,principal,operation.content.tags);
   await charge(tx,owner,principal,kind==='retract',now);
   if(kind==='create'){
    item={id,owner,scope,appKey,app:{issuer:actor.issuer,clientId:actor.app.clientId,origin:actor.app.origin,name:actor.app.name},connection:{...actor.connection},state:'active',revision:1,revisions:1,createdAt:now,updatedAt:now,...operation.content,read:false,readRevision:null,archived:false,bytes,eventGroup:null};
    delete item.body;item.eventGroup=await join(tx,owner,nextGroup,item,now);total.items++;share.items++;
   }else if(kind==='replace'){
    const {body,...content}=operation.content,moved=item.eventGroup&&content.collapseKey!==item.collapseKey;
    // Read and archive state survive; a replacement never enqueues new notification work by itself.
    item={...item,...content,revision,revisions:item.revisions+1,updatedAt:now,bytes:item.bytes+bytes};
    if(moved){item.eventGroup=await leave(tx,owner,{...item,eventGroup:item.eventGroup});item.eventGroup=await join(tx,owner,nextGroup,item,now);}
   }else item={...item,state:'retracted',revision,revisions:item.revisions+1,updatedAt:now,bytes:item.bytes+bytes,eventGroup:await leave(tx,owner,item)};
   total.bytes+=bytes;share.bytes+=bytes;
   const result={item:id,revision,admittedAt:now};
   await tx.put(revisionKey(owner,id,revision),record);await tx.put(key('activity-item',owner,id),item);await tx.put(key('activity-usage',owner),total);await tx.put(key('activity-usage',owner,appKey),share);
   await tx.put(receiptPath,{fingerprint,result,expiresAt:now+L.receiptRetention});
   return result;
  });
 }
 // Owner operations. Nothing below is reachable with app authority: the provider hands apps only `admit`.
 async list(owner,query={}){
  if(!plain(query)||Object.keys(query).some(k=>!OWNER_QUERY.includes(k)))fail('invalid_args','Choose a valid activity filter.');
  const limit=query.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('invalid_args','Choose a page size from 1 to 100.');
  if(query.app!==undefined&&typeof query.app!=='string'||query.archived!==undefined&&typeof query.archived!=='boolean'||query.unread!==undefined&&typeof query.unread!=='boolean'||query.state!==undefined&&!['active','retracted','expired'].includes(query.state)||query.cursor!==undefined&&(typeof query.cursor!=='string'||!/^\d{1,16}\.[a-f0-9-]{36}$/.test(query.cursor)))fail('invalid_args','Choose a valid activity filter.');
  if(query.tag!==undefined&&(!plain(query.tag)||Object.keys(query.tag).some(k=>!['app','id'].includes(k))||typeof query.tag.app!=='string'||typeof query.tag.id!=='string'))fail('invalid_args','Filter by a qualified app tag.');
  const now=this.clock.now();
  return this.transaction(async tx=>{
   const all=(await rows(tx,key('activity-item',owner),L.items+1)).map(([,item])=>item).filter(item=>item?.owner===owner).map(item=>summary(item,now));
   const apps=new Map();for(const item of all){const a=apps.get(item.app.principal)??{...item.app,count:0,unread:0};a.count++;if(!item.read)a.unread++;apps.set(item.app.principal,a);}
   const archived=query.archived??false,selected=all.filter(item=>item.archived===archived&&(query.app===undefined||item.app.principal===query.app)&&(query.unread===undefined||item.read===!query.unread)&&(query.state===undefined||item.state===query.state)&&(query.tag===undefined||item.tags.some(t=>t.app===query.tag.app&&t.id===query.tag.id)))
    .sort((a,b)=>b.updatedAt-a.updatedAt||(a.id<b.id?-1:1));
   let start=0;if(query.cursor){const [at,id]=query.cursor.split('.');start=selected.findIndex(item=>item.updatedAt<Number(at)||item.updatedAt===Number(at)&&item.id>id);if(start<0)start=selected.length;}
   const page=selected.slice(start,start+limit),more=start+limit<selected.length;
   const tags=query.app===undefined?[]:[...new Map(all.filter(i=>i.app.principal===query.app).flatMap(i=>i.tags).map(t=>[t.id,t])).values()].slice(0,L.rememberedTags);
   return {items:page,cursor:more?`${page.at(-1).updatedAt}.${page.at(-1).id}`:null,facets:{apps:[...apps.values()].slice(0,200),tags}};
  });
 }
 async item(tx,owner,id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))fail('not_found','Activity item not found.',404);const item=await tx.get(key('activity-item',owner,id));if(!item||item.owner!==owner)fail('not_found','Activity item not found.',404);return item;}
 /** The item, the requested (default current) revision's content and the signed revision history. */
 async get(owner,{id,revision}={}){
  const now=this.clock.now();
  return this.transaction(async tx=>{
   const item=await this.item(tx,owner,id),history=(await rows(tx,key('activity-rev',owner,id))).map(([,r])=>r);
   const wanted=revision??[...history].reverse().find(r=>r.content)?.revision;
   if(wanted!==undefined&&(!Number.isSafeInteger(wanted)||!history.some(r=>r.revision===wanted)))fail('not_found','Activity revision not found.',404);
   const record=history.find(r=>r.revision===wanted);
   // Retracted or expired content stays readable as inert history; it never carries live actions.
   return {...summary(item,now),content:record?.content?{revision:record.revision,subject:record.content.subject,mimeType:record.content.mimeType,body:record.content.body,inert:activityState(item,now)!=='active'||record.revision!==item.revision}:null,history:history.map(r=>({revision:r.revision,kind:r.kind,admittedAt:r.evidence.admittedAt,evidence:r.evidence,attestation:r.attestation}))};
  });
 }
 /** Read state acknowledges an exact revision: a concurrent replacement makes the request stale. */
 async mark(owner,input){
  if(!plain(input)||Object.keys(input).some(k=>!['id','revision','read'].includes(k))||typeof input.read!=='boolean'||!Number.isSafeInteger(input.revision))fail('invalid_args','Mark an exact activity revision read or unread.');
  const now=this.clock.now();
  return this.transaction(async tx=>{
   const item=await this.item(tx,owner,input.id);if(item.revision!==input.revision)fail('stale_revision','The activity item changed. Review the current revision.',409);
   const next={...item,read:input.read,readRevision:input.read?item.revision:null,eventGroup:input.read?await leave(tx,owner,item):item.eventGroup};
   await tx.put(key('activity-item',owner,item.id),next);return summary(next,now);
  });
 }
 /** Archive hides the item and cancels its undispatched notification work without deleting it. */
 async archive(owner,input){
  if(!plain(input)||Object.keys(input).some(k=>!['id','archived'].includes(k))||typeof input.archived!=='boolean')fail('invalid_args','Archive or restore one activity item.');
  const now=this.clock.now();
  return this.transaction(async tx=>{
   const item=await this.item(tx,owner,input.id),next={...item,archived:input.archived,eventGroup:input.archived?await leave(tx,owner,item):item.eventGroup};
   await tx.put(key('activity-item',owner,item.id),next);return summary(next,now);
  });
 }
 /** Recipient deletion is terminal: the ID is gone and can never become an upsert target; replay receipts remain. */
 async remove(owner,input){
  if(!plain(input)||Object.keys(input).some(k=>k!=='id'))fail('invalid_args','Delete one activity item.');
  return this.transaction(async tx=>{
   const item=await this.item(tx,owner,input.id),total=await usage(tx,owner);await leave(tx,owner,item);
   if(item.appKey){const share=await usage(tx,owner,item.appKey);await tx.put(key('activity-usage',owner,item.appKey),{items:Math.max(0,share.items-1),bytes:Math.max(0,share.bytes-item.bytes)});}
   for(const [path]of await rows(tx,key('activity-rev',owner,item.id)))await tx.delete(path);
   await tx.delete(key('activity-item',owner,item.id));await tx.put(key('activity-usage',owner),{items:Math.max(0,total.items-1),bytes:Math.max(0,total.bytes-item.bytes)});
   return {deleted:true};
  });
 }
 /** v1 app messages as activity rows (read-only adapter), scanning at most 200 message records per page. */
 async legacy(owner,query={}){
  if(!plain(query)||Object.keys(query).some(k=>k!=='cursor')||query.cursor!==undefined&&(typeof query.cursor!=='string'||!/^[a-f0-9-]{36}$/.test(query.cursor)))fail('invalid_args','Choose a valid activity page.');
  return this.transaction(async tx=>{
   const prefix=key('message',owner),scanned=[...(await tx.list({prefix,...query.cursor?{startAfter:key('message',owner,query.cursor)+'￿'}:{},limit:200})).entries()];
   const last=scanned.length===200?decodeURIComponent(scanned.at(-1)[0].slice(prefix.length).split('/')[0]):null;
   return {items:scanned.map(([,m])=>m).filter(m=>m?.owner===owner).map(activityFromAppMessage).filter(Boolean),cursor:last&&/^[a-f0-9-]{36}$/.test(last)?last:null};
  });
 }
 /** Pending notification work for ACT-2: each group resolves to its latest still-eligible member. */
 async pending(owner){
  const now=this.clock.now();
  return this.transaction(async tx=>{
   const out=[];for(const [,event]of await rows(tx,key('activity-event',owner))){
    for(const member of [...event.members].reverse()){const item=await tx.get(key('activity-item',owner,member.item));if(item&&activityState(item,now)==='active'&&!item.read&&!item.archived&&item.eventGroup===event.group){out.push({group:event.group,item:item.id,revision:item.revision,members:event.members.length});break;}}
   }
   return out;
  });
 }
}
