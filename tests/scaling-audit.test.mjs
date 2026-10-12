import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {StorageQuota,storageState} from '../packages/runtime/storage-quota.mjs';
import {AccountItemIndex} from '../packages/runtime/item-index.mjs';
import {BILLING_STATE_KEY} from '../packages/billing/index.mjs';
import {key} from '../packages/messaging/store.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate,FileBucket} from '../apps/node/resources.mjs';
import application from '../packages/runtime/http.mjs';
import {Webhook} from 'standardwebhooks';
import {createNodeServer} from '../apps/node/server.mjs';
import {mkdtemp,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const owner='aa111111-1111-4111-8111-111111111111',other='bb222222-2222-4222-8222-222222222222';
class Metadata {
  constructor(){this.rows=new Map();this.tail=Promise.resolve();this.alarm=null;}
  async get(k){return structuredClone(this.rows.get(k));}
  async put(k,v){this.rows.set(k,structuredClone(v));}
  async delete(k){for(const id of Array.isArray(k)?k:[k])this.rows.delete(id);}
  async list({prefix='',startAfter='',limit=100000}={}){return new Map([...this.rows].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  async getAlarm(){return this.alarm;}
  async setAlarm(value){this.alarm=value;}
  async transaction(fn){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;const rows=structuredClone(this.rows),alarm=this.alarm;try{return await fn(this);}catch(e){this.rows=rows;this.alarm=alarm;throw e;}finally{release();}}
}
function fixture(){let now=Date.now();const metadata=new Metadata(),deleted=[],blobs={delete:async ref=>deleted.push(ref)},quota=new StorageQuota({metadata,blobs,clock:()=>now});return {metadata,blobs,quota,deleted,get now(){return now;},advance:ms=>now+=ms};}
const reservation=(bytes,extra={})=>{const id=crypto.randomUUID();return {id,bytes,kind:'object',blobRef:`objects/${owner}/${id}`,...extra};};
function sqlFixture(){const db=new DatabaseSync(':memory:');const sql={exec:(query,...params)=>{const statement=db.prepare(query);return statement.columns().length?statement.all(...params):(statement.run(...params),[]);}};return {db,sql,index:new AccountItemIndex(sql)};}
async function controllerFixture(){
  const metadata=new SqliteMetadata(':memory:'),stored=new Map(),deleted=[],checks=[];
  const blobs={put:async(ref,bytes)=>{assert.equal(metadata.db.isTransaction,false,'blob upload must occur outside metadata transaction');const reservationRows=await metadata.list({prefix:'storage/reservation/'});assert([...reservationRows.values()].some(r=>r.blobRef===ref),'durable reservation precedes blob upload');checks.push(ref);stored.set(ref,new Uint8Array(bytes));},get:async ref=>{const bytes=stored.get(ref);return bytes?{arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}:null;},delete:async ref=>{deleted.push(ref);stored.delete(ref);}};
  const controller=new AccountController({metadata,gate:new SerialGate(),blobs,archives:{},config:{APP_ORIGIN:'https://3sln.example',KEY_ENCRYPTION_KEY:Buffer.alloc(32,47).toString('base64')},sql:metadata.sql});
  const invoke=async(method,...args)=>{const result=await controller.invoke({method,args:[owner,...args]});assert.equal(result.$fault,undefined,JSON.stringify(result));return result;};
  const collection=(await invoke('collections'))[0].id;
  const contact=await invoke('createContact','alice',{name:'Audit contact',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000});
  const minted=await invoke('mintContact',contact.url);
  return {controller,metadata,stored,deleted,checks,invoke,collection,token:minted.token,close:()=>metadata.close()};
}

test('audit: aggregate quota binds owner and expires paid storage without deleting committed usage',async()=>{
  const f=fixture();await f.metadata.put(key('message-usage',owner),{bytes:250000000,messages:10});await f.metadata.put('hosted-usage',{bytes:300000000,objects:10});
  await f.metadata.put(BILLING_STATE_KEY,{owner:other,source:'polar',plan:'pro',validUntil:f.now+1000});
  const mismatch=await f.quota.usage(owner);assert.equal(mismatch.plan,'free');assert.equal(mismatch.overLimit,true);assert.equal(mismatch.usedBytes,550000000);
  await f.metadata.put(BILLING_STATE_KEY,{owner,source:'polar',plan:'plus',validUntil:f.now+1000});assert.equal((await f.quota.usage(owner)).plan,'plus');
  f.advance(1001);const expired=await f.quota.usage(owner);assert.equal(expired.plan,'free');assert.equal(expired.usedBytes,550000000);assert.equal(expired.remainingBytes,0);
  await assert.rejects(f.quota.reserve(owner,reservation(1)),{code:'account_quota_exceeded'});
  const shrink=await f.quota.reserve(owner,reservation(1,{replacedBytes:2}));assert.equal(shrink.growthBytes,0);
});
test('audit: concurrent aggregate reservations cannot spend the same remaining bytes',async()=>{
  const f=fixture();await f.metadata.put('hosted-usage',{bytes:499999999,objects:1});
  const results=await Promise.allSettled([f.quota.reserve(owner,reservation(1)),f.quota.reserve(owner,reservation(1))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected')[0].reason.code,'account_quota_exceeded');
  const usage=await f.quota.usage(owner);assert.equal(usage.reservedBytes,1);assert.equal(usage.pendingUploadBytes,1);
});
test('audit: reservation survives rollback and commits atomically with final content usage',async()=>{
  const f=fixture(),r=await f.quota.reserve(owner,reservation(10));assert.equal(await f.metadata.getAlarm(),f.now+20*60000);
  await assert.rejects(f.metadata.transaction(async tx=>{await tx.put('hosted-usage',{bytes:10,objects:1});await f.quota.commit(tx,r.id);throw new Error('simulated metadata failure');}),/simulated metadata failure/);
  assert(await f.metadata.get('storage/reservation/'+r.id));assert.equal(await f.metadata.get('hosted-usage'),undefined);
  await f.metadata.transaction(async tx=>{await tx.put('hosted-usage',{bytes:10,objects:1});await f.quota.commit(tx,r.id);});
  assert.equal(await f.metadata.get('storage/reservation/'+r.id),undefined);assert.equal((await f.quota.usage(owner)).reservedBytes,0);assert.equal((await f.quota.usage(owner)).usedBytes,10);
  await f.quota.release(r.id);assert.equal(f.deleted.length,0,'committed data must never be cleaned as an orphan');
});
test('audit: a paid deadline crossed during upload rejects positive growth at commit',async()=>{
  const f=fixture();await f.metadata.put(BILLING_STATE_KEY,{owner,source:'polar',plan:'plus',validUntil:f.now+1});await f.metadata.put('hosted-usage',{bytes:500000000,objects:1});
  const r=await f.quota.reserve(owner,reservation(1));f.advance(2);
  await assert.rejects(f.metadata.transaction(async tx=>{await tx.put('hosted-usage',{bytes:500000001,objects:2});await f.quota.commit(tx,r.id);}),{code:'account_quota_exceeded'});
  assert.equal((await f.quota.usage(owner)).usedBytes,500000000);assert(await f.metadata.get('storage/reservation/'+r.id));
  await f.quota.release(r.id);assert.deepEqual(f.deleted,[r.blobRef]);
});
test('audit: failed orphan deletion retains reservation and retries through scheduled cleanup',async()=>{
  const f=fixture(),r=await f.quota.reserve(owner,reservation(10));f.blobs.delete=async()=>{throw new Error('bucket unavailable');};
  await f.quota.release(r.id);assert.equal((await f.quota.usage(owner)).reservedBytes,10);
  f.advance(21*60000);await f.quota.cleanup();assert(await f.metadata.get('storage/reservation/'+r.id));assert((await f.quota.nextCleanup())>f.now);
  f.blobs.delete=async ref=>f.deleted.push(ref);f.advance((await f.quota.nextCleanup())-f.now);await f.quota.cleanup();assert.equal((await f.quota.usage(owner)).reservedBytes,0);assert.deepEqual(f.deleted,[r.blobRef]);
});
test('audit: a timed-out upload lease cannot commit after its twenty-minute reservation window',async()=>{
  const f=fixture(),r=await f.quota.reserve(owner,reservation(1));f.advance(20*60000);
  await assert.rejects(f.metadata.transaction(async tx=>{await tx.put('hosted-usage',{bytes:1,objects:1});await f.quota.commit(tx,r.id);}),{code:'conflict'});
  assert.equal(await f.metadata.get('hosted-usage'),undefined);await f.quota.release(r.id);assert.deepEqual(f.deleted,[r.blobRef]);
});
test('audit: failed first cleanup page cannot permanently starve later healthy orphans',async()=>{
  const f=fixture();const ids=[];
  for(let i=0;i<40;i++){const id=String(i).padStart(8,'0')+'-1111-4111-8111-111111111111';ids.push(id);await f.quota.reserve(owner,reservation(1,{id,blobRef:`objects/${owner}/${id}`}));}
  const failing=new Set(ids.slice(0,32).map(id=>`objects/${owner}/${id}`));f.blobs.delete=async ref=>{if(failing.has(ref))throw new Error('specific corrupted object');f.deleted.push(ref);};f.advance(21*60000);
  for(let i=0;i<4;i++){await f.quota.cleanup();const next=await f.quota.nextCleanup();if(Number.isFinite(next))f.advance(Math.max(0,next-f.now));}
  assert.equal(f.deleted.length,8);for(const id of ids.slice(32))assert.equal(await f.metadata.get('storage/reservation/'+id),undefined);
});
test('audit: inbox SQL keyset pages bind owner and filter scope with equal timestamp ties',()=>{
  const f=sqlFixture();try{
    for(let i=0;i<450;i++)f.index.upsert({id:String(i).padStart(4,'0'),owner,receivedAt:100,collection:'inbox',readAt:null,quarantined:false,mimeType:'text/plain',size:1,blobRef:'private',bytes:new Uint8Array(1)});
    f.index.upsert({id:'secret',owner:other,receivedAt:200,collection:'inbox',readAt:null,quarantined:false});
    const first=f.index.page(owner,{limit:200});assert.equal(first.items.length,200);assert(first.items.every(x=>x.owner===owner&&!Object.hasOwn(x,'blobRef')&&!Object.hasOwn(x,'bytes')));
    assert.throws(()=>f.index.page(other,{limit:200,cursor:first.cursor}),{code:'invalid_args'});assert.throws(()=>f.index.page(owner,{limit:200,cursor:first.cursor,unread:true}),{code:'invalid_args'});
    const second=f.index.page(owner,{limit:200,cursor:first.cursor}),third=f.index.page(owner,{limit:200,cursor:second.cursor});assert.equal(third.items.length,50);assert.equal(third.cursor,null);assert.equal(new Set([...first.items,...second.items,...third.items].map(i=>i.id)).size,450);
  }finally{f.db.close();}
});
test('audit: Unicode hosted keys remain pageable and cursor cannot change resource or prefix',()=>{
  const f=sqlFixture();try{
    for(const name of ['📁/一','📁/二','📁/三'])f.index.upsertObject('resource',{key:name,size:1,version:'v',blobRef:'private'});
    const first=f.index.objectPage('resource',{prefix:'📁/',limit:1});assert.equal(first.objects.length,1);assert(first.cursor);assert(!Object.hasOwn(first.objects[0],'blobRef'));
    assert.throws(()=>f.index.objectPage('other',{prefix:'📁/',limit:1,cursor:first.cursor}),{code:'invalid_args'});
    const second=f.index.objectPage('resource',{prefix:'📁/',limit:1,cursor:first.cursor});assert.equal(second.objects.length,1);assert.notEqual(second.objects[0].key,first.objects[0].key);
  }finally{f.db.close();}
});
test('audit: actual Node message upload reserves before blob effect, outside SQL and commits metadata/index/usage together',async()=>{
  const f=await controllerFixture();try{
    const input={collection:f.collection,mimeType:'text/plain',bytes:Array.from(new TextEncoder().encode('audit payload')),idempotencyKey:'audit-upload'};
    const receipt=await f.invoke('receive',f.token,input);assert.equal(f.checks.length,1);assert.equal((await f.controller.storageUsage(owner)).reservedBytes,0);
    assert.equal(f.controller.itemIndex.page(owner).items[0].id,receipt.id);assert.equal((await f.controller.storageUsage(owner)).usedBytes,13);assert.equal(new TextDecoder().decode((await f.controller.content(owner,receipt.id)).bytes),'audit payload');
    const duplicate=await f.invoke('receive',f.token,input);assert.equal(duplicate.id,receipt.id);assert.equal(f.checks.length,1);
    await f.invoke('deleteMessage',receipt.id);assert.equal((await f.controller.storageUsage(owner)).usedBytes,0);assert.equal(f.controller.itemIndex.page(owner).items.length,0);assert.equal(f.stored.size,0);
  }finally{f.close();}
});
test('audit: Node metadata commit failure rolls back SQL index and usage, then releases the uncommitted blob',async()=>{
  const f=await controllerFixture();try{
    const commit=f.controller.quota.commit.bind(f.controller.quota);f.controller.quota.commit=async(...args)=>{await commit(...args);throw new Error('injected post-index commit failure');};
    const result=await f.controller.invoke({method:'receive',args:[owner,f.token,{collection:f.collection,mimeType:'text/plain',bytes:[97],idempotencyKey:'audit-rollback'}]});assert(result.$fault);
    assert.equal(f.checks.length,1);assert.equal(f.stored.size,0);assert.equal(f.deleted.length,1);assert.equal(f.controller.itemIndex.page(owner).items.length,0);
    const usage=await f.controller.storageUsage(owner);assert.equal(usage.usedBytes,0);assert.equal(usage.reservedBytes,0);assert.equal((await f.metadata.list({prefix:'message-receipt/'})).size,0);
  }finally{f.close();}
});
test('audit: actual hosted objects share inbox quota and preserve reads/shrinks/deletes after downgrade',async()=>{
  const f=await controllerFixture();try{
    const resource=await f.invoke('addResource',{provider:'hosted',name:'Audit storage'}),call=(method,args)=>f.controller.hostedOperation(resource,method,args);
    const created=await call('put',{key:'📁/one',dataBase64:Buffer.from('one').toString('base64'),condition:{absent:true}});assert.equal(f.checks.length,1);
    const disconnect=await f.controller.invoke({method:'deleteResource',args:[owner,resource.id]});assert.equal(disconnect.$fault?.code,'resource_not_empty');assert(await f.metadata.get('resource/'+resource.id));
    await f.metadata.put(key('message-usage',owner),{bytes:500000000,messages:1});
    assert.equal((await f.controller.storageUsage(owner)).overLimit,true);
    const before=f.checks.length;await assert.rejects(call('put',{key:'two',dataBase64:'eA==',condition:{absent:true}}),{code:'account_quota_exceeded'});assert.equal(f.checks.length,before,'over-quota growth must be refused before upload');
    assert.equal(Buffer.from((await call('get',{key:'📁/one'})).dataBase64,'base64').toString(),'one');
    const shrunk=await call('put',{key:'📁/one',dataBase64:'eA==',condition:{version:created.object.version}});assert.equal(shrunk.object.size,1);assert.equal((await f.controller.storageUsage(owner)).usedBytes,500000001);
    const page=await call('list',{prefix:'📁/'});assert.equal(page.objects.length,1);assert.equal(page.objects[0].key,'📁/one');
    await call('delete',{key:'📁/one',version:shrunk.object.version});assert.equal((await f.controller.storageUsage(owner)).usedBytes,500000000);assert.equal((await call('list',{})).objects.length,0);
    await f.invoke('deleteResource',resource.id);assert.equal(await f.metadata.get('resource/'+resource.id),undefined);
  }finally{f.close();}
});
test('audit: hosted object post-index failure rolls metadata, SQL and quota back and removes orphan',async()=>{
  const f=await controllerFixture();try{
    const resource=await f.invoke('addResource',{provider:'hosted',name:'Audit storage'}),commit=f.controller.quota.commit.bind(f.controller.quota);f.controller.quota.commit=async(...args)=>{await commit(...args);throw new Error('injected hosted transaction failure');};
    await assert.rejects(f.controller.hostedOperation(resource,'put',{key:'object',dataBase64:'eA==',condition:{absent:true}}),/injected hosted transaction failure/);
    assert.equal(f.checks.length,1);assert.equal(f.stored.size,0);assert.equal(f.deleted.length,1);assert.equal((await f.controller.storageUsage(owner)).usedBytes,0);assert.equal((await f.controller.storageUsage(owner)).reservedBytes,0);
    assert.equal(f.controller.itemIndex.objectPage(resource.id).objects.length,0);assert.equal((await f.metadata.list({prefix:'hosted/'})).size,0);
  }finally{f.close();}
});
test('audit: Node failed atomic blob rename cleans its untracked temporary file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'3sln-bucket-failure-audit-'));try{
    const bucket=new FileBucket(directory),destination=bucket.path('conflicting-key');await mkdir(destination);
    await assert.rejects(bucket.put('conflicting-key',new Uint8Array([1,2,3])));
    assert.deepEqual(await readdir(directory),[destination.slice(destination.lastIndexOf('/')+1)]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('audit: large-account alarms use bounded metadata pages and retain content beyond legacy snapshot bounds',async()=>{
  const f=await controllerFixture();try{
    await f.metadata.transaction(async tx=>{
      for(let i=0;i<2005;i++){const message={id:crypto.randomUUID(),owner,collection:f.collection,receivedAt:i,readAt:null,quarantined:false,mimeType:'text/plain',size:1,blobRef:`messages/${owner}/seed_${i}`};await tx.put(key('message',owner,message.id),message);f.controller.itemIndex.upsert(message);}
      await tx.put(key('message-usage',owner),{bytes:2005,messages:2005});await tx.put('lastOwnerActiveAt',0);
    });
    const list=f.metadata.list.bind(f.metadata),limits=[];f.metadata.list=async options=>{assert(options?.prefix,'alarm must not scan every account record');assert(Number.isSafeInteger(options.limit)&&options.limit<=2001,'alarm metadata pages must be bounded');limits.push(options.limit);return list(options);};
    await f.controller.alarm();assert(limits.includes(2001));assert.equal((await f.metadata.get('cold-index-mode')).mode,'indexed-sqlite');assert.equal(await f.metadata.get('shelved'),undefined);assert.equal((await f.controller.storageUsage(owner)).messageCount,2005);assert.equal(f.controller.itemIndex.page(owner,{limit:200}).items.length,200);assert((await f.metadata.getAlarm())>Date.now());
  }finally{f.close();}
});
test('audit: committed blob garbage retries fairly and cannot delete a current hosted replacement',async()=>{
  const f=await controllerFixture();try{
    const resource=await f.invoke('addResource',{provider:'hosted',name:'Garbage audit'}),call=(method,args)=>f.controller.hostedOperation(resource,method,args);
    const first=await call('put',{key:'item',dataBase64:'eA==',condition:{absent:true}}),replacement=await call('put',{key:'item',dataBase64:'eQ==',condition:{version:first.object.version}});
    const current=await f.metadata.get(`hosted/${resource.id}/${encodeURIComponent('item')}`),old=[...f.stored.keys()].find(ref=>ref!==current.blobRef);assert(old);assert.equal(f.stored.size,2);
    const deletion=f.controller.blobs.delete;f.controller.blobs.delete=async()=>{throw new Error('bucket outage');};await f.controller.collectBlobGarbage();assert.equal((await f.metadata.list({prefix:'blob-garbage/'})).size,1);assert.equal(f.stored.size,2);
    f.controller.blobs.delete=deletion;const retry=await f.metadata.get('storage/garbage-retry');await f.metadata.put('storage/garbage-retry',{...retry,retryAt:0});await f.controller.collectBlobGarbage();assert.equal(f.stored.size,1);assert(f.stored.has(current.blobRef));assert(!f.stored.has(old));assert.equal((await f.metadata.list({prefix:'blob-garbage/'})).size,0);
    assert.equal((await call('get',{key:'item',ifVersion:replacement.object.version})).dataBase64,'eQ==');
  }finally{f.close();}
});
test('audit: HTTP webhook validates exact raw signature before identity lookup or account allocation',async()=>{
  const secret='whsec_'+Buffer.alloc(32,59).toString('base64'),calls=[];
  const env={APP_ORIGIN:'https://3sln.example',BILLING_ENABLED:'true',POLAR_SERVER:'sandbox',POLAR_ACCESS_TOKEN:'offline',POLAR_WEBHOOK_SECRET:secret,POLAR_PRODUCT_ID_PLUS:'plus',POLAR_PRODUCT_ID_PRO:'pro',IDENTITY_ENGINE:()=>{throw new Error('webhook must not require an owner session');},IDENTITY_REPOSITORY:{get:async id=>{calls.push(['identity',id]);return id===owner?{id,status:'active'}:null;}},ACCOUNTS:{get:id=>{calls.push(['account',id]);return {invoke:async operation=>{calls.push(['operation',operation]);return {accepted:true};}};}}};
  const signed=(externalID=owner,tamper=false)=>{const date=new Date(),id='audit_hook',body=JSON.stringify({type:'customer.state_changed',api_version:'2026-10',timestamp:date.toISOString(),data:{external_id:externalID,metadata:{owner:other}}});return new Request(env.APP_ORIGIN+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(date.getTime()/1000)),'webhook-signature':new Webhook(secret).sign(id,date,body)},body:tamper?'{}':body});};
  const invalid=await application.fetch(signed(owner,true),env,{});assert.equal(invalid.status,403);assert.equal(calls.length,0);
  const valid=await application.fetch(signed(),env,{});assert.equal(valid.status,200);assert.deepEqual(calls.slice(0,2),[['identity',owner],['account',owner]]);
  const operation=calls[2][1];assert.equal(operation.method,'billingWebhookVerified');assert.equal(operation.args[0],owner);assert.equal(operation.args[1].owner,owner);assert(!Object.hasOwn(operation.args[1],'data'));
  calls.length=0;const inactive=await application.fetch(signed(other),env,{});assert.equal(inactive.status,409);assert.deepEqual(calls,[['identity',other]]);
  calls.length=0;assert.equal((await application.fetch(new Request(env.APP_ORIGIN+'/api/billing/webhook'),env,{})).status,405);assert.equal(calls.length,0);
});
test('audit: actual Node billing actions enforce owner session, exact Origin and CSRF before selecting authenticated UUID',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'3sln-billing-http-audit-')),origin='http://localhost:8789';let app;
  try{
    app=await createNodeServer({directory,config:{APP_ORIGIN:origin,BILLING_ENABLED:'false'}});
    const request=(path,{method='GET',value,headers={}}={})=>app.fetch(new Request(origin+path,{method,headers:{...(value===undefined?{}:{'content-type':'application/json'}),...headers},...(value===undefined?{}:{body:JSON.stringify(value)})}));
    const post=(path,value,headers={})=>request(path,{method:'POST',value,headers:{Origin:origin,...headers}});
    const pending=await (await post('/api/auth/signup',{handle:'billing_audit',method:'password',password:'offline billing audit test password',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'})).json();
    const recovery=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();
    const activated=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true});assert.equal(activated.status,200);const session=await activated.json();
    const headers={Origin:origin,Cookie:activated.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':session.csrfToken};
    assert.equal((await request('/api/billing')).status,401);assert.equal((await post('/api/billing/checkout',{plan:'plus'})).status,401);
    assert.equal((await post('/api/billing/checkout',{plan:'plus'},{...headers,Origin:'https://attacker.example'})).status,403);
    assert.equal((await post('/api/billing/checkout',{plan:'plus'},{...headers,'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await request('/api/billing/checkout',{headers})).status,405);
    const disabled=await post('/api/billing/checkout',{plan:'plus'},headers);assert.equal(disabled.status,503);assert.equal((await disabled.json()).error,'billing_disabled');
    const status=await request('/api/billing',{headers});assert.equal(status.status,200);assert.equal((await status.json()).storageBytes,500000000);
    const controller=app.resources.accounts.get(session.account.id),seen=[];controller.billing.checkout=async(id,plan)=>{seen.push({id,plan});return {url:'https://checkout.example/offline-mock'};};
    const selected=await post('/api/billing/checkout',{plan:'pro',owner:other,external_customer_id:other,metadata:{owner:other}},headers);assert.equal(selected.status,200);assert.deepEqual(seen,[{id:session.account.id,plan:'pro'}]);
  }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
