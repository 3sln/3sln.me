import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {consumeSignupCapacity} from '../packages/runtime/signup-capacity.mjs';
import {installAccountSession,accountSessionRoutes} from '../packages/runtime/account-session-http.mjs';
import {MAX_ACCOUNTS,MAX_OBSERVED,accountCookieName,sealAccountValue,parseAccountCookies,observedAccountMembers,readAccountMember,selectedAccountMember,defaultAccountCookie,createPickerToken,verifyPickerToken,accountSnapshotRevision,cleanupAccountCookie,readCleanupMembers} from '../packages/runtime/account-cookies.mjs';
import {fakeClock} from './helpers/chaos.mjs';

// Engine-level multi-account custody: the pure cookie vault and the install
// policy, with an injected identity engine. No HTTP server is involved.
const env={APP_ORIGIN:'http://localhost:8787',SESSION_COOKIE_KEY:Buffer.alloc(32,7).toString('base64url')};
const local=true,DAY=86400000,now=Date.UTC(2026,9,14,12);
const member=(owner=randomUUID(),expiresAt=now+3600000)=>({owner,token:owner+'.'+Buffer.alloc(32,owner.charCodeAt(0)).toString('base64url').slice(0,43),sessionContext:'ctx-'+owner.slice(0,8),expiresAt});
const seal=(value,name=accountCookieName(value.owner,local),purpose='session',e=env)=>sealAccountValue(e,purpose,name,value);
const cookieHeader=pairs=>pairs.map(([name,value])=>`${name}=${value}`).join('; ');
const request=(pairs,headers={})=>new Request(env.APP_ORIGIN+'/api/auth/accounts',{headers:{Cookie:cookieHeader(pairs),...headers}});
async function vault(members,extra=[]){return [...await Promise.all(members.map(async m=>[accountCookieName(m.owner,local),await seal(m)])),...extra];}

test('vault enumeration: expired, over-long and foreign members are stale; more than the observation cap fails closed',async()=>{
 const live=member(),expired=member(undefined,now),overlong=member(undefined,now+DAY+1),renamed=member();
 const pairs=await vault([live,expired,overlong]);pairs.push([accountCookieName(randomUUID(),local),await seal(renamed)]);
 const members=await observedAccountMembers(env,parseAccountCookies(request(pairs),local),local,now);
 assert.deepEqual(members.map(m=>m.owner),[live.owner]);assert.equal(members.stale.length,3);
 // Exactly at expiry the member is gone; one millisecond earlier it is live.
 assert.equal((await observedAccountMembers(env,parseAccountCookies(request(await vault([expired])),local),local,now-1)).length,1);
 const many=await vault(Array.from({length:MAX_OBSERVED+1},()=>member()));
 await assert.rejects(observedAccountMembers(env,parseAccountCookies(request(many),local),local,now),{code:'account_limit'});
 assert.equal((await observedAccountMembers(env,parseAccountCookies(request(many.slice(0,MAX_OBSERVED)),local),local,now)).length,MAX_OBSERVED);
});

test('sealed values are bound to origin, key, purpose and cookie name; duplicate names never let order choose',async()=>{
 const m=member(),name=accountCookieName(m.owner,local),cookies=value=>parseAccountCookies(request([[name,value]]),local);
 assert.equal((await readAccountMember(env,cookies(await seal(m)),m.owner,local,now)).owner,m.owner);
 for(const raw of [await seal(m,name,'default'),await seal(m,name,'session',{...env,APP_ORIGIN:'http://localhost:9999'}),await seal(m,name,'session',{...env,SESSION_COOKIE_KEY:Buffer.alloc(32,8).toString('base64url')}),await seal(m,accountCookieName(randomUUID(),local)),'ac1.'+'A'.repeat(16)+'.AAAA',(await seal(m)).slice(0,-2)])
  await assert.rejects(readAccountMember(env,cookies(raw),m.owner,local,now),{code:'invalid_account_cookie'});
 assert.throws(()=>parseAccountCookies(request([[name,'a'],[name,'b']]),local),{code:'invalid_account_cookie'});
 await assert.rejects(readAccountMember(env,cookies(await seal(m)),'not-a-uuid',local,now),{code:'account_context_conflict'});
});

test('tab selection: explicit owner needs its exact session context; header-less discovery falls back only to a live default',async()=>{
 const a=member(undefined,Date.now()+3600000),b=member(undefined,Date.now()+3600000),pairs=await vault([a,b]);
 const select=(headers,extra=[])=>selectedAccountMember(request([...pairs,...extra],headers),env,local);
 assert.equal((await select({'X-Bindle-Account':b.owner,'X-Bindle-Session-Context':b.sessionContext})).owner,b.owner);
 await assert.rejects(select({'X-Bindle-Account':b.owner,'X-Bindle-Session-Context':a.sessionContext}),{code:'session_context_conflict'});
 await assert.rejects(select({'X-Bindle-Account':b.owner}),{code:'account_context_conflict'});
 await assert.rejects(select({'X-Bindle-Session-Context':b.sessionContext}),{code:'account_context_conflict'});
 assert.equal(await select({}),null,'no default cookie selects nobody');
 const defaultTo=async owner=>{const raw=(await defaultAccountCookie(env,owner,local)).split(';')[0];return [raw.slice(0,raw.indexOf('=')),raw.slice(raw.indexOf('=')+1)];};
 assert.equal((await select({},[await defaultTo(a.owner)])).owner,a.owner);
 assert.equal(await select({},[await defaultTo(randomUUID())]),null,'a default naming a removed member selects nobody');
});

test('picker proof is bound to the exact member snapshot, its revision and a two-minute lifetime',async()=>{
 const a=member(),b=member(),revision=await accountSnapshotRevision([a,b]),token=await createPickerToken(env,[a,b],revision,now);
 assert.equal(await verifyPickerToken(env,token,[b,a],revision,now+119999),true);
 for(const [members,rev,at] of [[[a,b],revision,now+120000],[[a],revision,now],[[a,{...b,sessionContext:'rotated'}],revision,now],[[a,b],'other',now]])
  await assert.rejects(verifyPickerToken(env,token,members,rev,at),{code:'vault_conflict'});
 assert.notEqual(await accountSnapshotRevision([a,{...b,sessionContext:'rotated'}]),revision,'a re-login changes the snapshot revision');
});

test('retry-only cleanup custody keeps at most the observation cap of live members and never outlives them',async()=>{
 const members=Array.from({length:MAX_OBSERVED+5},(_,i)=>member(undefined,now+(i+1)*60000)),expired=member(undefined,now);
 const header=await cleanupAccountCookie(env,[expired,...members],local,now),raw=header.split(';')[0],name=raw.slice(0,raw.indexOf('='));
 const maxAge=Number(/Max-Age=(\d+)/.exec(header)[1]);assert(maxAge<=DAY/1000);
 const read=at=>readCleanupMembers(env,parseAccountCookies(request([[name,raw.slice(name.length+1)]]),local),local,at);
 const kept=await read(now);assert.equal(kept.length,MAX_OBSERVED);assert(!kept.some(m=>m.owner===expired.owner));
 assert.equal((await read(now+MAX_OBSERVED*60000)).length,0,'custody empties when its last session would have expired');
 assert.match(await cleanupAccountCookie(env,[expired],local,now),/Max-Age=0/);
});

function fakeEngine(refuse=()=>null){const revoked=[];return {revoked,dispatch(action){revoked.push(action.context.sessionToken);return {next:async()=>{const code=refuse(action);if(code)throw Object.assign(new Error(code),{code});return {detail:{loggedOut:true}};}};}};}
const fresh=owner=>{const m=member(owner,Date.now()+3600000);return {account:{id:m.owner},sessionToken:m.token,expiresAt:m.expiresAt,sessionContext:'fresh-'+m.owner.slice(0,8)};};

test('installing a session: the account cap revokes the fresh session; same-owner predecessors are revoked; failures stay in custody',async()=>{
 const others=Array.from({length:MAX_ACCOUNTS},()=>member(undefined,Date.now()+3600000)),pairs=await vault(others);
 let engine=fakeEngine();const extra=fresh();
 await assert.rejects(installAccountSession({request:request(pairs),env,local,engine,context:{},result:extra,legacyCleared:'x=; Max-Age=0'}),{code:'account_limit'});
 assert.deepEqual(engine.revoked,[extra.sessionToken],'only the refused fresh session is revoked');
 // Re-signing into an existing member never counts against the cap and revokes its predecessor.
 engine=fakeEngine();const again=fresh(others[0].owner);
 const headers=await installAccountSession({request:request(pairs),env,local,engine,context:{},result:again,legacyCleared:'x=; Max-Age=0'});
 assert.deepEqual(engine.revoked,[others[0].token]);assert(headers.some(h=>h.startsWith(accountCookieName(again.account.id,local)+'=ac1.')));
 assert(!headers.some(h=>h.startsWith('bindle_account_cleanup=')),'a resolved revocation needs no custody');
 // An unresolved predecessor revocation (not "unauthorized") is kept for retry.
 engine=fakeEngine(()=> 'unavailable');
 const pending=await installAccountSession({request:request(pairs),env,local,engine,context:{},result:fresh(others[1].owner),legacyCleared:'x=; Max-Age=0'});
 assert(pending.some(h=>h.startsWith('bindle_account_cleanup=ac1.')));
 // A malformed vault refuses before install and still revokes the fresh session.
 engine=fakeEngine();const refused=fresh();
 await assert.rejects(installAccountSession({request:request([...pairs,pairs[0]]),env,local,engine,context:{},result:refused,legacyCleared:''}),{code:'invalid_account_cookie'});
 assert.deepEqual(engine.revoked,[refused.sessionToken]);
});

test('fixed windows: limit holds until the window ends; a rolled-back clock never grants capacity and never locks a key past one window',async t=>{
 const metadata=new SqliteMetadata(':memory:');t.after(()=>metadata.close());const clock=fakeClock(now),guard=new FixedWindowGuard({metadata,clock:clock.now}),row={windowMs:60000,limit:2};
 assert.equal(await guard.consume(row),true);assert.equal(await guard.consume(row),true);assert.equal(await guard.consume(row),false);
 clock.advance(59999);assert.equal(await guard.consume(row),false);clock.advance(1);assert.equal(await guard.consume(row),true,'a new window opens exactly at the end');
 // Rollback shorter than a window keeps counting in the current window.
 assert.equal(await guard.consume(row),true);clock.advance(-59999);assert.equal(await guard.consume(row),false);clock.advance(59999);
 // A forward glitch followed by correction must not freeze the key for the glitch's duration.
 clock.advance(365*DAY);assert.equal(await guard.consume(row),true);assert.equal(await guard.consume(row),true);assert.equal(await guard.consume(row),false);
 clock.advance(-365*DAY);assert.equal(await guard.consume(row),true,'the future window is discarded once the clock is corrected');assert.equal(await guard.consume(row),true);assert.equal(await guard.consume(row),false);
 for(const bad of [{windowMs:999,limit:1},{windowMs:60000,limit:0},{windowMs:60000,limit:1,units:17},{windowMs:60000,limit:1,units:0},{lifetime:'yes',limit:1}])assert.equal(await guard.consume(bad),false);
});

test('operator and system admissions are idempotent by receipt; free stock and the global ceiling are exact at the boundary',async t=>{
 const metadata=new SqliteMetadata(':memory:');t.after(()=>metadata.close());const limits={limit:4,freeLimit:2},id=randomUUID(),digest='a'.repeat(64);
 const consume=options=>consumeSignupCapacity(metadata,{...limits,...options});
 assert.deepEqual(await consume({kind:'operator',admissionId:id,admissionDigest:digest}),{admitted:true});
 assert.deepEqual(await consume({kind:'operator',admissionId:id,admissionDigest:digest}),{admitted:true},'a replayed receipt admits without a second unit');
 assert.equal(await metadata.get('lifetime'),1);
 await assert.rejects(consume({kind:'operator',admissionId:id,admissionDigest:'b'.repeat(64)}),{code:'signup_capacity_unavailable'});
 await assert.rejects(consume({kind:'system',admissionId:randomUUID(),admissionDigest:digest,requireExisting:true}),{code:'signup_capacity_unavailable'});
 // Operator admissions spend global stock only; the free lane has its own ceiling.
 assert.deepEqual(await consume({kind:'free'}),{admitted:true});assert.deepEqual(await consume({kind:'free'}),{admitted:true});assert.deepEqual(await consume({kind:'free'}),{admitted:false,capacity:'free'});
 assert.deepEqual(await consume({kind:'paid'}),{admitted:true});assert.deepEqual(await consume({kind:'paid'}),{admitted:false,capacity:'global'});
 assert.deepEqual(await consume({kind:'operator',admissionId:id,admissionDigest:digest}),{admitted:true},'a receipt admitted before the ceiling stays admitted after it');
 assert.equal(await metadata.get('lifetime'),4);
 for(const bad of [{kind:'free',limit:0},{kind:'free',freeLimit:5},{kind:'guest'},{kind:'operator',admissionId:'x',admissionDigest:digest}])await assert.rejects(consume(bad),{code:'signup_capacity_unavailable'});
});

test('account chooser with an injected engine: a revoked member is dropped and switching to it fails closed without leaking another account',async()=>{
 const live=member(undefined,Date.now()+3600000),revoked=member(undefined,Date.now()+3600000),pairs=await vault([live,revoked]),queried=[];
 const engine={query(q){queried.push(q.context.expectedOwner);return {peek:async()=>{if(q.context.expectedOwner===revoked.owner)throw Object.assign(new Error('gone'),{code:'unauthorized'});return {account:{id:live.owner,handle:'n.1'},csrfToken:'csrf-live',expiresAt:live.expiresAt,sessionContext:live.sessionContext};}};},dispatch(){throw new Error('no revocation expected');}};
 const call=(path,method='GET',input)=>accountSessionRoutes({request:new Request(env.APP_ORIGIN+path,{method,headers:{Cookie:cookieHeader(pairs),Origin:env.APP_ORIGIN}}),env,local,engine,context:{},body:async()=>input,json:(value,status,headers)=>({value,status,headers}),legacyCleared:''});
 const listed=await call('/api/auth/accounts');
 assert.deepEqual(listed.value.accounts.map(a=>a.account.id),[live.owner]);assert.equal(listed.value.limit,MAX_ACCOUNTS);
 assert(listed.headers.getSetCookie().some(h=>h.startsWith(accountCookieName(revoked.owner,local)+'=;')),'the revoked member cookie is removed');
 const revision=await accountSnapshotRevision([live,revoked]),pickerToken=await createPickerToken(env,[live,revoked],revision);
 await assert.rejects(call('/api/auth/accounts/switch','POST',{owner:revoked.owner,expectedRevision:revision,pickerToken}),{code:'unauthorized'});
 await assert.rejects(call('/api/auth/accounts/switch','POST',{owner:randomUUID(),expectedRevision:revision,pickerToken}),{code:'account_unavailable'});
 await assert.rejects(call('/api/auth/accounts/switch','POST',{owner:live.owner,expectedRevision:'stale',pickerToken}),{code:'vault_conflict'});
 const switched=await call('/api/auth/accounts/switch','POST',{owner:live.owner,expectedRevision:revision,pickerToken});
 assert.equal(switched.value.account.id,live.owner);assert.equal(switched.value.csrfToken,'csrf-live');
 assert(switched.headers.getSetCookie().some(h=>h.startsWith('bindle_default_account=ac1.')));
});
