// BindleBox composition: the same ngin operations at mailbox, edge, test and CLI placements.
import {Engine,Provider,Action,Query} from '../../vendor/ngin/index.js';
import {PROVIDERS,auditTrail} from './providers.mjs';
import {fault,MailboxFault} from './faults.mjs';

export function createMailboxEngine({providers={},interceptors=[]}={}){
 for(const name of Object.keys(providers))if(!Object.hasOwn(PROVIDERS,name))throw new TypeError(`Uncatalogued mailbox provider: ${name}`);
 for(const name of ['clock','random','audit'])if(!Object.hasOwn(providers,name)||providers[name]==null)throw new TypeError(`The mailbox engine requires a ${name} provider`);
 return new Engine({providers:Object.fromEntries(Object.entries(providers).map(([name,value])=>[name,typeof value==='function'&&value.prototype instanceof Provider?value:Provider.fromSingleton(value)])),interceptors:[auditTrail,...interceptors]});
}
export async function perform(engine,action,{signal}={}){
 const feed=engine.dispatch(action);let result;
 feed.addEventListener('result',event=>{result=event;},{once:true});await feed.next('complete',{signal});
 if(!result)throw new Error(`${action.constructor.name} completed without a result`);return result.detail;
}
export const read=(engine,query)=>engine.query(query).peek();
export const operate=(engine,operation,options)=>operation instanceof Query?read(engine,operation):perform(engine,operation,options);
export function operations(...classes){
 const registry=Object.create(null);
 for(const Operation of classes){
  if(typeof Operation.operation!=='string'||!Operation.operation||!(Operation.prototype instanceof MailboxAction||Operation.prototype instanceof MailboxQuery))throw new TypeError(`${Operation.name} is not a mailbox operation`);
  if(Object.hasOwn(registry,Operation.operation))throw new TypeError(`Duplicate operation ${Operation.operation}`);registry[Operation.operation]=Operation;
 }
 return Object.freeze(registry);
}
export function ownerOf(actor){if(actor?.kind!=='owner'||typeof actor.owner!=='string'||!/^[a-f0-9-]{36}$/.test(actor.owner))fault('unauthorized','Sign in to continue.',401);return actor.owner;}
function payload(target,{actor,id,input}={}){
 target.actor=actor;if(id!==undefined)target.id=id;if(input!==undefined)target.input=input;
 const names=Array.isArray(target.constructor.deps)?target.constructor.deps.filter(name=>PROVIDERS[name]?.scoped):[];
 if(names.length)target.deps=Object.fromEntries(names.map(name=>[name,{actor}]));
}
export class MailboxAction extends Action {
 constructor(params){super();payload(this,params);}
 async execute(resources,context){
  const value=await this.run(resources,context);context.dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:value}));
  if(this.constructor.changes)context.engineFeed.dispatchEvent(new CustomEvent(this.constructor.changes,{detail:{operation:this.constructor.operation,owner:this.actor?.owner??null}}));
 }
 run(){throw new Error(`${this.constructor.name}.run() not implemented`);}
}
export class MailboxQuery extends Query {
 constructor(params){super();payload(this,params);}
 async boot(resources,{notify,engineFeed}){
  let sequence=0;const events=this.constructor.refreshOn??[];
  const refresh=async()=>{const mine=++sequence;try{const value=await this.fetch(resources);if(mine===sequence)notify(value);}catch(error){console.error(`${this.constructor.name} refresh failed:`,error?.code??'internal_error');}};
  const relevant=event=>{if(event.detail?.owner==null||event.detail.owner===this.actor?.owner)refresh();};
  const stop=()=>{sequence++;for(const name of events)engineFeed.removeEventListener(name,relevant);};this.kill=stop;
  for(const name of events)engineFeed.addEventListener(name,relevant);
  const mine=++sequence;try{const value=await this.fetch(resources);if(mine===sequence)notify(value);}catch(error){stop();throw error;}
 }
 fetch(){throw new Error(`${this.constructor.name}.fetch() not implemented`);}
}
// Domain handles carry an owner grant; a mailbox binding is checked before any domain code runs.
export class OwnerScopedProvider extends Provider {
 #deps;#held=new WeakMap();
 constructor(deps){super();this.#deps=deps;}
 async obtain({actor}={}){
  const owner=ownerOf(actor),resources={},obtained=[];
  try{
   for(const name of this.constructor.deps){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
   const bound=await resources.mailboxStore?.get('owner');if(bound!==undefined&&bound!==owner)throw new MailboxFault('forbidden','Mailbox owner mismatch.',403);
   const handle=Object.freeze(this.scope(resources,owner));this.#held.set(handle,{resources,obtained});return handle;
  }catch(error){for(const name of obtained.reverse())await this.#deps[name].release(resources[name]);throw error;}
 }
 async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained.reverse())await this.#deps[name].release(held.resources[name]);}
 scope(){throw new Error(`${this.constructor.name}.scope() not implemented`);}
}
