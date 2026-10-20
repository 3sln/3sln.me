import test from 'node:test';
import assert from 'node:assert/strict';
import {identityEngine,activate,context,sessionContext,PASSWORD} from './helpers/identity-engine.mjs';

const start=f=>f.act('createDeviceLogin',{label:'TV',turnstileToken:'verified'});
async function derive(f,parent){const request=await start(f);await f.act('approveDeviceLogin',{...request,approved:true,accountHandle:parent.account.handle},sessionContext(parent));f.clock.advance(5000);const result=await f.act('pollDeviceLogin',request);assert.equal(result.status,'authorized');return {...result,request};}
async function step(f,session){await f.service.stepUp({method:'password',password:PASSWORD},sessionContext(session));}
async function refused(f,session){
 const ctx=sessionContext(session),request=await start(f);
 for(const [method,input] of [['approveDeviceLogin',{...request,approved:true,accountHandle:session.account.handle}],['credentialBegin',{label:'Untrusted key'}],['emailStart',{email:'attacker@mail.example'}],['configureEmailLogin',{enabled:true}]])await assert.rejects(f.act(method,input,ctx),{code:'reauthentication_required'},method);
}

test('device, email and recovery sessions need their own credential step-up before changing access',async()=>{
 const f=identityEngine();try{
  const {owner,file,ownerContext}=await activate(f.act),child=await derive(f,owner);
  await refused(f,child);await step(f,child);await f.service.recent(sessionContext(child));
  await f.act('emailStart',{email:'owner@mail.example'},ownerContext);await f.act('emailConfirm',{token:f.mail.at(-1).token,confirmed:true},ownerContext);await f.act('configureEmailLogin',{enabled:true},ownerContext);await f.act('emailLoginStart',{email:'owner@mail.example',turnstileToken:'verified'});
  const email=await f.act('emailLoginConfirm',{token:f.mail.at(-1).token,confirmed:true});assert.equal((await f.service.authorized(sessionContext(email))).session.source,'email');await refused(f,email);await step(f,email);await f.service.recent(sessionContext(email));
  const recovering=await f.act('recover',{recoveryToken:file.recoveryToken,turnstileToken:'verified'});await f.act('setPendingPassword',{...recovering,password:PASSWORD});const replacement=await f.act('downloadRecovery',recovering),recovery=await f.act('confirmRecovery',{...recovering,recoveryToken:replacement.recoveryToken,downloadConfirmed:true});assert.equal((await f.service.authorized(sessionContext(recovery))).session.source,'recovery');await refused(f,recovery);await step(f,recovery);await f.service.recent(sessionContext(recovery));

 }finally{await f.engine.dispose();}
});

test('credential freshness expires at its boundary and future timestamps never authenticate',async()=>{
 const f=identityEngine();try{const {owner}=await activate(f.act);f.clock.advance(900000);await assert.rejects(f.service.recent(sessionContext(owner)),{code:'reauthentication_required'});await step(f,owner);await f.service.recent(sessionContext(owner));const account=await f.repository.get(owner.account.id);account.sessions[0].stepUpAt=f.clock.now()+1;await f.repository.compareAndSwap(account.id,account.revision,account);await assert.rejects(f.service.recent(sessionContext(owner)),{code:'reauthentication_required'});}finally{await f.engine.dispose();}
});

test('device session lifetime is capped at approval and remains bounded through a stepped-up chain',async()=>{
 const f=identityEngine();try{const {owner}=await activate(f.act);f.clock.advance(3600000);await step(f,owner);const child=await derive(f,owner);assert.equal(child.expiresAt,owner.expiresAt);assert.equal((await f.service.authorized(sessionContext(child))).session.parentSessionId,owner.sessionContext);await step(f,child);const grandchild=await derive(f,child);assert.equal(grandchild.expiresAt,owner.expiresAt);f.clock.set(owner.expiresAt);for(const session of [owner,child,grandchild])await assert.rejects(f.service.authorized(sessionContext(session)),{code:'unauthorized'});}finally{await f.engine.dispose();}
});

for(const operation of ['logout','logoutSaved','revokeSession','removePasskey','cancelDeviceLogin'])test(`${operation} revokes descendants transitively while preserving unrelated sessions`,async()=>{
 const f=identityEngine();try{
  const {owner}=await activate(f.act),child=await derive(f,owner);await step(f,child);const grandchild=await derive(f,child),unrelated=await f.act('loginPassword',{handle:owner.account.handle,password:PASSWORD,turnstileToken:'verified'});
  if(operation==='revokeSession')await f.act(operation,{sessionId:owner.sessionContext},sessionContext(unrelated));
  else if(operation==='removePasskey'){const account=await f.repository.get(owner.account.id);account.credentials=[{id:'parent-key'}];account.sessions.find(s=>s.id===owner.sessionContext).credentialId='parent-key';await f.repository.compareAndSwap(account.id,account.revision,account);await f.act(operation,{credentialId:'parent-key'},sessionContext(unrelated));}
  else if(operation==='cancelDeviceLogin')await f.act(operation,child.request);
  else await f.act(operation,{},sessionContext(owner));
  for(const session of [child,grandchild])await assert.rejects(f.service.authorized(sessionContext(session)),{code:'unauthorized'});await f.service.authorized(sessionContext(unrelated));
 }finally{await f.engine.dispose();}
});

test('revoke-others preserves a derived caller and its ancestors but revokes its descendants',async()=>{
 const f=identityEngine();try{const {owner}=await activate(f.act),child=await derive(f,owner);await step(f,child);const grandchild=await derive(f,child);await f.act('revokeOtherSessions',{},sessionContext(child));await f.service.authorized(sessionContext(owner));await f.service.authorized(sessionContext(child));await assert.rejects(f.service.authorized(sessionContext(grandchild)),{code:'unauthorized'});}finally{await f.engine.dispose();}
});

test('session eviction preserves live ancestors and removes orphaned descendants with expired parents',async()=>{
 const f=identityEngine();try{const {owner}=await activate(f.act),child=await derive(f,owner);for(let i=0;i<9;i++)await f.act('loginPassword',{handle:owner.account.handle,password:PASSWORD,turnstileToken:'verified'});await f.service.authorized(sessionContext(owner));await assert.rejects(f.service.authorized(sessionContext(child)),{code:'unauthorized'});const derived=await derive(f,owner),account=await f.repository.get(owner.account.id);account.sessions.find(s=>s.id===owner.sessionContext).expiresAt=f.clock.now();await f.repository.compareAndSwap(account.id,account.revision,account);await f.act('loginPassword',{handle:owner.account.handle,password:PASSWORD,turnstileToken:'verified'});await assert.rejects(f.service.authorized(sessionContext(derived)),{code:'unauthorized'});}finally{await f.engine.dispose();}
});

test('QR links carry only the locator; the typed code is required, hashed and matched before approval',async()=>{
 const f=identityEngine();try{const {ownerContext}=await activate(f.act),request=await start(f),other=await start(f),url=new URL(request.verificationUriComplete),record=await f.deviceRequests.get(request.requestId);assert.equal(url.hash,'#request='+request.requestId);assert.equal(JSON.stringify(record).includes(request.userCode),false);assert.match(record.userCodeHash,/^[A-Za-z0-9_-]{43}$/);for(const userCode of [undefined,'22222222'===request.userCode?'33333333':'22222222',other.userCode]){await assert.rejects(f.act('approveDeviceLogin',{requestId:request.requestId,userCode,accountHandle:'alice',approved:true},ownerContext),{code:'invalid_device_request'});assert.equal((await f.deviceRequests.get(request.requestId)).status,'pending');}await assert.rejects(f.service.deviceRequest(request,context),{code:'unauthorized'});const result=await f.act('approveDeviceLogin',{requestId:request.requestId,userCode:request.userCode.toLowerCase().replace(/(.{4})/,'$1- '),accountHandle:'alice',approved:true},ownerContext);assert.equal(result.approved,true);}finally{await f.engine.dispose();}
});

test('a device session can gain freshness through its own verified passkey step-up',async()=>{
 const f=identityEngine({webauthn:{authenticationOptions:async()=>({challenge:'step-up-challenge'}),verifyAuthentication:async({response,challenge,credential})=>{assert.equal(response.id,credential.id);assert.equal(challenge,'step-up-challenge');return {counter:1,backedUp:true};}}});try{const {owner}=await activate(f.act),child=await derive(f,owner),account=await f.repository.get(owner.account.id);account.credentials=[{id:'own-passkey'}];await f.repository.compareAndSwap(account.id,account.revision,account);await assert.rejects(f.service.recent(sessionContext(child)),{code:'reauthentication_required'});await f.service.stepUpBegin({},sessionContext(child));await f.service.stepUp({method:'passkey',response:{id:'own-passkey'}},sessionContext(child));await f.service.recent(sessionContext(child));}finally{await f.engine.dispose();}
});

test('revoking an ancestor from a derived caller reports that the caller was revoked',async()=>{
 const f=identityEngine();try{const {owner}=await activate(f.act),child=await derive(f,owner);await step(f,child);const result=await f.act('revokeSession',{sessionId:owner.sessionContext},sessionContext(child));assert.equal(result.currentSessionRevoked,true);await assert.rejects(f.service.authorized(sessionContext(child)),{code:'unauthorized'});}finally{await f.engine.dispose();}
});

test('parent logout fences a poll prepared before the account save',async()=>{
 const f=identityEngine();try{const {owner}=await activate(f.act),request=await start(f);await f.act('approveDeviceLogin',{...request,approved:true,accountHandle:'alice'},sessionContext(owner));f.clock.advance(5000);const swap=f.repository.compareAndSwap.bind(f.repository);let entered,resume;const waiting=new Promise(resolve=>entered=resolve),release=new Promise(resolve=>resume=resolve);f.repository.compareAndSwap=async(id,revision,account)=>{if(account.sessions.some(s=>s.deviceRequestId===request.requestId)){entered();await release;}return swap(id,revision,account);};const poll=f.act('pollDeviceLogin',request),rejection=assert.rejects(poll,{code:'conflict'});await waiting;await f.act('logout',{},sessionContext(owner));resume();await rejection;assert.equal((await f.repository.get(owner.account.id)).sessions.length,0);}finally{await f.engine.dispose();}
});

test('QR generation refuses code-bearing links and the anonymous inspection route is absent',async()=>{
 const {stages}=await import('../packages/runtime/routes/identity.mjs'),requestId=crypto.randomUUID(),verificationUriComplete=context.origin+'/device#request='+requestId;
 const call=(path,input)=>stages.session({request:new Request(context.origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),env:{APP_ORIGIN:context.origin},path,context:{},engine:{query:()=>{throw Error('Anonymous inspection reached the engine');}}});
 assert.equal((await call('/api/auth/device/qr',{verificationUriComplete})).status,200);
 for(const url of [verificationUriComplete+'&code=23456789',verificationUriComplete+'&extra=x',context.origin+'/device?code=23456789#request='+requestId,'https://attacker.example/device#request='+requestId])assert.equal((await call('/api/auth/device/qr',{verificationUriComplete:url})).status,400);
 assert.equal(await call('/api/auth/device/inspect',{requestId,userCode:'23456789'}),undefined);
});

for(const method of ['password','passkey','pending-password','no-ceremony','expired-ceremony','future-ceremony'])test(`activation freshness requires this setup credential ceremony: ${method}`,async()=>{
 const f=identityEngine({webauthn:{registrationOptions:async()=>({challenge:'register'}),verifyRegistration:async()=>({id:'registered',publicKey:'key'})}});try{
  const passwordSignup=['password','no-ceremony','expired-ceremony','future-ceremony'].includes(method),pending=await f.act('signup',{handle:'new-owner',method:passwordSignup?'password':'passkey',password:PASSWORD,termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'verified'});
  if(method==='passkey')await f.act('registerPasskey',{...pending,response:{id:'registered'}});
  if(method==='pending-password')await f.act('setPendingPassword',{...pending,password:PASSWORD});
  if(['no-ceremony','future-ceremony'].includes(method)){const account=await f.repository.get(pending.account.id);if(method==='no-ceremony')delete account.pendingCredentialAt;else account.pendingCredentialAt=f.clock.now()+1000;await f.repository.compareAndSwap(account.id,account.revision,account);}
  if(method==='expired-ceremony')f.clock.advance(900000);
  const file=await f.act('downloadRecovery',pending),owner=await f.act('confirmRecovery',{...pending,recoveryToken:file.recoveryToken,downloadConfirmed:true}),ctx=sessionContext(owner),{session}=await f.service.authorized(ctx);
  assert.equal(session.source,'activation');assert.equal(session.stepUpAt,undefined,'activation never grants privileged-console step-up');assert.equal((await f.repository.get(owner.account.id)).pendingCredentialAt,undefined);
  if(['no-ceremony','expired-ceremony','future-ceremony'].includes(method)){await refused(f,owner);return;}
  await f.service.recent(ctx);await f.act('credentialBegin',{},ctx);f.clock.advance(899999);await f.service.recent(ctx);f.clock.advance(1);await assert.rejects(f.service.recent(ctx),{code:'reauthentication_required'});
 }finally{await f.engine.dispose();}
});

test('rotating setup authority discards previous ceremony evidence',async()=>{
 const f=identityEngine();try{const pending=await f.act('signup',{handle:'rotated-owner',method:'password',password:PASSWORD,termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'verified'}),account=await f.repository.get(pending.account.id);assert(Number.isSafeInteger(account.pendingCredentialAt));await f.service.newPending(account,context);assert.equal(account.pendingCredentialAt,undefined);}finally{await f.engine.dispose();}
});
