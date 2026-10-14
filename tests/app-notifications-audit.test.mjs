import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {FederationController} from '../packages/federation/runtime.mjs';
import {MemoryFederationStore, PREFERENCES} from '../packages/federation/index.mjs';
import {handleFederation} from '../packages/federation/http.mjs';
import {AppConnections} from '../packages/apps/connections.mjs';
import {APP_NOTIFICATIONS, notificationInput} from '../packages/federation/app-notifications.mjs';
import {appNotificationCheck, appNotificationPublicKeys, appNotificationSigner} from '../packages/runtime/app-notifications.mjs';
import {canonical, fromBase64url} from '../packages/messaging/store.mjs';
import application from '../packages/runtime/http.mjs';
import {readFile} from 'node:fs/promises';
import {publicArtifacts} from '../packages/core/public-contracts.mjs';

const issuer='https://provider.example', appOrigin='https://app.example';
const clientId=appOrigin+'/client', fragment='https://schema.example/audit-notifications/v1';
const schema={id:fragment,title:'Audit settings',description:'Explicit app message permission.',publisher:'https://schema.example',fields:{label:{title:'Label',type:'string',maxLength:30},notifications:{title:'Messages',type:'resource',contracts:[APP_NOTIFICATIONS]}}};

async function fixture(){
  const owner=randomUUID(), subject=issuer+'/entities/'+owner, resource=subject+'/app-messages';
  const appStore=new MemoryFederationStore();
  const metadata={get:k=>appStore.transaction(tx=>tx.get(k)),transaction:fn=>appStore.transaction(tx=>fn({get:tx.get,put:tx.set,list:async({prefix,limit=Infinity})=>new Map((await tx.list(prefix)).slice(0,limit).map(r=>[r.key,r.value]))}))};
  metadata.list=options=>metadata.transaction(tx=>tx.list(options));
  const apps=new AppConnections({metadata,origin:issuer}), target={metadata,apps};
  const clients=[{id:clientId,origin:appOrigin,name:'Registered app',redirectUris:[appOrigin+'/callback']},{id:'https://other.example/client',origin:'https://other.example',name:'Other app',redirectUris:['https://other.example/callback']}];
  let now=Date.now(), effects=0, syncs=0;
  const controller=new FederationController({metadata:new MemoryFederationStore(),issuer,clients,clock:()=>now,refreshEnabled:true,schemaHosts:['schema.example'],schemaFetcher:async()=>schema,auth:{owner:async()=>({subject,epoch:'audit-epoch'})},connections:{
    binding:id=>apps.binding(owner,id),
    connect:(client,binding,permissions)=>apps.register(owner,client,binding.generation,{transport:'bindle',notifications:permissions.notifications,expectedNotificationGeneration:binding.notificationGeneration}),
    check:(connection,id)=>apps.check(owner,connection.id,connection.generation,id),
    notificationCheck:(connection,id)=>appNotificationCheck(target,owner,connection,id)
  },dispatcher:{durableJournal:true,execute:async()=>{effects++;return {accepted:true};}}});
  await controller.registerResource({}, {id:resource,label:'Owner messages',contracts:{[APP_NOTIFICATIONS]:['createOwn']}});
  await controller.configure({}, {fragment,values:{label:'Keep readable',notifications:resource}});
  const service=controller.service, sync=service.syncResources.bind(service);
  service.syncResources=async(...args)=>{syncs++;return sync(...args);};
  async function connect({notifications=true,afterInspect}={}){
    const client=service.clients.get(clientId), verifier='a'.repeat(43), methods=notifications?{notifications:{[APP_NOTIFICATIONS]:['createOwn']}}:{};
    const fields=notifications?['label','notifications']:['label'];
    const {requestId}=await controller.beginAuthorization({clientId,redirectUri:client.redirectUris[0],challenge:createHash('sha256').update(verifier).digest('base64url'),challengeMethod:'S256',state:'audit',requests:[{fragment,required:true,purpose:'Audit owner-local messages',fields,methods}]});
    const view=await controller.inspect({sessionToken:'review-owner'},requestId);
    await afterInspect?.();
    const approved=await controller.approve({}, {requestId,approved:[{fragment,revision:view.requests[0].revision,fields,...notifications?{resources:{notifications:[resource]},methods}:{}}]});
    return controller.exchange({clientId,redirectUri:client.redirectUris[0],code:new URL(approved.redirectUri).searchParams.get('code'),verifier});
  }
  const envelope=(args={})=>{const tx=randomUUID();return {version:'0',tx,resource,contract:APP_NOTIFICATIONS,method:'createOwn',args:{transactionId:tx,createdAt:now,subject:'Literal subject',body:'Literal content',...args}};};
  const read=token=>controller.rpc(token,{version:'0',tx:randomUUID(),resource:'@preferences',contract:PREFERENCES,method:'read',args:{fragment}});
  const http=(token,origin,envelope)=>handleFederation(new Request(issuer+'/bindle/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...origin===undefined?{}:{Origin:origin}},body:JSON.stringify(envelope)}),{controller,issuer,clients});
  return {controller,service,apps,metadata,owner,resource,connect,envelope,read,http,get effects(){return effects;},get syncs(){return syncs;},setNow:value=>{now=value;}};
}

test('independent notification audit: raw RPC and HTTP reject missing, opaque, foreign and provider-origin context before sync/effects',async()=>{
  const f=await fixture(), token=await f.connect(), request=f.envelope();
  const before=f.syncs;
  for(const requestOrigin of [undefined,null,'null',issuer,'https://other.example',appOrigin+'.evil.example',appOrigin+':444']){
    await assert.rejects(f.controller.rpc(token.access_token,request,{requestOrigin}),{code:'forbidden'});
    assert.equal(f.syncs,before);assert.equal(f.effects,0);
    const response=await f.http(token.access_token,requestOrigin??undefined,request);
    assert.equal(response.status,403);assert.equal(f.effects,0);
  }
  const forged=f.envelope({requestOrigin:appOrigin});
  await assert.rejects(f.controller.rpc(token.access_token,forged),{code:'invalid_args'});
  const accepted=await f.http(token.access_token,appOrigin,request);
  assert.equal(accepted.status,200);assert.equal(f.effects,1);
  assert.equal((await f.http(token.access_token,appOrigin,request)).status,200);assert.equal(f.effects,1);
});

test('independent notification audit: enabling later does not grant an old token the notification method',async()=>{
  const f=await fixture(), old=await f.connect({notifications:false}), [connection]=await f.apps.list(f.owner);
  await f.apps.notificationSettings(f.owner,connection.id,{enabled:true});
  const current=await f.connect();
  await assert.rejects(f.controller.rpc(old.access_token,f.envelope(),{requestOrigin:appOrigin}),{code:'forbidden'});
  assert.equal((await f.read(old.access_token)).result.values.label,'Keep readable');
  await f.controller.rpc(current.access_token,f.envelope(),{requestOrigin:appOrigin});assert.equal(f.effects,1);
});

test('independent notification audit: disable/re-enable and refresh preserve the notification ceiling without breaking scalar access',async()=>{
  const f=await fixture(), old=await f.connect(), [connection]=await f.apps.list(f.owner);
  await f.apps.notificationSettings(f.owner,connection.id,{enabled:false});
  await f.apps.notificationSettings(f.owner,connection.id,{enabled:true});
  const refreshed=await f.controller.refresh({clientId,refreshToken:old.refresh_token});
  await assert.rejects(f.controller.rpc(refreshed.access_token,f.envelope(),{requestOrigin:appOrigin}),{code:'forbidden'});
  assert.equal((await f.read(refreshed.access_token)).result.values.label,'Keep readable');
  const fresh=await f.connect();await f.controller.rpc(fresh.access_token,f.envelope(),{requestOrigin:appOrigin});assert.equal(f.effects,1);
});

test('independent notification audit: a moved registration cannot transfer old token authority to the replacement origin',async()=>{
  const f=await fixture(), old=await f.connect(), next='https://replacement.example';
  f.service.clients.set(clientId,{id:clientId,origin:next,name:'Moved app',redirectUris:[next+'/callback']});
  await assert.rejects(f.controller.rpc(old.access_token,f.envelope(),{requestOrigin:next}),{code:'forbidden'});
  const fresh=await f.connect();
  await assert.rejects(f.controller.rpc(old.access_token,f.envelope(),{requestOrigin:next}),{code:'forbidden'});
  await f.controller.rpc(fresh.access_token,f.envelope(),{requestOrigin:next});assert.equal(f.effects,1);
});

test('independent notification audit: stale consent cannot undo a later owner Messages decision',async()=>{
  const f=await fixture();await f.connect();const [connection]=await f.apps.list(f.owner);
  await assert.rejects(f.connect({afterInspect:()=>f.apps.notificationSettings(f.owner,connection.id,{enabled:false})}),{code:'consent_stale'});
  assert.equal((await f.apps.notificationSettings(f.owner,connection.id)).enabled,false);
  assert.equal(f.effects,0);
});

test('independent notification audit: canonical operation age and encoded size bound retries and unsupported fields',()=>{
  const now=2*86400000, tx=randomUUID(), good={transactionId:tx,createdAt:now,subject:'Subject',body:'Message'};
  assert.deepEqual(notificationInput(good,tx,now),{...good,mimeType:'text/plain',tags:[]});
  for(const createdAt of [now-86400000,now+60001,0,NaN])assert.throws(()=>notificationInput({...good,createdAt},tx,now),{code:'operation_expired'});
  notificationInput({...good,createdAt:now+60000},tx,now);
  for(const extra of [{owner:randomUUID()},{origin:appOrigin},{actions:[]},{mimeType:'application/javascript'}])assert.throws(()=>notificationInput({...good,...extra},tx,now),{code:'invalid_args'});
  assert.throws(()=>notificationInput({...good,body:'\\'.repeat(9000)},tx,now),{code:'body_too_large'});
  assert.throws(()=>notificationInput({...good,body:'\u0000'},tx,now),{code:'invalid_args'});
  assert.throws(()=>notificationInput(good,randomUUID(),now),{code:'invalid_args'});
  const html={...good,mimeType:'text/html',body:'<form><input name="answer"></form>',tags:['calendar']};
  assert.deepEqual(notificationInput(html,tx,now),html);
  for(const tags of [Array.from({length:32},(_,i)=>'tag-'+i),['a','a'],[' '],['x\n']])assert.throws(()=>notificationInput({...good,tags},tx,now),{code:'invalid_args'});
});

test('independent notification audit: attestation keys reject private publication and mismatched pairs; signatures bind exact provenance',async()=>{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const privateJWK={...await crypto.subtle.exportKey('jwk',pair.privateKey),kid:'audit-key',alg:'ES256',use:'sig'};
  const publicJWK={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'audit-key',alg:'ES256',use:'sig'};
  const config={APP_NOTIFICATION_SIGNING_JWK:privateJWK,APP_NOTIFICATION_PUBLIC_JWKS:{keys:[publicJWK]}};
  assert.throws(()=>appNotificationPublicKeys({...config,APP_NOTIFICATION_PUBLIC_JWKS:{keys:[privateJWK]}}),{code:'app_notifications_unavailable'});
  const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  await assert.rejects(appNotificationSigner({...config,APP_NOTIFICATION_PUBLIC_JWKS:{keys:[{...await crypto.subtle.exportKey('jwk',other.publicKey),kid:'audit-key',alg:'ES256'}]}}),{code:'app_notifications_unavailable'});
  const signer=await appNotificationSigner(config), record={purpose:'bindle-app-notification-admission-v1',issuer,owner:randomUUID(),bodyDigest:'bounded-audit-digest'};
  const signature=fromBase64url(await signer.sign(record)), bytes=value=>new TextEncoder().encode(canonical(value));
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,signature,bytes(record)),true);
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,signature,bytes({...record,owner:randomUUID()})),false);
});

test('independent app message publication audit: public keys and machine definitions need no account or cookie authority',async()=>{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'public-audit',alg:'ES256',use:'sig'};
  const env={APP_ORIGIN:issuer,APP_NOTIFICATION_PUBLIC_JWKS:{keys:[jwk]},IDENTITY_ENGINE:()=>{throw Error('Public discovery touched identity');},ASSETS:{fetch:async request=>{
    const artifact=publicArtifacts.find(item=>item.path===new URL(request.url).pathname);
    return artifact?new Response(await readFile(artifact.source,'utf8')):new Response(null,{status:404});
  }}};
  const request=(path,method='GET')=>application.fetch(new Request(issuer+path,{method,headers:{Cookie:'private=irrelevant',Accept:'text/html'}}),env);
  const path='/.well-known/bindle/app-notification-keys.json';
  const response=await request(path);assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');assert.match(response.headers.get('Cache-Control'),/^public/);assert.equal(response.headers.get('Set-Cookie'),null);assert.deepEqual(await response.json(),{keys:[jwk]});
  assert.equal(await (await request(path,'HEAD')).text(),'');assert.equal((await request(path,'OPTIONS')).status,204);assert.equal((await request(path,'POST')).status,405);
  env.APP_NOTIFICATION_PUBLIC_JWKS={keys:[{...jwk,d:'private-must-not-appear'}]};const invalid=await request(path);assert.equal(invalid.status,503);assert(!(await invalid.text()).includes('private-must-not-appear'));
  for(const id of ['https://3sln.me/artefacts/contracts/app-messages/v1','https://3sln.me/artefacts/preferences/app-messages/v1']){
    const artifact=publicArtifacts.find(item=>item.id===id);assert(artifact);
    for(const endpoint of [new URL(id).pathname,artifact.path]){const value=await request(endpoint);assert.equal(value.status,200);assert.equal(await value.text(),await readFile(artifact.source,'utf8'));assert.equal(value.headers.get('Access-Control-Allow-Origin'),'*');assert.match(value.headers.get('Content-Type'),/json/);assert.equal(await (await request(endpoint,'HEAD')).text(),'');}
  }
});

test('independent owner Messages route audit: exact Origin and session CSRF precede settings mutation',async()=>{
  const owner=randomUUID(), connection=randomUUID(), calls=[];
  const env={APP_ORIGIN:issuer,IDENTITY_ENGINE:async()=>({dispose(){},query:()=>({peek:async()=>({account:{id:owner},csrfToken:'audit-csrf'})})}),ACCOUNTS:{get:id=>({invoke:async call=>{calls.push({id,...call});return {enabled:false,generation:2};}})}};
  const request=(origin,csrf,body={enabled:false})=>application.fetch(new Request(`${issuer}/api/apps/${connection}/notifications`,{method:'PUT',headers:{'Content-Type':'application/json',...origin?{Origin:origin}:{},...csrf?{'X-CSRF-Token':csrf}:{}},body:JSON.stringify(body)}),env);
  for(const [origin,csrf]of [[undefined,'audit-csrf'],['https://other.example','audit-csrf'],[issuer,undefined],[issuer,'wrong']]){assert.equal((await request(origin,csrf)).status,403);assert.equal(calls.length,0);}
  assert.equal((await request(issuer,'audit-csrf',{enabled:false,padding:'x'.repeat(1024)})).status,413);assert.equal(calls.length,0);
  assert.equal((await request(issuer,'audit-csrf')).status,200);assert.deepEqual(calls,[{id:owner,method:'appNotificationSettings',args:[owner,connection,{enabled:false}]}]);
});
