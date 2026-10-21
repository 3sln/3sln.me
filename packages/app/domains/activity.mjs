// Activity domain (docs/spec/activity.md, docs/architecture/activity-center.md): ACT-1 core activity model.
//
// Two authorities share one provider and never one handle:
//   owner  {kind:'owner', owner}: feed, detail, read/unread, archive, delete. Registered in ACCOUNT_OPERATIONS.
//   app    {kind:'app', owner, issuer, app:{clientId,origin,name}, connection:{id,generation,admissionGeneration}}:
//          create, replace, retract only. Built server side by the resource-method handler after federation has
//          checked the grant, origin and connection (packages/runtime/app-notifications.mjs `activityResourceMethod`).
//          These operations are deliberately NOT in ACCOUNT_OPERATIONS: the owner RPC always constructs an owner
//          actor, so no wire request can claim app authority, and an app handle has no feed or recipient state.
// The issuer signer travels as obtain options (`keys`), set by the server-side constructor, never from the wire.
// Exposure is gated by ACTIVITY_V2_ENABLED at both entry points (routes/messages.mjs, the resource handler).
import {Provider} from '../../../vendor/ngin/index.js';
import {ActivityStore} from '../../activity/store.mjs';
import {AppAction,AppQuery,ownerOf} from '../engine.mjs';
import {AppFault} from '../faults.mjs';

const UUIDISH=/^[a-f0-9-]{36}$/,plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const bounded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
/** The verified app authority, or an `unauthorized` fault. Every field is required and nothing else is accepted. */
export function appActorOf(actor){
 const ok=exact(actor,['kind','owner','issuer','app','connection'])&&actor.kind==='app'&&typeof actor.owner==='string'&&UUIDISH.test(actor.owner)&&bounded(actor.issuer,512)
  &&exact(actor.app,['clientId','origin','name'])&&bounded(actor.app.clientId,512)&&bounded(actor.app.origin,512)&&bounded(actor.app.name,200)
  &&exact(actor.connection,['id','generation','admissionGeneration'])&&typeof actor.connection.id==='string'&&UUIDISH.test(actor.connection.id)&&Number.isSafeInteger(actor.connection.generation)&&actor.connection.generation>0&&Number.isSafeInteger(actor.connection.admissionGeneration)&&actor.connection.admissionGeneration>0;
 if(!ok)throw new AppFault('unauthorized','Application authorization is required.',401);
 return actor.owner;
}

export class ActivityProvider extends Provider{
 static deps=['accountStore','clock','random'];
 #deps;#held=new WeakMap();
 constructor(deps){super();this.#deps=deps;}
 async obtain({actor,keys}={}){
  const app=actor?.kind==='app',owner=app?appActorOf(actor):ownerOf(actor),resources={},obtained=[];
  try{
   for(const name of this.constructor.deps){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
   const bound=await resources.accountStore.get('owner');if(bound!==undefined&&bound!==owner)throw new AppFault('forbidden','Account owner mismatch.',403);
   const store=new ActivityStore(resources),frozen=Object.freeze(structuredClone(actor));
   const handle=Object.freeze(app?{
    admit:(kind,input,options)=>store.admit(frozen,kind,input,keys,options),
   }:{
    list:query=>store.list(owner,query),get:input=>store.get(owner,input),mark:input=>store.mark(owner,input),archive:input=>store.archive(owner,input),
    remove:input=>store.remove(owner,input),legacy:query=>store.legacy(owner,query),pending:()=>store.pending(owner),
   });
   this.#held.set(handle,{resources,obtained});return handle;
  }catch(error){for(const name of obtained)await this.#deps[name].release(resources[name]);throw error;}
 }
 async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained)await this.#deps[name].release(held.resources[name]);}
}
const owned=handle=>{if(typeof handle.list!=='function')throw new AppFault('forbidden','This operation needs owner authority.',403);return handle;};
const admitting=handle=>{if(typeof handle.admit!=='function')throw new AppFault('forbidden','This operation needs app authority.',403);return handle;};

// Owner operations.
/** Pending notification work (latest eligible member per collapse group). For ACT-2 dispatch; not owner-routed. */
export class PendingActivity extends AppQuery{
 static operation='activity.pending';static deps=['activity'];
 fetch({activity}){return owned(activity).pending();}
}
/** `input`: {app?, tag?:{app,id}, archived?, unread?, state?, limit?, cursor?}. Default: unarchived, newest first. */
export class ActivityFeed extends AppQuery{
 static operation='activity.list';static deps=['activity'];static refreshOn=['activity-changed'];
 fetch({activity}){return owned(activity).list(this.input??{});}
}
/** `id`, optional `input`: {revision}. Current content, signed history, inert flag for terminal or older revisions. */
export class ActivityItem extends AppQuery{
 static operation='activity.get';static deps=['activity'];static refreshOn=['activity-changed'];
 fetch({activity}){return owned(activity).get({id:this.id,...plain(this.input)&&this.input.revision!==undefined?{revision:this.input.revision}:{}});}
}
/** v1 app messages projected as activity rows; `input`: {cursor?}. */
export class LegacyActivityPage extends AppQuery{
 static operation='activity.legacy';static deps=['activity'];
 fetch({activity}){return owned(activity).legacy(this.input??{});}
}
/** `id` plus `input`: {revision, read}. */
export class MarkActivity extends AppAction{
 static operation='activity.mark';static deps=['activity'];static changes='activity-changed';
 run({activity}){return owned(activity).mark({...this.input,id:this.id});}
}
/** `id` plus `input`: {archived}. */
export class ArchiveActivity extends AppAction{
 static operation='activity.archive';static deps=['activity'];static changes='activity-changed';
 run({activity}){return owned(activity).archive({...this.input,id:this.id});}
}
/** `id`: recipient deletion (terminal). */
export class DeleteActivity extends AppAction{
 static operation='activity.delete';static deps=['activity'];static changes='activity-changed';
 run({activity}){return owned(activity).remove({id:this.id});}
}

// App operations: constructed only by server-side code holding verified app authority and the issuer signer.
class AppActivityAction extends AppAction{
 static deps=['activity'];static changes='activity-changed';
 constructor({actor,input,keys,operationId}={}){super({actor,input});this.deps={activity:{actor,keys}};this.operationId=operationId;}
 run({activity}){return admitting(activity).admit(this.constructor.kind,this.input,{operationId:this.operationId});}
}
export class CreateActivity extends AppActivityAction{static operation='activity.create';static kind='create';}
export class ReplaceActivity extends AppActivityAction{static operation='activity.replace';static kind='replace';}
export class RetractActivity extends AppActivityAction{static operation='activity.retract';static kind='retract';}

export const ACTIVITY_PROVIDERS={activity:ActivityProvider};
export const ACTIVITY_OPERATIONS=[ActivityFeed,ActivityItem,LegacyActivityPage,MarkActivity,ArchiveActivity,DeleteActivity];
/** Method name of the provisional activity contract to its app operation. Never registered for owner dispatch. */
export const ACTIVITY_APP_OPERATIONS=Object.freeze({create:CreateActivity,replace:ReplaceActivity,retract:RetractActivity});
