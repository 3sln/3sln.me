// Device authorization grant, federation half (LA2): engine-level evidence over the real LA1 identity core and real
// owner FederationService shards. Device endpoint validation and browser refusal, the RFC 8628 state machine and
// pre-consent privacy, polling limits, single redemption under seeded interleavings, DPoP binding of the device code,
// refresh and access tokens (including RPC), rotation and reuse detection, the 180-day idle limit and the absence of an
// absolute lifetime, immediate revocation through lineage and suspension, and refusal of unreviewed clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {identityEngine,activate,context,sessionContext,config as identityConfig,PASSWORD,MemoryAccounts,MemoryDevices} from './helpers/identity-engine.mjs';
import {forEachSeed,createScheduler,fakeClock} from './helpers/chaos.mjs';
import {createTestEngine} from './helpers/app-engine.mjs';
import {dpopKey} from './authorization-entry-helpers.mjs';
import {LinkedSystemAction,LinkedApprovalAction,LinkedResolveQuery,LinkedLineageQuery,LinkedOutboxQuery,MemoryLinkedLimits} from '../packages/identity/index.mjs';
import {FederationController} from '../packages/federation/runtime.mjs';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {dpopNonces} from '../packages/federation/dpop.mjs';
import {NO_EXPIRY} from '../packages/federation/app-sessions.mjs';
import {bindChildTokens,sweepDeviceFamilies,createDeviceGrantProvider,linkedPort,attachAppSessions,deviceManifest,DEVICE_GRANT,DEVICE_FEATURE,DeviceAuthorize,DeviceToken,DeviceReview,DeviceApprove,DeviceRpc,DeviceCancel,DeviceLineageDrain} from '../packages/federation/device-authorization.mjs';

const DAY=86400000,MINUTE=60000,issuer=identityConfig.origin,SECRET='device-test-dpop-secret-0001',FORM={'Content-Type':'application/x-www-form-urlencoded'};
const fragment='https://schema.example/settings/v1',schema={id:fragment,title:'Settings',description:'Shared settings',publisher:'https://schema.example',fields:{theme:{title:'Theme',type:'enum',values:['dark','light']}}};
const cli={id:'https://acme.example/cli',name:'Acme CLI',origin:'https://acme.example',redirectUris:['https://acme.example/callback'],grantTypes:[DEVICE_GRANT,'refresh_token'],deviceFragments:[fragment]};
const web={id:'https://web.example/app',name:'Web app',origin:'https://web.example',redirectUris:['https://web.example/callback']};
const unreviewed={...cli,id:'https://unreviewed.example/cli',origin:'https://unreviewed.example',redirectUris:['https://unreviewed.example/cb'],reviewed:false};
const body=fields=>new URLSearchParams(fields).toString();

async function fixture({clock=fakeClock(),flag=true,repository,deviceRequests,linkedPollLimits,policy={}}={}){
 const id=identityEngine({clock,config:{...identityConfig,deviceAuthorizationEnabled:true},...repository?{repository}:{},...deviceRequests?{deviceRequests}:{},...linkedPollLimits?{linkedPollLimits}:{}});
 const linked=linkedPort(id.engine,{LinkedSystemAction,LinkedApprovalAction,LinkedResolveQuery,LinkedLineageQuery,LinkedOutboxQuery});
 const shards=new Map(),clients=[cli,web,unreviewed];
 const shard=owner=>{if(!shards.has(owner)){const subject=`${issuer}/entities/${owner}`;
  const controller=new FederationController({metadata:new MemoryFederationStore(),issuer,clients,crypto:webcrypto,clock:clock.now,routingKey:owner,refreshEnabled:true,schemaHosts:['schema.example'],schemaFetcher:async()=>structuredClone(schema),dispatcher:async()=>({ok:true}),dpop:{secret:SECRET},
   validateSubject:async(candidate,epoch)=>candidate===subject&&epoch==='epoch-1'&&(await id.repository.get(owner))?.status==='active',
   // The production bridge (runtime/federation.mjs): the identity session authorizes the owner shard.
   auth:{owner:async(ctx,{mutation})=>{const {account,session}=await id.service.authorized(ctx,mutation);if(account.id!==owner)throw Object.assign(new Error('forbidden'),{code:'forbidden'});return {subject,epoch:'epoch-1',authTime:id.service.authAt(session)};}}});
  attachAppSessions(controller.service,{linked,config:policy});shards.set(owner,controller);}return shards.get(owner);};
 const nonces=dpopNonces({secret:SECRET,crypto:webcrypto,clock:clock.now}),pollLimits=new MemoryLinkedLimits(clock.now);
 const provider=createDeviceGrantProvider({issuer,clients,linked,shard,nonces,limits:new MemoryLinkedLimits(clock.now),pollLimits,crypto:webcrypto,clock:clock.now});
 const engine=await createTestEngine({providers:{config:{DEVICE_AUTHORIZATION_ENABLED:flag?'true':'false'},deviceGrant:provider}});
 const op=(Kind,input)=>engine.perform(new Kind({input}));
 const iat=()=>Math.floor(clock.now()/1000);
 const f={id,clock,linked,shard,nonces,provider,engine,op,pollLimits,
  service:owner=>shard(owner).service,
  authorize:(fields,{headers={},remoteIP='192.0.2.10'}={})=>op(DeviceAuthorize,{headers:{...FORM,...headers},body:body(fields),remoteIP}),
  start:async(key,fields={},options)=>{const r=await f.authorize({client_id:cli.id,dpop_jkt:key.jkt,...fields},options);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;},
  proof:async(key,extra={})=>key.sign({htu:`${issuer}/oauth/token`,nonce:await nonces.issue('token'),iat:iat(),...extra}),
  poll:async(key,flow,{proof,clientId=cli.id,remoteIP='192.0.2.10',headers={}}={})=>op(DeviceToken,{headers:{...FORM,...proof===null?{}:{DPoP:proof??await f.proof(key)},...headers},body:body({grant_type:DEVICE_GRANT,device_code:flow.device_code,client_id:clientId}),remoteIP}),
  login:async(handle='alice')=>id.act('loginPassword',{handle,password:PASSWORD,turnstileToken:'verified'},context),
  review:(session,flow)=>op(DeviceReview,{context:sessionContext(session),requestId:requestOf(flow),code:flow.user_code}),
  approve:async(session,flow,extra={})=>{const view=await f.review(session,flow);return op(DeviceApprove,{context:sessionContext(session),requestId:requestOf(flow),code:flow.user_code,approved:view.consent.requests.map(r=>({fragment:r.fragment,fields:r.fields,revision:r.revision})),...extra});},
  refresh:async(owner,key,token,extra={})=>f.service(owner).refresh({refreshToken:token,clientId:cli.id,dpop:await key.sign({htu:`${issuer}/oauth/token`,nonce:await nonces.issue('token'),iat:iat(),...extra})}),
  rpc:async(key,token,extra={})=>op(DeviceRpc,{authorization:`DPoP ${token}`,dpop:await key.sign({htu:`${issuer}/bindle/rpc`,ath:token,iat:iat(),...extra}),envelope:envelope()}),
  families:async owner=>(await f.service(owner).store.transaction(tx=>tx.list('federation/family/'))).map(row=>row.value),
  dispose:async()=>{await engine.dispose();await id.engine.dispose();}};
 return f;
}
const requestOf=flow=>flow.device_code.split('.')[0];
const envelope=()=>({version:'0',tx:crypto.randomUUID(),resource:'@profile',contract:'https://3sln.me/artefacts/contracts/profile/v1',method:'read',args:{}});
/** RPC outcome: `unauthorized` means the credential is dead; `forbidden` means it passed every live check and only lacks a granted resource. */
const rpcCode=async promise=>{try{await promise;return 'ok';}catch(error){return error.code;}};
/** A complete identity-only device sign-in: start, fresh sign-in, consent, approval, redemption. */
async function signedIn(f,{choice,fields={}}={}){
 const key=await dpopKey(),flow=await f.start(key,fields),approver=await f.login();await f.approve(approver,flow,choice?{choice}:{});
 f.clock.advance(5000);const response=await f.poll(key,flow);assert.equal(response.status,200,JSON.stringify(response.body));
 return {key,flow,approver,token:response.body,owner:approver.account.id};
}

test('device endpoint: reviewed device clients only, exact form media type, browser refusal, fragment allowlist and no complete URI',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const key=await dpopKey(),base={client_id:cli.id,dpop_jkt:key.jkt};
  const ok=await f.authorize(base);assert.equal(ok.status,200);assert.equal(ok.headers['Cache-Control'],'no-store');
  assert.deepEqual(Object.keys(ok.body).sort(),['device_code','expires_in','interval','user_code','verification_uri']);assert.equal(ok.body.expires_in,600);assert.equal(ok.body.interval,5);assert.equal(ok.body.verification_uri,`${issuer}/approve`);
  assert.match(ok.body.user_code,/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);assert.equal(ok.headers['Access-Control-Allow-Origin'],undefined,'no CORS');
  const error=async(fields,options)=>{const r=await f.authorize(fields,options);return [r.status,r.body.error];};
  assert.deepEqual(await error(base,{headers:{Origin:'https://evil.example'}}),[400,'invalid_request'],'Origin refused');
  assert.deepEqual(await error(base,{headers:{'Sec-Fetch-Site':'cross-site'}}),[400,'invalid_request'],'Fetch Metadata refused');
  assert.deepEqual(await error(base,{headers:{'Content-Type':'text/plain'}}),[400,'invalid_request']);
  assert.deepEqual(await error({...base,scope:'openid'}),[400,'invalid_scope']);
  assert.deepEqual(await error({...base,extra:'1'}),[400,'invalid_request']);
  assert.equal((await f.op(DeviceAuthorize,{headers:FORM,body:`client_id=${encodeURIComponent(cli.id)}&client_id=x&dpop_jkt=${key.jkt}`})).body.error,'invalid_request','repeated parameters');
  assert.deepEqual(await error({...base,client_id:'https://meta.example/client.json'}),[400,'unauthorized_client'],'metadata-document clients get no device grant');
  assert.deepEqual(await error({...base,client_id:'not a client'}),[400,'invalid_client']);
  assert.deepEqual(await error({...base,client_id:web.id}),[400,'unauthorized_client'],'a code-only registration');
  assert.deepEqual(await error({...base,client_id:unreviewed.id}),[400,'unauthorized_client'],'an unreviewed snapshot');
  assert.deepEqual(await error({...base,dpop_jkt:'short'}),[400,'invalid_request']);
  assert.deepEqual(await error({...base,bindle_requests:JSON.stringify([{fragment:'https://other.example/f/v1',required:true,purpose:'x',fields:['a']}])}),[400,'invalid_scope'],'off the device allowlist');
  assert.deepEqual(await error({...base,bindle_requests:'{'}),[400,'invalid_request']);
  assert.equal((await f.authorize({...base,bindle_requests:JSON.stringify([{fragment,required:true,purpose:'Theme',fields:['theme']}]),identity:'alice',ui_locales:'en es-MX'})).status,200);
  assert.deepEqual(await error({...base,identity:'a\u0000b'}),[400,'invalid_request']);
  // At most three live requests per address per pending window, then temporarily_unavailable with Retry-After.
  const limited=await f.authorize(base,{remoteIP:'198.51.100.7'});await f.authorize(base,{remoteIP:'198.51.100.7'});await f.authorize(base,{remoteIP:'198.51.100.7'});
  assert.equal(limited.status,200);const busy=await f.authorize(base,{remoteIP:'198.51.100.7'});assert.equal(busy.status,503);assert.equal(busy.body.error,'temporarily_unavailable');assert.equal(busy.headers['Retry-After'],'600');
  assert.equal((await f.authorize(base,{remoteIP:'198.51.100.8'})).status,200,'another address is unaffected');
  assert.deepEqual(deviceManifest(issuer).features,{[DEVICE_FEATURE]:{}});assert.deepEqual(deviceManifest(issuer).grant_types_supported,[DEVICE_GRANT,'refresh_token']);
 }finally{await f.dispose();}
 const off=await fixture({flag:false});try{
  const key=await dpopKey();await assert.rejects(off.op(DeviceAuthorize,{headers:FORM,body:body({client_id:cli.id,dpop_jkt:key.jkt})}),{code:'not_found'});
  for(const Kind of [DeviceToken,DeviceReview,DeviceApprove,DeviceRpc,DeviceCancel,DeviceLineageDrain])await assert.rejects(off.op(Kind,{}),{code:'not_found'},Kind.name);
 }finally{await off.dispose();}
});

test('grant state machine: pending answers are byte-identical before and during review, slow_down, DPoP and client binding without state change, denial and expiry',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const key=await dpopKey(),other=await dpopKey(),flow=await f.start(key);
  const early=await f.poll(key,flow);assert.equal(early.body.error,'slow_down','the first poll waits one interval');assert.ok(early.headers['DPoP-Nonce']);
  f.clock.advance(10000);const before=await f.poll(key,flow);assert.deepEqual([before.status,before.body],[400,{error:'authorization_pending',interval:10}],'slow_down added 5 s for later polls');
  const session=await f.login();const view=await f.review(session,flow);assert.equal(view.linked.kind,'app');assert.equal(view.linked.app.host,'acme.example');assert.deepEqual(view.consent.requests,[]);
  f.clock.advance(10000);const during=await f.poll(key,flow);assert.deepEqual(during.body,before.body,'pre-consent privacy: a review is unobservable');
  f.clock.advance(1000);assert.equal((await f.poll(key,flow)).body.error,'slow_down');
  f.clock.advance(20000);
  const missing=await f.poll(key,flow,{proof:null});assert.equal(missing.body.error,'invalid_dpop_proof');
  assert.equal((await f.poll(key,flow,{proof:await key.sign({htu:`${issuer}/oauth/token`,iat:Math.floor(f.clock.now()/1000)})})).body.error,'use_dpop_nonce');
  assert.equal((await f.poll(other,flow)).body.error,'invalid_dpop_proof','another key');
  assert.equal((await f.poll(key,flow,{clientId:web.id})).body.error,'unauthorized_client');
  const proof=await f.proof(key);assert.equal((await f.poll(key,flow,{proof})).body.error,'authorization_pending');
  f.clock.advance(20000);assert.equal((await f.poll(key,flow,{proof})).body.error,'invalid_dpop_proof','a proof is single use');
  assert.equal((await f.poll(key,flow,{headers:{Origin:'https://evil.example'}})).body.error,'invalid_request','browser refusal at the token endpoint');
  assert.equal((await f.poll(key,{device_code:'not-a-code'})).body.error,'invalid_grant');
  assert.equal((await f.id.deviceRequests.get(requestOf(flow))).status,'pending','none of these changed the request');
  const denied=await f.start(key),denier=await f.login();await f.op(DeviceReview,{context:sessionContext(denier),requestId:requestOf(denied),code:denied.user_code});
  await f.id.engine.dispatch(new LinkedApprovalAction('linkedDeny',{requestId:requestOf(denied),code:denied.user_code},sessionContext(denier))).next('result');
  f.clock.advance(5000);assert.equal((await f.poll(key,denied)).body.error,'access_denied');
  const lapsed=await f.start(key);f.clock.advance(601000);assert.equal((await f.poll(key,lapsed)).body.error,'expired_token');
 }finally{await f.dispose();}
});

test('approval issues one DPoP-bound session: 60-minute DPoP access, no absolute lifetime, single redemption and no success replay',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const {key,flow,token,owner}=await signedIn(f);
  assert.equal(token.token_type,'DPoP');assert.equal(token.expires_in,3600);assert.equal(token.refresh_expires_in,180*86400);assert.equal(token.refresh_idle_expires_in,180*86400);
  assert.equal(token.subject,`${issuer}/entities/${owner}`);assert.equal(token.client_id,cli.id);assert.deepEqual(token.grants,[]);
  const [family]=await f.families(owner);assert.equal(family.expiresAt,NO_EXPIRY);assert.equal(family.access,'dpop');assert.equal(family.jkt,key.jkt);assert.equal(family.grantType,DEVICE_GRANT);assert.ok(family.lineage.lineageId);
  f.clock.advance(10000);const again=await f.poll(key,flow);assert.equal(again.body.error,'invalid_grant','the device code is redeemed at most once');
  assert.equal((await f.families(owner)).length,1);
 }finally{await f.dispose();}
});

test('fragment consent: the owner shard pins and grants the approved fragment; a failed linked decision reverts the consent',async()=>{
 const f=await fixture();try{
  const {ownerContext,owner}=await activate(f.id.act),service=f.service(owner.account.id);
  await service.configure({context:ownerContext,mutation:true},{fragment,values:{theme:'dark'}});
  const key=await dpopKey(),requests=JSON.stringify([{fragment,required:true,purpose:'Theme',fields:['theme']}]),flow=await f.start(key,{bindle_requests:requests});
  const session=await f.login(),view=await f.review(session,flow);assert.equal(view.consent.requests[0].values.theme,'dark');
  const selections=view.consent.requests.map(r=>({fragment:r.fragment,fields:r.fields,revision:r.revision}));
  await assert.rejects(f.op(DeviceApprove,{context:sessionContext(session),requestId:requestOf(flow),code:flow.user_code,approved:selections,accountHandle:'mallory'}),{code:'confirmation_required'});
  const grants=async()=>(await service.store.transaction(tx=>tx.list('federation/grant/'))).map(r=>r.value);
  assert.deepEqual((await grants()).filter(g=>g.active),[],'reverted: no live grant');assert.equal(await service.store.transaction(tx=>tx.get(`federation/code/device/${requestOf(flow)}`)),undefined);
  await f.approve(session,flow);f.clock.advance(5000);const token=(await f.poll(key,flow)).body;
  assert.equal(token.grants.length,1);assert.equal(token.granted_fragments[0].fragment,fragment);
  // Revoking the grant ends renewal through the live grant check.
  await service.revoke({context:ownerContext,mutation:true},token.grants[0]);await assert.rejects(f.refresh(owner.account.id,key,token.refresh_token),{code:'unauthorized'});
  const stale=await f.start(key),late=await f.login();f.clock.advance(6*MINUTE);
  await assert.rejects(f.approve(late,stale),{code:'reauthentication_required'},'one fresh step-up at approval');assert.equal((await grants()).filter(g=>g.active).length,0,'checked before any grant is written');
 }finally{await f.dispose();}
});

test('polling limits: network and global bounds answer before any proof check or identity read',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const key=await dpopKey(),flow=await f.start(key);
  for(let n=0;n<120;n++)await f.poll(key,flow,{proof:'x.y.z',remoteIP:'203.0.113.9'});
  const limited=await f.poll(key,flow,{proof:'garbage',remoteIP:'203.0.113.9'});assert.deepEqual(limited.body,{error:'slow_down',interval:10},'prefix bound before the (invalid) proof is read');
  assert.equal((await f.poll(key,flow,{proof:'garbage',remoteIP:'203.0.113.10'})).body.error,'invalid_dpop_proof','another address is unaffected');
  const g=await fixture({clock:f.clock});try{
   for(let n=0;n<20000;n++)await g.pollLimits.consume('device-poll-global',{windowMs:60000,limit:20000});
   const busy=await g.poll(key,flow);assert.equal(busy.status,503);assert.equal(busy.body.error,'temporarily_unavailable');assert.equal(busy.headers['Retry-After'],'5');
  }finally{await g.dispose();}
 }finally{await f.dispose();}
});

test('chaos: concurrent polls redeem a device code exactly once under every interleaving',async()=>{
 await forEachSeed(8,async random=>{
  const clock=fakeClock(),scheduler=createScheduler(random),accounts=new MemoryAccounts(),devices=new MemoryDevices();
  const f=await fixture({clock,repository:scheduler.wrap(accounts,'accounts'),deviceRequests:scheduler.wrap(devices,'devices'),linkedPollLimits:{consume:async()=>true}});
  try{
   await activate(f.id.act);const key=await dpopKey(),flow=await f.start(key),approver=await f.login();await f.approve(approver,flow);clock.advance(5000);
   const proofs=await Promise.all(Array.from({length:4},()=>f.proof(key)));
   const results=await scheduler.run(proofs.map(proof=>()=>f.poll(key,flow,{proof})));
   const trace=scheduler.trace.join(' | '),issued=results.filter(r=>r.status==='fulfilled'&&r.value.status===200);
   assert.equal(issued.length,1,`issued ${issued.length} times; ${trace}`);
   for(const r of results)if(r.value?.status!==200)assert.equal(r.value?.body?.error,'invalid_grant',`${JSON.stringify(r.value?.body??r.reason?.code)}; ${trace}`);
   const owner=approver.account.id,families=await f.families(owner);assert.equal(families.length,1);
   assert.deepEqual((await accounts.get(owner)).linkedLineage.map(e=>e.families),[[families[0].familyId]]);
  }finally{await f.dispose();}
 });
});

test('DPoP binding: access tokens are refused as Bearer and with any other key; refresh needs the session key and does not rotate otherwise',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const {key,token,owner}=await signedIn(f),thief=await dpopKey(),service=f.service(owner);
  assert.equal(await rpcCode(f.rpc(key,token.access_token)),'forbidden','live: only an identity-only grant is missing');
  assert.equal(await rpcCode(service.rpc(token.access_token,envelope())),'unauthorized','the bound token is unknown on the Bearer path');
  assert.equal(await rpcCode(f.rpc(thief,token.access_token)),'unauthorized','another key');
  assert.equal(await rpcCode(f.op(DeviceRpc,{authorization:`DPoP ${token.access_token}`,dpop:await key.sign({htu:`${issuer}/bindle/rpc`,iat:Math.floor(f.clock.now()/1000)}),envelope:envelope()})),'unauthorized','a proof without ath');
  assert.equal(await rpcCode(f.op(DeviceRpc,{authorization:`Bearer ${token.access_token}`,dpop:await key.sign({htu:`${issuer}/bindle/rpc`,ath:token.access_token,iat:Math.floor(f.clock.now()/1000)}),envelope:envelope()})),'unauthorized');
  const proof=await key.sign({htu:`${issuer}/bindle/rpc`,ath:token.access_token,iat:Math.floor(f.clock.now()/1000)});
  assert.equal(await rpcCode(f.op(DeviceRpc,{authorization:`DPoP ${token.access_token}`,dpop:proof,envelope:envelope()})),'forbidden');
  assert.equal(await rpcCode(f.op(DeviceRpc,{authorization:`DPoP ${token.access_token}`,dpop:proof,envelope:envelope()})),'unauthorized','RPC proofs are single use');
  await assert.rejects(f.refresh(owner,thief,token.refresh_token),{code:'invalid_dpop_proof'});
  await assert.rejects(service.refresh({refreshToken:token.refresh_token,clientId:cli.id}),{code:'invalid_dpop_proof'});
  const next=await f.refresh(owner,key,token.refresh_token);assert.equal(next.token_type,'DPoP');assert.equal(next.expires_in,3600);assert.notEqual(next.refresh_token,token.refresh_token);
  f.clock.advance(61*MINUTE);assert.equal(await rpcCode(f.rpc(key,next.access_token)),'unauthorized','access tokens end after 60 minutes');
 }finally{await f.dispose();}
});

test('rotation and reuse detection: the 30 s same-key grace, then reuse revokes the family, its access tokens and its lineage',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const {key,token,owner}=await signedIn(f),ref=async()=>{const [family]=await f.families(owner);return {owner,lineageId:family.lineage.lineageId,familyId:family.familyId};};
  const lineage=await ref();assert.equal(await f.linked.lineageLive(lineage),true);
  const first=await f.refresh(owner,key,token.refresh_token),grace=await f.refresh(owner,key,token.refresh_token);assert.equal(grace.refresh_token,first.refresh_token,'one same-key retry inside 30 s');
  await assert.rejects(f.refresh(owner,key,token.refresh_token),{code:'invalid_grant'});
  await assert.rejects(f.refresh(owner,key,first.refresh_token),{code:'invalid_grant'},'the successor dies with the family');
  assert.equal(await rpcCode(f.rpc(key,first.access_token)),'unauthorized');assert.equal(await rpcCode(f.rpc(key,grace.access_token)),'unauthorized');
  assert.equal(await f.linked.lineageLive(lineage),false,'reuse also ends the approval lineage');
  const late=await signedIn(f),rotated=await f.refresh(late.owner,late.key,late.token.refresh_token);f.clock.advance(31000);
  await assert.rejects(f.refresh(late.owner,late.key,late.token.refresh_token),{code:'invalid_grant'},'outside the grace');await assert.rejects(f.refresh(late.owner,late.key,rotated.refresh_token),{code:'invalid_grant'});
  // RFC 7009 revocation of the current refresh token ends the family and frees the lineage.
  const known=new Set((await f.families(owner)).map(x=>x.familyId)),third=await signedIn(f),service=f.service(third.owner);
  await service.revokeToken({token:third.token.refresh_token,clientId:cli.id});assert.equal(await rpcCode(f.rpc(third.key,third.token.access_token)),'unauthorized');
  const revoked=(await f.families(third.owner)).find(x=>!known.has(x.familyId));assert.equal(revoked.status,'revoked');assert.equal(await f.linked.lineageLive({owner:third.owner,lineageId:revoked.lineage.lineageId,familyId:revoked.familyId}),false);
 }finally{await f.dispose();}
});

test('lifetime: a 180-day idle limit on a fake clock, no absolute expiry, a host idle override and an optional user-chosen limit',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);let {key,token,owner}=await signedIn(f),current=token.refresh_token;
  // Three years of use every 150 days: the connection never reaches an absolute end.
  for(let step=0;step<8;step++){f.clock.advance(150*DAY);const next=await f.refresh(owner,key,current);assert.ok(next.refresh_token,`step ${step}`);assert.equal(next.refresh_idle_expires_in,180*86400);current=next.refresh_token;}
  f.clock.advance(180*DAY+1000);await assert.rejects(f.refresh(owner,key,current),{code:'invalid_grant'},'180 days unused ends it');
  const hourly=await signedIn(f,{choice:'1h'});assert(hourly.token.refresh_expires_in<=3600&&hourly.token.refresh_expires_in>3500);assert.equal(hourly.token.expires_in,hourly.token.refresh_expires_in,'the chosen hour caps the access token');
  f.clock.advance(30*MINUTE);const renewed=await f.refresh(hourly.owner,hourly.key,hourly.token.refresh_token);assert(renewed.expires_in<=1800,'access never outlives a chosen limit');assert.ok(renewed.refresh_expires_in<=1800);
  f.clock.advance(31*MINUTE);await assert.rejects(f.refresh(hourly.owner,hourly.key,renewed.refresh_token),{code:'invalid_grant'});
 }finally{await f.dispose();}
 const g=await fixture({policy:{APP_REFRESH_IDLE_DAYS:'10',APP_DPOP_ACCESS_TOKEN_MINUTES:'15'}});try{
  await activate(g.id.act);const {key,token,owner}=await signedIn(g);assert.equal(token.refresh_idle_expires_in,10*86400);assert.equal(token.expires_in,900);
  g.clock.advance(10*DAY+1000);await assert.rejects(g.refresh(owner,key,token.refresh_token),{code:'invalid_grant'});
 }finally{await g.dispose();}
});

test('immediate revocation: ending the approving session stops RPC and refresh at once; the drain revokes the family; suspension refuses both',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const {key,token,owner,approver}=await signedIn(f);
  await f.id.act('logout',{},sessionContext(approver));
  assert.equal(await rpcCode(f.rpc(key,token.access_token)),'unauthorized','RPC checks the lineage before the outbox drains');
  const [family]=await f.families(owner);assert.equal(family.status,'revoked','the failed RPC check revoked the family');
  await assert.rejects(f.refresh(owner,key,token.refresh_token),{code:'invalid_grant'});
  const drained=await f.op(DeviceLineageDrain,{owner});assert.equal(drained.acknowledged,1);assert.deepEqual(await f.linked.outbox({owner}),[]);
  // A second app, ended by sign-out and drained before any use: the drain alone revokes it.
  const second=await signedIn(f);await f.id.act('logout',{},sessionContext(second.approver));
  assert.deepEqual(await f.op(DeviceLineageDrain,{owner}),{revoked:1,acknowledged:1});await assert.rejects(f.refresh(owner,second.key,second.token.refresh_token),{code:'invalid_grant'});
  // Suspension: the account check refuses RPC and refresh immediately.
  const third=await signedIn(f),account=await f.id.repository.get(owner);account.status='suspended';await f.id.repository.compareAndSwap(owner,account.revision,account);
  assert.equal(await rpcCode(f.rpc(third.key,third.token.access_token)),'unauthorized');
  await assert.rejects(f.refresh(owner,third.key,third.token.refresh_token),error=>['invalid_grant','unauthorized'].includes(error.code));
 }finally{await f.dispose();}
});

test('reserve → activate → re-check: a lineage that ends between redemption and issuance closes the grant with access_denied',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const key=await dpopKey(),flow=await f.start(key),approver=await f.login();await f.approve(approver,flow);f.clock.advance(5000);
  let ended=false;
  // The approving session signs out right after the family is written, before the re-check.
  const service=f.service(approver.account.id),write=service.store.transaction.bind(service.store);
  service.store.transaction=async op=>{const result=await write(op);if(!ended&&(await write(tx=>tx.list('federation/family/'))).length){ended=true;await f.id.act('logout',{},sessionContext(approver));}return result;};
  const response=await f.poll(key,flow);assert.equal(response.body.error,'access_denied');
  service.store.transaction=write;const [family]=await f.families(approver.account.id);assert.equal(family.status,'revoked');
 }finally{await f.dispose();}
});

test('client cancellation at the revocation endpoint needs the request key; unknown codes are silent',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const key=await dpopKey(),other=await dpopKey(),flow=await f.start(key);
  const cancel=async(signer,token=flow.device_code)=>f.op(DeviceCancel,{headers:{...FORM,DPoP:await signer.sign({htu:`${issuer}/oauth/revoke`,nonce:await f.nonces.issue('token'),iat:Math.floor(f.clock.now()/1000)})},body:body({token,token_type_hint:'device_code',client_id:cli.id})});
  assert.equal((await cancel(other)).body.error,'invalid_dpop_proof');assert.equal((await f.id.deviceRequests.get(requestOf(flow))).status,'pending');
  assert.equal((await cancel(key,'unknown')).status,200);assert.equal((await cancel(key)).status,200);
  f.clock.advance(5000);assert.equal((await f.poll(key,flow)).body.error,'access_denied');
 }finally{await f.dispose();}
});

test('review fixes: bound children, network-first poll budget, step-up after the request, idle lineage sweep, no overwritten approval',async()=>{
 const f=await fixture();try{
  await activate(f.id.act);const {key,token,owner}=await signedIn(f),service=f.service(owner);
  // LA2-S1: a resource token minted from a bound token leaves the Bearer namespace and needs the parent's key.
  const child=`${owner}.${'C'.repeat(43)}`,[family]=await f.families(owner),{createHash}=await import('node:crypto');
  const bearerId=createHash('sha256').update(`token\0${child}`).digest('base64url');
  await service.store.transaction(tx=>tx.set(`federation/token/${bearerId}`,{issuer,audience:`${issuer}/bindle/rpc`,subject:`${issuer}/entities/${owner}`,epoch:'epoch-1',familyId:family.familyId,clientId:cli.id,grants:[],expiresAt:f.clock.now()+MINUTE}));
  await bindChildTokens(service,{values:{storage:{id:'x',token:child}}},key.jkt);
  assert.equal(await rpcCode(service.rpc(child,envelope())),'unauthorized','no longer a Bearer credential');
  assert.equal(await rpcCode(f.rpc(key,child)),'forbidden','usable only with the parent key and the lineage check');
  // LA2-S4: one network's polls never spend the global budget.
  const flow=await f.start(key),spent=await f.pollLimits.peek('device-poll-global');for(let n=0;n<150;n++)await f.poll(key,flow,{proof:'x.y.z',remoteIP:'203.0.113.50'});
  assert.equal(await f.pollLimits.peek('device-poll-global')-spent,120,'refused polls are not charged globally');
  // LA2-S7: a step-up made before the request does not approve it.
  const early=await f.login();f.clock.advance(1000);const later=await f.start(key);
  await assert.rejects(f.approve(early,later),{code:'reauthentication_required'});
  // LA2-S6: an idle device family's lineage ends at the owner's next approval.
  f.clock.advance(181*DAY);assert.equal(await f.linked.lineageLive({owner,lineageId:family.lineage.lineageId,familyId:family.familyId}),true);
  assert.equal(await sweepDeviceFamilies(service,owner),1);assert.equal(await f.linked.lineageLive({owner,lineageId:family.lineage.lineageId,familyId:family.familyId}),false);
  assert.equal(await sweepDeviceFamilies(service,owner),0,'once');void token;
 }finally{await f.dispose();}
});
