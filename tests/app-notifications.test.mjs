import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {FederationController,federationMetadata} from '../packages/federation/runtime.mjs';
import {handleFederation} from '../packages/federation/http.mjs';
import {federationControllerOptions,federationEpoch} from '../packages/runtime/federation.mjs';
import {APP_NOTIFICATIONS,APP_NOTIFICATION_PREFERENCES,notificationInput} from '../packages/federation/app-notifications.mjs';
import {publicNotificationKeys,appNotificationSigner} from '../packages/runtime/app-notifications.mjs';
import {canonical,key,fromBase64url} from '../packages/messaging/store.mjs';
import {defaultNotificationPreferences} from '../packages/messaging/notifications.mjs';
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ISSUER='https://provider.example',ORIGIN='https://app.example';
const client={id:ORIGIN+'/client',origin:ORIGIN,name:'Calendar app',redirectUris:[ORIGIN+'/callback']};
const subject=ISSUER+'/entities/'+OWNER,resource=subject+'/app-messages';
const fragment={id:APP_NOTIFICATION_PREFERENCES,title:'App messages',description:'Allow app messages',publisher:'https://3sln.me',fields:{notifications:{type:'resource',title:'Messages',contracts:[APP_NOTIFICATIONS]}}};
async function keys(){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const kid=crypto.randomUUID();return {APP_NOTIFICATION_SIGNING_JWK:{...await crypto.subtle.exportKey('jwk',pair.privateKey),kid,alg:'ES256'},APP_NOTIFICATION_PUBLIC_JWKS:{keys:[{...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,alg:'ES256'}]}};}
async function fixture(t,overrides={}){
 const directory=await mkdtemp(join(tmpdir(),'bindle-app-messages-'));let db=new SqliteMetadata(join(directory,'account.sqlite')),fedDB=new SqliteMetadata(join(directory,'federation.sqlite'));t.after(async()=>{db.close();fedDB.close();await rm(directory,{recursive:true,force:true});});
 const blobs=new Map();let puts=0,failPut=false,afterPut;
 const bucket={put:async(path,bytes)=>{puts++;if(failPut)throw Error('lost storage response');blobs.set(path,new Uint8Array(bytes));await afterPut?.();},get:async path=>blobs.has(path)?{arrayBuffer:async()=>blobs.get(path).buffer}:null,delete:async path=>blobs.delete(path)};
 const identity={id:OWNER,status:'active',handle:'n.1',assignmentId:crypto.randomUUID(),recoveryHash:'recovery'},epoch=await federationEpoch(identity);
 const config={APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:[structuredClone(client)],FEDERATION_SCHEMAS:{[APP_NOTIFICATION_PREFERENCES]:fragment},FEDERATION_IDENTITY_CHECK:async(owner,value)=>owner===OWNER&&value===epoch&&identity.status==='active',...await keys(),...overrides};
 let account=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config,sql:db.sql});await account.touch(OWNER);
 const options=federationControllerOptions({config,repository:{get:async id=>id===OWNER?identity:null},accounts:{get:()=>account},owner:OWNER});
 let controller=new FederationController({...federationControllerOptions({config,repository:{get:async id=>id===OWNER?identity:null},accounts:{get:()=>account},owner:OWNER}),metadata:federationMetadata(fedDB),auth:{owner:async()=>({subject,epoch})}});
 const ownerAuth={sessionToken:'session'};
 await controller.configure(ownerAuth,{fragment:APP_NOTIFICATION_PREFERENCES,values:{notifications:resource},expectedRevision:null});
 async function connect(methods=['createOwn']){const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url'),request=await controller.beginAuthorization({clientId:client.id,redirectUri:client.redirectUris[0],challenge,challengeMethod:'S256',state:'state',requests:[{fragment:APP_NOTIFICATION_PREFERENCES,required:true,purpose:'Send me messages',fields:['notifications'],methods:{notifications:{[APP_NOTIFICATIONS]:methods}}}]});const view=await controller.inspect(ownerAuth,request.requestId);const callback=new URL((await controller.approve(ownerAuth,{requestId:request.requestId,approved:[{fragment:APP_NOTIFICATION_PREFERENCES,revision:view.requests[0].revision,fields:['notifications'],resources:{notifications:[resource]},methods:methods.length?{notifications:{[APP_NOTIFICATIONS]:methods}}:{}}]})).redirectUri);const session=await controller.exchange({clientId:client.id,redirectUri:client.redirectUris[0],code:callback.searchParams.get('code'),verifier});const pref=await controller.rpc(session.access_token,{version:'0',tx:crypto.randomUUID(),resource:'@preferences',contract:'https://3sln.me/artefacts/contracts/preferences/v1',method:'read',args:{fragment:APP_NOTIFICATION_PREFERENCES}});return {session,ref:pref.result.values.notifications};}
 const envelope=(ref,input={})=>{const transactionId=input.transactionId??crypto.randomUUID();return {version:'0',tx:transactionId,resource:ref.id,contract:APP_NOTIFICATIONS,method:'createOwn',args:{transactionId,createdAt:Date.now(),subject:'Event reminder',body:'Meeting tomorrow',...input}};};
 const send=(ref,e=envelope(ref),origin=ORIGIN)=>controller.rpc(ref.token,e,{requestOrigin:origin});
 const http=(ref,e,origin=ORIGIN)=>handleFederation(new Request(ISSUER+'/bindle/rpc',{method:'POST',headers:{Authorization:'Bearer '+ref.token,'Content-Type':'application/json',...(origin===null?{}:{Origin:origin})},body:JSON.stringify(e)}),{controller,issuer:ISSUER,clients:config.FEDERATION_CLIENTS});
 const invoke=async(method,args)=>{const r=await account.invoke({method,args});if(r?.$fault)throw Object.assign(Error(r.$fault.message),r.$fault);return r;};
 return {get db(){return db;},get fedDB(){return fedDB;},config,get account(){return account;},get controller(){return controller;},restart:()=>{db.close();fedDB.close();db=new SqliteMetadata(join(directory,'account.sqlite'));fedDB=new SqliteMetadata(join(directory,'federation.sqlite'));account=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config,sql:db.sql});controller=new FederationController({...federationControllerOptions({config,repository:{get:async id=>id===OWNER?identity:null},accounts:{get:()=>account},owner:OWNER}),metadata:federationMetadata(fedDB),auth:{owner:async()=>({subject,epoch})}});},identity,epoch,connect,envelope,send,http,invoke,blobs,get puts(){return puts;},failPut:()=>{failPut=true;},afterPut:f=>{afterPut=f;}};
}
test('app notification signer strictly validates public/private configuration without disclosing secrets',async()=>{
 const config=await keys(),signer=await appNotificationSigner(config);assert.equal(signer.kid,config.APP_NOTIFICATION_SIGNING_JWK.kid);assert.equal((await signer.sign({test:true})).length,86);
 for(const value of [undefined,{}, {keys:[]},{keys:[config.APP_NOTIFICATION_SIGNING_JWK]},{keys:[{...config.APP_NOTIFICATION_PUBLIC_JWKS.keys[0],alg:'none'}]}])assert.throws(()=>publicNotificationKeys(value),{code:'app_notifications_unavailable'});
 const other=await keys();for(const bad of [{...config,APP_NOTIFICATION_SIGNING_JWK:undefined},{...config,APP_NOTIFICATION_PUBLIC_JWKS:other.APP_NOTIFICATION_PUBLIC_JWKS},{...config,APP_NOTIFICATION_SIGNING_JWK:{...config.APP_NOTIFICATION_SIGNING_JWK,d:other.APP_NOTIFICATION_SIGNING_JWK.d}}])await assert.rejects(appNotificationSigner(bad),e=>e.code==='app_notifications_unavailable'&&!e.message.includes(config.APP_NOTIFICATION_SIGNING_JWK.d));
});
test('plaintext schema rejects routing/actions, invalid UUID/timestamps, control text and encoded byte excess',()=>{
 const now=Date.now(),transactionId=crypto.randomUUID(),base={transactionId,createdAt:now,subject:'Hi',body:'Hello'};assert.deepEqual(notificationInput(base,transactionId,now),{...base,mimeType:'text/plain',tags:[]});
 for(const input of [{...base,recipient:OWNER},{...base,actions:[]},{...base,createdAt:now-86400000},{...base,createdAt:now+60001},{...base,body:'x\0'},{...base,subject:'x'.repeat(121)},{...base,body:'界'.repeat(6000)}])assert.throws(()=>notificationInput(input,transactionId,now));
 assert.throws(()=>notificationInput(base,crypto.randomUUID(),now));assert.doesNotThrow(()=>notificationInput({...base,subject:'🙂'.repeat(120)},transactionId,now));
});
test('real durable resource consent creates signed local plaintext with no contact capability; replay creates one blob/outbox',async t=>{
 const f=await fixture(t),{ref}=await f.connect(),e=f.envelope(ref);const response=await f.send(ref,e);assert.equal(response.error,undefined);const accepted=response.result;assert.equal(accepted.accepted,true);assert.equal(f.puts,1);assert.deepEqual((await f.send(ref,e)).result,accepted);assert.equal(f.puts,1);
 const records=await f.db.list({prefix:'message/'});assert.equal(records.size,1);assert.equal((await f.db.list({prefix:'contact-grant/'})).size,0);assert.equal((await f.db.list({prefix:'notification-event/'})).size,1);
 const record=[...records.values()][0],{attestation,...payload}=record.appNotification;assert.equal(payload.origin,ORIGIN);assert.equal(payload.name,client.name);assert.equal(payload.owner,OWNER);assert.equal(record.mimeType,'text/plain');assert.equal(record.notificationSummary.title,e.args.subject);assert.equal(record.notificationSummary.text,e.args.body);assert.equal(record.senderMetadata.subject,e.args.subject);assert.equal(record.grantId,null);
 const pub=await crypto.subtle.importKey('jwk',f.config.APP_NOTIFICATION_PUBLIC_JWKS.keys[0],{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,fromBase64url(attestation.signature),new TextEncoder().encode(canonical(payload))),true);
 assert.equal((await f.account.messagePage(OWNER)).items[0].appNotification.origin,ORIGIN);await assert.rejects(f.send(ref,{...e,args:{...e.args,body:'changed'}}),{code:'tx_conflict'});assert.equal(f.puts,1);
});
test('strict Origin reaches controller and HTTP including issuer exception; rejected calls cause no journal/blob',async t=>{
 const f=await fixture(t),{ref}=await f.connect();for(const origin of [null,'null',ISSUER,'https://evil.example']){const e=f.envelope(ref);await assert.rejects(f.send(ref,e,origin),{code:'forbidden'});const response=await f.http(ref,e,origin);assert.equal(response.status,403);}
 await assert.rejects(f.controller.rpc(ref.token,f.envelope(ref)),{code:'forbidden'});assert.equal((await f.fedDB.list({prefix:'federation/journal/'})).size,0);assert.equal(f.puts,0);
 const response=await f.http(ref,f.envelope(ref));assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
});
test('disabling and re-enabling Messages never revives old tokens; fresh exact method consent is required',async t=>{
 const f=await fixture(t),{ref}=await f.connect(),e=f.envelope(ref);await f.send(ref,e);const app=(await f.account.appConnections(OWNER))[0];await f.invoke('appNotificationSettings',[OWNER,app.id,{enabled:false}]);await assert.rejects(f.send(ref,e),{code:'forbidden'});await f.invoke('appNotificationSettings',[OWNER,app.id,{enabled:true}]);await assert.rejects(f.send(ref,f.envelope(ref)),{code:'forbidden'});const next=await f.connect();assert.equal((await f.send(next.ref)).result.accepted,true);assert.equal(f.puts,2);
 await f.invoke('appDisconnect',[OWNER,app.id]);await assert.rejects(f.send(next.ref),{code:'invalid_token'});
});
test('notification jobs recheck connection settings at delivery after claim',async t=>{
 const f=await fixture(t),{ref}=await f.connect();const prefs=defaultNotificationPreferences();prefs.push.enabled=true;await f.account.notifications.setPreferences(OWNER,prefs);await f.account.notifications.subscribe(OWNER,{endpoint:'https://fcm.googleapis.com/test',keys:{p256dh:Buffer.alloc(65,1).toString('base64url'),auth:Buffer.alloc(16,2).toString('base64url')}});
 await f.send(ref);const [job]=await f.account.notifications.claimDue(OWNER);assert(job);assert.equal(await f.account.notifications.authorizeDelivery(OWNER,job.id,job.lease),true);const app=(await f.account.appConnections(OWNER))[0];await f.invoke('appNotificationSettings',[OWNER,app.id,{enabled:false}]);assert.equal(await f.account.notifications.authorizeDelivery(OWNER,job.id,job.lease),false);assert.equal(await f.account.notifications.nextDue(OWNER),null);
});
test('in-flight disable after blob write fails admission and cleans orphan, leaves no message/outbox',async t=>{
 const f=await fixture(t),{ref}=await f.connect(),app=(await f.account.appConnections(OWNER))[0];f.afterPut(async()=>{const r=await f.db.get('resource/'+app.id);r.notifications.enabled=false;r.notifications.generation++;await f.db.put('resource/'+app.id,r);});const result=await f.send(ref);assert.equal(result.error?.code,'forbidden');assert.equal((await f.db.list({prefix:'message/'})).size,0);assert.equal((await f.db.list({prefix:'notification-event/'})).size,0);assert.equal(f.blobs.size,0);
});
test('failed blob write stays indeterminate and conservatively consumes admission only once',async t=>{
 const f=await fixture(t),{ref}=await f.connect(),e=f.envelope(ref);f.failPut();assert.equal((await f.send(ref,e)).error.code,'indeterminate');assert.equal((await f.send(ref,e)).error.code,'indeterminate');assert.equal(f.puts,1);assert.equal((await f.account.messageReceiptBudget.status(OWNER)).windows.day.messages,1);assert.equal((await f.db.list({prefix:'message/'})).size,0);
});
test('expired operation is rejected before cached journal or new token can replay it',async t=>{
 const f=await fixture(t),{ref}=await f.connect();const e=f.envelope(ref,{createdAt:Date.now()-86400001});await assert.rejects(f.send(ref,e),{code:'operation_expired'});assert.equal(f.puts,0);assert.equal((await f.fedDB.list({prefix:'federation/journal/'})).size,0);
});
test('per-connection minute quota stops new blobs and parent owner receipt budget remains cumulative',async t=>{
 // Wall time is frozen mid-minute: the fixed minute bucket cannot roll over between the 10th and 11th send.
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,14,12,0,30)});
 const f=await fixture(t),{ref}=await f.connect();for(let i=0;i<10;i++)assert.equal((await f.send(ref)).result.accepted,true);assert.equal((await f.send(ref)).error.code,'rate_limited');assert.equal(f.puts,10);assert.equal((await f.account.messageReceiptBudget.status(OWNER)).windows.day.messages,10);
});
test('SQLite actor restart preserves receipts, grant authority, origin provenance and exactly one retained message',async t=>{
 const f=await fixture(t),{ref}=await f.connect(),e=f.envelope(ref),first=(await f.send(ref,e)).result;f.restart();assert.deepEqual((await f.send(ref,e)).result,first);assert.equal(f.puts,1);assert.equal((await f.account.messagePage(OWNER)).items[0].appNotification.origin,ORIGIN);const app=(await f.account.appConnections(OWNER))[0];await f.invoke('appNotificationSettings',[OWNER,app.id,{enabled:false}]);f.restart();await assert.rejects(f.send(ref,e),{code:'forbidden'});
});
test('HTML and caller tags use normal content/rules with required app-message delivery tag, never action descriptors',async t=>{
 const f=await fixture(t),{ref}=await f.connect();await f.account.rules(OWNER,[{id:'app-work',enabled:true,match:{tagsAll:['app-message','work']},actions:{tags:['handled'],classification:'work'}}]);const e=f.envelope(ref,{mimeType:'text/html',body:'<h1>Reminder</h1><form><button>Choose</button></form><script>alert(1)</script>',tags:['work']});const result=(await f.send(ref,e)).result;const record=await f.db.get(key('message',OWNER,result.id));assert.equal(record.mimeType,'text/html');assert.deepEqual(record.deliveryTags,['app-message','work']);assert.deepEqual(record.tags,['app-message','sys:automation','handled','sys:work']);assert.equal(record.tagProvenance['sys:automation'].source,'app');assert.equal(record.classification,'work');assert.equal(record.appNotification.mimeType,'text/html');assert.deepEqual(record.appNotification.tags,['work']);const rendered=(await f.account.message(OWNER,result.id)).render;assert.equal(rendered.kind,'document');assert(!rendered.html?.includes('<script>alert'));
 for(const extra of [{actions:[]},{tags:Array.from({length:32},(_,i)=>'tag'+i)},{tags:['x','x']},{mimeType:'application/javascript'}])await assert.rejects(f.send(ref,f.envelope(ref,extra)),{code:'invalid_args'});
});
test('missing signer and forged owner/app metadata cannot write a message or debit receipt allowance',async t=>{
 const f=await fixture(t),{ref}=await f.connect();f.config.APP_NOTIFICATION_SIGNING_JWK=undefined;assert.equal((await f.send(ref)).error.code,'app_notifications_unavailable');assert.equal(f.puts,0);assert.equal((await f.account.messageReceiptBudget.status(OWNER)).windows.day.messages,0);
 const app=(await f.account.appConnections(OWNER))[0],ctx={authority:'bindle',subject,epoch:f.epoch,connection:app,resource,resourceGeneration:OWNER,contract:APP_NOTIFICATIONS,method:'createOwn',clientId:client.id,requestOrigin:ORIGIN,app:{id:client.id,origin:'https://evil.example',name:client.name},tx:crypto.randomUUID()};ctx.args={transactionId:ctx.tx,createdAt:Date.now(),subject:'Hi',body:'body'};await assert.rejects(f.invoke('federationRPC',[ctx]),{code:'forbidden'});assert.equal(f.puts,0);
});

test('initial app-message tag survives owner intake rules with no silent truncation or blob on overflow',async t=>{const f=await fixture(t),{ref}=await f.connect();for(const tags of [Array.from({length:31},(_,i)=>'tag'+i),['app-message',...Array.from({length:31},(_,i)=>'tag'+i)]]){await f.account.rules(OWNER,[{id:'routing',enabled:true,match:{tagsAll:['app-message']},actions:{tags}}]);const r=await f.send(ref);assert(r.result);const message=await f.db.get(key('message',OWNER,r.result.id));assert.equal(message.tags.filter(t=>!t.startsWith('sys:')).length,32);assert(message.tags.includes('app-message'));await f.account.updateMessage(OWNER,r.result.id,{tags:['owner-chosen']});assert.deepEqual((await f.db.get(key('message',OWNER,r.result.id))).tags,['sys:automation','owner-chosen']);}const before=f.puts;await f.account.rules(OWNER,[{id:'routing',enabled:true,match:{tagsAll:['app-message']},actions:{tags:Array.from({length:32},(_,i)=>'tag'+i)}}]);const result=await f.send(ref);assert.equal(result.error.code,'invalid_actions');assert.equal(f.puts,before);assert.equal((await f.db.list({prefix:'message/'})).size,2);});
