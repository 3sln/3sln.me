// IA-2: request suppression, caps and the decline ladder (docs/spec/incremental-authorization.md §9, §10). Owner data
// held in the owner shard's federation store next to grants, keyed by entity and *app site*: the registrable domain of
// the client's verified origin, so sibling client IDs (web, mobile) share every record and counter (§9.1). Nothing
// here is visible to apps: creation consults only caps and the ladder, whose every input is an outcome the app itself
// observed; suppression is consulted only inside the provider page, and a suppressed request completes exactly like a
// decline (incremental.mjs). Owner operations are engine Actions/Queries over the `incremental` provider, behind the
// default-off INCREMENTAL_AUTH_ENABLED flag. No route is mounted here.
import {AppAction,AppQuery,ownerOf} from '../app/engine.mjs';
import {boundedString,canonical} from '../messaging/store.mjs';
import {fail,object,https} from './schema.mjs';
export const REQUEST_KINDS=Object.freeze(['grant-more','configure']);
export const SUPPRESSION_SCOPES=Object.freeze(['app','kind','fragment','field']);
const HOUR=3600000,DAY=86400000;
/** 3sln.me reference values (§10, provisional). `ladder[n]` is the cooldown after the (n+1)th decline, the last value
 * repeating; the ladder resets after `ladderResetMs` without a decline or when the owner grants/configures the target. */
export const REQUEST_LIMITS=Object.freeze({hour:3,day:6,month:20,ladder:Object.freeze([DAY,7*DAY,30*DAY]),ladderResetMs:90*DAY,records:256,chain:8,appScopeOffer:{declines:3,windowMs:7*DAY}});
export const suppressionKey=(...parts)=>`incremental/${parts.map(part=>encodeURIComponent(String(part))).join('/')}`;
const FIELD=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** App identity for suppression and limits: the registrable domain of the client's verified origin. `registrableDomain`
 * must be backed by an accurate public suffix list; a missing resolution fails closed (never a last-two-labels guess). */
export function appSite(client,registrableDomain){
 let host;try{host=new URL(client?.origin??client?.id).hostname.toLowerCase();}catch{fail('invalid_request');}
 const site=typeof registrableDomain==='function'?registrableDomain(host):null;if(typeof site!=='string'||!site||!(host===site||host.endsWith(`.${site}`)))fail('temporarily_unavailable','Application requests are not available.');return site;
}
/** Ladder target (§10): own-site fragments share one target per host, so `/v2`, `/v3` churn cannot reset a cooldown;
 * third-party fragments use the root of their `supersedes` chain. Field targets add the field. */
export const ladderTarget=({kind,root,host,own,field})=>`${kind}|${own?`host:${host}`:`url:${root}`}${field?`#${field}`:''}`;
/** Whether one record suppresses one request item. `item`: {kind, chain, host, own, field?}; `chain` is the fragment URL
 * followed by every manifest it supersedes. Fragment scope covers the chain and, for own-site fragments, the host. */
export function suppresses(record,item){
 if(record.scope==='app')return true;if(record.scope==='kind')return record.kind===item.kind;
 if(record.scope==='fragment')return (!record.kind||record.kind===item.kind)&&(record.host?item.host===record.host:item.chain.includes(record.fragment));
 return record.scope==='field'&&item.kind==='configure'&&item.field===record.field&&(record.host?item.host===record.host:item.chain.includes(record.fragment));
}
/** Store-backed suppression records, caps and ladder for one federation store. Every method takes the caller's open
 * transaction so admission, completion and counting commit atomically with the incremental entry record. */
export class RequestSuppressions {
 constructor({clock,crypto=globalThis.crypto,registrableDomain,limits={}}){Object.assign(this,{clock,crypto,registrableDomain,limits:{...REQUEST_LIMITS,...limits}});}
 /** Validated owner input → record shape. `item` (optional) is the request item the owner is looking at. */
 normalize(input){
  if(!object(input)||Object.keys(input).some(k=>!['scope','kind','fragment','field'].includes(k))||!SUPPRESSION_SCOPES.includes(input.scope))fail('invalid_args');
  const {scope}=input,kind=input.kind;
  if(scope==='app'){if(kind!==undefined||input.fragment!==undefined||input.field!==undefined)fail('invalid_args');return {scope};}
  if(scope==='kind'){if(!REQUEST_KINDS.includes(kind)||input.fragment!==undefined||input.field!==undefined)fail('invalid_args');return {scope,kind};}
  https(input.fragment);if(kind!==undefined&&!REQUEST_KINDS.includes(kind))fail('invalid_args');
  if(scope==='fragment'){if(input.field!==undefined)fail('invalid_args');return {scope,fragment:input.fragment,...kind?{kind}:{}};}
  if(kind!==undefined&&kind!=='configure'||typeof input.field!=='string'||!FIELD.test(input.field))fail('invalid_args');return {scope,kind:'configure',fragment:input.fragment,field:input.field};
 }
 /** Own-site fragment scope records the host, so every fragment the app publishes on it matches (§9.1). */
 withHost(record,site){if(!record.fragment)return record;const host=new URL(record.fragment).hostname.toLowerCase();const own=this.registrableDomain?.(host)===site;return own?{...record,host}:record;}
 async records(tx,subject,site){return (await tx.list(suppressionKey('s',subject,site,''))).map(row=>row.value);}
 async add(tx,{subject,site,input,source='settings'}){
  const record=this.withHost(this.normalize(input),site),existing=await this.records(tx,subject,site),same=existing.find(r=>canonical({...r,id:0,createdAt:0,source:0})===canonical({...record,id:0,createdAt:0,source:0}));if(same)return same;
  if(existing.length>=this.limits.records)fail('rate_limited','Too many blocked requests for this app. Remove some first.');
  const id=this.crypto.randomUUID(),stored={id,...record,createdAt:this.clock(),source};await tx.set(suppressionKey('s',subject,site,id),stored);return stored;
 }
 async remove(tx,{subject,site,id}){if(typeof id!=='string'||!boundedString(id,64))fail('invalid_args');const name=suppressionKey('s',subject,site,id),record=await tx.get(name);if(!record)return {removed:false};await tx.delete(name);return {removed:true};}
 /** Removes the records that suppress `item` (the owner revealed and answered it on the provider page). */
 // IA-R3: only fragment/field records naming this item; app- and kind-wide blocks stay until the owner removes them.
 async lift(tx,{subject,site,item}){for(const record of await this.records(tx,subject,site))if(['fragment','field'].includes(record.scope)&&suppresses(record,item))await tx.delete(suppressionKey('s',subject,site,record.id));}
 async matching(tx,{subject,site,item}){return (await this.records(tx,subject,site)).filter(record=>suppresses(record,item));}
 /** Caps (§10): every admitted entry counts, whatever happens to it. Throws `rate_limited` when over. */
 async checkCaps(tx,{subject,site}){
  const now=this.clock(),record=await tx.get(suppressionKey('c',subject,site))??{times:[]},times=record.times.filter(t=>t>now-30*DAY),{hour,day,month}=this.limits;
  const over=(span,limit)=>{const inside=times.filter(t=>t>now-span);return inside.length>=limit?inside[inside.length-limit]+span:0;};
  const until=Math.max(over(HOUR,hour),over(DAY,day),over(30*DAY,month));return {times,until};
 }
 async count(tx,{subject,site,times}){times.push(this.clock());await tx.set(suppressionKey('c',subject,site),{times:times.slice(-Math.max(this.limits.month,this.limits.day,this.limits.hour)),expiresAt:this.clock()+30*DAY});}
 /** The end of the longest active cooldown among `targets`, or 0. */
 async cooling(tx,{subject,site,targets}){
  const now=this.clock();let until=0;
  for(const target of targets){const record=await tx.get(suppressionKey('l',subject,site,target));if(!record||now-record.last>=this.limits.ladderResetMs)continue;const step=this.limits.ladder[Math.min(record.count,this.limits.ladder.length)-1];if(now<record.last+step)until=Math.max(until,record.last+step);}
  return until;
 }
 /** One ladder step per target for a decision the owner saw and made (decline, notice return). */
 async step(tx,{subject,site,targets}){
  const now=this.clock();for(const target of new Set(targets)){const name=suppressionKey('l',subject,site,target),record=await tx.get(name),fresh=!record||now-record.last>=this.limits.ladderResetMs;await tx.set(name,{target,count:fresh?1:record.count+1,last:now,expiresAt:now+this.limits.ladderResetMs});}
  const name=suppressionKey('d',subject,site),declines=(await tx.get(name))?.times?.filter(t=>t>now-this.limits.appScopeOffer.windowMs)??[];declines.push(now);await tx.set(name,{times:declines.slice(-16),expiresAt:now+this.limits.appScopeOffer.windowMs});
 }
 /** The owner granted or configured the target themselves: its ladder starts over. */
 async reset(tx,{subject,site,targets}){for(const target of new Set(targets))await tx.delete(suppressionKey('l',subject,site,target));}
 /** CX §6.4: the app-wide option is offered after 3 declines from one app within 7 days. */
 async offerAppScope(tx,{subject,site}){const now=this.clock(),times=(await tx.get(suppressionKey('d',subject,site)))?.times??[];return times.filter(t=>t>now-this.limits.appScopeOffer.windowMs).length>=this.limits.appScopeOffer.declines;}
 /** Owner listing: every record with scope and date, per app site (§9.2). */
 async list(tx,{subject,site}){const prefix=site?suppressionKey('s',subject,site,''):suppressionKey('s',subject,'');return (await tx.list(prefix)).map(row=>({site:decodeURIComponent(row.key.slice(suppressionKey('s',subject,'').length).split('/')[0]),...row.value})).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));}
 /** Account export and deletion (§9.2): suppressions, counters and ladders of one entity. */
 async export(tx,{subject}){return {suppressions:await this.list(tx,{subject})};}
 async erase(tx,{subject}){let removed=0;for(const kind of ['s','c','l','d'])for(const row of await tx.list(suppressionKey(kind,subject,''))){await tx.delete(row.key);removed++;}return {removed};}
}
const enabled=config=>{if(config?.INCREMENTAL_AUTH_ENABLED!==true&&config?.INCREMENTAL_AUTH_ENABLED!=='true')fail('not_found','Not found.');};
/** Owner operations (CX §7.1 access views; mounted by CX-3). The owner names an app by client ID; the provider maps it
 * to the app site. Removing a suppression never re-sends or replays an earlier request. */
export class SuppressionList extends AppQuery {static operation='federation.incremental.suppressions';static deps=['config','incremental'];fetch({config,incremental}){enabled(config);return incremental.suppressionList(ownerOf(this.actor),this.input??{});}}
export class SuppressionAdd extends AppAction {static operation='federation.incremental.suppress';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.suppressionAdd(ownerOf(this.actor),this.input);}}
export class SuppressionRemove extends AppAction {static operation='federation.incremental.unsuppress';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.suppressionRemove(ownerOf(this.actor),this.input);}}
export class SuppressionExport extends AppQuery {static operation='federation.incremental.export';static deps=['config','incremental'];fetch({config,incremental}){enabled(config);return incremental.suppressionExport(ownerOf(this.actor));}}
export class SuppressionErase extends AppAction {static operation='federation.incremental.erase';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.suppressionErase(ownerOf(this.actor));}}
/** The owner granted or configured a target from the provider's own interface (§10 ladder reset). */
export class RequestOwnerActed extends AppAction {static operation='federation.incremental.owner-acted';static deps=['config','incremental'];run({config,incremental}){enabled(config);return incremental.ownerActed(ownerOf(this.actor),this.input);}}
