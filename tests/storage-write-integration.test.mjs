import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {AccountController,FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {guardedBucket} from '../packages/runtime/guarded-bucket.mjs';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://provider.example',contract='https://3sln.me/artefacts/contracts/object-storage/v1';
async function fixture(t,config={}){
 const metadata=new SqliteMetadata(':memory:'),shared=new Map(),objects=new Map();let calls=0,archives=0,fail=false;
 const bucket={put:async(key,bytes)=>{calls++;if(fail)throw new Error('Unknown provider outcome');objects.set(key,new Uint8Array(bytes));},get:async key=>objects.has(key)?{arrayBuffer:async()=>objects.get(key).buffer}:null,delete:async key=>objects.delete(key)};
 const authority={consume:async(key,limits)=>{if(!shared.has(key))shared.set(key,new SqliteMetadata(':memory:'));return new FixedWindowGuard({metadata:shared.get(key)}).consume(limits);}};
 const controller=new AccountController({metadata,gate:new SerialGate(),blobs:bucket,archives:{...bucket,put:async()=>{archives++;}},config:{APP_ORIGIN:origin,STORAGE_WRITE_ENABLED:'true',WORK_LIMITS_ENABLED:'false',WORK_AUTHORITY:authority,...config},sql:metadata.sql});
 t.after(()=>{metadata.close();for(const db of shared.values())db.close();});const invoke=async(method,...args)=>{const result=await controller.invoke({method,args});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;};const resource=(await invoke('resources',owner))[0];
 const rpc=(method,args,clientId='https://app.example/client',tx=crypto.randomUUID())=>invoke('federationRPC',{subject:origin+'/entities/'+owner,resource:origin+'/entities/'+owner+'/resources/'+resource.id,contract,method,args,clientId,tx});
 return {metadata,controller,resource,rpc,shared,get calls(){return calls;},get archives(){return archives;},set fail(value){fail=value;}};
}
test('real account writes and replacements share durable app/account bursts across both bucket ports',async t=>{
 const f=await fixture(t,{STORAGE_WRITE_APP_PER_MINUTE:2,STORAGE_WRITE_OWNER_PER_MINUTE:4});
 const first=await f.rpc('put',{key:'same',dataBase64:'eA==',condition:{absent:true}}),second=await f.rpc('put',{key:'same',dataBase64:'eQ==',condition:{version:first.object.version}});
 await assert.rejects(f.rpc('put',{key:'different',dataBase64:'eg==',condition:{absent:true}}),error=>error.code==='rate_limited'&&error.status===429&&error.retryAfter>0);assert.equal(f.calls,2);
 await f.rpc('delete',{key:'same',version:second.object.version});await f.rpc('put',{key:'same',dataBase64:'eg==',condition:{absent:true}},'https://other.example/client');await f.rpc('put',{key:'another',dataBase64:'eA==',condition:{absent:true}},'https://other.example/client');assert.equal(f.calls,4);
 await assert.rejects(f.controller.archives.put('accounts/'+owner+'.json','{}'),{code:'rate_limited'});assert.equal(f.archives,0);assert.equal((await f.controller.storageUsage(owner)).writeOperations.used,4);
 const read=await f.rpc('get',{key:'same'});assert.equal(read.dataBase64,'eg==');assert.equal(f.calls,4);
});
test('monthly write exhaustion preserves archived maintenance, reads and completed replay without more provider writes',async t=>{
 const f=await fixture(t,{STORAGE_WRITE_FREE_MONTHLY_LIMIT:1,STORAGE_WRITE_MAINTENANCE_MONTHLY_LIMIT:1});const tx=crypto.randomUUID(),args={key:'one',dataBase64:'eA==',condition:{absent:true}},result=await f.rpc('put',args,undefined,tx);
 assert.deepEqual(await f.rpc('put',args,undefined,tx),result);assert.equal(f.calls,1);await assert.rejects(f.rpc('put',{...args,key:'two'}),{code:'quota_exceeded'});assert.equal(f.calls,1);
 await f.controller.archives.put('accounts/'+owner+'.json','{}');assert.equal(f.archives,1);await assert.rejects(f.controller.archives.put('accounts/'+owner+'.json','{}'),{code:'quota_exceeded'});assert.equal(f.archives,1);
 assert.equal((await f.rpc('get',{key:'one'})).dataBase64,'eA==');await f.rpc('delete',{key:'one',version:result.object.version});assert.equal((await f.controller.storageUsage(owner)).writeOperations.maintenanceUsed,1);
});
test('failed physical attempts are charged and unknown write outcomes never automatically retry the bucket',async t=>{
 const f=await fixture(t,{STORAGE_WRITE_FREE_MONTHLY_LIMIT:1});f.fail=true;const tx=crypto.randomUUID(),args={key:'one',dataBase64:'eA==',condition:{absent:true}};
 await assert.rejects(f.rpc('put',args,undefined,tx),{code:'indeterminate'});await assert.rejects(f.rpc('put',args,undefined,tx),{code:'indeterminate'});assert.equal(f.calls,1);assert.equal((await f.controller.storageUsage(owner)).writeOperations.used,1);
 await assert.rejects(f.rpc('put',{...args,key:'two'}),{code:'quota_exceeded'});assert.equal(f.calls,1);
});
test('paused physical cleanup stops storage churn while preserving reads, deletion and archive capacity',async t=>{
 const f=await fixture(t),first=await f.rpc('put',{key:'one',dataBase64:'eA==',condition:{absent:true}});await f.metadata.put('storage/garbage-retry',{paused:true});
 await assert.rejects(f.rpc('put',{key:'one',dataBase64:'eQ==',condition:{version:first.object.version}}),{code:'storage_write_unavailable',status:503});assert.equal(f.calls,1);assert.equal((await f.rpc('get',{key:'one'})).dataBase64,'eA==');await f.rpc('delete',{key:'one',version:first.object.version});
 await f.controller.archives.put('accounts/'+owner+'.json','{}');assert.equal(f.archives,1);assert.equal((await f.controller.storageUsage(owner)).writeOperations.used,1);
});
test('bucket guard strips private admission fields and exposes no unmetered list/copy/multipart operations',async()=>{
 assert.throws(()=>new AccountController({config:{STORAGE_WRITE_ENABLED:'enabled'}}),{name:'TypeError'});
 let received,admissions=0;const bucket=guardedBucket({put:async(...args)=>{received=args;},get:async()=>null,delete:async()=>true,list:async()=>{throw Error('Unmetered list');},createMultipartUpload:async()=>{throw Error('Unmetered multipart');}},{admit:async clientId=>{admissions++;assert.equal(clientId,'app');}});
 await bucket.put('key','data',{httpMetadata:{contentType:'text/plain'},storageAdmission:{clientId:'app'}});assert.deepEqual(received,['key','data',{httpMetadata:{contentType:'text/plain'}}]);assert.equal(admissions,1);assert.equal(bucket.list,undefined);assert.equal(bucket.createMultipartUpload,undefined);assert.equal(await bucket.delete('key'),true);
});
test('shared lifetime and storage service state cannot reset on null or a changed monthly allocation policy',async()=>{
 const db=new SqliteMetadata(':memory:');try{const guard=new FixedWindowGuard({metadata:db});await db.put('lifetime',null);assert.equal(await guard.consume({lifetime:true,limit:10}),false);assert.equal(await db.get('lifetime'),null);
 const storageWrite={pool:'foreground',totalLimit:10,foregroundLimit:8,maintenanceLimit:2};assert.equal(await guard.consume({lifetime:true,limit:8,units:8,storageWrite}),true);assert.equal(await guard.consume({lifetime:true,limit:4,units:4,storageWrite:{pool:'maintenance',totalLimit:10,foregroundLimit:6,maintenanceLimit:4}}),false);assert.equal((await db.get('storage-write')).total,8);
 assert.equal(await guard.consume({lifetime:true,limit:2,units:2,storageWrite:{...storageWrite,pool:'maintenance'}}),true);assert.equal((await db.get('storage-write')).total,10);assert.equal(await guard.consume({lifetime:true,limit:8,storageWrite}),false);
 await db.put('storage-write',{version:1,limits:{total:10,foreground:8,maintenance:2},total:3,foreground:0,maintenance:3});assert.equal(await guard.consume({lifetime:true,limit:8,storageWrite}),false);assert.equal((await db.get('storage-write')).foreground,0);
 }finally{db.close();}
});
