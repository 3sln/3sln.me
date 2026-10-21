// Generic multi-party transport scaffold. B1 supplies wire handlers; there is no protocol here.
import {createRandom,fakeClock,injectFaults} from '../../helpers/chaos.mjs';
import {createTestEngine,memoryStore} from './engine.mjs';
import {memoryEffects} from '../../../packages/bindlebox-engine/providers.mjs';
import {faultOf,MailboxFault} from '../../../packages/bindlebox-engine/faults.mjs';
const names=['alice','bob','carol'];
const failure=code=>Object.assign(new Error(`Simulated ${code}`),{code});
const matches=(when,n,random)=>when===undefined||when==='always'?true:typeof when==='function'?Boolean(when({n})):Array.isArray(when)?when.includes(n):Number.isInteger(when)?when===n:typeof when==='number'&&when>0&&when<1?random.chance(when):false;
export function createNetwork({peers=3,seed=Number(process.env.CHAOS_SEED??1),clock=fakeClock(),rules=[]}={}){
 const ids=Array.isArray(peers)?peers:Array.from({length:peers},(_,i)=>names[i]??`peer${i+1}`);
 if(!ids.length||ids.length>64||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9-]*$/.test(id)))throw new TypeError('Use 1–64 unique peer names');
 const random=createRandom(seed),parties=new Map(),trace=[],pending=[],counts=new Map(),plan=[...rules];let sequence=0;
 const directory={resolve:async name=>{const peer=parties.get(name);if(!peer)throw new MailboxFault('not_found','Unknown simulated peer.',404);return structuredClone({principal:peer.principal,ingress:peer.ingress});}};
 const delay=(ms,work)=>new Promise((resolve,reject)=>pending.push({at:clock.now()+ms,sequence:sequence++,reject,run:()=>Promise.resolve().then(work).then(resolve,reject)}));
 async function deliver(from,to,request){
  const peer=parties.get(to);if(!peer||!peer.online)throw failure('host_unavailable');
  const response=await peer.handler(structuredClone(request),{from,to,peer});if(!(response instanceof Response))throw new TypeError('A simulated handler must return a Response');return response;
 }
 async function send(from,to,request){
  if(!parties.get(from)?.online)throw failure('host_unavailable');
  const key=`${from}>${to}`,n=(counts.get(key)??0)+1;counts.set(key,n);
  const rule=plan.find(rule=>(!rule.from||rule.from===from)&&(!rule.to||rule.to===to)&&matches(rule.when,n,random));
  const mode=rule?.mode??'pass';trace.push({from,to,n,mode,at:clock.now()});
  const work=()=>deliver(from,to,request);
  switch(mode){
   case 'pass':return work();
   case 'delay':return delay(rule.ms??1000,work);
   case 'trickle':{let canceled=false;return new Response(new ReadableStream({start(controller){const bytes=new TextEncoder().encode(rule.body??'{}'),ms=rule.ms??1000;if(!bytes.length)controller.close();for(let i=0;i<bytes.length;i++)delay(ms*(i+1),()=>{if(canceled)return;controller.enqueue(bytes.slice(i,i+1));if(i===bytes.length-1)controller.close();}).catch(error=>{if(!canceled){canceled=true;controller.error(error);}});},cancel(){canceled=true;}}),{status:200});}
   case 'status':case 'rate-limit':return Response.json({error:mode==='rate-limit'?'rate_limited':'simulated_failure'},{status:mode==='rate-limit'?429:rule.status??503,headers:mode==='rate-limit'?{'Retry-After':String(rule.retryAfter??60)}:{}});
   case 'partial':return Response.json({results:structuredClone(rule.results??[])},{status:200});
   case 'drop':case 'reset':case 'after':case 'duplicate':{
    const injected=mode==='drop'?'timeout':mode==='reset'?'throw':mode;
    return injectFaults({send:work},[{method:'send',mode:injected,error:failure(mode==='drop'?'timeout':mode==='duplicate'?'injected_fault':'connection_reset')}],{random}).send();
   }
   default:throw new TypeError(`Unknown network fault ${mode}`);
  }
 }
 for(const [index,name]of ids.entries()){
  const effects=memoryEffects({seed:seed+index+1}),owner=effects.random.uuid(),store=memoryStore([['owner',owner]]),principal={iss:`https://${name}.provider.example`,sub:owner},ingress=`https://${name}.box.example/ingress`;
  let offset=0;const localClock={now:()=>clock.now()+offset,advance:ms=>{offset+=ms;return localClock.now();},set:ms=>{offset=ms-clock.now();return ms;}};
  // These are deliberately fake fixtures, never signatures or delegation certificates.
  const delegateKeys={fake:true,id:effects.random.uuid(),material:effects.random.bytes(32)};
  const providerLink={fake:true,links:new Map(),slots:new Map(),principal};
  const peer={name,owner,principal,ingress,store,delegateKeys,providerLink,online:true,clock:localClock};
  const providers={delegateKeys,providerLink,directory,egress:{send:(to,request)=>send(name,to,request),fetch:async(url,init)=>{const target=[...parties.values()].find(peer=>peer.ingress===String(url));if(!target)throw failure('network_denied');return send(name,target.name,{url:String(url),...init});}}};
  const start=()=>createTestEngine({seed:seed+index+1,owner,clock:localClock,store,providers});peer.engine=start();
  peer.handler=async request=>{try{return Response.json(await peer.engine.run(request.op,request.params));}catch(error){const fault=faultOf(error);return Response.json(fault,{status:fault.status??500});}};
  peer.restart=async()=>{peer.online=false;await peer.engine.dispose();peer.engine=start();peer.online=true;};parties.set(name,peer);
 }
 return {seed,clock,peers:parties,trace,rules:plan,send,
  mount(name,handler){const peer=parties.get(name);if(!peer)throw new TypeError('Unknown peer');peer.handler=handler;},
  async advance(ms){clock.advance(ms);for(;;){pending.sort((a,b)=>a.at-b.at||a.sequence-b.sequence);if(!pending.length||pending[0].at>clock.now())break;await pending.shift().run();}return clock.now();},
  skew(name,ms){const peer=parties.get(name);if(!peer)throw new TypeError('Unknown peer');return peer.clock.advance(ms);},
  kill(name){const peer=parties.get(name);if(!peer)throw new TypeError('Unknown peer');peer.online=false;},
  async recover(name){const peer=parties.get(name);if(!peer)throw new TypeError('Unknown peer');await peer.restart();},
  async dispose(){for(const peer of parties.values())peer.online=false;for(const task of pending.splice(0))task.reject(failure('network_closed'));await Promise.all([...parties.values()].map(peer=>peer.engine.dispose()));},
 };
}
