// BB-B5: independent copy of the core View grammar and idempotent configuration.
import {MailboxFault as StorageError,fault} from '../faults.mjs';
import {OwnerScopedProvider,MailboxAction,MailboxQuery} from '../engine.mjs';
import {incomingPage,projectIncoming,validItemId,mailboxTransaction} from '../store/item-index.mjs';
import {KEYS} from '../store/mailbox.mjs';
import {createTagsProvider} from './tags.mjs';
import {createRulesProvider} from './rules.mjs';
import {validTagIds as validTagList,escapeLegacyTag,CLASSIFICATIONS} from './tags.mjs';
import {canonical,isUUIDv4} from '../../core/primitives.mjs';
const invalid=()=>{throw new StorageError('invalid_view','Choose a valid bounded View filter.');};
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const fields=(v,allowed)=>plain(v)&&Object.keys(v).every(k=>allowed.includes(k));
export function normalizeIncomingFilter(value={version:1}){
 if(!fields(value,['version','tagsAll','read','types','classifications','receivedAfter','receivedBefore'])||value.version!==1)invalid();
 const out={version:1};
 if(value.tagsAll!==undefined){if(!validTagList(value.tagsAll))invalid();if(value.tagsAll.length)out.tagsAll=[...value.tagsAll].sort();}
 if(value.read!==undefined){if(typeof value.read!=='boolean')invalid();out.read=value.read;}
 for(const [field,allowed]of [['types',['message','conversation']],['classifications',CLASSIFICATIONS]])if(value[field]!==undefined){const a=value[field];if(!Array.isArray(a)||a.length>allowed.length||new Set(a).size!==a.length||a.some(v=>!allowed.includes(v)))invalid();if(a.length)out[field]=[...a].sort();}
 for(const field of ['receivedAfter','receivedBefore'])if(value[field]!==undefined){if(!Number.isSafeInteger(value[field])||value[field]<0)invalid();out[field]=value[field];}
 if(out.receivedAfter!==undefined&&out.receivedBefore!==undefined&&out.receivedAfter>=out.receivedBefore)invalid();
 return out;
}
export function incomingSort(value='activity-desc'){if(!['activity-desc','received-desc'].includes(value))invalid();return value;}
export function normalizeIncomingQuery(value={}){
 if(!fields(value,['filter','sort','limit','cursor','view','viewRevision']))invalid();
 const limit=value.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100||value.cursor!==undefined&&(typeof value.cursor!=='string'||value.cursor.length>8192))invalid();
 if(value.view!==undefined&&(typeof value.view!=='string'||value.view.length>64||value.filter!==undefined||value.sort!==undefined||!Number.isSafeInteger(value.viewRevision)||value.viewRevision<1))invalid();
 if(value.view===undefined&&value.viewRevision!==undefined)invalid();
 return {...value,limit,...value.view===undefined?{filter:normalizeIncomingFilter(value.filter),sort:incomingSort(value.sort)}:{}};
}
export function defaultMessageViews(){return [
 {version:1,id:'all',name:'All messages',revision:1,builtin:true,filter:{version:1},sort:'activity-desc'},
 {version:1,id:'unread',name:'Unread',revision:1,builtin:true,filter:{version:1,read:false},sort:'activity-desc'},
 {version:1,id:'conversations',name:'Conversations',revision:1,builtin:true,filter:{version:1,types:['conversation']},sort:'activity-desc'}
 ];}
function definition(input,update=false){if(!fields(input,['name','filter','sort',...update?['expectedRevision']:['operationId']])||!update&&input.operationId!==undefined&&!isUUIDv4(input.operationId)||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||/[\x00-\x1f\x7f]/.test(input.name)||update&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1))invalid();return {name:input.name,filter:normalizeIncomingFilter(input.filter),sort:incomingSort(input.sort)};}
const path=owner=>'bb:views/v1/'+owner;
// Create receipts: a retry that reuses a client operation ID after a lost reply
// returns the original View instead of adding a duplicate. Only the most recent
// receipts are kept, one per possible View, so the record stays bounded.
const receiptsPath=owner=>'bb:view-operations/v1/'+owner,RECEIPTS=64;
// Views saved before the tag registry may hold unregistered `sys:` strings; they match escaped legacy tags.
function storedFilter(filter){try{return normalizeIncomingFilter(filter);}catch(e){if(!Array.isArray(filter?.tagsAll))throw e;return normalizeIncomingFilter({...filter,tagsAll:[...new Set(filter.tagsAll.map(t=>validTagList([t])?t:escapeLegacyTag(t)))]});}}
export class MessageViews{
 // `uuid` is the injected randomness (the app engine's `random` provider); seeded in engine tests.
 constructor(metadata,{uuid=()=>crypto.randomUUID()}={}){this.metadata=metadata;this.uuid=uuid;}
 async list(owner){const stored=await this.metadata.get(path(owner));return structuredClone(stored??defaultMessageViews());}
 async mutate(owner,operation,id,input){
  const data=operation==='delete'?null:definition(input,operation==='update');
  if(operation==='delete'&&(!fields(input,['expectedRevision'])||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1))invalid();
  if(!['create','update','delete'].includes(operation)||operation!=='create'&&(typeof id!=='string'||id.length>64))invalid();
  const expectedRevision=input?.expectedRevision;
  return this.metadata.transaction(async tx=>{const rows=await tx.get(path(owner))??defaultMessageViews();
   if(operation==='create'){
    const operationId=input.operationId,fingerprint=canonical(data),receipts=operationId?await tx.get(receiptsPath(owner))??[]:null,prior=receipts?.find(r=>r.operationId===operationId);
    if(prior){if(prior.fingerprint!==fingerprint)throw new StorageError('view_operation_conflict','This request ID was already used for a different View.',409);return structuredClone(prior.view);}
    if(rows.length>=64)throw new StorageError('view_limit','You can keep up to 64 Views.',409);const view={version:1,id:this.uuid(),revision:1,...data};rows.push(view);await tx.put(path(owner),rows);
    if(receipts)await tx.put(receiptsPath(owner),[...receipts,{operationId,fingerprint,view}].slice(-RECEIPTS));
    return view;
   }
   const index=rows.findIndex(v=>v.id===id);if(index<0)throw new StorageError('view_not_found','This View no longer exists.',404);
   if(rows[index].revision!==expectedRevision)throw new StorageError('view_conflict','This View changed. Reload it before saving.',409);
   if(operation==='delete'){rows.splice(index,1);await tx.put(path(owner),rows);return {deleted:true};}
   const view={version:1,id,revision:rows[index].revision+1,...data};rows[index]=view;await tx.put(path(owner),rows);return view;
  });
 }
 async resolve(owner,input){const query=normalizeIncomingQuery(input);if(query.view===undefined)return query;const view=(await this.list(owner)).find(v=>v.id===query.view);if(!view)throw new StorageError('view_not_found','This View no longer exists.',404);if(view.revision!==query.viewRevision)throw new StorageError('view_conflict','This View changed. Reload it before paging.',409);return {...query,filter:storedFilter(view.filter),sort:incomingSort(view.sort)};}
}

// No routes are mounted here. Composition must explicitly enable each provider (default off).
export function createViewsProvider({BINDLEBOX_ENABLED=false}={}){
 return class ViewsProvider extends OwnerScopedProvider {
  static deps=['mailboxStore','random'];
  scope({mailboxStore:store,random},owner){
   if(BINDLEBOX_ENABLED!==true)fault('not_found','BindleBox is disabled.',404);
   const check=async()=>{if(BINDLEBOX_ENABLED!==true)fault('not_found','BindleBox is disabled.',404);if(await store.get('owner')!==owner)fault('forbidden','Mailbox owner mismatch.',403);};
   const transaction=work=>mailboxTransaction(store,owner,BINDLEBOX_ENABLED,work),views=new MessageViews({get:key=>store.get(key),transaction},{uuid:()=>random.uuid()});
   return {async list(){await check();return views.list(owner);},async mutate(operation,id,input){await check();return views.mutate(owner,operation,id,input);},async page(input){await check();return transaction(async tx=>{const local=new MessageViews(tx),query=await local.resolve(owner,input);return incomingPage(tx,owner,query,random);});},async index(id){await check();if(!validItemId(id))fault('invalid_input','Choose an item.',400);return transaction(async tx=>{const item=await tx.get(KEYS.item(id));if(!item)fault('not_found','Item not found.',404);return projectIncoming(tx,item);});}};
  }
 };
}
export class SavedViews extends MailboxQuery {
 static operation='views.list';static deps=['views'];static refreshOn=['views-changed'];
 async fetch({views}){return {views:await views.list()};}
}
export class CreateView extends MailboxAction {
 static operation='views.create';static deps=['views'];static changes='views-changed';
 run({views}){return views.mutate('create',null,this.input);}
}
export class UpdateView extends MailboxAction {
 static operation='views.update';static deps=['views'];static changes='views-changed';
 run({views}){return views.mutate('update',this.id,this.input);}
}
export class DeleteView extends MailboxAction {
 static operation='views.delete';static deps=['views'];static changes='views-changed';
 run({views}){return views.mutate('delete',this.id,this.input);}
}
export class IncomingPage extends MailboxQuery {
 static operation='incoming.query';static deps=['views'];static refreshOn=['views-changed','incoming-changed'];
 fetch({views}){return views.page(this.input??{});}
}
// Explicit reconciliation hook for existing custody writers; new writers call projectIncoming in their transaction.
export class IndexIncoming extends MailboxAction {
 static operation='incoming.index';static deps=['views'];static changes='incoming-changed';
 run({views}){return views.index(this.id??this.input?.id);}
}
export const VIEW_OPERATIONS=[SavedViews,CreateView,UpdateView,DeleteView,IncomingPage,IndexIncoming];

// Null is the explicit unoccupied optional port; ngin requires every declared dependency to be bound.
export const organizationProviders=({BINDLEBOX_ENABLED=false,classifier=null}={})=>({views:createViewsProvider({BINDLEBOX_ENABLED}),rules:createRulesProvider({BINDLEBOX_ENABLED}),tags:createTagsProvider({BINDLEBOX_ENABLED}),classifier});
