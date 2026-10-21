import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
import {identityShardName} from '../../packages/runtime/identity-shards.mjs';

test('actual Worker alarms physically delete expired linked requests and code claims, retaining a consumed session through E',async t=>{
 const h=await createHarness();t.after(()=>h.close());const namespace=await h.mf.getDurableObjectNamespace('IDENTITIES'),now=Date.now(),id=crypto.randomUUID(),code=crypto.randomUUID(),record={id,revision:0,userCodeHash:code,kind:'session',status:'pending',pendingUntil:now+1000,expiresAt:now+1000,requester:{network:{country:'MX'}}};
 assert.equal(await h.directory.createDevice(record),true);assert.equal(await h.directory.compareAndSwapDevice(id,0,{...record,revision:1,status:'consumed',expiresAt:now+60000,issuedSessionHash:'cancellation-fence'}),true);
 const primary=namespace.get(namespace.idFromName(await identityShardName('device',id))),lookup=namespace.get(namespace.idFromName(await identityShardName('device-code',code)));
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,now+1001-Date.now())));await primary.fireAlarm();await lookup.fireAlarm();assert.equal((await h.directory.getDevice(id)).issuedSessionHash,'cancellation-fence');assert.equal(new Map(await lookup.rows()).has('identity-lookup/device-code/'+code),false);assert.ok(await primary.alarmAt());
 assert.equal(await h.directory.compareAndSwapDevice(id,1,{...record,revision:2,status:'consumed',expiresAt:now-1}),true);await primary.fireAlarm();assert.equal(await h.directory.getDevice(id),null);assert.equal(new Map(await primary.rows()).has('identity-record/device/'+id),false);
});

// LA3 mount, end to end on workerd: the actual Worker routes, identity shards and owner FederationObjects. The CLI
// client below is an operator-reviewed static client; hosts stay under reserved .example names.
import {dpopKey} from '../authorization-entry-helpers.mjs';
import {revokeAllLineage} from '../../packages/identity/linked-approval.mjs';
const URN='urn:ietf:params:oauth:grant-type:device_code',PASSWORD='isolated test account password';
const cli={id:'https://acme.example/cli',name:'Acme CLI',origin:'https://acme.example',redirectUris:['https://acme.example/callback'],grantTypes:[URN,'refresh_token']};
const deviceBindings=(flag='true')=>({FEDERATION_ENABLED:'true',DEVICE_AUTHORIZATION_ENABLED:flag,FEDERATION_CLIENTS:JSON.stringify([cli])});
const form=fields=>new URLSearchParams(fields).toString();
// Creation starts the first interval (RFC 8628 §3.5), so every first poll waits it out.
const wait=()=>new Promise(resolve=>setTimeout(resolve,5100));
async function flows(t,flag='true'){
 const h=await createHarness({bindings:deviceBindings(flag)});t.after(()=>h.close());
 const call=async(path,{fields,json,headers={}}={})=>{const r=await h.mf.dispatchFetch(h.origin+path,{method:'POST',headers:{'Content-Type':fields?'application/x-www-form-urlencoded':'application/json',...headers},body:fields?form(fields):JSON.stringify(json??{})});const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body,headers:r.headers};};
 const f={h,call,nonce:null,
  async member(handle){const r=await call('/api/auth/login/password',{json:{handle,password:PASSWORD,turnstileToken:'local-browser-test-token'},headers:{Origin:h.origin}});assert.equal(r.status,200,JSON.stringify(r.body));return {handle,owner:r.body.account.id,sessionContext:r.body.sessionContext,headers:{Origin:h.origin,Cookie:r.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':r.body.csrfToken}};},
  // Token-endpoint calls with a DPoP proof, answering one nonce challenge.
  async token(key,fields,path='/oauth/token'){for(let attempt=0;attempt<2;attempt++){const r=await call(path,{fields,headers:{DPoP:await key.sign({htu:h.origin+path,...f.nonce?{nonce:f.nonce}:{}})}});f.nonce=r.headers.get('DPoP-Nonce')??f.nonce;if(r.body?.error!=='use_dpop_nonce')return r;}throw new Error('nonce loop');},
  rpc:async(key,access)=>call('/bindle/rpc',{json:{version:'0',tx:crypto.randomUUID(),resource:'@profile',contract:'https://3sln.me/artefacts/contracts/profile/v1',method:'read',args:{}},headers:{Authorization:'DPoP '+access,DPoP:await key.sign({htu:h.origin+'/bindle/rpc',ath:access})}}),
  async cliSignIn(handle){
   const key=await dpopKey(),start=await call('/oauth/device_authorization',{fields:{client_id:cli.id,dpop_jkt:key.jkt}});assert.equal(start.status,200,JSON.stringify(start.body));
   assert.deepEqual(Object.keys(start.body).sort(),['device_code','expires_in','interval','user_code','verification_uri']);assert.equal(start.body.verification_uri,h.origin+'/approve');assert.equal(start.headers.get('Access-Control-Allow-Origin'),null);
   await wait();const pending=await f.token(key,{grant_type:URN,device_code:start.body.device_code,client_id:cli.id});assert.deepEqual([pending.status,pending.body],[400,{error:'authorization_pending',interval:5}]);
   const approver=await f.member(handle),review=await call('/api/auth/linked/resolve',{json:{code:start.body.user_code.toLowerCase().replace('-',' ')},headers:approver.headers});
   assert.equal(review.status,200,JSON.stringify(review.body));assert.equal(review.body.request.kind,'app');assert.deepEqual(review.body.request.client,{origin:'https://acme.example',reviewed:true});assert.deepEqual(review.body.consent,{requests:[]});
   assert.doesNotMatch(JSON.stringify(review.body),/Acme CLI|dpop|device_code/i,'no requester text or device authority on the page');
   const approved=await call('/api/auth/linked/approve',{json:{requestId:review.body.request.id,code:start.body.user_code,owner:approver.owner,sessionContext:approver.sessionContext,choice:'ongoing',consent:[]},headers:approver.headers});
   assert.equal(approved.status,200,JSON.stringify(approved.body));assert.equal(approved.body.expiresAt,null);
   await wait();const issued=await f.token(key,{grant_type:URN,device_code:start.body.device_code,client_id:cli.id});assert.equal(issued.status,200,JSON.stringify(issued.body));assert.equal(issued.body.token_type,'DPoP');assert.ok(issued.body.expires_in<=3600);
   const replay=await f.token(key,{grant_type:URN,device_code:start.body.device_code,client_id:cli.id});assert.equal(replay.body.error,'invalid_grant','single redemption');
   return {key,approver,token:issued.body,owner:approver.owner};
  }};
 return f;
}
const federationStub=async(h,owner)=>{const namespace=await h.mf.getDurableObjectNamespace('FEDERATION');return namespace.get(namespace.idFromName('bindle-federation-v1/'+owner));};

test('LA3 CLI device flow on workerd: declaration, request, browser approval, DPoP token, RPC, refresh and revoke',async t=>{
 const f=await flows(t),{h}=f;
 const manifest=await(await h.mf.dispatchFetch(h.origin+'/.well-known/bindle/manifest.json')).json();
 assert.deepEqual(manifest.features['device-authorization.v1'],{});assert.equal(manifest.device_authorization_endpoint,h.origin+'/oauth/device_authorization');assert.ok(manifest.grant_types_supported.includes(URN)&&manifest.grant_types_supported.includes('refresh_token'));assert.ok(manifest.dpop_signing_alg_values_supported.includes('ES256'));assert.equal(manifest.revocation_endpoint,h.origin+'/oauth/revoke');
 const browser=await f.call('/oauth/device_authorization',{fields:{client_id:cli.id,dpop_jkt:(await dpopKey()).jkt},headers:{Origin:h.origin}});assert.deepEqual([browser.status,browser.body.error],[400,'invalid_request'],'browser refusal');
 for(const headers of [{'Sec-Fetch-Mode':'cors'},{'Sec-Fetch-Mode':'cors','Sec-Fetch-Site':'none'}]){const r=await f.call('/oauth/device_authorization',{fields:{client_id:cli.id,dpop_jkt:(await dpopKey()).jkt},headers});assert.equal(r.status,Object.keys(headers).length===1&&headers['Sec-Fetch-Mode']==='cors'?200:400,JSON.stringify(headers));assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);}
 const unregistered=await f.call('/oauth/device_authorization',{fields:{client_id:'https://other.example/cli',dpop_jkt:(await dpopKey()).jkt}});assert.equal(unregistered.status,400);
 const handle=(await h.signup()).result.account.handle;const {key,token}=await f.cliSignIn(handle);
 assert.equal((await f.rpc(key,token.access_token)).status,403,'live: passes the lineage and token checks, lacks only a granted resource');
 assert.equal((await f.rpc(await dpopKey(),token.access_token)).status,401,'another key');
 const refreshed=await f.token(key,{grant_type:'refresh_token',refresh_token:token.refresh_token,client_id:cli.id});assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));assert.notEqual(refreshed.body.refresh_token,token.refresh_token);
 assert.equal((await f.rpc(key,refreshed.body.access_token)).status,403);
 const revoked=await f.call('/oauth/revoke',{fields:{token:refreshed.body.refresh_token,client_id:cli.id},headers:{DPoP:await key.sign({htu:h.origin+'/oauth/revoke',jti:'stale',iat:1})}});assert.equal(revoked.status,200,'a DPoP-signed, unhinted refresh revocation always reaches RFC 7009 (LA3-S1)');
 assert.equal((await f.rpc(key,refreshed.body.access_token)).status,401,'revocation ends RPC');
 assert.equal((await f.token(key,{grant_type:'refresh_token',refresh_token:refreshed.body.refresh_token,client_id:cli.id})).body.error,'invalid_grant');
});

test('LA3 session device flow on workerd: linked start, locator QR, approval, Continue as, accept and cancel',async t=>{
 const f=await flows(t),{h,call}=f,handle=(await h.signup()).result.account.handle;
 const start=await call('/api/auth/linked/start',{json:{deviceKind:'tv',turnstileToken:'local-browser-test-token'},headers:{Origin:h.origin}});assert.equal(start.status,200,JSON.stringify(start.body));
 const binding=start.headers.get('Set-Cookie').split(';')[0],device={Origin:h.origin,Cookie:binding};assert.match(binding,/^bindle_device=/);
 assert.equal(start.body.locatorUri,h.origin+'/approve#r='+start.body.requestId);assert.match(start.body.userCode,/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
 assert.equal((await call('/api/auth/device/qr',{json:{verificationUriComplete:start.body.locatorUri},headers:{Origin:h.origin}})).status,200,'locator QR');
 assert.equal((await call('/api/auth/device/qr',{json:{verificationUriComplete:start.body.locatorUri+'&code='+start.body.userCode},headers:{Origin:h.origin}})).status,400,'a QR never carries the code');
 assert.equal((await call('/api/auth/linked/poll',{json:{deviceCode:start.body.deviceCode},headers:device})).body.status,'slow_down','polling before the first interval');
 assert.equal((await call('/api/auth/linked/poll',{json:{deviceCode:start.body.deviceCode},headers:{Origin:h.origin}})).status,401,'binding cookie required');
 const approver=await f.member(handle);
 assert.equal((await call('/api/auth/linked/resolve',{json:{code:start.body.userCode,locator:start.body.requestId},headers:{...approver.headers,'X-CSRF-Token':'wrong'}})).status,403,'member CSRF');
 assert.equal((await call('/api/auth/linked/resolve',{json:{code:start.body.userCode,locator:start.body.requestId},headers:{...approver.headers,Origin:'https://evil.example'}})).status,403,'exact Origin');
 const review=await call('/api/auth/linked/resolve',{json:{code:start.body.userCode,locator:start.body.requestId},headers:approver.headers});
 assert.equal(review.status,200,JSON.stringify(review.body));assert.equal(review.body.request.kind,'session');assert.equal(review.body.request.deviceKind,'tv');assert.ok(review.body.session.authAt>0,'fresh credential sign-in');
 assert.equal((await call('/api/auth/linked/approve',{json:{requestId:start.body.requestId,code:start.body.userCode,owner:crypto.randomUUID(),sessionContext:approver.sessionContext,choice:3600000},headers:approver.headers})).status,409,'reviewed member must be the tab member');
 const approved=await call('/api/auth/linked/approve',{json:{requestId:start.body.requestId,code:start.body.userCode,owner:approver.owner,sessionContext:approver.sessionContext,choice:3600000},headers:approver.headers});
 assert.equal(approved.status,200,JSON.stringify(approved.body));assert.ok(approved.body.expiresAt<=Date.now()+3600000+5000);
 await new Promise(resolve=>setTimeout(resolve,10200));
 const confirm=await call('/api/auth/linked/poll',{json:{deviceCode:start.body.deviceCode},headers:device});assert.deepEqual(confirm.body.account,{handle});assert.equal(confirm.body.status,'confirm');
 const accepted=await call('/api/auth/linked/accept',{json:{deviceCode:start.body.deviceCode},headers:device});assert.equal(accepted.body.status,'authorized');assert.equal(accepted.body.sessionToken,undefined,'the session stays in the cookie');
 const session={Cookie:accepted.headers.get('Set-Cookie').split(';')[0]};assert.equal((await(await h.mf.dispatchFetch(h.origin+'/api/session',{headers:session})).json()).account.handle,handle);
 assert.deepEqual((await call('/api/auth/linked/cancel',{json:{deviceCode:start.body.deviceCode},headers:device})).body,{cancelled:true});
 assert.equal((await(await h.mf.dispatchFetch(h.origin+'/api/session',{headers:session})).json()).authenticated,false,'cancel revokes the issued session');
 const page=await h.mf.dispatchFetch(h.origin+'/approve');assert.equal(page.status,200);assert.equal(page.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.match(page.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('Referrer-Policy'),'no-referrer');
 const legacy=await h.mf.dispatchFetch(h.origin+'/device',{redirect:'manual'});assert.equal(legacy.status,302);assert.equal(legacy.headers.get('Location'),'/approve');
 assert.equal((await(await h.mf.dispatchFetch(h.origin+'/api/config')).json()).deviceAuthorizationEnabled,true);
});

test('LA3 flag off on workerd: no linked or device routes, no declaration, legacy QR flow intact',async t=>{
 const f=await flows(t,'false'),{h,call}=f;
 const manifest=await(await h.mf.dispatchFetch(h.origin+'/.well-known/bindle/manifest.json')).json();
 assert.equal(manifest.features?.['device-authorization.v1'],undefined);assert.equal(manifest.device_authorization_endpoint,undefined);assert.ok(!manifest.grant_types_supported.includes(URN));
 const key=await dpopKey();assert.equal((await call('/oauth/device_authorization',{fields:{client_id:cli.id,dpop_jkt:key.jkt}})).status,404);
 const token=await call('/oauth/token',{fields:{grant_type:URN,device_code:crypto.randomUUID()+'.'+'a'.repeat(43),client_id:cli.id},headers:{DPoP:await key.sign({htu:h.origin+'/oauth/token'})}});assert.deepEqual([token.status,token.body.error],[400,'invalid_request'],'the generic token endpoint, no device branch');
 assert.equal((await call('/bindle/rpc',{json:{},headers:{Authorization:'DPoP '+crypto.randomUUID()+'.'+'a'.repeat(43),DPoP:'x'}})).body.message,'Bearer token required.');
 const unknown=await call('/api/auth/no-such-route',{json:{},headers:{Origin:h.origin}});
 for(const path of ['/api/auth/linked/start','/api/auth/linked/poll','/api/auth/linked/resolve','/api/auth/linked/approve']){const r=await call(path,{json:{deviceKind:'tv',turnstileToken:'local-browser-test-token'},headers:{Origin:h.origin}});assert.deepEqual([r.status,r.body],[unknown.status,unknown.body],path);assert.equal(r.headers.get('Set-Cookie'),null);}
 const page=await h.mf.dispatchFetch(h.origin+'/approve');assert.equal(page.headers.get('Cross-Origin-Opener-Policy'),null);assert.notEqual((await h.mf.dispatchFetch(h.origin+'/device',{redirect:'manual'})).status,302);
 assert.equal((await(await h.mf.dispatchFetch(h.origin+'/api/config')).json()).deviceAuthorizationEnabled,false);
 const legacy=await call('/api/auth/device/start',{json:{label:'TV or shared screen',turnstileToken:'local-browser-test-token'},headers:{Origin:h.origin}});assert.equal(legacy.status,200,JSON.stringify(legacy.body));
 assert.equal((await call('/api/auth/device/qr',{json:{verificationUriComplete:legacy.body.verificationUriComplete},headers:{Origin:h.origin}})).status,200,'legacy QR');
 assert.equal((await call('/api/auth/device/qr',{json:{verificationUriComplete:h.origin+'/approve#r='+legacy.body.requestId},headers:{Origin:h.origin}})).status,400,'no linked locator QR with the flag off');
 await wait();assert.equal((await call('/api/auth/device/poll',{json:{deviceCode:legacy.body.deviceCode},headers:{Origin:h.origin,Cookie:legacy.headers.get('Set-Cookie').split(';')[0]}})).body.status,'authorization_pending');
});

test('LA3 lineage on workerd: sign-out and suspension end device RPC and refresh at once; the owner alarm drains the outbox',async t=>{
 const f=await flows(t),{h,call}=f,handle=(await h.signup()).result.account.handle;
 const first=await f.cliSignIn(handle);assert.equal((await f.rpc(first.key,first.token.access_token)).status,403);
 // Ordinary sign-out of the approving session ends the app it approved (LA-9).
 assert.equal((await call('/api/auth/logout',{json:{},headers:first.approver.headers})).status,200);
 assert.equal((await f.rpc(first.key,first.token.access_token)).status,401,'RPC refused once the lineage ends');
 assert.equal((await f.token(first.key,{grant_type:'refresh_token',refresh_token:first.token.refresh_token,client_id:cli.id})).body.error,'invalid_grant');
 const second=await f.cliSignIn(handle);assert.equal((await f.rpc(second.key,second.token.access_token)).status,403);
 // Suspension as AdminService.suspend applies it: lineage revoked and sessions removed in one identity CAS.
 const account=await h.directory.get(second.owner),revision=account.revision;revokeAllLineage(account,Date.now());Object.assign(account,{status:'suspended',sessions:[],revision:revision+1});assert.equal(await h.directory.compareAndSwap(second.owner,revision,account),true);
 assert.ok((await h.directory.get(second.owner)).lineageOutbox.length>=1,'families queued for the drain');
 assert.equal((await f.rpc(second.key,second.token.access_token)).status,401);
 const refused=await f.token(second.key,{grant_type:'refresh_token',refresh_token:second.token.refresh_token,client_id:cli.id});assert.ok(['invalid_grant','unauthorized'].includes(refused.body.error),JSON.stringify(refused.body));
 const stub=await federationStub(h,second.owner),statuses=async()=>(await stub.rows()).filter(([key,value])=>key.startsWith('federation/family/')&&value.lineage).map(([,value])=>value.status);
 assert.ok((await statuses()).includes('active'),'the suspended account\'s family is still stored active: the front refused RPC without waking the shard');
 await stub.fireAlarm();
 assert.deepEqual((await h.directory.get(second.owner)).lineageOutbox,[],'drained and acknowledged');
 const families=await statuses();assert.ok(families.length>=1&&families.every(value=>value!=='active'),JSON.stringify(families));
});
