import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createNodeServer} from '../apps/node/server.mjs';
import {sealAccountValue,accountCookieName} from '../packages/runtime/account-cookies.mjs';
// Real Node adapter + sharded identity repository. Cookie jars model browser
// replacement/expiry per name; nothing here is a mocked session authority.
const origin='http://localhost:8790',key=randomBytes(32).toString('base64url');
class Jar{constructor(entries=[]){this.map=new Map(entries);}apply(response){for(const line of response.headers.getSetCookie()){const [pair,...attributes]=line.split(';'),i=pair.indexOf('='),name=pair.slice(0,i),value=pair.slice(i+1);if(attributes.some(a=>/^\s*Max-Age=0$/i.test(a)))this.map.delete(name);else this.map.set(name,value);}return response;}header(){return [...this.map].map(([k,v])=>k+'='+v).join('; ');}copy(){return new Jar(this.map);}members(){return [...this.map.keys()].filter(k=>/^bindle_account_[0-9a-f-]{36}$/.test(k));}}
async function fixture(t,config={}){const directory=await mkdtemp(join(tmpdir(),'bindle-accounts-'));let app=await createNodeServer({directory,config:{APP_ORIGIN:origin,SESSION_COOKIE_KEY:key,SIGNUP_IP_DAILY_LIMIT:'50',SIGNUP_SUBNET_DAILY_LIMIT:'50',SIGNUP_REGION_HOURLY_LIMIT:'50',SIGNUP_REGION_DAILY_LIMIT:'50',SIGNUP_GLOBAL_HOURLY_LIMIT:'50',SIGNUP_GLOBAL_DAILY_LIMIT:'200',...config}});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});let ip=0;
 const call=(path,{jar,method='GET',value,headers={}}={})=>app.fetch(new Request(origin+path,{method,headers:{...method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'},...jar?{Cookie:jar.header()}:{},'CF-Connecting-IP':'198.51.100.'+(++ip%250),...headers},...value!==undefined?{body:JSON.stringify(value)}:{}}));
 async function signup(jar){const pending=await jar.apply(await call('/api/auth/signup',{jar,method:'POST',value:{method:'password',password:'Multi account test long password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}})).json();const recovery=await jar.apply(await call('/api/auth/recovery/download',{jar,method:'POST',value:{pendingToken:pending.pendingToken}})).json();const response=jar.apply(await call('/api/auth/recovery/confirm',{jar,method:'POST',value:{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true}}));return {response,pending,body:await response.json()};}
 const as=(session,csrf=true)=>({'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext,...csrf?{'X-CSRF-Token':session.csrfToken}:{}});
 const inventory=async jar=>{const response=jar.apply(await call('/api/auth/accounts',{jar}));assert.equal(response.status,200);return response.json();};
 return {get app(){return app;},directory,call,signup,as,inventory,restart:async extra=>{await app.close();app=await createNodeServer({directory,config:{APP_ORIGIN:origin,SIGNUP_IP_WINDOW_MS:'1',...extra}});}};
}
test('five independent member cookies: per-tab selection, byte budget, explicit sixth-account refusal with compensation',async t=>{
 const f=await fixture(t),jar=new Jar(),sessions=[];for(let i=0;i<5;i++){const {response,body}=await f.signup(jar);assert.equal(response.status,200);assert.equal(body.sessionToken,undefined);assert.match(body.sessionContext,/^[0-9a-f-]{36}$/);sessions.push(body);for(const line of response.headers.getSetCookie())if(line.startsWith('bindle_account_'))assert.match(line,/HttpOnly; SameSite=Strict; Max-Age=8\d{4}$/);}
 assert.equal(jar.members().length,5);
 // Measured worst-case Cookie header for the member/default set; documented budget.
 const bytes=new TextEncoder().encode(jar.header()).length;assert(bytes<3000,`cookie header ${bytes} bytes`);for(const [name,value] of jar.map)assert(name.length+value.length+1<400,name);
 // Each tab names its own member; neither follows the global default.
 for(const s of sessions){const r=await f.call('/api/session',{jar,headers:f.as(s,false)});assert.equal((await r.json()).account.id,s.account.id);}
 const list=await f.inventory(jar);assert.equal(list.accounts.length,5);assert.equal(list.limit,5);assert.deepEqual(new Set(list.accounts.map(a=>a.account.id)),new Set(sessions.map(s=>s.account.id)));assert.equal(JSON.stringify(list).includes(sessions[0].csrfToken),false);for(const row of list.accounts)assert.deepEqual(Object.keys(row.account).sort(),['handle','id']);
 const sixth=await f.signup(jar);assert.equal(sixth.response.status,409);assert.equal(sixth.body.error,'account_limit');assert.equal(jar.members().length,5);const record=await f.app.resources.repository.get(sixth.pending.account.id);assert.equal(record.sessions.length,0,'minted session was revoked, not orphaned');
});
test('authentication and selector checks reject tampered, duplicate, foreign and mismatched cookies before owner routing',async t=>{
 const f=await fixture(t),jar=new Jar(),{body:a}=await f.signup(jar),{body:b}=await f.signup(jar),repository=f.app.resources.repository,accounts=f.app.resources.accounts;let reads=0,actors=0,ids=new Set();const get=repository.get.bind(repository),actor=accounts.get.bind(accounts);repository.get=id=>{reads++;ids.add(id);return get(id);};accounts.get=id=>{actors++;return actor(id);};
 const name=accountCookieName(a.account.id,true),original=jar.map.get(name),tampered=jar.copy();tampered.map.set(name,original.slice(0,-3)+(original.endsWith('AAA')?'BBB':'AAA'));
 const foreignEnv={APP_ORIGIN:'http://localhost:9999',SESSION_COOKIE_KEY:key},foreign=jar.copy();foreign.map.set(name,await sealAccountValue(foreignEnv,'session',name,{owner:a.account.id,token:a.account.id+'.'+'A'.repeat(43),expiresAt:Date.now()+60000,sessionContext:a.sessionContext}));
 const renamed=jar.copy();renamed.map.set(accountCookieName(b.account.id,true),original);
 const cases=[[tampered,f.as(a),401,'invalid_account_cookie'],[foreign,f.as(a),401,'invalid_account_cookie'],[renamed,f.as(b),401,'invalid_account_cookie'],[jar,{...f.as(a),'X-Bindle-Session-Context':b.sessionContext},409,'session_context_conflict'],[jar,{'X-Bindle-Account':a.account.id},409,'account_context_conflict'],[jar,{'X-Bindle-Account':'not-a-uuid','X-Bindle-Session-Context':'x'},409,'account_context_conflict'],[new Jar(),f.as(a),401,'account_unavailable']];
 for(const [cookies,headers,status,code] of cases){reads=0;actors=0;const response=await f.call('/api/account',{jar:cookies,headers});assert.equal(response.status,status,code);assert.equal((await response.json()).error,code);assert.equal(reads,0,'no identity actor read for '+code);assert.equal(actors,0,'no account actor for '+code);}
 reads=0;const duplicate=await f.call('/api/account',{headers:{...f.as(a),Cookie:jar.header()+'; '+name+'='+original}});assert.equal(duplicate.status,401);assert.equal(reads,0);
 // Header-less private writes never follow the mutable default member.
 assert.equal((await f.call('/api/contacts',{jar,method:'POST',value:{name:'x'},headers:{'X-CSRF-Token':b.csrfToken}})).status,409);
 // Valid selection touches only its owner record.
 reads=0;ids.clear();const ok=await f.call('/api/session',{jar,headers:f.as(a,false)});assert.equal(ok.status,200);assert(reads>0);assert.deepEqual([...ids],[a.account.id]);
});
test('switching requires exact origin, fetch metadata, current revision and picker proof or member CSRF; a switch is not an extension',async t=>{
 const f=await fixture(t),jar=new Jar(),{body:a}=await f.signup(jar),{body:b}=await f.signup(jar),list=await f.inventory(jar);
 const post=(path,value,headers={},cookies=jar)=>f.call(path,{jar:cookies,method:'POST',value,headers});
 assert.equal((await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken},{Origin:'https://evil.example'})).status,403);
 assert.equal((await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken},{'Sec-Fetch-Site':'same-site'})).status,403);
 assert.equal((await f.call('/api/auth/accounts',{jar,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await (await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:'stale',pickerToken:list.pickerToken})).json()).error,'vault_conflict');
 assert.equal((await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision})).status,403,'no picker proof and no member CSRF');
 assert.equal((await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision},{...f.as(b,false),'X-CSRF-Token':a.csrfToken})).status,403,'CSRF from another member');
 const viaCsrf=await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision},f.as(b));assert.equal(viaCsrf.status,200);
 const switched=jar.apply(await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken}));const result=await switched.json();assert.equal(result.account.id,a.account.id);assert.equal(result.csrfToken,a.csrfToken);assert.equal(result.expiresAt,a.expiresAt);assert.equal(switched.headers.getSetCookie().length,1);
 assert.equal((await (await f.call('/api/session',{jar})).json()).account.id,a.account.id,'default updated for header-less discovery');
 assert.equal((await (await f.call('/api/session',{jar,headers:f.as(b,false)})).json()).account.id,b.account.id,'other tab keeps its member');
 const other=new Jar(),{body:c}=await f.signup(other);assert.equal((await post('/api/auth/accounts/switch',{owner:c.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken})).status,401,'picker cannot select a non-member');
 const changed=await post('/api/auth/accounts/switch',{owner:a.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken},{},(()=>{const j=jar.copy();j.map.delete(accountCookieName(b.account.id,true));return j;})());assert.equal((await changed.json()).error,'vault_conflict','picker proof is bound to the observed member snapshot');
});
test('partial logout keeps retry-only custody, later retries revoke exactly those sessions, and replayed cookies cannot revive them',async t=>{
 const f=await fixture(t),jar=new Jar(),{body:a}=await f.signup(jar),{body:b}=await f.signup(jar),copied=jar.copy(),repository=f.app.resources.repository,swap=repository.compareAndSwap.bind(repository);
 repository.compareAndSwap=async(id,...rest)=>id===b.account.id?false:swap(id,...rest);
 let list=await f.inventory(jar);const out=jar.apply(await f.call('/api/auth/accounts/logout-all',{jar,method:'POST',value:{expectedRevision:list.revision,pickerToken:list.pickerToken}}));const outcome=await out.json();assert.equal(outcome.cleanupPending,true);assert.equal(jar.members().length,0,'no ordinary selection remains');assert(jar.map.has('bindle_account_cleanup'));
 assert.equal((await f.call('/api/account',{jar:copied,headers:f.as(a,false)})).status,401,'A revoked: copied cookie is dead');
 assert.equal((await f.call('/api/account',{jar:copied,headers:f.as(b,false)})).status,200,'B unresolved: copied cookie is honestly still live');
 list=await f.inventory(jar);assert.equal(list.accounts.length,0);assert.equal(list.cleanupPending,true);
 const cleanupOnly=new Jar([['bindle_account_cleanup',jar.map.get('bindle_account_cleanup')]]);assert.equal((await (await f.call('/api/session',{jar:cleanupOnly})).json()).authenticated,false,'cleanup custody never authenticates');
 const again=jar.apply(await f.call('/api/auth/accounts/cleanup',{jar,method:'POST',value:{expectedRevision:list.revision,pickerToken:list.pickerToken}}));assert.equal((await again.json()).cleanupPending,true);
 repository.compareAndSwap=swap;list=await f.inventory(jar);const retried=jar.apply(await f.call('/api/auth/accounts/cleanup',{jar,method:'POST',value:{expectedRevision:list.revision,pickerToken:list.pickerToken}}));assert.equal((await retried.json()).cleanupPending,false);assert.equal(jar.map.has('bindle_account_cleanup'),false);
 assert.equal((await f.call('/api/account',{jar:copied,headers:f.as(b,false)})).status,401,'retry revoked B');
 // Stale responses: replaying old member cookies leaves them unauthenticated and inventory drops them.
 const replay=copied.copy();const inv=await f.inventory(replay);assert.equal(inv.accounts.length,0);assert.equal(replay.members().length,0);
});
test('sign out one keeps others, clears the default only for that account, and same-owner relogin revokes its predecessor',async t=>{
 const f=await fixture(t),jar=new Jar(),{body:a,pending}=await f.signup(jar),{body:b}=await f.signup(jar);let list=await f.inventory(jar);
 const out=jar.apply(await f.call('/api/auth/accounts/logout',{jar,method:'POST',value:{owner:a.account.id,expectedRevision:list.revision},headers:f.as(a)}));const result=await out.json();assert.equal(result.accountsRemaining,1);assert.equal(result.cleanupPending,false);assert.deepEqual(jar.members(),[accountCookieName(b.account.id,true)]);
 assert.equal((await f.call('/api/account',{jar,headers:f.as(b,false)})).status,200);
 // B is the default (most recent sign-in) and stays selected for discovery; A's logout cannot activate anything new.
 assert.equal((await (await f.call('/api/session',{jar})).json()).account.id,b.account.id);
 const login=async()=>jar.apply(await f.call('/api/auth/login/password',{jar,method:'POST',value:{handle:pending.account.handle,password:'Multi account test long password!',turnstileToken:'local-browser-test-token'}}));
 const first=await (await login()).json(),second=await (await login()).json();assert.notEqual(first.sessionContext,second.sessionContext);const record=await f.app.resources.repository.get(a.account.id);assert.equal(record.sessions.length,1,'predecessor revoked');assert.equal(jar.members().length,2);
 list=await f.inventory(jar);const last=jar.apply(await f.call('/api/auth/accounts/logout',{jar,method:'POST',value:{owner:a.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken}}));assert.equal(last.status,200);assert.deepEqual(jar.members(),[accountCookieName(b.account.id,true)]);assert.equal((await (await f.call('/api/session',{jar})).json()).authenticated,false,'logging out the default never selects the remaining account');
});
test('legacy single-session cookie migrates once; a present vault never falls back to legacy credentials',async t=>{
 const f=await fixture(t,{SESSION_COOKIE_KEY:undefined}),jar=new Jar(),{body:a}=await f.signup(jar);assert(jar.map.has('bindle_session'));assert.equal(jar.members().length,0);const legacy=jar.copy();
 await f.restart({SESSION_COOKIE_KEY:key});const migrated=jar.apply(await f.call('/api/session',{jar}));assert.equal((await migrated.json()).account.id,a.account.id);assert.equal(jar.map.has('bindle_session'),false);assert.deepEqual(jar.members(),[accountCookieName(a.account.id,true)]);
 assert.equal((await f.call('/api/session',{jar,headers:f.as({...a,sessionContext:(await f.inventory(jar)).accounts[0].sessionContext},false)})).status,200);
 const mixed=legacy.copy();mixed.map.set(accountCookieName(a.account.id,true),'ac1.AAAAAAAAAAAAAAAA.tampered');assert.equal((await (await f.call('/api/session',{jar:mixed})).json()).authenticated,false,'malformed vault does not downgrade to legacy');
 const both=legacy.copy();both.map.set('bindle_default_account','ac1.AAAAAAAAAAAAAAAA.bad');assert.equal((await (await f.call('/api/session',{jar:both})).json()).authenticated,false);
});
test('production __Host- byte budget: five members plus default and worst-case cleanup stay under one 4 KiB cookie each and a 4 KiB header',async()=>{
 const {installedAccountCookies,cleanupAccountCookie}=await import('../packages/runtime/account-cookies.mjs'),env={APP_ORIGIN:'https://accounts.example',SESSION_COOKIE_KEY:key},now=Date.now(),member=()=>{const owner=crypto.randomUUID();return {owner,token:owner+'.'+'A'.repeat(43),expiresAt:now+86400000,sessionContext:'s'.repeat(43)};},members=Array.from({length:5},member),lines=[];for(const m of members)lines.push(...await installedAccountCookies(env,m,false));
 const jar=new Map(lines.map(line=>{const pair=line.split(';')[0],i=pair.indexOf('=');return [pair.slice(0,i),pair.slice(i+1)];})),size=map=>[...map].map(([k,v])=>k+'='+v).join('; ').length;assert(lines.every(line=>line.includes('; Secure')&&line.startsWith('__Host-')));assert(size(jar)<=2300,`members ${size(jar)}`);
 const cleanup=await cleanupAccountCookie(env,members,false,now),pair=cleanup.split(';')[0];jar.set(pair.slice(0,pair.indexOf('=')),pair.slice(pair.indexOf('=')+1));assert(size(jar)<=4000,`with cleanup ${size(jar)}`);
 const worst=(await cleanupAccountCookie(env,Array.from({length:8},member),false,now)).split(';')[0];assert(worst.length<4096,`eight-entry cleanup ${worst.length}`);
});
test('review regressions: unreadable cleanup is expired, header-less identity writes fail closed, over-limit sets stay recoverable, logout-all clears legacy',async t=>{
 const f=await fixture(t),jar=new Jar(),{body:a}=await f.signup(jar),{sealAccountValue:seal}=await import('../packages/runtime/account-cookies.mjs');
 const rotated=jar.copy();rotated.map.set('bindle_account_cleanup',await seal({APP_ORIGIN:origin,SESSION_COOKIE_KEY:randomBytes(32).toString('base64url')},'cleanup','bindle_account_cleanup',{members:[],expiresAt:Date.now()+1000}));
 const listed=await f.call('/api/auth/accounts',{jar:rotated});assert.equal(listed.status,200);rotated.apply(listed);assert.equal(rotated.map.has('bindle_account_cleanup'),false);assert.equal((await listed.json()).cleanupPending,false);
 const headerless=await f.call('/api/auth/logout',{jar,method:'POST',value:{},headers:{'X-CSRF-Token':a.csrfToken}});assert.notEqual(headerless.status,200);assert.equal((await f.call('/api/account',{jar,headers:f.as(a,false)})).status,200,'default account was not signed out');
 const crowded=jar.copy();for(let i=0;i<9;i++){const owner=crypto.randomUUID(),name=accountCookieName(owner,true);crowded.map.set(name,await seal({APP_ORIGIN:origin,SESSION_COOKIE_KEY:key},'session',name,{owner,token:owner+'.'+'A'.repeat(43),expiresAt:Date.now()+60000,sessionContext:'x'}));}
 crowded.map.set('bindle_session','legacy-token');const list=await f.inventory(crowded);assert.equal(list.accounts.length,1,'forged members are dropped, the real one listed');const out=crowded.apply(await f.call('/api/auth/accounts/logout-all',{jar:crowded,method:'POST',value:{expectedRevision:list.revision,pickerToken:list.pickerToken}}));assert.equal(out.status,200);assert.equal(crowded.members().length,0);assert.equal(crowded.map.has('bindle_session'),false);
});
