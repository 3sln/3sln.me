import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {APP_SESSION,NO_EXPIRY,appSessionPolicy} from '../packages/federation/app-sessions.mjs';
import {provider,createEntry,providerPage,exchange,refresh,form,dpopKey,tokenNonce,codeOf,issuer,appOrigin,clientId,fragment} from './authorization-entry-helpers.mjs';
const tokenURL=`${issuer}/oauth/token`;
// 401 means the bearer is dead; a live bearer without a granted resource gets 403.
const rpc=async(p,token)=>(await p.fetch(`${issuer}/bindle/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({version:'0',tx:randomUUID(),resource:'@profile',contract:'https://3sln.me/artefacts/contracts/profile/v1',method:'read',args:{}})})).status===401?401:200;
async function bound(p,key){
 const {entryId,verifier}=await createEntry(p,{dpopJkt:key.jkt}),page=await providerPage(p,entryId,p.signIn());const code=codeOf(page.result.redirectUri);
 const response=await exchange(p,code,verifier,{dpop:await key.sign({htu:tokenURL,nonce:await tokenNonce(p),iat:Math.floor(p.clock()/1000)})});return {response,token:await response.json(),code,verifier};
}
const renew=async(p,key,token,extra={})=>refresh(p,token,{dpop:await key.sign({htu:tokenURL,nonce:await tokenNonce(p),iat:Math.floor(p.clock()/1000),...extra})});

test('a dpopJkt entry needs a nonce-bearing proof from that key at exchange and yields a session with no absolute lifetime and a 180-day idle limit',async()=>{
 const p=await provider(),key=await dpopKey(),other=await dpopKey();
 const {entryId,verifier}=await createEntry(p,{dpopJkt:key.jkt}),code=codeOf((await providerPage(p,entryId,p.signIn())).result.redirectUri);
 const missing=await exchange(p,code,verifier);assert.equal(missing.status,400);assert.equal((await missing.json()).error,'invalid_dpop_proof');
 const noNonce=await exchange(p,code,verifier,{dpop:await key.sign({htu:tokenURL})});assert.equal(noNonce.status,400);assert.equal((await noNonce.json()).error,'use_dpop_nonce');
 const nonce=noNonce.headers.get('DPoP-Nonce');assert.ok(nonce);assert.equal(noNonce.headers.get('Access-Control-Expose-Headers'),'DPoP-Nonce');
 assert.equal((await exchange(p,code,verifier,{dpop:await other.sign({htu:tokenURL,nonce:await tokenNonce(p)})})).status,400);
 assert.equal((await exchange(p,code,verifier,{dpop:await key.sign({htu:`${issuer}/oauth/revoke`,nonce:await tokenNonce(p)})})).status,400);
 const ok=await exchange(p,code,verifier,{dpop:await key.sign({htu:tokenURL,nonce})}),token=await ok.json();assert.equal(ok.status,200);
 assert.equal(token.token_type,'Bearer');assert.equal(token.refresh_expires_in,180*86400,'the refresh token lives for the idle window');assert.equal(token.refresh_idle_expires_in,180*86400);
 const family=(await p.shard(p.accounts[0].owner).service.store.transaction(tx=>tx.list('federation/family/')))[0].value;assert.equal(family.expiresAt,NO_EXPIRY,'no absolute expiry');assert.ok(ok.headers.get('DPoP-Nonce'));
 // The JSON body cannot smuggle a proof past the header rule.
 const smuggled=await p.fetch(tokenURL,{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin},body:JSON.stringify({grantType:'refresh_token',refreshToken:token.refresh_token,clientId,dpop:'x'})});assert.equal(smuggled.status,400);
 // An unpinned key cannot bind a memory-profile authorization.
 const plain=await createEntry(p),plainCode=codeOf((await providerPage(p,plain.entryId,p.signIn())).result.redirectUri);
 assert.equal((await exchange(p,plainCode,plain.verifier,{dpop:await key.sign({htu:tokenURL,nonce:await tokenNonce(p)})})).status,400);
 const memory=await(await exchange(p,plainCode,plain.verifier)).json();assert.equal(memory.refresh_expires_in,180*86400);assert.equal(memory.refresh_idle_expires_in,180*86400);
});

test('bound refresh rotates only with the session key; a stolen token with another key neither renews nor revokes',async()=>{
 const p=await provider(),key=await dpopKey(),thief=await dpopKey(),{token}=await bound(p,key);
 assert.equal((await refresh(p,token.refresh_token)).status,400);
 const stolen=await renew(p,thief,token.refresh_token);assert.equal(stolen.status,400);assert.equal((await stolen.json()).error,'invalid_dpop_proof');
 const next=await(await renew(p,key,token.refresh_token)).json();assert.ok(next.access_token);assert.notEqual(next.refresh_token,token.refresh_token);assert.equal(await rpc(p,next.access_token),200);
 // Proof replay: the same jti and nonce are refused.
 const proof=await key.sign({htu:tokenURL,nonce:await tokenNonce(p)});const third=await(await refresh(p,next.refresh_token,{dpop:proof})).json();assert.ok(third.refresh_token);
 assert.equal((await refresh(p,third.refresh_token,{dpop:proof})).status,400);
 const stale=await renew(p,key,third.refresh_token,{iat:Math.floor(p.clock()/1000)-120});assert.equal(stale.status,400);
});

test('reuse outside the one-time 30 s same-key grace revokes the session, its access tokens and its successor',async()=>{
 const p=await provider(),key=await dpopKey(),{token}=await bound(p,key);
 const first=await(await renew(p,key,token.refresh_token)).json();
 // The immediately previous token is accepted once within 30 s and returns the same successor.
 const grace=await(await renew(p,key,token.refresh_token)).json();assert.equal(grace.refresh_token,first.refresh_token);assert.notEqual(grace.access_token,first.access_token);
 const again=await renew(p,key,token.refresh_token);assert.equal(again.status,400);assert.equal((await again.json()).error,'invalid_grant');
 assert.equal((await renew(p,key,first.refresh_token)).status,400);assert.equal(await rpc(p,first.access_token),401);assert.equal(await rpc(p,grace.access_token),401);
 const late=await bound(p,key),rotated=await(await renew(p,key,late.token.refresh_token)).json();p.time.advance(31000);
 assert.equal((await renew(p,key,late.token.refresh_token)).status,400);assert.equal((await renew(p,key,rotated.refresh_token)).status,400);
});

test('the 180-day idle limit ends the session; there is no absolute lifetime; renewal checks live grants',async()=>{
 const p=await provider(),key=await dpopKey(),DAY=86400000,idle=await bound(p,key);p.time.advance(180*DAY-1000);
 const kept=await(await renew(p,key,idle.token.refresh_token)).json();assert.ok(kept.refresh_token,'used just inside the idle window');assert.equal(kept.refresh_idle_expires_in,180*86400);
 p.time.advance(180*DAY+1000);const lapsed=await renew(p,key,kept.refresh_token);assert.equal(lapsed.status,400);assert.equal((await lapsed.json()).error,'invalid_grant');
 // Two years of monthly use: never an absolute end, and the advertised refresh lifetime stays the idle window.
 let current=(await bound(p,key)).token.refresh_token;for(let month=0;month<24;month++){p.time.advance(30*DAY);const next=await(await renew(p,key,current)).json();assert.ok(next.refresh_token,`month ${month}`);assert.equal(next.refresh_expires_in,180*86400);assert.equal(next.token_type,'Bearer');assert.equal(next.expires_in,15*60,'Bearer access tokens last 15 minutes');current=next.refresh_token;}
 const revoked=await bound(p,key),grants=await p.shard(p.accounts[0].owner).service.store.transaction(tx=>tx.list('federation/grant/'));assert.equal(grants.length,0);
 // Identity-only grants: revoking the owner account ends renewal through the live account check.
 p.owners.get(p.accounts[0].owner).status='suspended';assert.equal((await renew(p,key,revoked.token.refresh_token)).status,401);
});

test('at most eight live sessions per client and owner; the least recently used yields',async()=>{
 const p=await provider(),key=await dpopKey(),sessions=[];for(let n=0;n<9;n++){sessions.push((await bound(p,key)).token);p.time.advance(1000);}
 assert.equal((await renew(p,key,sessions[0].refresh_token)).status,400);assert.equal(await rpc(p,sessions[0].access_token),401);
 assert.equal((await renew(p,key,sessions[8].refresh_token)).status,200);
});

test('RFC 7009 revocation ends the family and its access tokens; foreign, unknown and stale tokens are silent no-ops',async()=>{
 const p=await provider(),key=await dpopKey(),{token}=await bound(p,key),revoke=(fields,origin=appOrigin)=>form(p,`${issuer}/oauth/revoke`,fields,{Origin:origin});
 assert.equal((await revoke({token:token.refresh_token,client_id:'https://other.example/client'})).status,403);
 assert.equal((await form(p,`${issuer}/oauth/revoke`,{token:token.refresh_token,client_id:'https://other.example/client'})).status,400);
 assert.equal((await revoke({token:'garbage',client_id:clientId})).status,200);
 // An old token from a bound family's history, presented without the key, revokes nothing; unknown hints are ignored.
 const rotated=await(await renew(p,key,token.refresh_token)).json();p.time.advance(31000);
 assert.equal((await revoke({token:token.refresh_token,client_id:clientId,token_type_hint:'nonsense'})).status,200);
 const next=await(await renew(p,key,rotated.refresh_token)).json();assert.ok(next.refresh_token);
 const response=await revoke({token:next.refresh_token,client_id:clientId,token_type_hint:'refresh_token'});assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),appOrigin);
 assert.equal((await renew(p,key,next.refresh_token)).status,400);assert.equal(await rpc(p,next.access_token),401);
 const access=await bound(p,key);assert.equal((await revoke({token:access.token.access_token,client_id:clientId})).status,200);assert.equal(await rpc(p,access.token.access_token),401);assert.equal((await renew(p,key,access.token.refresh_token)).status,200);
 assert.equal((await revoke({token:'x',client_id:clientId,extra:'1'})).status,400);
});

test('a bound session survives far more than 128 rotations and still detects reuse of recent tokens',async()=>{
 const p=await provider(),key=await dpopKey();let {token}=await bound(p,key),current=token.refresh_token;const seen=[];
 for(let n=0;n<140;n++){p.time.advance(240000);const next=await(await renew(p,key,current)).json();assert.ok(next.refresh_token,`rotation ${n}`);seen.push(current);current=next.refresh_token;}
 const family=(await p.shard(p.accounts[0].owner).service.store.transaction(tx=>tx.list('federation/family/')))[0].value;assert.ok(family.history.length<=64);
 p.time.advance(31000);assert.equal((await renew(p,key,seen.at(-2))).status,400);assert.equal((await renew(p,key,current)).status,400);
});

test('per-client eviction frees a slot before the per-account session bound is counted',async()=>{
 const p=await provider(),key=await dpopKey(),alex=p.accounts[0];const service=p.shard(alex.owner).service;
 // Fill the account with 32 live families from this client directly, then sign in once more.
 await service.store.transaction(async tx=>{for(let n=0;n<32;n++)await tx.set(`federation/family/f${n}`,{familyId:`f${n}`,subject:alex.subject,clientId,epoch:'epoch-1',grants:[],status:'active',issuer,audience:`${issuer}/bindle/rpc`,expiresAt:p.clock()+86400000,lastUsedAt:n,history:[]});});
 const {response}=await bound(p,key);assert.equal(response.status,200);
});

test('every renewal checks the live grant: a revoked fragment grant ends the bound session',async()=>{
 const p=await provider(),key=await dpopKey(),alex=p.signIn(),context={sessionToken:alex.token,csrfToken:alex.csrf,origin:issuer},shard=p.shard(p.accounts[0].owner);await shard.configure(context,{fragment,values:{theme:'dark'}});
 const {entryId,verifier}=await createEntry(p,{dpopJkt:key.jkt,requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}]}),code=codeOf((await providerPage(p,entryId,alex)).result.redirectUri);
 const token=await(await exchange(p,code,verifier,{dpop:await key.sign({htu:tokenURL,nonce:await tokenNonce(p)})})).json();assert.equal(token.grants.length,1);
 const next=await(await renew(p,key,token.refresh_token)).json();assert.deepEqual(next.grants,token.grants);
 await shard.revoke(context,token.grants[0]);const after=await renew(p,key,next.refresh_token);assert.equal(after.status,401);
});

test('host policy: APP_REFRESH_IDLE_DAYS and access-token minutes are configurable within their ceilings',async()=>{
 assert.deepEqual(appSessionPolicy({}),{idleMs:180*86400000,bearerAccessMs:15*60000,dpopAccessMs:60*60000});
 assert.deepEqual(appSessionPolicy({APP_REFRESH_IDLE_DAYS:'30',APP_ACCESS_TOKEN_MINUTES:'5',APP_DPOP_ACCESS_TOKEN_MINUTES:'20'}),{idleMs:30*86400000,bearerAccessMs:5*60000,dpopAccessMs:20*60000});
 for(const config of [{APP_REFRESH_IDLE_DAYS:'0'},{APP_REFRESH_IDLE_DAYS:'366'},{APP_REFRESH_IDLE_DAYS:'7.5'},{APP_ACCESS_TOKEN_MINUTES:'16'},{APP_DPOP_ACCESS_TOKEN_MINUTES:'61'},{APP_DPOP_ACCESS_TOKEN_MINUTES:'x'}])assert.throws(()=>appSessionPolicy(config),TypeError);
 const p=await provider(),key=await dpopKey(),service=p.shard(p.accounts[0].owner).service;service.appSessions={idleMs:2*86400000,bearerAccessMs:120000};
 const {token}=await bound(p,key);assert.equal(token.refresh_idle_expires_in,2*86400);const next=await(await renew(p,key,token.refresh_token)).json();assert.equal(next.expires_in,120);
 p.time.advance(2*86400000+1000);assert.equal((await renew(p,key,next.refresh_token)).status,400,'a shorter host idle limit applies');
 // Out-of-range wiring falls back to the defaults rather than widening them.
 service.appSessions={idleMs:1000*86400000,bearerAccessMs:3600000};const again=await(await renew(p,key,(await bound(p,key)).token.refresh_token)).json();assert.equal(again.refresh_idle_expires_in,180*86400);assert.equal(again.expires_in,15*60);
 assert.equal(APP_SESSION.idle,7*86400000,'paired embed credentials keep their own 7-day idle limit');
});

test('cleanup schedules sliding idle expiry and reclaims idle families and their descendants within the batch limit',async()=>{
 const p=await provider(),key=await dpopKey(),{token}=await bound(p,key),service=p.shard(p.accounts[0].owner).service;
 let family=(await service.store.transaction(tx=>tx.list('federation/family/')))[0].value;
 assert.equal(token.expires_in,900,'initial issuance shares the Bearer access policy');
 const now=p.clock();await service.store.transaction(async tx=>{
  await tx.set('federation/embed/idle',{familyId:family.familyId,status:'active',expiresAt:NO_EXPIRY,idleExpiresAt:now+7*86400000});
  await tx.set('federation/token/long-child',{familyId:family.familyId,expiresAt:NO_EXPIRY});
 });
 p.time.advance(7*86400000);let swept=await service.cleanup({limit:1});assert.equal(swept.removed,1);assert.ok(swept.nextAlarmAt<=p.clock()+60000,'expired work remains due');
 for(let n=0;n<10;n++)await service.cleanup({limit:1});
 assert.equal(await service.store.transaction(tx=>tx.get('federation/embed/idle')),undefined,'embed idle expiry is not the family absolute sentinel');
 p.time.advance(173*86400000);let removed=0;
 for(let n=0;n<20;n++){swept=await service.cleanup({limit:1});assert.ok(swept.removed<=1);removed+=swept.removed;if(!swept.remaining)break;}
 assert.ok(removed>=3);for(const kind of ['family','refresh','token','embed'])assert.equal((await service.store.transaction(tx=>tx.list(`federation/${kind}/`))).length,0,kind);
});
