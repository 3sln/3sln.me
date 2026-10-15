import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createHarness} from './harness.mjs';
// Actual workerd + SQLite Durable Objects. Browser cookie replacement is modeled per name.
const key=randomBytes(32).toString('base64url');
class Jar{constructor(entries=[]){this.map=new Map(entries);}apply(response){for(const line of response.headers.getSetCookie()){const [pair,...attributes]=line.split(';'),i=pair.indexOf('=');if(attributes.some(a=>/^\s*Max-Age=0$/i.test(a)))this.map.delete(pair.slice(0,i));else this.map.set(pair.slice(0,i),pair.slice(i+1));}return response;}header(){return [...this.map].map(([k,v])=>k+'='+v).join('; ');}copy(){return new Jar(this.map);}members(){return [...this.map.keys()].filter(k=>/^bindle_account_[0-9a-f-]{36}$/.test(k));}}
test('Worker adapter: independent member cookies, tab-bound selection, switch, sign-out and limit compensation',async t=>{
 const h=await createHarness({bindings:{SESSION_COOKIE_KEY:key,SIGNUP_REGION_HOURLY_LIMIT:'50',SIGNUP_GLOBAL_HOURLY_LIMIT:'50',SIGNUP_IP_DAILY_LIMIT:'50',SIGNUP_SUBNET_DAILY_LIMIT:'50'}});t.after(()=>h.close());let ip=0;
 const call=(path,{jar,method='GET',value,headers={}}={})=>h.request(path,{method,value,headers:{...method==='GET'?{}:{Origin:h.origin},...jar?{Cookie:jar.header()}:{},'CF-Connecting-IP':'203.0.113.'+(++ip%250),...headers}});
 const signup=async jar=>{const pending=await jar.apply(await call('/api/auth/signup',{jar,method:'POST',value:{method:'password',password:'isolated test account password',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}})).json();const file=await jar.apply(await call('/api/auth/recovery/download',{jar,method:'POST',value:{pendingToken:pending.pendingToken}})).json();const response=jar.apply(await call('/api/auth/recovery/confirm',{jar,method:'POST',value:{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true}}));return {response,pending,body:await response.json()};};
 const as=(s,csrf=true)=>({'X-Bindle-Account':s.account.id,'X-Bindle-Session-Context':s.sessionContext,...csrf?{'X-CSRF-Token':s.csrfToken}:{}});
 const jar=new Jar(),sessions=[];for(let i=0;i<5;i++){const {response,body}=await signup(jar);assert.equal(response.status,200);sessions.push(body);}
 assert.equal(jar.members().length,5);assert(jar.header().length<3000);
 for(const s of sessions)assert.equal((await (await call('/api/account',{jar,headers:as(s,false)})).json()).account.id,s.account.id);
 const sixth=await signup(jar);assert.equal(sixth.response.status,409);assert.equal(sixth.body.error,'account_limit');assert.equal(jar.members().length,5);assert.equal((await h.directory.get(sixth.pending.account.id)).sessions.length,0);
 const [a,b]=sessions,name='bindle_account_'+a.account.id,tampered=jar.copy();tampered.map.set(name,jar.map.get(name).replace(/.{4}$/,'AAAA'));
 assert.equal((await call('/api/account',{jar:tampered,headers:as(a,false)})).status,401);
 assert.equal((await (await call('/api/account',{jar,headers:{...as(a,false),'X-Bindle-Session-Context':b.sessionContext}})).json()).error,'session_context_conflict');
 assert.equal((await call('/api/contacts',{jar,method:'POST',value:{name:'x'},headers:{'X-CSRF-Token':b.csrfToken}})).status,409);
 let list=await jar.apply(await call('/api/auth/accounts',{jar})).json();assert.equal(list.accounts.length,5);
 assert.equal((await call('/api/auth/accounts',{jar,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 const switched=await jar.apply(await call('/api/auth/accounts/switch',{jar,method:'POST',value:{owner:a.account.id,expectedRevision:list.revision,pickerToken:list.pickerToken}})).json();assert.equal(switched.account.id,a.account.id);assert.equal(switched.csrfToken,a.csrfToken);
 assert.equal((await (await call('/api/session',{jar})).json()).account.id,a.account.id);
 const out=await jar.apply(await call('/api/auth/accounts/logout',{jar,method:'POST',value:{owner:b.account.id,expectedRevision:list.revision},headers:as(b)})).json();assert.equal(out.cleanupPending,false);assert.equal(out.accountsRemaining,4);
 assert.equal((await call('/api/account',{jar,headers:as(a,false)})).status,200);
 list=await jar.apply(await call('/api/auth/accounts',{jar})).json();const copied=jar.copy(),all=await jar.apply(await call('/api/auth/accounts/logout-all',{jar,method:'POST',value:{expectedRevision:list.revision,pickerToken:list.pickerToken}})).json();assert.equal(all.cleanupPending,false);assert.equal(jar.members().length,0);
 for(const s of sessions.slice(2))assert.equal((await call('/api/account',{jar:copied,headers:as(s,false)})).status,401);
 assert.equal((await (await call('/api/session',{jar})).json()).authenticated,false);
});
