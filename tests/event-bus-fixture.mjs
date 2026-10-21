// Shared EV-2 engine-harness fixture (not a test file): a bus manifest, a live fake grant registry and the eventBus
// provider composed into the ordinary account test engine.
import {createTestEngine,OWNER} from './helpers/app-engine.mjs';
import {eventBusProvider,EVENT_BUS_OWNER_OPERATIONS,EVENT_BUS_OPERATIONS,EVENT_BUS_APP_OPERATIONS} from '../packages/app/domains/events.mjs';
import {busKeys,EVENT_BUS_CONTRACT} from '../packages/events/index.mjs';

export const url='https://tasks.example/buses/task-changes/v1',ISSUER='https://3sln.example';
export const manifest=(bus={})=>({id:url,title:'Task changes',description:'A record when a task changes.',publisher:'https://tasks.example',fields:{bus:{title:'Task changes bus',type:'resource',cardinality:{min:0,max:1},contracts:[EVENT_BUS_CONTRACT]}},
 slot:{v:1,crit:['bus'],field:'bus',selection:'exclusive',consumers:['application','provider'],bus:{v:1,types:['created','completed','reassigned'],
  payload:{type:'object',additionalProperties:false,required:['task'],properties:{task:{type:'string',maxLength:128},title:{type:'string',maxLength:200},n:{type:'integer',minimum:0},link:{type:'string',maxLength:300,format:'uri'},at:{type:'string',maxLength:40,format:'date-time'},tags:{type:'array',maxItems:3,items:{type:'string',maxLength:16}}}},
  max_record_bytes:2048,retention:{min_seconds:3600,max_seconds:604800},publishers:['application','provider'],readers:['application','provider'],history:'owner-choice',
  effects:{read:{en:'See tasks when they change.'},write:{en:'Add task changes that connected apps see.'}},...bus}}});
const byName=Object.fromEntries(EVENT_BUS_OPERATIONS.map(Operation=>[Operation.operation,Operation]));

/** A live grant registry: `allow(client, methods, epoch)`, `revoke(client)`; `check` is consulted on every call. */
export function grantRegistry(){
 const held=new Map(),calls=[];
 return {held,calls,allow(clientId,methods,epoch='e1'){held.set(clientId,{methods:new Set(methods),epoch});},revoke(clientId){held.delete(clientId);},
  check({actor,bus,method}){calls.push({client:actor.clientId,method,bus:bus.id});const grant=held.get(actor.clientId);return grant?.methods.has(method)?{allowed:true,epoch:grant.epoch}:{allowed:false};}};
}
export const app=(name='tasks',generation=1)=>({kind:'app',owner:OWNER,clientId:`https://${name}.example/bindle/client.json`,origin:`https://${name}.example`,connection:{id:`cnx-${name}`,generation}});

import {BUS_LIMITS} from '../packages/events/limits.mjs';
// Tests run on a frozen fake clock, so the per-grant read rate is lifted unless a test passes its own limits.
const testLimits={...BUS_LIMITS,reads:{...BUS_LIMITS.reads,perSecond:1e6}};
export async function busHarness(t,{plan='free',waits=false,notifier,grants=grantRegistry(),enabled=true,limits=testLimits,...options}={}){
 const keys=await busKeys({KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')});
 const e=await createTestEngine({...options,providers:{eventBus:eventBusProvider({enabled,keys:async()=>keys,issuer:ISSUER,plan,grants,notifier,waits,limits}),...options.providers}});
 t.after(()=>e.dispose());
 const run=(name,params={})=>{if(!EVENT_BUS_OWNER_OPERATIONS.includes(name))throw new TypeError(name);const Operation=byName[name];const operation=new Operation({actor:{kind:'owner',owner:OWNER},...params});return Operation.prototype.fetch?e.read(operation):e.perform(operation);};
 const system=(name,params={})=>{const Operation=byName[name];const operation=new Operation({actor:{kind:'system',owner:OWNER},...params});return Operation.prototype.fetch?e.read(operation):e.perform(operation);};
 const create=async(document=manifest())=>(await run('events.create',{input:{url:document.id,manifest:document}})).bus;
 const publish=(actor,bus,type,data,tx=crypto.randomUUID())=>e.perform(new EVENT_BUS_APP_OPERATIONS.publish({actor,id:bus,input:{type,data},tx}));
 const read=(actor,bus,args={},{resume,hold}={})=>e.perform(new EVENT_BUS_APP_OPERATIONS.read({actor,id:bus,input:args,hold,...resume?{resume}:{}}));
 return {e,keys,grants,run,system,create,publish,read,clock:e.clock};
}
export const code=async(promise)=>{try{await promise;return 'ok';}catch(error){return error.code??String(error);}};
