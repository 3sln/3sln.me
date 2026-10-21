// Test-only composition. No identity, provider internals, durable adapter or protocol claims.
import {createMailboxEngine,perform,read,operate} from '../../../packages/bindlebox-engine/engine.mjs';
import {MAILBOX_OPERATIONS} from '../../../packages/bindlebox-engine/operations.mjs';
import {memoryEffects} from '../../../packages/bindlebox-engine/providers.mjs';
import {createRandom,injectFaults,concurrently} from '../../helpers/chaos.mjs';
export const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ownerActor=(owner=OWNER)=>({kind:'owner',owner});
// Serialized copy-on-write transactions: a failed callback rolls back, an after fault loses only the reply.
export function memoryStore(initial=[]){
 let data=new Map(structuredClone(initial)),tail=Promise.resolve();
 const handle=map=>({get:async key=>structuredClone(map.get(key)),put:async(key,value)=>{map.set(key,structuredClone(value));},set:async(key,value)=>{map.set(key,structuredClone(value));},delete:async key=>map.delete(key),list:async({prefix=''}={})=>new Map([...map].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,structuredClone(value)]))});
 return {get:key=>handle(data).get(key),list:options=>handle(data).list(options),transaction(work){const result=tail.then(async()=>{const draft=structuredClone(data),value=await work(handle(draft));data=draft;return value;});tail=result.catch(()=>{});return result;},put(key,value){return this.transaction(tx=>tx.put(key,value));},delete(key){return this.transaction(tx=>tx.delete(key));}};
}
export function createTestEngine({seed=Number(process.env.CHAOS_SEED??1),owner=OWNER,clock,store=memoryStore([['owner',owner]]),faults={},wrap={},providers={},interceptors=[],registry=MAILBOX_OPERATIONS}={}){
 const effects=memoryEffects({seed:seed^0x5eed5eed});if(clock)effects.clock=clock;
 // Audit follows an injected clock, too. ID and fault streams stay independent.
 const entries=[],audit={entries,record(entry){entries.push({at:effects.clock.now(),...entry});}};
 const decorate=(name,value)=>{const resource=faults[name]?injectFaults(value,faults[name],{random:createRandom(seed)}):value;return wrap[name]?wrap[name](resource):resource;};
 const resources={...effects,audit,mailboxStore:store,...providers};
 const engine=createMailboxEngine({providers:Object.fromEntries(Object.entries(resources).map(([name,value])=>[name,decorate(name,value)])),interceptors});
 const events=[],facts=[...new Set(Object.values(registry).map(Operation=>Operation.changes).filter(Boolean))];
 for(const fact of facts)engine.feed.addEventListener(fact,event=>events.push({type:event.type,...event.detail}));
 return {engine,store,clock:resources.clock,random:resources.random,audit:resources.audit,events,actor:(id=owner)=>ownerActor(id),
  perform:(action,options)=>perform(engine,action,options),read:query=>read(engine,query),all:items=>concurrently(items.map(item=>()=>operate(engine,item))),
  run(name,params={}){if(!Object.hasOwn(registry,name))throw new TypeError(`Unknown operation ${name}`);return operate(engine,new registry[name]({actor:ownerActor(owner),...params}));},
  dispose:()=>engine.dispose(),
 };
}
