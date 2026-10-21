// ACT-1 resource-method seam: the provisional activity contract on AccountController.federationRPC (dispatch registry
// in packages/runtime/account/storage.mjs). Off by default (unknown, 404); on, it runs the v1 live federation, client,
// exact-origin and admission-consent checks before the engine admits with the issuer's signing key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {ACTIVITY_CONTRACT,originBoundContract,hasAdmissionMethod,APP_NOTIFICATIONS} from '../packages/federation/app-notifications.mjs';
import {appNotificationPublicKeys} from '../packages/runtime/app-notifications.mjs';
import {verifyEvidence} from '../packages/activity/index.mjs';
import {ActivityFeed,ActivityItem} from '../packages/app/domains/activity.mjs';

const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ISSUER='https://provider.example',ORIGIN='https://app.example',EPOCH='epoch-1';
const client={id:ORIGIN+'/client',origin:ORIGIN,name:'Calendar app',redirectUris:[ORIGIN+'/callback']};
async function keys(){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const kid=crypto.randomUUID();return {APP_NOTIFICATION_SIGNING_JWK:{...await crypto.subtle.exportKey('jwk',pair.privateKey),kid,alg:'ES256'},APP_NOTIFICATION_PUBLIC_JWKS:{keys:[{...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,alg:'ES256'}]}};}
const bucket=()=>{const m=new Map();return {put:async(k,v)=>{m.set(k,v);},get:async k=>m.has(k)?{arrayBuffer:async()=>m.get(k)}:null,delete:async k=>m.delete(k)};};
async function fixture(t,flag){
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());
 const config={APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:[structuredClone(client)],FEDERATION_IDENTITY_CHECK:async(owner,epoch)=>owner===OWNER&&epoch===EPOCH,ACTIVITY_V2_ENABLED:flag,...await keys()};
 const account=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket(),archives:bucket(),config,sql:db.sql});await account.touch(OWNER);
 const id=await account.apps.id(OWNER,client.id),record={id,owner:OWNER,clientId:client.id,name:client.name,status:'active',generation:1,connectedAt:1,kind:'app-connection',provider:'app',transport:'bindle',appOrigin:ORIGIN,notifications:{enabled:true,generation:2}};
 await db.put('resource/'+id,record);
 const context=(method,args,overrides={})=>{const tx=args.operationId??crypto.randomUUID();return {authority:'bindle',subject:`${ISSUER}/entities/${OWNER}`,epoch:EPOCH,clientId:client.id,requestOrigin:ORIGIN,app:{id:client.id,origin:ORIGIN,name:client.name},connection:{id,generation:1,appOrigin:ORIGIN,notifications:{enabled:true,generation:2}},resource:`${ISSUER}/entities/${OWNER}/activity`,resourceGeneration:OWNER,contract:ACTIVITY_CONTRACT,method,args,tx,...overrides};};
 const create=(extra={},overrides={})=>{const operationId=crypto.randomUUID();return account.federationRPC(context('create',{operationId,createdAt:Date.now(),subject:'Hello',body:'World',...extra},overrides));};
 return {db,account,config,id,record,context,create};
}
const rejects=(promise,code)=>assert.rejects(promise,error=>{assert.equal(error.code,code,`expected ${code}, got ${error.code}: ${error.message}`);return true;});

test('the activity contract is unknown with ACTIVITY_V2_ENABLED off and v1 classification is unchanged', async t=>{
 const f=await fixture(t,'false');await rejects(f.create(),'not_found');
 assert.equal((await f.db.list({prefix:'activity-'})).size,0);
 assert.equal(originBoundContract(APP_NOTIFICATIONS),true);assert.equal(originBoundContract(ACTIVITY_CONTRACT),true);assert.equal(originBoundContract('https://3sln.me/artefacts/contracts/object-storage/v1'),false);
 assert.equal(hasAdmissionMethod({f:{[ACTIVITY_CONTRACT]:['retract']}}),true);assert.equal(hasAdmissionMethod({f:{[ACTIVITY_CONTRACT]:['read']}}),false);
});

test('with the flag on, admission is app-bound, signed with the issuer key and visible only to the owner', async t=>{
 const f=await fixture(t,'true'),result=await f.create({tags:['build']});
 assert.equal(result.revision,1);
 const detail=await f.account.dispatch(OWNER,{operation:ActivityItem.operation,id:result.item});
 assert.equal(detail.app.origin,ORIGIN);assert.equal(detail.app.name,'Calendar app');
 const [{evidence,attestation}]=detail.history;
 assert.equal(await verifyEvidence(evidence,attestation,{issuer:ISSUER,keys:appNotificationPublicKeys(f.config)}),true);
 assert.equal(evidence.connection.id,f.id);assert.equal(evidence.app.clientId,client.id);
 assert.equal((await f.account.dispatch(OWNER,{operation:ActivityFeed.operation})).items.length,1);
 // Replace and retract use the same seam with the exact revision.
 const replaced=await f.account.federationRPC(f.context('replace',{operationId:crypto.randomUUID(),createdAt:Date.now(),item:result.item,expectedRevision:1,subject:'Hello 2',body:'World 2'}));
 assert.equal(replaced.revision,2);
 await f.account.federationRPC(f.context('retract',{operationId:crypto.randomUUID(),createdAt:Date.now(),item:result.item,expectedRevision:2}));
 assert.equal((await f.account.dispatch(OWNER,{operation:ActivityItem.operation,id:result.item})).state,'retracted');
});

test('the seam refuses wrong origins, resources, operation IDs, methods and revoked admission before effects', async t=>{
 const f=await fixture(t,'true');
 await rejects(f.create({},{requestOrigin:'https://evil.example'}),'forbidden');
 await rejects(f.create({},{app:{id:client.id,origin:ORIGIN,name:'Bank'}}),'forbidden');
 await rejects(f.create({},{resource:`${ISSUER}/entities/${OWNER}/app-messages`}),'forbidden');
 await rejects(f.create({},{epoch:'stale'}),'forbidden');
 await rejects(f.create({},{tx:crypto.randomUUID()}),'invalid_args');
 await rejects(f.account.federationRPC(f.context('read',{})),'unsupported_method');
 await rejects(f.create({tags:['sys:spam']}),'reserved_tag');
 await f.db.put('resource/'+f.id,{...f.record,notifications:{enabled:false,generation:2}});
 await rejects(f.create(),'forbidden');
 await f.db.put('resource/'+f.id,{...f.record,status:'disconnected',generation:2});
 await rejects(f.create(),'invalid_token');
 assert.equal((await f.db.list({prefix:'activity-item/'})).size,0);
});

test('runtime descriptor enables consent → token → activity RPC only with ACTIVITY_V2_ENABLED',async t=>{
 const {federationControllerOptions}=await import('../packages/runtime/federation.mjs'),{FederationService,MemoryFederationStore,PREFERENCES}=await import('../packages/federation/index.mjs');
 for(const flag of ['false','true']){
  const f=await fixture(t,flag),subject=`${ISSUER}/entities/${OWNER}`,fragment='https://schema.example/activity/v1',resource=subject+'/activity',schema={id:fragment,title:'App activity',description:'Choose app activity access.',publisher:'https://schema.example',fields:{feed:{title:'Activity',type:'resource',contracts:[ACTIVITY_CONTRACT]}}};
  const options=federationControllerOptions({config:f.config,repository:{get:async()=>({id:OWNER,handle:'alice',status:'active'})},accounts:{get:()=>({invoke:async({method})=>method==='resources'?[]:{displayName:'Alice'}})},owner:OWNER});
  const descriptors=await options.resourceProvider();assert.equal(descriptors.some(d=>d.id===resource),flag==='true');
  if(flag==='false')continue;
  assert.deepEqual(descriptors.find(d=>d.id===resource).contracts,{[ACTIVITY_CONTRACT]:['create','replace','retract']});
  const service=new FederationService({issuer:ISSUER,store:new MemoryFederationStore(),clients:[client],schemaHosts:['schema.example'],schemaFetcher:async()=>schema,resourceProvider:options.resourceProvider,authenticateOwner:async()=>({subject,epoch:EPOCH}),validateSubject:async()=>true,connections:{binding:async()=>({generation:1}),connect:async()=>({id:f.id,generation:1,appOrigin:ORIGIN,notifications:{enabled:true,generation:2}}),check:async()=>true,notificationCheck:async()=>true},dispatchCapability:context=>f.account.federationRPC({...context,authority:'bindle'})});
  const owner={},verifier='v'.repeat(43),challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  await service.configure(owner,{fragment,values:{feed:resource},expectedRevision:null});
  const {requestId}=await service.beginAuthorization({clientId:client.id,redirectUri:client.redirectUris[0],challenge,challengeMethod:'S256',state:'activity',requests:[{fragment,required:true,purpose:'App activity',fields:['feed'],methods:{feed:{[ACTIVITY_CONTRACT]:['create','replace','retract']}}}]});
  const view=await service.inspect(requestId,owner),approved=await service.approve(owner,{requestId,approved:[{fragment,revision:view.requests[0].revision,fields:['feed'],resources:{feed:[resource]},methods:{feed:{[ACTIVITY_CONTRACT]:['create','replace','retract']}}}]}),token=await service.exchange({code:new URL(approved.redirectUri).searchParams.get('code'),verifier,clientId:client.id,redirectUri:client.redirectUris[0]});
  const rpc=(credential,ref,contract,method,args)=>service.rpc(credential,{version:'0',tx:args.operationId??crypto.randomUUID(),resource:ref,contract,method,args},{requestOrigin:ORIGIN});
  const prefs=await rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment}),feed=prefs.result.values.feed;
  const created=await rpc(feed.token,feed.id,ACTIVITY_CONTRACT,'create',{operationId:crypto.randomUUID(),createdAt:Date.now(),subject:'Integrated',body:'Through consent and RPC'});assert.equal(created.result.revision,1);
  assert.equal((await f.account.dispatch(OWNER,{operation:ActivityItem.operation,id:created.result.item})).app.clientId,client.id);
  const replaced=await rpc(feed.token,feed.id,ACTIVITY_CONTRACT,'replace',{operationId:crypto.randomUUID(),createdAt:Date.now(),item:created.result.item,expectedRevision:1,subject:'Updated',body:'Updated body'});assert.equal(replaced.result.revision,2);
  await rpc(feed.token,feed.id,ACTIVITY_CONTRACT,'retract',{operationId:crypto.randomUUID(),createdAt:Date.now(),item:created.result.item,expectedRevision:2});assert.equal((await f.account.dispatch(OWNER,{operation:ActivityItem.operation,id:created.result.item})).state,'retracted');
 }
});
