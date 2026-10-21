// Event buses domain, EV-2 (docs/spec/events.md §3.1, §4–§9): the 3sln.me-hosted bus as engine operations over
// BusStore (packages/events/store.mjs). Everything is refused with `not_found` unless EVENT_BUSES_ENABLED is on.
//
// Actors (built by trusted adapters only, never from a request body; packages/runtime/account/events.mjs):
//   {kind:'owner', owner}                         list, inspect, create the built-in occupant, retention, purge,
//                                                 delete, history opt-in, provider-feature enablement
//   {kind:'system', owner}                        reader approval floors, revocation, sweeps, descriptors, limits
//   {kind:'app', owner, clientId, origin, connection:{id,generation}}
//                                                 publish and read on one bus, after federation authorized the method;
//                                                 the domain re-checks the grant live through the `grants` port
//   {kind:'feature', owner, feature}               a provider feature the owner enabled on that bus (§5)
// App and feature operations are NOT owner-dispatchable: the owner RPC always constructs an owner actor.
import {Provider} from '../../../vendor/ngin/index.js';
import {AppAction,AppQuery} from '../engine.mjs';
import {AppFault} from '../faults.mjs';
import {UUID} from '../../core/primitives.mjs';
import {BusStore} from '../../events/store.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const input=(value,names)=>{if(value===undefined)return {};if(!plain(value)||Object.keys(value).some(name=>!names.includes(name)))throw new AppFault('invalid_request','Unsupported feed request.',400);return value;};

/**
 * The `eventBus` provider class for createAppEngine. Options (all from trusted composition):
 *   enabled   EVENT_BUSES_ENABLED, from configuration
 *   keys      async () => busKeys(config) (null refuses: fail closed)
 *   issuer    APP_ORIGIN (`attested_by`)
 *   plan      async (accountStore) => 'free' | 'paid'
 *   grants    {check({actor,bus,method}), live?(tx,actor)}; a function (actor) => grants is called per obtain
 *   notifier  {advance, revoke} of the wait object; `waits` true when the adapter holds long-polls outside the account
 */
export function eventBusProvider({enabled=false,keys,issuer,plan,grants,notifier,waits=false,limits}={}){
 return class extends EventBusProvider{static deps=['accountStore','clock','random'];constructor(deps){super(deps);Object.assign(this,{enabled:enabled===true,keys,issuer,plan,grants,notifier,waits,limits});}};
}
export class EventBusProvider extends Provider{
 #deps;#held=new WeakMap();
 constructor(deps){super();this.#deps=deps;this.readRate=new Map();}
 async obtain({actor,bus,grants:callGrants}={}){
  if(!this.enabled)throw new AppFault('not_found','Not found.',404);
  if(!['owner','system','app','feature'].includes(actor?.kind)||typeof actor.owner!=='string'||!UUID.test(actor.owner))throw new AppFault('unauthorized','Sign in to continue.',401);
  const resources={},obtained=[];
  try{
   for(const name of this.constructor.deps){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
   const bound=await resources.accountStore.get('owner');if(bound!==undefined&&bound!==actor.owner)throw new AppFault('forbidden','Account owner mismatch.',403);
   const keys=await this.keys?.();if(!keys)throw new AppFault('temporarily_unavailable','Feeds are unavailable.',503);
   const plan=typeof this.plan==='function'?await this.plan(resources.accountStore):this.plan;
   const grants=callGrants??(typeof this.grants==='function'?this.grants(actor):this.grants);
   const store=new BusStore({accountStore:resources.accountStore,clock:resources.clock,random:resources.random,keys,owner:actor.owner,issuer:this.issuer,plan,grants,notifier:this.notifier,waits:this.waits,readRate:this.readRate,...this.limits?{limits:this.limits}:{}});
   const frozen=Object.freeze(structuredClone(actor));let handle;
   if(actor.kind==='owner')handle={list:()=>store.list(),get:id=>store.get(id),create:value=>store.create(value),setRetention:value=>store.setRetention(value),purge:value=>store.purge(value),remove:value=>store.remove(value),allowHistory:value=>store.allowHistory(value),setFeature:value=>store.setFeature(value)};
   else if(actor.kind==='system')handle={readerApproved:value=>store.readerApproved(value),readerRevoked:value=>store.readerRevoked(value),sweep:value=>store.sweep(value),descriptors:()=>store.descriptors(),limits:id=>store.limits(id)};
   else{if(typeof bus!=='string'||!UUID.test(bus))throw new AppFault('forbidden','This feed access is not allowed.',403);const at=store.at(bus);handle={publish:(args,options)=>at.publish(frozen,args,options),read:(args,options)=>at.read(frozen,args,options)};}
   handle=Object.freeze(handle);this.#held.set(handle,{resources,obtained});return handle;
  }catch(error){for(const name of obtained)await this.#deps[name].release(resources[name]);throw error;}
 }
 async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained)await this.#deps[name].release(held.resources[name]);}
}
const role=(handle,method)=>{if(typeof handle[method]!=='function')throw new AppFault('forbidden','This operation is not available to this caller.',403);return handle;};

// Owner operations.
export class EventBuses extends AppQuery{static operation='events.buses';static deps=['eventBus'];static refreshOn=['event-buses-changed'];fetch({eventBus}){return role(eventBus,'list').list();}}
export class EventBusDetail extends AppQuery{static operation='events.bus';static deps=['eventBus'];static refreshOn=['event-buses-changed'];fetch({eventBus}){return role(eventBus,'get').get(this.id);}}
/** `input`: {url, manifest} — the adapter resolves `manifest` from the reviewed registry; EV-1 re-validates it. */
export class CreateEventBus extends AppAction{static operation='events.create';static deps=['eventBus'];static changes='event-buses-changed';run({eventBus}){const {url,manifest}=input(this.input,['url','manifest']);return role(eventBus,'create').create({url,manifest});}}
export class SetEventBusRetention extends AppAction{static operation='events.retention';static deps=['eventBus'];static changes='event-buses-changed';run({eventBus}){const {seconds}=input(this.input,['seconds']);return role(eventBus,'setRetention').setRetention({bus:this.id,seconds});}}
export class PurgeEventBus extends AppAction{static operation='events.purge';static deps=['eventBus'];static changes='event-buses-changed';run({eventBus}){input(this.input,[]);return role(eventBus,'purge').purge({bus:this.id});}}
export class DeleteEventBus extends AppAction{static operation='events.delete';static deps=['eventBus'];static changes='event-buses-changed';run({eventBus}){input(this.input,[]);return role(eventBus,'remove').remove({bus:this.id});}}
export class AllowEventBusHistory extends AppAction{static operation='events.history';static deps=['eventBus'];static changes='event-buses-changed';run({eventBus}){const {clientId}=input(this.input,['clientId']);return role(eventBus,'allowHistory').allowHistory({bus:this.id,clientId});}}
export class SetEventBusFeature extends AppAction{static operation='events.feature';static deps=['eventBus'];static changes='event-buses-changed';run({eventBus}){const {feature,read,publish}=input(this.input,['feature','read','publish']);return role(eventBus,'setFeature').setFeature({bus:this.id,feature,read,publish});}}

// System operations.
export class ApproveEventBusReader extends AppAction{static operation='events.reader-approved';static deps=['eventBus'];run({eventBus}){const {clientId,epoch,history}=input(this.input,['clientId','epoch','history']);return role(eventBus,'readerApproved').readerApproved({bus:this.id,clientId,epoch,history});}}
export class RevokeEventBusReader extends AppAction{static operation='events.reader-revoked';static deps=['eventBus'];run({eventBus}){const {clientId}=input(this.input,['clientId']);return role(eventBus,'readerRevoked').readerRevoked({...this.id!==undefined?{bus:this.id}:{},clientId});}}
export class SweepEventBuses extends AppAction{static operation='events.sweep';static deps=['eventBus'];run({eventBus}){input(this.input,[]);return role(eventBus,'sweep').sweep();}}
export class EventBusDescriptors extends AppQuery{static operation='events.descriptors';static deps=['eventBus'];fetch({eventBus}){return role(eventBus,'descriptors').descriptors();}}
export class EventBusLimits extends AppQuery{static operation='events.limits';static deps=['eventBus'];fetch({eventBus}){return role(eventBus,'limits').limits(this.id);}}

// App and feature operations: constructed only by server-side code holding verified authority (the resource handler).
// `grants` (the live check for this call), `tx`, `hold` and `resume` travel as constructor options, never from the wire.
class BusAppAction extends AppAction{
 static deps=['eventBus'];
 constructor({actor,id,input:args,tx,resume,hold,grants}={}){super({actor,id,input:args});this.deps={eventBus:{actor,bus:id,...grants?{grants}:{}}};Object.assign(this,{tx,resume,hold:hold===true});}
}
export class PublishEvent extends BusAppAction{static operation='events.publish';run({eventBus}){return role(eventBus,'publish').publish(this.input,{tx:this.tx});}}
export class ReadEvents extends BusAppAction{static operation='events.read';run({eventBus}){return role(eventBus,'read').read(this.input??{},{hold:this.hold,...this.resume===undefined?{}:{resume:this.resume}});}}

export const EVENT_BUS_OPERATIONS=[EventBuses,EventBusDetail,CreateEventBus,SetEventBusRetention,PurgeEventBus,DeleteEventBus,AllowEventBusHistory,SetEventBusFeature,ApproveEventBusReader,RevokeEventBusReader,SweepEventBuses,EventBusDescriptors,EventBusLimits,PublishEvent,ReadEvents];
/** Owner-dispatchable wire names (the account RPC builds the owner actor itself). */
export const EVENT_BUS_OWNER_OPERATIONS=Object.freeze(['events.buses','events.bus','events.create','events.retention','events.purge','events.delete','events.history','events.feature']);
export const EVENT_BUS_SYSTEM_OPERATIONS=Object.freeze(['events.reader-approved','events.reader-revoked','events.sweep','events.descriptors','events.limits']);
export const EVENT_BUS_APP_OPERATIONS=Object.freeze({publish:PublishEvent,read:ReadEvents});
