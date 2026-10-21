import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
// EV-2 on real workerd with SQLite Durable Objects: the account single writer (gated by blockConcurrencyWhile, as
// AccountObject is) admits a long-poll as a lease and returns at once; the separate EventBusWaiter object holds it;
// a publish to the account completes while the poll waits and wakes it; a revocation answers the held poll forbidden.
const source=`
import {DurableObject} from 'cloudflare:workers';
export {EventBusWaiter} from './apps/worker/event-bus-waiter.mjs';
import {createAppEngine,perform,read} from './packages/app/engine.mjs';
import {eventBusProvider,EVENT_BUS_APP_OPERATIONS,CreateEventBus,RevokeEventBusReader} from './packages/app/domains/events.mjs';
import {busKeys,busWaitsPort,holdBusRead,publicRead,EVENT_BUS_CONTRACT} from './packages/events/index.mjs';
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',url='https://tasks.example/buses/task-changes/v1';
const manifest={id:url,title:'Task changes',description:'A record when a task changes.',publisher:'https://tasks.example',fields:{bus:{title:'Bus',type:'resource',cardinality:{min:0,max:1},contracts:[EVENT_BUS_CONTRACT]}},slot:{v:1,crit:['bus'],field:'bus',selection:'exclusive',consumers:['application'],bus:{v:1,types:['created'],payload:{type:'object',additionalProperties:false,required:['task'],properties:{task:{type:'string',maxLength:64}}},max_record_bytes:1024,retention:{min_seconds:60,max_seconds:86400},publishers:['application'],readers:['application'],effects:{read:{en:'See tasks.'},write:{en:'Add tasks.'}}}}};
const actor=name=>({kind:'app',owner:OWNER,clientId:'https://'+name+'.example/client.json',origin:'https://'+name+'.example',connection:{id:'cnx-'+name,generation:1}});
const envelope=async work=>{try{return {ok:true,result:await work()};}catch(error){return {ok:false,code:error.code??'internal',message:String(error.message)};}};
export class TestBusAccount extends DurableObject{
 constructor(ctx,env){super(ctx,env);
  const grants={check:async({actor:who,method})=>{const held=await ctx.storage.get('grant/'+who.clientId);return held?.includes(method)?{allowed:true,epoch:'e1'}:{allowed:false};}};
  let keys;this.engine=createAppEngine({providers:{clock:{now:()=>Date.now()},random:{uuid:()=>crypto.randomUUID()},audit:{record(){}},accountStore:ctx.storage,
   eventBus:eventBusProvider({enabled:true,keys:()=>keys??=busKeys({KEY_ENCRYPTION_KEY:env.KEY}),issuer:'https://3sln.example',plan:'free',grants,notifier:busWaitsPort(env.EVENT_BUS_WAITS)})}});
 }
 gated(work){return envelope(()=>this.ctx.blockConcurrencyWhile(work));}
 setup(){return this.gated(async()=>{await this.ctx.storage.put('grant/'+actor('reader').clientId,['read']);await this.ctx.storage.put('grant/'+actor('writer').clientId,['publish']);return (await perform(this.engine,new CreateEventBus({actor:{kind:'owner',owner:OWNER},input:{url,manifest}}))).bus;});}
 publish(bus,task){return this.gated(()=>perform(this.engine,new EVENT_BUS_APP_OPERATIONS.publish({actor:actor('writer'),id:bus,input:{type:'created',data:{task}},tx:crypto.randomUUID()})));}
 read(bus,args,options){return this.gated(()=>perform(this.engine,new EVENT_BUS_APP_OPERATIONS.read({actor:actor('reader'),id:bus,input:args,...options})));}
 granted(){return this.gated(async()=>(await this.ctx.storage.get('grant/'+actor('reader').clientId))?.includes('read')===true);}
 revoke(){return this.gated(async()=>{await this.ctx.storage.delete('grant/'+actor('reader').clientId);return perform(this.engine,new RevokeEventBusReader({actor:{kind:'system',owner:OWNER},input:{clientId:actor('reader').clientId}}));});}
 leases(){return this.gated(async()=>[...(await this.ctx.storage.list({prefix:'evbus/wait/'})).keys()].length);}
}
const unwrap=value=>{if(!value.ok)throw Object.assign(new Error(value.message),{code:value.code});return value.result;};
export default {async fetch(request,env){
 const account=env.ACCOUNTS.get(env.ACCOUNTS.idFromName(OWNER)),u=new URL(request.url),q=u.searchParams,json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 try{
  if(u.pathname==='/setup')return json(unwrap(await account.setup()));
  if(u.pathname==='/publish')return json(unwrap(await account.publish(q.get('bus'),q.get('task'))));
  if(u.pathname==='/revoke')return json(unwrap(await account.revoke()));
  if(u.pathname==='/leases')return json(unwrap(await account.leases()));
  if(u.pathname==='/read')return json(publicRead(unwrap(await account.read(q.get('bus'),q.has('cursor')?{cursor:q.get('cursor'),wait:Number(q.get('wait')??0)}:{},{}))));
  if(u.pathname==='/poll'){
   const args={cursor:q.get('cursor'),wait:Number(q.get('wait'))};
   const result=await holdBusRead({owner:OWNER,waits:busWaitsPort(env.EVENT_BUS_WAITS),revokeCheckMs:Number(q.get('slice')??5000),
    read:async lease=>unwrap(await account.read(q.get('bus'),args,lease?{resume:lease}:{hold:true})),
    recheck:async()=>{if(!unwrap(await account.granted()))throw Object.assign(new Error('revoked'),{code:'forbidden'});}});
   return json(publicRead(result));
  }
  return json({error:'not_found'},404);
 }catch(error){return json({error:error.code??'internal',message:String(error.message)},error.code==='forbidden'?403:500);}
}};`;

async function harness(){
 const temporary=await mkdtemp(path.join(tmpdir(),'3sln-event-bus-')),out=path.join(temporary,'worker.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'event-bus-wait-harness.mjs'},outfile:out,bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers','node:*'],target:'es2022',logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'event-bus-wait-test',modulesRoot:temporary,modules:[{type:'ESModule',path:out}],compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],log:new Log(LogLevel.ERROR),bindings:{KEY:Buffer.alloc(32,9).toString('base64')},
  durableObjects:{ACCOUNTS:{className:'TestBusAccount',useSQLite:true},EVENT_BUS_WAITS:{className:'EventBusWaiter',useSQLite:true}}}));
 const call=async(route,status=200)=>{const response=await mf.dispatchFetch('http://localhost'+route);const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
 return {call,close:async()=>{await mf.dispose();await rm(temporary,{recursive:true,force:true});}};
}

test('workerd: long-polls wait in the EventBusWaiter object, never in the account object; publish wakes, revocation forbids',async t=>{
 const h=await harness();t.after(()=>h.close());
 const bus=await h.call('/setup'),start=await h.call(`/read?bus=${bus.id}`);
 const begun=Date.now(),poll=h.call(`/poll?bus=${bus.id}&cursor=${encodeURIComponent(start.cursor)}&wait=15`);
 await new Promise(resolve=>setTimeout(resolve,300));
 const publishStart=Date.now();await h.call(`/publish?bus=${bus.id}&task=woke`);const publishMs=Date.now()-publishStart;
 assert.ok(publishMs<2000,`the gated account object served a publish while the poll waited (${publishMs} ms)`);
 const woke=await poll;assert.deepEqual(woke.records.map(r=>r.data.task),['woke']);assert.equal(woke.wait,undefined);
 assert.ok(Date.now()-begun<8000,'woken by the publish, not the 15 s timeout');
 assert.equal(await h.call('/leases'),0,'the resumed read released its lease');
 // Without the holding adapter, `wait` is served as 0 and no lease is taken.
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));await pause(1100);// production read rate: 2 per second per grant
 const quick=Date.now(),unheld=await h.call(`/read?bus=${bus.id}&cursor=${encodeURIComponent(woke.cursor)}&wait=10`);
 assert.deepEqual([unheld.records.length,unheld.wait],[0,undefined]);assert.ok(Date.now()-quick<2000);assert.equal(await h.call('/leases'),0);
 await pause(1100);
 // A held poll is answered forbidden after revocation (the hook rings the wait object; the edge recheck backs it up).
 const held=h.call(`/poll?bus=${bus.id}&cursor=${encodeURIComponent(woke.cursor)}&wait=15&slice=1000`,403);
 await new Promise(resolve=>setTimeout(resolve,300));const revokedAt=Date.now();await h.call('/revoke');
 assert.equal((await held).error,'forbidden');assert.ok(Date.now()-revokedAt<5000,'within 5 s of revocation');
 assert.equal(await h.call('/leases'),0);
});

test('workerd owner routes: 404 with the flag off; with it on, feeds come only from the reviewed registry',async t=>{
 const {createHarness}=await import('./harness.mjs');
 const url='https://tasks.example/buses/task-changes/v1',contract='https://spec.bindle.example/contracts/event-bus/v1';
 const manifest={id:url,title:'Task changes',description:'A record when a task changes.',publisher:'https://tasks.example',fields:{bus:{title:'Bus',type:'resource',cardinality:{min:0,max:1},contracts:[contract]}},slot:{v:1,crit:['bus'],field:'bus',selection:'exclusive',consumers:['application'],bus:{v:1,types:['created'],payload:{type:'object',additionalProperties:false,properties:{task:{type:'string',maxLength:64}}},max_record_bytes:1024,retention:{min_seconds:60,max_seconds:86400},publishers:['application'],readers:['application'],history:'owner-choice',effects:{read:{en:'See tasks.'},write:{en:'Add tasks.'}}}}};
 for(const enabled of ['false','true']){
  const h=await createHarness({bindings:{EVENT_BUSES_ENABLED:enabled,FEDERATION_SCHEMAS:JSON.stringify({[url]:manifest})}});t.after(()=>h.close());
  const {result:owner,cookie}=await h.signup(),headers={Origin:h.origin,Cookie:cookie,'X-CSRF-Token':owner.csrfToken};
  const call=(path,method='GET',value)=>h.request(path,{method,headers:method==='GET'?{Cookie:cookie}:headers,...value!==undefined?{value}:{}});
  if(enabled==='false'){for(const [path,method]of [['/api/events/buses','GET'],['/api/events/buses','POST']])assert.equal((await call(path,method,method==='POST'?{url}:undefined)).status,404);continue;}
  assert.deepEqual(await (await call('/api/events/buses')).json(),{buses:[]});
  assert.equal((await call('/api/events/buses','POST',{url:url+'/other'})).status,400,'unregistered manifests are refused');
  const created=await (await call('/api/events/buses','POST',{url})).json();assert.equal(created.created,true);const id=created.bus.id;
  assert.equal((await (await call('/api/events/buses','POST',{url})).json()).created,false);
  assert.equal((await (await call(`/api/events/buses/${id}/retention`,'PUT',{seconds:3600})).json()).retention.seconds,3600);
  assert.equal((await call(`/api/events/buses/${id}/purge`,'POST',{})).status,200);
  assert.equal((await call(`/api/events/buses/${id}/history`,'PUT',{clientId:'https://tasks.example/client.json'})).status,200);
  assert.equal((await call(`/api/events/buses/${id}/purge`,'GET')).status,405);
  assert.equal((await h.request('/api/events/buses',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},value:{url}})).status,403);
  assert.deepEqual(await (await call(`/api/events/buses/${id}`,'DELETE')).json(),{deleted:true});
  assert.equal((await call(`/api/events/buses/${id}`)).status,404);
 }
});
