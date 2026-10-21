import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {createTestEngine,ownerActor,OWNER,OTHER} from './helpers/engine.mjs';
import {SHELL_OPERATIONS} from '../../apps/bindlebox/worker/operations.mjs';
import {createNodeShell,listenNodeShell} from '../../apps/bindlebox/node/server.mjs';
import {linkContract} from './receive-fixtures.test.mjs';
import {SqliteMailboxStore} from '../../apps/bindlebox/node/storage.mjs';
import {createHTTP} from '../../apps/bindlebox/worker/http.mjs';
import {party,world,linkPayload,recordPayload,receiptFor,uuidOf} from './vectors/fixtures.mjs';
import {principalKey} from '../../packages/bindlebox-engine/store/mailbox.mjs';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
const vectors=JSON.parse(await readFile(new URL('./vectors/vectors.json',import.meta.url))),now=Date.now();
const alice=await party('alice',vectors.keys,{now}),bob=await party('bob',vectors.keys,{now}),owner=alice.principal.subject;
const grant={revision:1,active:true,recipients:[{issuer:bob.principal.issuer,subject:bob.principal.subject}]};
async function draft(n=1){const body=new TextEncoder().encode('Durable shell message'),payload=await linkPayload(alice,bob,{operationId:uuidOf(n),createdAt:Date.now()-1000,body});return {operationId:uuidOf(n),body,recipients:[{envelope:await B.signEnvelope(payload,alice.signer),ingress:bob.ingress,credential:'BindleLink e30.e30.AA'}]};}
const harness=`
import worker,{MailboxObject,LinkIndexObject} from './apps/bindlebox/worker/index.mjs';
import {DurableObject} from 'cloudflare:workers';
import {party,world,receiptFor} from './tests/bindlebox/vectors/fixtures.mjs';
import * as B from './packages/bindlebox-protocol/index.mjs';
export {LinkIndexObject};
export class Recipient extends DurableObject {
 async deliver(contentType,bytes){const parsed=await B.parseDelivery(contentType,bytes),id=parsed.envelope.payload.operationId;let receipt=await this.ctx.storage.get(id);if(!receipt){const bob=await party('bob',JSON.parse(this.env.TEST_KEYS),{now:Date.now()});receipt=await receiptFor(bob,parsed.envelope,{receivedAt:Date.now(),ingress:bob.ingress});await this.ctx.storage.put(id,receipt);await this.ctx.storage.put('effects',(await this.ctx.storage.get('effects')??0)+1);}return {receipt};}
 async effects(){return await this.ctx.storage.get('effects')??0;}
}
export class TestMailbox extends MailboxObject {
 ports(){return {directory:{resolveKey:async q=>{const bob=await party('bob',JSON.parse(this.env.TEST_KEYS),{now:Date.now()});return world({bob}).resolveKey(q);},status:async()=>({status:'active'})},egress:{fetch:async(url,init)=>{const recipient=this.env.RECIPIENT.get(this.env.RECIPIENT.idFromName('bob')),value=await recipient.deliver(init.headers['Content-Type'],init.body);if(this.env.TEST_MODE==='crash')return new Promise(()=>{});return Response.json(value);}}};}
 async snapshot(){return {rows:[...await this.ctx.storage.list()],alarm:await this.ctx.storage.getAlarm(),sql:[...this.ctx.storage.sql.exec('SELECT name FROM sqlite_master')]};}
 async rollback(){try{await this.store.transaction(async tx=>{await tx.put('bb:send:task/rollback',{state:'queued',nextAttemptAt:Date.now()+86400000});throw new Error('rollback');});}catch{}return this.snapshot();}
}
export default worker;
`;
async function workerHarness(t,{enabled='true',mode='deliver'}={}){
 const directory=await mkdtemp(join(tmpdir(),'bb-b8-workerd-')),out=join(directory,'worker.mjs');let mf;
 await build({stdin:{contents:harness,resolveDir:process.cwd(),sourcefile:'bb-b8-harness.mjs'},outfile:out,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],logLevel:'silent'});
 const start=async(nextMode=mode)=>{mf=new Miniflare(convertV4MiniflareOptions({name:'bb-b8',modules:[{type:'ESModule',path:out}],modulesRoot:directory,compatibilityDate:'2026-10-11',log:new Log(LogLevel.ERROR),resourcePersistencePath:join(directory,'state'),bindings:{BINDLEBOX_ENABLED:enabled,TEST_MODE:nextMode,TEST_KEYS:JSON.stringify(vectors.keys)},durableObjects:{MAILBOXES:{className:'TestMailbox',useSQLite:true},LINK_INDEX:{className:'LinkIndexObject',useSQLite:true},RECIPIENT:{className:'Recipient',useSQLite:true}}}));await mf.ready;};
 await start();t.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
 return {get mf(){return mf;},async box(id=owner){const ns=await mf.getDurableObjectNamespace('MAILBOXES');return ns.get(ns.idFromName(id));},async recipient(){const ns=await mf.getDurableObjectNamespace('RECIPIENT');return ns.get(ns.idFromName('bob'));},async restart(nextMode='deliver'){await mf.dispose();await start(nextMode);}};
}
const rows=snapshot=>new Map(snapshot.rows);
async function waitFor(read,accept,timeout=25000){const end=Date.now()+timeout;for(;;){const value=await read();if(accept(value))return value;if(Date.now()>end)assert.fail('Timed out waiting for workerd alarm');await new Promise(resolve=>setTimeout(resolve,50));}}
function value(result){assert.equal(result.ok,true,JSON.stringify(result));return result.value;}

test('BB-B8 shell operations use the engine harness, bind owners and fence authorization updates',async t=>{
 const h=createTestEngine({registry:SHELL_OPERATIONS,providers:{delegateKeys:{renew:async()=>({jkt:'test',expiresAt:123})}}});t.after(()=>h.dispose());
 assert.deepEqual(await h.run('shell.bind'),{owner:OWNER});
 await assert.rejects(h.run('shell.bind',{actor:ownerActor(OTHER)}),error=>error.code==='forbidden');
 assert.deepEqual(await h.run('shell.authorization',{input:{...grant,revision:2}}),{applied:true,revision:2});
 assert.deepEqual(await h.run('shell.authorization',{input:{...grant,active:false}}),{applied:false,revision:2});
 assert.deepEqual(await h.run('shell.delegation-renew'),{jkt:'test',expiresAt:123});
 assert.equal((await h.store.get('shell:renewal')).at,h.clock.now()+60000);
 await h.run('shell.authorization',{input:{...grant,revision:3,active:false}});
 await assert.rejects(h.run('shell.delegation-renew'),error=>error.code==='not_authorized');assert.equal(await h.store.get('shell:renewal'),undefined);
});

test('BB-B8 Worker is disabled by default; SQLite mailbox never binds through disabled HTTP/RPC',async t=>{
 const h=await workerHarness(t,{enabled:'false'}),box=await h.box();
 assert.equal((await h.mf.dispatchFetch('https://messages.example/api/send')).status,404);
 assert.equal((await box.invoke(owner,'mailbox.ping')).error.code,'not_found');
 assert.equal(rows(await box.snapshot()).get('owner'),undefined);
});

test('BB-B8 workerd conversation return routing checks the durable capability index before waking a mailbox',async t=>{
 const h=await workerHarness(t),token=B.base64url(new Uint8Array(24).fill(17)),url='https://messages.example/bindle/ingress/return/'+token,request=()=>h.mf.dispatchFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal((await request()).status,403);assert.equal(rows(await (await h.box()).snapshot()).get('owner'),undefined);
 let hash=2166136261;for(const c of 'route:'+token)hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;const ns=await h.mf.getDurableObjectNamespace('LINK_INDEX'),index=ns.get(ns.idFromName(`links-v1/${hash%64}`));
 assert.equal(await index.publishConversation({kind:'route',token,owner,generation:2}),true);assert.equal(await index.publishConversation({kind:'route',token,owner,generation:1}),false);
 assert.equal((await request()).status,403,'mailbox independently refuses a capability with no local invitation');assert.equal(rows(await (await h.box()).snapshot()).get('owner'),owner,'valid indexed capability reached the conversation engine');
});

test('BB-B8 outbox uses B4 live peer authority and cancels a removed peer before delivery',async t=>{
 const h=createTestEngine({owner});t.after(()=>h.dispose());await h.store.put('shell:authorization',{...grant,recipients:[]});
 const {createMailbox}=await import('../../apps/bindlebox/worker/mailbox.mjs'),clock={now:()=>now},box=createMailbox({store:h.store,clock,BINDLEBOX_ENABLED:true});t.after(()=>box.dispose());
 const body=new TextEncoder().encode('Conversation message'),payload=await recordPayload(alice,bob,'message',{createdAt:now-1000,body,operationId:uuidOf(70)}),cid=payload.record.conversationId,peerKey=`conv/peer/${cid}/${principalKey({issuer:bob.principal.issuer,subject:bob.principal.subject})}`,peer={state:'accepted',outbound:{incarnation:payload.recipient.incarnation}};
 await h.store.put('conv/room/'+cid,{id:cid,state:'active'});await h.store.put(peerKey,peer);
 await box.run(owner,'send.submit',{input:{operationId:payload.operationId,body,recipients:[{envelope:await B.signEnvelope(payload,alice.signer),ingress:bob.ingress,credential:`BindleConversation ${payload.record.epoch}.${B.base64url(new Uint8Array(32))}`} ]}});
 await h.store.put(peerKey,{...peer,state:'removed'});await box.run(owner,'outbox.drain');assert.equal((await box.run(owner,'outbox.get',{id:payload.operationId})).cancelled,1);
});

test('BB-B8 workerd SQLite alarms recover remote custody after process loss during an in-flight send',async t=>{
 const h=await workerHarness(t,{mode:'crash'}),box=await h.box(),input=await draft();await box.provision(owner,{authorization:grant});
 const submitted=value(await box.invoke(owner,'send.submit',{input}));assert.equal(submitted.pending,1);
 const held=await waitFor(()=>box.snapshot(),snapshot=>[...rows(snapshot)].some(([key,row])=>key.startsWith('bb:send:task/')&&row.state==='in_progress'));
 const task=[...rows(held)].find(([key])=>key.startsWith('bb:send:task/'))[1];
 assert.ok(held.sql.length,'actual workerd SQLite storage, not a memory provider');assert.ok(held.alarm>=task.lease.until,'claim durably arms recovery before egress');
 await waitFor(async()=>(await h.recipient()).effects(),n=>n===1);
 const rolled=await box.rollback();assert.equal(rows(rolled).has('bb:send:task/rollback'),false);assert.equal(rolled.alarm,held.alarm,'failed transaction leaves alarm and queue unchanged');
 await h.restart();const restored=await h.box();
 let view=value(await restored.invoke(owner,'outbox.get',{id:input.operationId}));assert.equal(view.pending,1);assert.equal(view.recipients[0].attempts,1,'restart respects the persisted lease');
 await waitFor(async()=>value(await restored.invoke(owner,'outbox.get',{id:input.operationId})),view=>view.delivered===1);
 view=value(await restored.invoke(owner,'outbox.get',{id:input.operationId}));assert.equal(view.recipients[0].attempts,2);assert.equal(await (await h.recipient()).effects(),1,'same operation has one recipient effect');
 assert.equal((await restored.snapshot()).alarm,null,'final receipt stops the queue alarm');
 const page=value(await restored.invoke(owner,'send.events',{input:{after:'invalid/resume/token'}}));assert.equal(page.reset,true);assert.equal(page.events[0].type,'reset');
 const streamed=await restored.invoke(owner,'send.events-stream',{input:{after:'invalid/resume/token'}});assert.equal(streamed.ok,true);const stream=new Response(streamed.response.body,{status:streamed.response.status,headers:streamed.response.headers});assert.equal(stream.headers.get('Content-Type'),'text/event-stream');assert.match(await stream.text(),/event: reset/);
 await h.restart();assert.equal(value(await (await h.box()).invoke(owner,'outbox.get',{id:input.operationId})).delivered,1,'verified receipt survives another runtime restart');
});

test('BB-B8 Node SQLite recovers idle mailbox timers and preserves bytes, rollbacks and consent on restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'bb-b8-node-'));let shell;
 t.after(async()=>{await shell?.close();await rm(directory,{recursive:true,force:true});});
 const input=await draft(2),store=new SqliteMailboxStore(join(directory,owner+'.sqlite'));
 // Commit through the SAME production composition without a running timer, then simulate process exit.
 const {createMailbox}=await import('../../apps/bindlebox/worker/mailbox.mjs'),box=createMailbox({store,BINDLEBOX_ENABLED:true});await box.open(owner);await box.provision(owner,{authorization:grant});await box.run(owner,'send.submit',{input});
 await store.put('typed',new Uint8Array([0,255]));await assert.rejects(store.transaction(async tx=>{await tx.put('typed','lost');throw new Error('rollback');}));await box.dispose();await store.close();
 let deliveries=0;
 shell=await createNodeShell({directory,BINDLEBOX_ENABLED:true,portsFor:()=>({directory:world({bob}),egress:{fetch:async(url,init)=>{deliveries++;const parsed=await B.parseDelivery(init.headers['Content-Type'],init.body);return Response.json({receipt:await receiptFor(bob,parsed.envelope,{receivedAt:Date.now(),ingress:bob.ingress})});}}})});
 const restored=await shell.mailbox(owner);assert.deepEqual(await restored.store.get('typed'),new Uint8Array([0,255]));
 await waitFor(()=>restored.run(owner,'outbox.get',{id:input.operationId}),v=>v.delivered===1);assert.equal(deliveries,1);assert.equal(await restored.store.get('shell:alarm'),undefined);
});

test('BB-B8 HTTP maps allowlisted intents to dispatch, pins the authenticated actor and bounds bodies',async()=>{
 const calls=[],box={run:async(...args)=>{calls.push(args);return {ok:true};}},http=createHTTP({BINDLEBOX_ENABLED:true,authenticate:async()=>({kind:'owner',owner}),mailbox:async()=>box});
 const headers={Authorization:'Bearer local-test','Content-Type':'application/json'};
 assert.equal((await http(new Request('https://messages.example/api/send',{method:'POST',headers,body:JSON.stringify({...await draft(3),body:[65],actor:{kind:'owner',owner:OTHER}})}))).status,200);
 assert.equal(calls[0][0],owner);assert.equal(calls[0][1],'send.submit');assert.deepEqual(calls[0][2].input.body,new Uint8Array([65]));
 assert.equal((await http(new Request('https://messages.example/api/send',{method:'POST',headers,body:'{"body":[999]}'}))).status,400);
 for(const body of ['null','[]','{"body":null,"recipients":[null]}'])assert.equal((await http(new Request('https://messages.example/api/send',{method:'POST',headers,body}))).status,400);
 assert.equal((await http(new Request('https://messages.example/api/events',{headers:{...headers,Accept:'text/event-stream','Last-Event-ID':'resume'}}))).status,200);assert.equal(calls.at(-1)[1],'send.events-stream');assert.equal(calls.at(-1)[2].input.after,'resume');
 assert.equal((await http(new Request('https://messages.example/api/delegation/renew',{method:'POST',headers}))).status,200);assert.equal(calls.at(-1)[1],'shell.delegation-renew');
 assert.equal((await http(new Request('https://messages.example/api/send'))).status,401);
 assert.equal((await http(new Request('https://messages.example/api/dispatch',{method:'POST',headers}))).status,404);
 assert.equal((await http(new Request('https://messages.example/api/send',{method:'POST',headers:{...headers,'Content-Length':'9000000'},body:'{}'}))).status,413);
});

test('BB-B8 Node HTTP receives a signed delivery through its durable edge index and replays committed custody',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'bb-b8-receive-')),ingress='https://alice.box.example/bindle/ingress',recipient=await party('alice',vectors.keys,{claims:{ingress}}),clock={now:()=>Date.UTC(2026,9,20,12)},links=linkContract(recipient,clock);let shell;
 const start=()=>createNodeShell({directory,BINDLEBOX_ENABLED:true,clock,portsFor:()=>({directory:world({alice:recipient,bob:awaitedBob}),delegateKeys:{current:async()=>recipient.signer},providerLink:links})});
 const awaitedBob=await party('bob',vectors.keys);shell=await start();t.after(async()=>{await shell.close();await rm(directory,{recursive:true,force:true});});
 await shell.provision(owner,{receive:{principal:recipient.principal,ingress},authorization:{...grant,recipients:[]}});const target=await shell.mailbox(owner),link=await target.run(owner,'contacts.create-link',{input:{}}),body=new TextEncoder().encode('Actual Node custody');
 const payload=await linkPayload(awaitedBob,recipient,{operationId:uuidOf(40),createdAt:clock.now()-1000,body,recipient:{issuer:recipient.principal.issuer,owner,contactId:link.jti,resource:link.resource}}),envelope=await B.signEnvelope(payload,awaitedBob.signer),wire=B.encodeDelivery(envelope,{body,boundary:'bb-b8-node'}),headers={'Content-Type':wire.contentType,Authorization:'BindleLink '+new URL(link.link).searchParams.get('bindle_meta'),'Idempotency-Key':payload.operationId};
 const first=await shell.fetch(new Request(ingress,{method:'POST',headers,body:wire.bytes}));assert.equal(first.status,200,await first.clone().text());const admitted=await first.json();assert.ok(admitted.receipt);
 await shell.close();shell=await start();const replay=await shell.fetch(new Request(ingress,{method:'POST',headers,body:wire.bytes}));assert.equal(replay.status,200,await replay.clone().text());assert.deepEqual(await replay.json(),admitted);assert.equal((await (await shell.mailbox(owner)).store.list({prefix:'item/'})).size,1);
});

test('BB-B8 executable Node listener serves default-off HTTP over a real loopback socket',async t=>{
 const host=await listenNodeShell({port:0});t.after(()=>host.close());const response=await fetch(`http://127.0.0.1:${host.server.address().port}/api/send`);assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'not_found'});
});
