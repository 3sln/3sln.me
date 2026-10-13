import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageReceiptBudget,MESSAGE_RECEIPT_DEFAULTS,MESSAGE_RECEIPT_STATE,MESSAGE_RECEIPT_MAX_PARENTS,MESSAGE_RECEIPT_MAX_STATE_BYTES,messageReceiptLimits} from '../packages/runtime/message-receipt-budget.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {conversationInbox} from '../packages/conversations/runtime.mjs';
import {key} from '../packages/messaging/store.mjs';
import application from '../packages/runtime/http.mjs';

const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START=Date.UTC(2026,9,13,12,0,0);
function limits(ownerCount=10,contactCount=5,ownerBytes=10485760,contactBytes=5242880){const policy=structuredClone(MESSAGE_RECEIPT_DEFAULTS);for(const p of Object.values(policy))for(const [scope,count,bytes]of [['owner',ownerCount,ownerBytes],['contact',contactCount,contactBytes]])for(const name of ['minute','hour','day'])p[scope][name]={messages:count,bytes};return policy;}
async function fixture(t,policy=limits()){
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());await db.put('owner',OWNER);let now=START;
 const config={MESSAGE_RECEIPT_LIMITS:policy},budget=new MessageReceiptBudget({metadata:db,config,clock:()=>now});
 const parent=async(owner=OWNER)=>{const id=crypto.randomUUID();await db.put(key('contact-grant',id),{id,owner,active:true,claims:{sub:owner,exp:Math.floor((START+10*86400000)/1000)}});return id;};
 return {db,budget,config,parent,clock:v=>{now=v;},get now(){return now;}};
}

test('receipt configuration is strict, bounded by owner, and preserves approved defaults',()=>{
 assert.equal(MESSAGE_RECEIPT_DEFAULTS.free.owner.minute.messages,30);assert.equal(MESSAGE_RECEIPT_DEFAULTS.free.contact.minute.messages,15);
 assert.equal(MESSAGE_RECEIPT_DEFAULTS.ultra.owner.day.bytes,8192*1048576);
 for(const input of [null,[],new Date(),1,'{',{'unknown':{}},{free:{}},JSON.stringify({free:{owner:{},contact:{}}})])assert.throws(()=>messageReceiptLimits({MESSAGE_RECEIPT_LIMITS:input}),{code:'message_receipt_unavailable'});
 for(const value of [-1,1.5,'2',NaN,Infinity]){const p=limits();p.free.owner.minute.messages=value;assert.throws(()=>messageReceiptLimits({MESSAGE_RECEIPT_LIMITS:p}),{code:'message_receipt_unavailable'});}
 const p=limits();p.free.contact.minute.messages=11;assert.throws(()=>messageReceiptLimits({MESSAGE_RECEIPT_LIMITS:p}),{code:'message_receipt_unavailable'});
 const valid=messageReceiptLimits({MESSAGE_RECEIPT_LIMITS:JSON.stringify({free:limits(0,0,0,0).free})});assert.equal(valid.free.owner.day.messages,0);assert.equal(valid.paid.owner.minute.messages,120);
});

test('owner and contact count/byte windows intersect atomically without rejection writes',async t=>{
 const f=await fixture(t,limits(3,2,9,6)),a=await f.parent(),b=await f.parent();
 await f.budget.admit(OWNER,{parent:a,bytes:3});await f.budget.admit(OWNER,{parent:a,bytes:3});const state=await f.db.get(MESSAGE_RECEIPT_STATE);
 await assert.rejects(f.budget.admit(OWNER,{parent:a,bytes:0}),{code:'message_receipt_limited',retryAfter:43200});assert.deepEqual(await f.db.get(MESSAGE_RECEIPT_STATE),state);
 await assert.rejects(f.budget.admit(OWNER,{parent:b,bytes:7}),error=>error.code==='message_receipt_too_large'&&error.status===413&&error.retryAfter===undefined);
 await assert.rejects(f.budget.admit(OWNER,{parent:b,bytes:4}),{code:'message_receipt_limited'});assert.deepEqual(await f.db.get(MESSAGE_RECEIPT_STATE),state);
 await f.budget.admit(OWNER,{parent:b,bytes:3});await assert.rejects(f.budget.admit(OWNER,{parent:b,bytes:0}),{code:'message_receipt_limited'});
 const status=await f.budget.status(OWNER);assert.equal(status.unit,'admitted-new-message-attempts');assert.equal(status.windows.day.messages,3);assert.equal(status.windows.day.bytes,9);assert.deepEqual(status.windows.day.remaining,{messages:0,bytes:0});
});

test('simultaneous parent lanes cannot exceed one owner cap; restart retains state',async t=>{
 const f=await fixture(t,limits(12,12)),parents=await Promise.all(Array.from({length:4},()=>f.parent()));
 const competing=new MessageReceiptBudget({metadata:f.db,config:f.config,clock:()=>f.now});
 const result=await Promise.allSettled(Array.from({length:40},(_,i)=>(i%2?f.budget:competing).admit(OWNER,{parent:parents[i%4],bytes:1})));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,12);assert(result.filter(r=>r.status==='rejected').every(r=>r.reason.code==='message_receipt_limited'));
 const restarted=new MessageReceiptBudget({metadata:f.db,config:f.config,clock:()=>f.now});await assert.rejects(restarted.admit(OWNER,{parent:parents[0],bytes:1}),{code:'message_receipt_limited'});
});

test('window boundaries, failed attempts, disabled limits and backward/corrupt state fail conservatively',async t=>{
 const p=limits(10,10);p.free.owner.minute.messages=1;p.free.contact.minute.messages=1;const f=await fixture(t,p),parent=await f.parent();
 await f.budget.admit(OWNER,{parent,bytes:0});await assert.rejects(f.budget.admit(OWNER,{parent,bytes:0}),{retryAfter:60});
 f.clock(START+60000);await f.budget.admit(OWNER,{parent,bytes:0});assert.equal((await f.budget.status(OWNER)).windows.hour.messages,2);
 f.clock(START+59999);await assert.rejects(f.budget.admit(OWNER,{parent,bytes:0}),{code:'message_receipt_unavailable'});
 f.clock(START+2*3600000);const later=await f.parent();await f.budget.admit(OWNER,{parent:later,bytes:1});assert.equal((await f.budget.status(OWNER)).windows.day.messages,3);
 f.clock(START+86400000);await f.budget.admit(OWNER,{parent,bytes:1});assert.equal((await f.budget.status(OWNER)).windows.day.messages,1);
 const zero=new MessageReceiptBudget({metadata:f.db,config:{MESSAGE_RECEIPT_LIMITS:limits(0,0,0,0)},clock:()=>f.now});await assert.rejects(zero.admit(OWNER,{parent,bytes:1}),error=>error.code==='message_receipt_disabled'&&error.retryAfter===undefined);
 const good=await f.db.get(MESSAGE_RECEIPT_STATE);
 for(const bad of [null,{...good,last:NaN},{...good,owner:OTHER},{...good,last:good.last+60000},{...good,windows:{...good.windows,hour:{...good.windows.hour,epoch:good.windows.hour.epoch-1}}},{...good,contacts:{bad:{}}},{...good,windows:{...good.windows,day:{...good.windows.day,bytes:-1}}}]){await f.db.put(MESSAGE_RECEIPT_STATE,bad);await assert.rejects(f.budget.status(OWNER),{code:'message_receipt_unavailable'});}
});

test('owner, live parent and confirmed plan checks precede accounting; downgrade does not reset usage',async t=>{
 const p=limits(1,1);p.paid=limits(3,3).paid;const f=await fixture(t,p),parent=await f.parent(),foreign=await f.parent(OTHER);
 await assert.rejects(f.budget.admit(OTHER,{parent:foreign,bytes:1}),{code:'forbidden'});
 for(const id of [foreign,crypto.randomUUID()])await assert.rejects(f.budget.admit(OWNER,{parent:id,bytes:1}),{code:'unauthorized'});
 for(const bytes of [-1,1048577,1.5,NaN])await assert.rejects(f.budget.admit(OWNER,{parent,bytes}),{code:'invalid_message'});
 assert.equal(await f.db.get(MESSAGE_RECEIPT_STATE),undefined);
 await f.db.put('billing/state',{owner:OWNER,source:'polar',catalogVersion:2,plan:'paid',validUntil:START+1000});
 await f.budget.admit(OWNER,{parent,bytes:1});await f.budget.admit(OWNER,{parent,bytes:1});assert.equal((await f.budget.status(OWNER)).plan,'paid');
 f.clock(START+1001);await assert.rejects(f.budget.admit(OWNER,{parent,bytes:1}),{code:'message_receipt_limited'});assert.equal((await f.budget.status(OWNER)).windows.day.messages,2);
 const grant=await f.db.get(key('contact-grant',parent));await f.db.put(key('contact-grant',parent),{...grant,active:false});await assert.rejects(f.budget.admit(OWNER,{parent,bytes:1}),{code:'unauthorized'});
});

test('all current plan tiers map directly and provisional or foreign billing cannot inflate allowance',async t=>{
 const f=await fixture(t);for(const plan of ['paid','plus','ultra']){await f.db.put('billing/state',{owner:OWNER,source:'polar',catalogVersion:2,plan,validUntil:START+60000});assert.equal((await f.budget.status(OWNER)).plan,plan);}
 const parameters=id=>({id,name:id,storageBytes:1000000,activityHour:100,activityDay:1000}),config={...f.config,APP_ORIGIN:'https://provider.example',POLAR_SERVER:'sandbox'};
 const billing={owner:OWNER,source:'polar',catalogVersion:3,plan:'paid',validUntil:START+60000,origin:config.APP_ORIGIN,server:'sandbox',metadataPrefix:'3sln_me_',catalogMode:'static',organizationId:'org',productId:'product',subscriptionId:'subscription',currency:'usd',verifiedPlan:parameters('paid')};
 billing.upgrade={version:1,plan:'ultra',parameters:parameters('ultra'),owner:OWNER,origin:billing.origin,server:billing.server,organizationId:billing.organizationId,subscriptionId:billing.subscriptionId,targetProductId:'upgrade',currency:'usd',startedAt:START,expiresAt:START+1000};
 await f.db.put('billing/state',billing);const budget=new MessageReceiptBudget({metadata:f.db,config,clock:()=>START});assert.equal((await budget.status(OWNER)).plan,'paid');
 await f.db.put('billing/state',{...billing,origin:'https://other.example'});assert.equal((await budget.status(OWNER)).plan,'free');
 await f.db.put('billing/state',{...billing,owner:OTHER});assert.equal((await budget.status(OWNER)).plan,'free');
});

test('bounded parent state has a distinct capacity refusal and expires without resetting owner windows',async t=>{
 const f=await fixture(t,limits(5000,5000)),parent=await f.parent();await f.budget.admit(OWNER,{parent,bytes:1});const state=await f.db.get(MESSAGE_RECEIPT_STATE);
 for(let i=1;i<MESSAGE_RECEIPT_MAX_PARENTS;i++)state.contacts[crypto.randomUUID()]=structuredClone(state.contacts[parent]);for(const row of Object.values(state.windows)){row.messages=MESSAGE_RECEIPT_MAX_PARENTS;row.bytes=MESSAGE_RECEIPT_MAX_PARENTS;}await f.db.put(MESSAGE_RECEIPT_STATE,state);
 assert(new TextEncoder().encode(JSON.stringify(state)).byteLength<=MESSAGE_RECEIPT_MAX_STATE_BYTES);
 const next=await f.parent();await assert.rejects(f.budget.admit(OWNER,{parent:next,bytes:1}),{code:'message_receipt_capacity',retryAfter:43200});
 f.clock(START+86400000);await f.budget.admit(OWNER,{parent:next,bytes:1});assert.equal(Object.keys((await f.db.get(MESSAGE_RECEIPT_STATE)).contacts).length,1);
});

async function runtime(t,policy=limits(2,1),extraConfig={}){
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());const stored=new Map();let puts=0,failPut=false;
 const blobs={put:async(k,bytes)=>{puts++;if(failPut)throw Error('storage unavailable');stored.set(k,new Uint8Array(bytes));},get:async k=>stored.has(k)?{arrayBuffer:async()=>stored.get(k).buffer}:null,delete:async k=>stored.delete(k)};
 const controller=new AccountController({metadata:db,gate:new SerialGate(),blobs,archives:{},config:{APP_ORIGIN:'https://provider.example',KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),MESSAGE_RECEIPT_LIMITS:policy,...extraConfig},sql:db.sql});
 await controller.touch(OWNER);const collection=(await controller.collections(OWNER))[0].id;
 const contact=async()=>{const link=await controller.createContact(OWNER,'person',{name:'Receipt test',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,maxMessages:100});return {...link,token:(await controller.mintContact(OWNER,link.url)).token};};
 const invoke=async(method,args)=>{const result=await controller.invoke({method,args});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;};
 const send=(link,id=crypto.randomUUID(),text='hello')=>invoke('receive',[OWNER,link.token,{collection,mimeType:'text/plain',bytes:[...new TextEncoder().encode(text)],idempotencyKey:id,senderMetadata:{subject:'test',tags:[]}}]);
 return {db,controller,collection,contact,send,stored,get puts(){return puts;},fail:()=>{failPut=true;}};
}

test('runtime replay and refreshed child tokens share parent cap; conflict/revocation never reveal or debit replay',async t=>{
 const f=await runtime(t),a=await f.contact(),b=await f.contact(),id=crypto.randomUUID(),accepted=await f.send(a,id);assert.equal(f.puts,1);
 a.token=(await f.controller.mintContact(OWNER,a.url)).token;assert.deepEqual(await f.send(a,id),accepted);assert.equal(f.puts,1);
 await assert.rejects(f.send(a,id,'changed'),{code:'idempotency_conflict'});assert.equal((await f.controller.messageReceiptBudget.status(OWNER)).windows.day.messages,1);
 await assert.rejects(f.send(a),{code:'message_receipt_limited'});assert.equal(f.puts,1);
 await f.send(b);const c=await f.contact();await assert.rejects(f.send(c),{code:'message_receipt_limited'});assert.equal(f.puts,2);
 await f.controller.tokens.revoke(OWNER,a.id);await assert.rejects(f.send(a,id),{code:'unauthorized'});assert.equal(f.puts,2);
 assert.equal((await f.controller.snapshot(OWNER)).messageReceiptAdmission.unit,'admitted-new-message-attempts');
});

test('runtime downstream write failure conservatively consumes attempt without enabling refunds or retries past cap',async t=>{
 const f=await runtime(t,limits(1,1),{WORK_LIMITS_ENABLED:true,STORAGE_WRITE_ENABLED:true,WORK_AUTHORITY:{consume:async()=>true}}),a=await f.contact(),before=(await f.controller.workBudget.status(OWNER)).used;
 f.fail();await assert.rejects(f.send(a));assert.equal(f.puts,1);assert.equal((await f.controller.workBudget.status(OWNER)).used,before+2);await assert.rejects(f.send(a),{code:'message_receipt_limited'});assert.equal(f.puts,1);assert.equal((await f.controller.workBudget.status(OWNER)).used,before+2);assert.equal((await f.controller.messageReceiptBudget.status(OWNER)).windows.day.messages,1);
});

test('stored conversation events share aggregate receipt cap and established event replay avoids R2 churn',async t=>{
 const f=await runtime(t),a=await f.contact();await f.send(a);
 const room={id:crypto.randomUUID(),source:{origin:'https://peer.example',owner:OTHER},collection:f.collection,title:'Thread'},event={eventId:crypto.randomUUID(),threadId:crypto.randomUUID(),replyTo:null,tags:[],text:'Event'};
 const receive=e=>f.controller.gate.run(()=>conversationInbox(f.controller,OWNER,room,e));const accepted=await receive(event);assert.equal(f.puts,2);assert.deepEqual(await receive(event),accepted);assert.equal(f.puts,2);
 await assert.rejects(receive({...event,text:'changed'}),{code:'conversation_replay_conflict'});await assert.rejects(receive({...event,eventId:crypto.randomUUID()}),{code:'message_receipt_limited'});assert.equal(f.puts,2);assert.equal((await f.controller.messageReceiptBudget.status(OWNER)).windows.day.messages,2);
});

test('cross-origin signed contact HTTP refusal exposes Retry-After without weakening private-route CORS',async t=>{
 const f=await runtime(t,limits(1,1)),link=await f.contact();await f.send(link);
 const env={APP_ORIGIN:'https://provider.example',ABUSE_HASH_KEY:'test-abuse-key',ABUSE:{consume:async()=>true},IDENTITY_REPOSITORY:{get:async()=>({id:OWNER,status:'active',handle:'person'})},ACCOUNTS:{get:()=>f.controller}};
 const form=new FormData();form.append('collection',f.collection);form.append('mimeType','text/plain');form.append('idempotencyKey',crypto.randomUUID());form.append('message',new Blob(['limited'],{type:'text/plain'}),'message.txt');
 const response=await application.fetch(new Request(link.url,{method:'POST',headers:{Origin:'https://external.example'},body:form}),env);
 assert.equal(response.status,429,await response.clone().text());assert.equal((await response.json()).error,'message_receipt_limited');assert(Number(response.headers.get('Retry-After'))>0);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(response.headers.get('Access-Control-Expose-Headers'),'Retry-After');assert.equal(response.headers.get('Vary'),'Accept');assert.equal(f.puts,1);
 const privateResponse=await application.fetch(new Request('https://provider.example/api/contacts',{method:'POST',headers:{Origin:'https://external.example','Content-Type':'application/json'},body:'{}'}),env);assert.equal(privateResponse.headers.get('Access-Control-Allow-Origin'),null);
});
