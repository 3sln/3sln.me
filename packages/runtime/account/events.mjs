// AccountController slice EV-2, event buses (docs/spec/events.md; docs/architecture/consent-experience.md §12).
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists what `invoke` accepts
// (packages/runtime/account/index.mjs). Everything answers `not_found` unless EVENT_BUSES_ENABLED is on.
//
// Entry points:
//   eventBusOwner(owner, {operation, id, input})     owner operations (EVENT_BUS_OWNER_OPERATIONS); `events.create`
//       takes only {url} and resolves the manifest from the reviewed registry (FEDERATION_SCHEMAS) itself.
//   eventBusReader(owner, {operation, id, input})    trusted hooks: 'approved' {clientId, readSince, history?} sets a
//       reader floor when consent first grants `read`, 'revoked' drops reader state and rings held waits (federation revocation; integration hunk).
//   eventBusResourceMethod(c, owner, context)        the RESOURCE_METHOD_HANDLERS entry for `event-bus/v1`.
//   eventBusSweep(owner) / eventBusDescriptors(owner) internal: maintenance and federation resource descriptors.
//
// Long-polls: the handler holds nothing. With `context.busWaits === true` (the calling adapter holds waits in the
// EVENT_BUS_WAITS object, packages/events/waiter.mjs `holdBusRead`), an empty read with `wait` answers `{wait}` and
// the adapter resumes with `context.busResume`. Otherwise `wait` is served as 0 and descriptors advertise
// `maxWaitSeconds: 0`. Both members are set by host code, never from RPC arguments.
import {createAppEngine,perform,read,AppQuery} from '../../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../../app/providers.mjs';
import {eventBusProvider,EVENT_BUS_OPERATIONS,EVENT_BUS_OWNER_OPERATIONS,EVENT_BUS_APP_OPERATIONS,ApproveEventBusReader,RevokeEventBusReader,SweepEventBuses,EventBusDescriptors} from '../../app/domains/events.mjs';
import {busKeys,eventBusesEnabled,EVENT_BUS_CONTRACT,busWaitsPort} from '../../events/index.mjs';
import {BILLING_STATE_KEY,entitlementFromState} from '../../billing/catalog.mjs';
import {withDoorbellKick} from '../../events/doorbell.mjs';
import {StorageError} from '../../storage/policy.mjs';

const byName=Object.fromEntries(EVENT_BUS_OPERATIONS.map(Operation=>[Operation.operation,Operation]));
const notFound=()=>{throw new StorageError('not_found','Not found.',404);};
const forbidden=()=>{throw new StorageError('forbidden','This feed access is not allowed.',403);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const parsed=value=>{if(value===undefined||value==='')return undefined;try{return typeof value==='string'?JSON.parse(value):value;}catch{return undefined;}};
const bareDigest=value=>typeof value==='string'?value.replace(/^sha256-/,''):null;

/** The notifier/wait port: the Worker namespace binding, or an injected port (Node, tests). */
export const eventBusWaits=config=>busWaitsPort(config.EVENT_BUS_WAITS)??(typeof config.EVENT_BUS_WAITER?.advance==='function'?config.EVENT_BUS_WAITER:null);
const engines=new WeakMap();
function eventBusEngine(c){
 let engine=engines.get(c);
 if(!engine){
  let keys;const waits=eventBusWaits(c.config),notifier=withDoorbellKick(waits,owner=>c.integrationEventsKick(owner),{store:c.metadata});
  engine=createAppEngine({providers:{clock:systemClock,random:cryptoRandom,audit:nullAudit,accountStore:c.metadata,eventBus:eventBusProvider({enabled:eventBusesEnabled(c.config),keys:()=>keys??=busKeys(c.config),issuer:c.config.APP_ORIGIN,
   plan:async store=>{const state=await store.get(BILLING_STATE_KEY);return entitlementFromState(state,Date.now(),c.config).plan==='free'?'free':'paid';},notifier,waits:!!waits&&c.config.EVENT_BUS_WAITS_MOUNTED===true})}});
  engines.set(c,engine);
 }
 return engine;
}
const run=(c,operation)=>operation instanceof AppQuery?read(eventBusEngine(c),operation):perform(eventBusEngine(c),operation);
const shape=value=>{if(value!==undefined&&!plain(value))throw new StorageError('invalid_request','Unsupported feed request.');return value===undefined?undefined:structuredClone(value);};
/** A bus manifest from the reviewed fragment registry (the same registry federation pins from); never fetched here. */
function reviewedManifest(c,url){
 const registry=typeof c.config.EVENT_BUS_MANIFESTS==='function'?null:parsed(c.config.FEDERATION_SCHEMAS)??{};
 const document=typeof c.config.EVENT_BUS_MANIFESTS==='function'?c.config.EVENT_BUS_MANIFESTS(url):plain(registry)&&Object.hasOwn(registry,url)?registry[url]:undefined;
 if(!plain(document))throw new StorageError('untrusted_schema_host','This feed manifest has not been registered with this provider.',400);
 return structuredClone(document);
}
/** Verified publisher origin: the reviewed client's configured origin, else the https origin of a metadata-document id. */
function clientOrigin(c,clientId){
 const clients=parsed(c.config.FEDERATION_CLIENTS);const reviewed=Array.isArray(clients)?clients.find(client=>client?.id===clientId):null;
 if(reviewed){try{return new URL(reviewed.origin??reviewed.id).origin;}catch{forbidden();}}
 try{const url=new URL(clientId);if(url.protocol==='https:')return url.origin;}catch{}forbidden();
}

export const methods={
  async eventBusOwner(owner,{operation,id,input}={}){
   if(!eventBusesEnabled(this.config)||typeof operation!=='string'||![...EVENT_BUS_OWNER_OPERATIONS,'events.push','events.subscriptions'].includes(operation))notFound();
   await this.warm(owner);if(['events.push','events.subscriptions'].includes(operation))return this.eventDoorbellOwner(owner,{operation,id,input});let value=shape(input);
   if(operation==='events.create'){if(!plain(value)||Object.keys(value).some(key=>key!=='url')||typeof value.url!=='string')throw new StorageError('invalid_request','Choose a registered feed manifest.');value={url:value.url,manifest:reviewedManifest(this,value.url)};}
   await this.scheduleAlarm(Date.now()+600000);
   const result=await run(this,new byName[operation]({actor:{kind:'owner',owner},...id!==undefined?{id}:{},...value!==undefined?{input:value}:{}}));
   if(operation==='events.delete')await this.eventDoorbellCancel(owner,{id});
   if(['events.purge','events.delete'].includes(operation))await this.eventBusSweep(owner).catch(()=>{});return result;
  },
  async eventBusReader(owner,{operation,id,input}={}){
   if(!eventBusesEnabled(this.config)||!['approved','revoked'].includes(operation))notFound();
   await this.warm(owner);const Operation=operation==='approved'?ApproveEventBusReader:RevokeEventBusReader;let value=shape(input);
   // One epoch derivation with the resource handler: `grant:<readSince>` (review hardening note on EV2-S1).
   if(operation==='approved'){const {clientId,readSince,history}=value??{};if(typeof readSince!=='string'||!readSince||readSince.length>200)throw new StorageError('invalid_request','Reader approval needs its read-approval identity.');value={clientId,epoch:`grant:${readSince}`,...history!==undefined?{history}:{}};}
   const result=await run(this,new Operation({actor:{kind:'system',owner},...id!==undefined?{id}:{},input:value}));if(operation==='revoked')await this.eventDoorbellCancel(owner,{id,clientId:value?.clientId});return result;
  },
  async eventBusSweep(owner){if(!eventBusesEnabled(this.config))return {more:false};return run(this,new SweepEventBuses({actor:{kind:'system',owner}}));},
  async eventBusDescriptors(owner){if(!eventBusesEnabled(this.config))return [];return run(this,new EventBusDescriptors({actor:{kind:'system',owner}}));},
};

export const rpc={
 eventBusOwner:{warm:true},
 eventBusReader:{warm:true},
 eventBusDescriptors:{warm:true},
};

/**
 * RESOURCE_METHOD_HANDLERS entry for `event-bus/v1`. Federation has authorized `context.method` on the bus resource
 * and re-authorized it immediately before this call; this handler additionally requires the authorizing fragment
 * grant (`context.grant {fragment, digest, readSince, history?}`), which must name this bus's manifest URL and pinned
 * digest, and fails closed without it. `readSince` identifies the read approval: it changes whenever read is revoked and
 * re-approved, never on widening or connection-generation changes (EV2-S1/S6), and is the reader-floor epoch. The live connection is checked here and again inside each commit.
 */
export async function eventBusResourceMethod(c,owner,context){
 if(!eventBusesEnabled(c.config))notFound();
 if(context.contract!==EVENT_BUS_CONTRACT)throw new StorageError('unsupported_contract','Unsupported contract.',400);
 if(!['publish','read','subscribe','unsubscribe'].includes(context.method))throw new StorageError('unsupported_method','Unsupported feed method.',400);
 const prefix=`${c.config.APP_ORIGIN}/entities/${owner}/buses/`,id=typeof context.resource==='string'&&context.resource.startsWith(prefix)?context.resource.slice(prefix.length):'';
 if(!UUID.test(id))forbidden();
 if(context.authority!=='bindle'||!context.epoch||typeof c.config.FEDERATION_IDENTITY_CHECK!=='function'||await c.config.FEDERATION_IDENTITY_CHECK(owner,context.epoch)!==true)forbidden();
 const connection=context.connection;if(!plain(connection)||typeof connection.id!=='string'||!Number.isSafeInteger(connection.generation)||typeof context.clientId!=='string')forbidden();
 const grant=context.grant;if(!plain(grant)||typeof grant.fragment!=='string'||typeof grant.digest!=='string'||typeof grant.readSince!=='string'||!grant.readSince||grant.readSince.length>200)forbidden();
 await c.warm(owner);await c.apps.check(owner,connection.id,connection.generation,context.clientId);
 const actor={kind:'app',owner,clientId:context.clientId,origin:clientOrigin(c,context.clientId),connection:{id:connection.id,generation:connection.generation}};
 const grants={
  check:async({bus,method})=>({allowed:method===context.method&&bus.id===id&&grant.fragment===bus.manifest&&bareDigest(grant.digest)===bareDigest(bus.digest),epoch:`grant:${grant.readSince}`,history:grant.history===true}),
  live:async(tx,who)=>{const r=await tx.get('resource/'+who.connection.id);return r?.owner===owner&&r.kind==='app-connection'&&r.status==='active'&&r.generation===who.connection.generation&&r.clientId===who.clientId;},
 };
 if(['subscribe','unsubscribe'].includes(context.method)){if(!plain(context.args)||Object.keys(context.args).length)throw new StorageError('invalid_request','Unsupported feed request.');return c.eventDoorbellApp(owner,{method:context.method,id,actor,resource:context.resource,epoch:`grant:${grant.readSince}`});}
 const Operation=EVENT_BUS_APP_OPERATIONS[context.method];
 // EV2-S4: bounded opportunistic maintenance at most every 10 minutes per controller; the account alarm hook is an
 // integration hunk required before the flag is enabled (idle buses are swept only then).
 if(!(c.eventBusSweptAt>Date.now()-600000)){c.eventBusSweptAt=Date.now();await c.eventBusSweep(owner).catch(()=>{});}
 return perform(eventBusEngine(c),new Operation({actor,id,input:context.args,grants,...context.method==='publish'?{tx:context.tx}:{hold:context.busWaits===true,...context.busResume!==undefined?{resume:context.busResume}:{}}}));
}
