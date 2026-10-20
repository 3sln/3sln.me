// Views domain (docs/architecture/message-views.md): saved Views and the
// incoming pages they select. Migration slice 1 of docs/architecture/app-engine.md.
//
// Providers hold the state and resources; these Actions and Queries are the only
// public operations. Every handle is owner-scoped, so no operation here takes or
// holds an owner ID. Each Action commits at most one accountStore transaction:
// MessageViews.mutate and UpdateIncoming each open exactly one, which is what
// keeps them correct without relying on the account gate around them.
import {MessageViews,normalizeIncomingUpdate} from '../../runtime/message-views.mjs';
import {StorageError} from '../../storage/policy.mjs';
import {AppAction,AppQuery,OwnerScopedProvider} from '../engine.mjs';

/** Owner-scoped saved Views over the account store; View IDs come from `random`. */
export class ViewsProvider extends OwnerScopedProvider {
 static deps=['accountStore','random'];
 scope({accountStore,random},owner){const views=new MessageViews(accountStore,{uuid:random.uuid});return {list:()=>views.list(owner),create:input=>views.mutate(owner,'create',null,input),update:(id,input)=>views.mutate(owner,'update',id,input),remove:(id,input)=>views.mutate(owner,'delete',id,input),resolve:input=>views.resolve(owner,input)};}
}
/** Owner-scoped incoming catalog. `itemIndex` shares the accountStore database, so
 * the organization write commits inside one accountStore transaction (a DO storage
 * transaction covers its SQL; Node runs both on one SQLite handle). */
export class IncomingProvider extends OwnerScopedProvider {
 static deps=['accountStore','itemIndex'];
 // A missing itemIndex answers 'upgrading' exactly as the controller did before migration. Both Worker and
 // Node always bind SQL, so this is a legacy branch, not a feature switch (app-engine review finding 9).
 scope({accountStore,itemIndex},owner){
  const ready=async()=>{if(!itemIndex||!await accountStore.get('item-index-ready')||itemIndex.incomingState('ready')!=='1')throw new StorageError('temporarily_unavailable','Your incoming index is being upgraded. Try again shortly.',503);};
  return {ready,page:query=>itemIndex.incomingPage(owner,query),update:request=>accountStore.transaction(()=>itemIndex.updateIncoming(owner,request))};
 }
}

export class SavedViews extends AppQuery {
 static operation='views.list';static deps=['views'];static refreshOn=['views-changed'];
 async fetch({views}){return {views:await views.list()};}
}
/** `input`: {name, filter, sort, operationId?}. A retried operationId returns the original View. */
export class CreateView extends AppAction {
 static operation='views.create';static deps=['views'];static changes='views-changed';
 run({views}){return views.create(this.input);}
}
/** `id` plus `input`: {name, filter, sort, expectedRevision}. */
export class UpdateView extends AppAction {
 static operation='views.update';static deps=['views'];static changes='views-changed';
 run({views}){return views.update(this.id,this.input);}
}
/** `id` plus `input`: {expectedRevision}. */
export class DeleteView extends AppAction {
 static operation='views.delete';static deps=['views'];static changes='views-changed';
 run({views}){return views.remove(this.id,this.input);}
}
/** `input`: a normalized incoming query, or {view, viewRevision, limit?, cursor?}. Readiness is
 * checked before the View resolves, as before, so an upgrading index answers 503 first. */
export class IncomingPage extends AppQuery {
 static operation='incoming.query';static deps=['views','incoming'];static refreshOn=['views-changed','incoming-changed'];
 async fetch({views,incoming}){await incoming.ready();return incoming.page(await views.resolve(this.input??{}));}
}
/** `input`: {id, expectedRevision, expectedActivityRevision?, tags|addTags|removeTags|classification|read}. */
export class UpdateIncoming extends AppAction {
 static operation='incoming.update';static deps=['incoming'];static changes='incoming-changed';
 async run({incoming}){const request=normalizeIncomingUpdate(this.input);await incoming.ready();return incoming.update(request);}
}
export const VIEW_PROVIDERS={views:ViewsProvider,incoming:IncomingProvider};
export const VIEW_OPERATIONS=[SavedViews,CreateView,UpdateView,DeleteView,IncomingPage,UpdateIncoming];
