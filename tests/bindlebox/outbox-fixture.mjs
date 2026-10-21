import {readFile} from 'node:fs/promises';
import {createTestEngine,memoryStore} from './helpers/engine.mjs';
import {createNetwork} from './helpers/network.mjs';
import {fakeClock} from '../helpers/chaos.mjs';
import {operations} from '../../packages/bindlebox-engine/engine.mjs';
import {createOutboxProvider,OUTBOX_OPERATIONS} from '../../packages/bindlebox-engine/domains/outbox.mjs';
import {SEND_OPERATIONS} from '../../packages/bindlebox-engine/domains/send.mjs';
import {EVENT_OPERATIONS} from '../../packages/bindlebox-engine/domains/events.mjs';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
import {party,world,NOW,encoder,linkPayload,recordPayload,receiptFor,uuidOf,EPOCH} from './vectors/fixtures.mjs';
const vectors=JSON.parse(await readFile(new URL('./vectors/vectors.json',import.meta.url),'utf8'));
export const P={};for(const name of ['alice','bob','carol'])P[name]=await party(name,vectors.keys,name==='carol'?{claims:{ingress:'https://carol.box.example/ingress'}}:{});
export const REGISTRY=operations(...SEND_OPERATIONS,...OUTBOX_OPERATIONS,...EVENT_OPERATIONS);
export {B,NOW,uuidOf};
export async function fixture(t,{rules=[],limits={},enabled=true,authorize,repair,store,timers,directory}={}){
 const clock=fakeClock(NOW),network=createNetwork({clock,rules}),w=world(P),blocked=new Set(),received=new Map(),requests=[];
 store??=memoryStore([['owner',P.alice.principal.subject]]);
 const egress={fetch:(url,init)=>{requests.push({url,redirect:init.redirect,credentials:init.credentials,at:clock.now()});const to=url.includes('carol.')?'carol':'bob';const {signal,...wire}=init;return network.send('alice',to,{url,...wire});}};
 for(const name of ['bob','carol'])network.mount(name,async request=>{
  const parsed=await B.parseDelivery(request.headers['Content-Type'],request.body),key=`${name}/${parsed.envelope.payload.operationId}`;
  if(!received.has(key))received.set(key,await receiptFor(P[name],parsed.envelope,{receivedAt:clock.now(),ingress:request.url}));
  return Response.json({receipt:received.get(key)});
 });
 const Policy=createOutboxProvider({BINDLEBOX_ENABLED:enabled,authorize:authorize??((tx,task)=>!blocked.has(task.peer)),repair,limits,...timers?{timers}:{}});
 const start=()=>createTestEngine({owner:P.alice.principal.subject,store,clock,registry:REGISTRY,providers:{outbox:Policy,egress,directory:directory??w}});
 let harness=start();
 const out={network,clock,w,blocked,received,requests,store,get h(){return harness;},run:(...args)=>harness.run(...args),async restart(nextStore=store){await harness.dispose();store=nextStore;out.store=store;harness=start();},async submit({people=['bob'],id=1,record=false,type='message',createdAt=clock.now()-1000,body=encoder.encode('Queue body'),...over}={}){
  const recipients=[];for(const name of people){const to=P[name],payload=record?await recordPayload(P.alice,to,type,{operationId:uuidOf(id),createdAt,body,...over}):await linkPayload(P.alice,to,{operationId:uuidOf(id),createdAt,body,...over});
   recipients.push({envelope:await B.signEnvelope(payload,P.alice.signer),ingress:name==='carol'?'https://carol.box.example/ingress':to.ingress,credential:record?`BindleConversation ${EPOCH}.${B.base64url(new Uint8Array(32))}`:'BindleLink e30.e30.AA'});
  }
  const input={operationId:uuidOf(id),recipients,body};return {input,result:await out.run('send.submit',{input})};
 },get:id=>out.run('outbox.get',{id:typeof id==='number'?uuidOf(id):id}),drain:()=>out.run('outbox.drain'),async due(){const result=await out.drain();if(result.nextAlarmAt!==null)clock.set(Math.max(clock.now(),result.nextAlarmAt));return result;}};
 t.after(async()=>{await harness.dispose();await network.dispose();});return out;
}
