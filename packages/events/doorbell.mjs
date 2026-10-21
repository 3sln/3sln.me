// EV-3, push doorbells for provider-hosted event buses (docs/spec/events.md §4.3, §6.3, §7.2, §8, §9;
// docs/architecture/consent-experience.md EV-3). A doorbell is data-free: the integration SET `bus-advanced/v1` carries
// only the subscriber's own bus resource id and the bus `head` (a cursor hint) beside the X6 `connection`, `generation`
// and `seq`. The subscriber then pulls with `read` from its own cursor under a live grant check.
//
// Rows (account store, beside EV-2's evbus/ rows):
//   evbus/sub/<bus>/<connection>   one subscription per (bus, connection); the read-approval epoch and connection
//                                  generation it was created under, the reader principal, `notified` (the last head
//                                  rung), `rangAt` and the subscription's hourly window
//   evbus/push/<bus>               owner switch: {enabled:false} pauses doorbells for every subscriber of the bus
//   evbus/meter/<day>/bell/<hour>[/<bus>]  doorbell budget counters in the event-allowance meter family (EV-2 sweeps
//                                  them); never the owner's storage-write, work or activity meters
//
// Delivery reuses the X6 outbox (packages/runtime/integration-events.mjs, "EV-3 doorbell hunk"): a publish only moves
// the bus head and kicks the account alarm; `ring` compares each live subscription's `notified` with the visible head
// and enqueues at most one pending `bus-advanced` row per subscription (coalesced, never queued). Doorbell rows have
// their own row budget there and the lowest priority, so they never block an owner write (a preferences marker in the
// owner's commit) or a revocation SET. The payload is rebuilt from live state (including the live grant port) before
// the lease, re-checked inside the X6 lease commit and again just before egress, so no doorbell is leased after the
// commit that revokes the reader, suspends the connection or deletes the bus; one already leased and in flight may
// still arrive (§8 "requests already admitted may complete"; it is data-free). `cancel` additionally deletes the
// subscription and its pending row in the revoking commit.
//
// Flags: the provider refuses with `not_found` unless the composition passes enabled (EVENT_BUSES_ENABLED and
// INTEGRATIONS_ENABLED, both default off).
import {Provider} from '../../vendor/ngin/index.js';
import {AppAction,AppQuery,operations} from '../app/engine.mjs';
import {AppFault} from '../app/faults.mjs';
import {busActor} from './store.mjs';
import {principalKey} from './cursor.mjs';

export const BUS_ADVANCED_EVENT='https://spec.bindle.example/events/bus-advanced/v1';
/** Reference-host values of §9 (provisional). `perSubscriptionHourly` is the static fair share floor(hourly/perAccount):
 * the account and per-bus caps can therefore never bind, so one subscriber's doorbell budget never depends on another
 * subscriber's activity (consumer isolation, §6.3). */
export const DOORBELL_LIMITS=Object.freeze({perBus:16,perAccount:64,perConnection:8,windowMs:5000,hourly:2000,busShare:0.25,perSubscriptionHourly:31});
const L=DOORBELL_LIMITS;
const fault=(code,message,status=400)=>{throw new AppFault(code,message,status);};
const forbidden=()=>fault('forbidden','This feed access is not allowed.',403);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const UUIDISH=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,CONNECTION=/^[A-Za-z0-9._~-]{1,128}$/,OWNER=/^[a-f0-9-]{36}$/;
const httpsId=v=>{if(typeof v!=='string'||v.length>512||/[\u0000- \u007f]/.test(v))return false;try{const u=new URL(v);return u.protocol==='https:'&&u.href===v&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}};
const K={sub:(bus,connection)=>`evbus/sub/${bus}/${connection}`,subs:bus=>bus?`evbus/sub/${bus}/`:'evbus/sub/',push:bus=>`evbus/push/${bus}`,bus:id=>`evbus/bus/${id}`,reader:(bus,p)=>`evbus/reader/${bus}/${p}`,
 meter:(now,bus)=>`evbus/meter/${Math.floor(now/86400000)}/bell/${Math.floor(now/3600000)}${bus?'/'+bus:''}`};
const rows=async(tx,prefix,limit)=>[...(await tx.list({prefix,limit})).entries()];
const hourOf=now=>Math.floor(now/3600000),nextHour=now=>(hourOf(now)+1)*3600000;
const min=(a,b)=>a===null?b:Math.min(a,b);
const DEAD=Symbol('dead'),PAUSED=Symbol('paused');
const pushable=r=>r?.integration?.kind==='external'&&typeof r.integration.snapshot?.manifest?.events_endpoint==='string'&&Array.isArray(r.integration.snapshot.manifest.events)&&r.integration.snapshot.manifest.events.includes(BUS_ADVANCED_EVENT);

/** Live state of one subscription inside a transaction: DEAD (delete it), PAUSED (owner switch), or {head, floor}. A
 * subscription lives only while its bus incarnation, the reader floor of the same read approval, the same active
 * connection generation and the connection's subscription to `bus-advanced` all hold (§4.3, §8). */
async function live(tx,sub){
 const bus=await tx.get(K.bus(sub.bus));
 if(!bus||bus.state!=='active'||bus.incarnation!==sub.incarnation||!bus.spec?.readers?.includes('application'))return DEAD;
 const reader=await tx.get(K.reader(sub.bus,sub.principal));if(!reader||reader.epoch!==sub.epoch||!Number.isSafeInteger(reader.floor))return DEAD;
 const c=await tx.get('resource/'+sub.connection);
 if(c?.kind!=='app-connection'||c.status!=='active'||c.generation!==sub.generation||c.clientId!==sub.clientId||!pushable(c))return DEAD;
 if((await tx.get(K.push(sub.bus)))?.enabled===false)return PAUSED;
 return {head:bus.head,floor:reader.floor};
}

/** X6 send-time hook (inside the lease commit as well): the doorbell body for a pending `bus-advanced` row, or null
 * when it must be dropped. `head` is reported only above the reader's floor (§4.2), so it never reveals activity
 * before the floor. */
export async function doorbellTarget(tx,{row,connection,owner,subscribed}){
 if(!plain(row)||typeof row.bus!=='string'||!plain(connection))return null;
 const sub=await tx.get(K.sub(row.bus,row.connection));
 if(!sub||sub.connection!==connection.id||sub.generation!==connection.generation||sub.resource!==row.resource)return null;
 const state=await live(tx,sub);if(state===DEAD||state===PAUSED||state.head<=state.floor)return null;
 // EV3-R1: outside a commit (`subscribed` given) the live grant (read and subscribe) is consulted too, fail closed.
 if(subscribed!==undefined&&!await grantHolds(subscribed,owner,sub))return null;
 return {bus:sub.resource,head:state.head};
}

/** The live grant port: true only when the reader's grant still includes `read` and `subscribe` (§4.3, §8). */
export async function grantHolds(subscribed,owner,sub){if(typeof subscribed!=='function')return false;try{return await subscribed({owner,bus:sub.bus,clientId:sub.clientId,connection:sub.connection,generation:sub.generation,epoch:sub.epoch})===true;}catch{return false;}}

/** X6 lease hook: the window is measured from the latest attempt too, so a doorbell delayed in the outbox is never
 * followed by another within 5 s (§7.2, §9). Retries of the same doorbell are integrations §6.4 retries. */
export async function markDoorbellSent(tx,{row,now}){const key=K.sub(row.bus,row.connection),sub=await tx.get(key);if(sub&&Number.isSafeInteger(now)&&now>sub.rangAt)await tx.put(key,{...sub,rangAt:now});}

/** Wraps EV-2's notifier ({advance, revoke} of the wait object) so a successful publish also kicks the account alarm
 * (`kick(owner)`, the X6 `integrationEventsKick`). Failures are swallowed: a missed kick only delays a doorbell until
 * the next alarm, and never fails a publish. */
export function withDoorbellKick(notifier,kick,{store}={}){
 if(typeof kick!=='function')return notifier;
 // EV3-R4: with the account store, only a bus that has a subscription kicks (one bounded list per publish).
 const wanted=async bus=>!store||typeof bus==='string'&&UUIDISH.test(bus)&&(await store.list({prefix:K.subs(bus),limit:1})).size>0;
 return {...notifier??{},async advance(input){try{await notifier?.advance?.(input);}finally{try{if(await wanted(input?.bus))await kick(input.owner);}catch{}}},...notifier?.revoke?{revoke:input=>notifier.revoke(input)}:{},...notifier?.wait?{wait:input=>notifier.wait(input)}:{}};
}

class Doorbells{
 constructor(x){Object.assign(this,x);}
 now(){return this.clock.now();}
 async remove(tx,key,sub){await tx.delete(key);await this.cancel(tx,{connection:sub.connection,bus:sub.bus});}
 /** App: subscribe the calling connection to doorbells for one bus. The resource handler has authorized `subscribe`
  * under the reader's grant; `epoch` is that grant's read-approval identity and `resource` the bus id it called. */
 async subscribe(actor,{bus,resource,epoch}){
  const who=busActor(actor);if(who.kind!=='application')forbidden();
  if(typeof bus!=='string'||!UUIDISH.test(bus)||!httpsId(resource)||typeof epoch!=='string'||!epoch||epoch.length>256)forbidden();
  // EV3-R6a: the doorbell names exactly the resource this bus is published as.
  if(typeof this.issuer!=='string'||resource!==`${this.issuer}/entities/${this.owner}/buses/${bus}`)forbidden();
  if(!await grantHolds(this.subscribed,this.owner,{bus,clientId:actor.clientId,connection:actor.connection.id,generation:actor.connection.generation,epoch}))forbidden();
  const principal=await principalKey(this.keys,'client',who.client),now=this.now();
  return this.store.transaction(async tx=>{
   const row=await tx.get(K.bus(bus));if(!row||row.state!=='active'||row.owner!==this.owner)fault('not_found','Feed not found.',404);
   if(!row.spec.readers.includes('application'))forbidden();
   const reader=await tx.get(K.reader(bus,principal));if(!reader||reader.epoch!==epoch)forbidden();
   const c=await tx.get('resource/'+actor.connection.id);
   if(c?.kind!=='app-connection'||c.status!=='active'||c.generation!==actor.connection.generation||c.clientId!==actor.clientId)forbidden();
   if(!pushable(c))fault('unsupported_method','This app cannot receive feed notifications.',400);
   const key=K.sub(bus,c.id),prior=await tx.get(key);
   if(prior&&prior.generation===c.generation&&prior.epoch===epoch&&prior.resource===resource&&prior.incarnation===row.incarnation)return {subscribed:true};
   if(!prior){
    // EV3-R3: dead rows are reaped before counting, so only live subscriptions count; a connection's own cap (8) binds
    // first for most callers. The per-bus and per-account caps (§9) refuse identically; residual in the review record.
    let all=0,onBus=0,mine=0;
    for(const [k,s] of await rows(tx,K.subs(),L.perAccount*2+1)){if(await live(tx,s)===DEAD){await this.remove(tx,k,s);continue;}all++;if(s.bus===bus)onBus++;if(s.connection===c.id)mine++;}
    if(mine>=L.perConnection||onBus>=L.perBus||all>=L.perAccount)fault('rate_limited','Too many feed notification subscriptions.',429);
   }else await this.cancel(tx,{connection:c.id,bus});
   await tx.put(key,{v:1,bus,connection:c.id,generation:c.generation,clientId:actor.clientId,principal,epoch,incarnation:row.incarnation,resource,createdAt:now,notified:row.head,rangAt:0,hour:hourOf(now),count:0});
   return {subscribed:true};
  });
 }
 /** App: idempotent; removes this connection's subscription and its pending doorbell. */
 async unsubscribe(actor,{bus}){
  busActor(actor);if(typeof bus!=='string'||!UUIDISH.test(bus))forbidden();
  return this.store.transaction(async tx=>{const key=K.sub(bus,actor.connection.id),sub=await tx.get(key);if(sub&&sub.clientId===actor.clientId)await this.remove(tx,key,sub);return {subscribed:false};});
 }
 /** System (revocation, reduction, disconnect, bus deletion hooks): deletes matching subscriptions and their pending
  * doorbells in one commit. `tx` lets a revoking commit call it in-line. */
 async cancelMatching(match,tx){
  const run=async t=>{let n=0;for(const [key,sub] of await rows(t,K.subs(match.bus),L.perAccount*2+1)){if(match.clientId!==undefined&&sub.clientId!==match.clientId||match.connection!==undefined&&sub.connection!==match.connection)continue;await this.remove(t,key,sub);n++;}return {cancelled:n};};
  return tx?run(tx):this.store.transaction(run);
 }
 /** Owner: pause or resume doorbells for every subscriber of a bus. Pausing drops pending doorbells. */
 async setPush({bus,enabled}){
  if(typeof bus!=='string'||!UUIDISH.test(bus)||typeof enabled!=='boolean')fault('invalid_request','Unsupported feed notification setting.');
  return this.store.transaction(async tx=>{const row=await tx.get(K.bus(bus));if(!row||row.state!=='active'||row.owner!==this.owner)fault('not_found','Feed not found.',404);
   if(enabled)await tx.delete(K.push(bus));else{await tx.put(K.push(bus),{enabled:false,at:this.now()});for(const [,sub] of await rows(tx,K.subs(bus),L.perBus*2+1))await this.cancel(tx,{connection:sub.connection,bus});}
   return {bus,push:enabled};});
 }
 /** Owner: subscription health for a bus (host owner interface, §5); never reachable by an app. */
 async subscriptions({bus}){
  if(typeof bus!=='string'||!UUIDISH.test(bus))fault('invalid_request','Unsupported feed request.');
  const row=await this.store.get(K.bus(bus));if(!row||row.state!=='active'||row.owner!==this.owner)fault('not_found','Feed not found.',404);
  const paused=(await this.store.get(K.push(bus)))?.enabled===false;
  return {push:!paused,subscriptions:(await rows(this.store,K.subs(bus),L.perBus*2+1)).map(([,s])=>({clientId:s.clientId,connection:s.connection,createdAt:s.createdAt,lastRungAt:s.rangAt||null}))};
 }
 /**
  * System (account alarm, after a publish kick): one bounded pass over every subscription in one commit. Rings a
  * subscription when its visible head moved past `notified`, its 5 s window has passed and its fair share of the hourly
  * budget remains; otherwise the advance stays coalesced in the head and `next` says when to look again. Dead
  * subscriptions are deleted with their pending rows. Returns a tally and `next` (ms epoch or null).
  */
 async ring(){
  const now=this.now(),checks=new Map();
  // EV3-R1: the live grant port (read and subscribe still granted) is mandatory and consulted outside the commit.
  for(const [key,sub] of await rows(this.store,K.subs(),L.perAccount*2+1))checks.set(key,await grantHolds(this.subscribed,this.owner,sub));
  return this.store.transaction(async tx=>{
   const tally={rung:0,coalesced:0,windowed:0,budget:0,full:0,paused:0,cancelled:0};let next=null;
   const account=K.meter(now),hourly=Math.min(L.hourly,L.perSubscriptionHourly*L.perAccount),busCap=Math.floor(L.hourly*L.busShare);
   for(const [key,sub] of await rows(tx,K.subs(),L.perAccount*2+1)){
    const state=checks.get(key)===false?DEAD:await live(tx,sub);
    if(state===DEAD){await this.remove(tx,key,sub);tally.cancelled++;continue;}
    if(state===PAUSED){tally.paused++;continue;}
    if(state.head<=Math.max(sub.notified,state.floor))continue;
    if(now-sub.rangAt<L.windowMs){tally.windowed++;next=min(next,sub.rangAt+L.windowMs);continue;}
    const count=sub.hour===hourOf(now)?sub.count:0,used=await tx.get(account)??0,onBus=await tx.get(K.meter(now,sub.bus))??0;
    if(count>=L.perSubscriptionHourly||used>=hourly||onBus>=busCap){tally.budget++;next=min(next,nextHour(now));continue;}
    let out;try{out=await this.enqueue(tx,{type:'bus-advanced',connection:sub.connection,bus:sub.bus,resource:sub.resource},{now});}
    catch(error){if(error?.code!=='integration_events_full')throw error;tally.full++;next=min(next,now+L.windowMs);continue;}
    // EV3-R6c: a coalesced advance leaves the subscription untouched, so an in-flight older doorbell never hides it.
    if(out?.coalesced){tally.coalesced++;continue;}
    tally.rung++;await tx.put(account,used+1);await tx.put(K.meter(now,sub.bus),onBus+1);
    await tx.put(key,{...sub,notified:state.head,rangAt:now,hour:hourOf(now),count:count+1});
   }
   // Owner switches of buses that no longer exist.
   for(const [key] of await rows(tx,'evbus/push/',65)){const bus=await tx.get(K.bus(key.slice('evbus/push/'.length)));if(!bus||bus.state!=='active')await tx.delete(key);}
   return {...tally,next};
  });
 }
}

/**
 * The `eventDoorbells` provider class for createAppEngine. Options (trusted composition only):
 *   enabled     EVENT_BUSES_ENABLED and INTEGRATIONS_ENABLED
 *   keys        async () => busKeys(config) (null refuses: fail closed)
 *   enqueue     (tx, event, {now}) => {coalesced}: X6 enqueueIntegrationEvent
 *   cancel      (tx, {connection, bus}) => boolean: X6 cancelIntegrationDoorbell
 *   subscribed  async ({owner, bus, clientId, connection, epoch}) => boolean: the live grant still includes `read` and
 *               `subscribe` (required: without it nothing is subscribed or rung, EV3-R1)
 *   issuer      APP_ORIGIN (bus resource ids)
 */
export function eventDoorbellsProvider({enabled=false,keys,enqueue,cancel,subscribed,issuer}={}){
 const options=Object.freeze({enabled:enabled===true,keys,enqueue,cancel,subscribed,issuer});
 return class extends EventDoorbellsProvider{static deps=['accountStore','clock'];constructor(deps){super(deps,options);}};
}
export class EventDoorbellsProvider extends Provider{
 #deps;#options;#held=new WeakMap();
 constructor(deps,options){super();this.#deps=deps;this.#options=options;}
 async obtain({actor}={}){
  const o=this.#options;if(!o?.enabled)fault('not_found','Not found.',404);
  if(!['owner','system','app'].includes(actor?.kind)||typeof actor.owner!=='string'||!OWNER.test(actor.owner))fault('unauthorized','Sign in to continue.',401);
  if(actor?.kind!=='owner'&&(typeof o.enqueue!=='function'||typeof o.cancel!=='function'||typeof o.subscribed!=='function'))fault('temporarily_unavailable','Feed notifications are unavailable.',503);
  const resources={},obtained=[];
  try{
   for(const name of ['accountStore','clock']){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
   const bound=await resources.accountStore.get('owner');if(bound!==undefined&&bound!==actor.owner)fault('forbidden','Account owner mismatch.',403);
   const keys=actor.kind==='app'?await o.keys?.():null;if(actor.kind==='app'&&!keys)fault('temporarily_unavailable','Feeds are unavailable.',503);
   const d=new Doorbells({store:resources.accountStore,clock:resources.clock,owner:actor.owner,keys,enqueue:o.enqueue,cancel:o.cancel,subscribed:o.subscribed,issuer:o.issuer});
   const frozen=Object.freeze(structuredClone(actor));let handle;
   if(actor.kind==='owner')handle={setPush:v=>d.setPush(v),subscriptions:v=>d.subscriptions(v)};
   else if(actor.kind==='system')handle={ring:()=>d.ring(),cancel:v=>d.cancelMatching(v)};
   else{if(!plain(actor.connection)||typeof actor.connection.id!=='string'||!CONNECTION.test(actor.connection.id))forbidden();handle={subscribe:v=>d.subscribe(frozen,v),unsubscribe:v=>d.unsubscribe(frozen,v)};}
   handle=Object.freeze(handle);this.#held.set(handle,{resources,obtained});return handle;
  }catch(error){for(const name of obtained)await this.#deps[name].release(resources[name]);throw error;}
 }
 async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained)await this.#deps[name].release(held.resources[name]);}
}
const role=(handle,method)=>{if(typeof handle[method]!=='function')fault('forbidden','This operation is not available to this caller.',403);return handle;};
const input=(value,names)=>{if(value===undefined)return {};if(!plain(value)||Object.keys(value).some(k=>!names.includes(k)))fault('invalid_request','Unsupported feed notification request.');return value;};
const CHANGED='event-doorbells-changed';

/** App, constructed only by the resource handler holding verified authority: `id` is the bus; `resource` (the bus id the
 * app called) and `epoch` (the grant's read-approval identity) travel as constructor options, never from the wire. */
class DoorbellAppAction extends AppAction{
 static deps=['eventDoorbells'];
 constructor({actor,id,input:args,resource,epoch}={}){super({actor,id,input:args});Object.assign(this,{resource,epoch});}
}
export class SubscribeEventBus extends DoorbellAppAction{static operation='events.subscribe';static changes=CHANGED;run({eventDoorbells}){input(this.input,[]);return role(eventDoorbells,'subscribe').subscribe({bus:this.id,resource:this.resource,epoch:this.epoch});}}
export class UnsubscribeEventBus extends DoorbellAppAction{static operation='events.unsubscribe';static changes=CHANGED;run({eventDoorbells}){input(this.input,[]);return role(eventDoorbells,'unsubscribe').unsubscribe({bus:this.id});}}
/** Owner. `id` is the bus; `input`: {enabled}. */
export class SetEventBusPush extends AppAction{static operation='events.push';static deps=['eventDoorbells'];static changes=CHANGED;run({eventDoorbells}){const {enabled}=input(this.input,['enabled']);return role(eventDoorbells,'setPush').setPush({bus:this.id,enabled});}}
export class EventBusSubscriptions extends AppQuery{static operation='events.subscriptions';static deps=['eventDoorbells'];static refreshOn=[CHANGED];fetch({eventDoorbells}){return role(eventDoorbells,'subscriptions').subscriptions({bus:this.id});}}
/** System. `input`: {clientId?, connection?} with optional `id` (one bus); at least one selector. */
export class CancelEventDoorbells extends AppAction{static operation='events.doorbells-cancel';static deps=['eventDoorbells'];static changes=CHANGED;static lifecycle='purging';
 run({eventDoorbells}){const {clientId,connection}=input(this.input,['clientId','connection']);if(clientId===undefined&&connection===undefined||clientId!==undefined&&(typeof clientId!=='string'||!clientId||clientId.length>512)||connection!==undefined&&(typeof connection!=='string'||!CONNECTION.test(connection))||this.id!==undefined&&(typeof this.id!=='string'||!UUIDISH.test(this.id)))fault('invalid_request','Name the app or connection.');
  return role(eventDoorbells,'cancel').cancel({...this.id!==undefined?{bus:this.id}:{},...clientId!==undefined?{clientId}:{},...connection!==undefined?{connection}:{}});}}
/** System. One ring pass (see Doorbells.ring). */
export class RingEventDoorbells extends AppAction{static operation='events.doorbells-ring';static deps=['eventDoorbells'];static lifecycle='purging';run({eventDoorbells}){input(this.input,[]);return role(eventDoorbells,'ring').ring();}}
export const EVENT_DOORBELL_OPERATIONS=operations(SubscribeEventBus,UnsubscribeEventBus,SetEventBusPush,EventBusSubscriptions,CancelEventDoorbells,RingEventDoorbells);
export const EVENT_DOORBELL_APP_OPERATIONS=Object.freeze({subscribe:SubscribeEventBus,unsubscribe:UnsubscribeEventBus});
