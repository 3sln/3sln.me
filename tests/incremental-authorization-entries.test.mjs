// IA-1 through the provider-owned authorization entry and its HTTP handler, plus the token-endpoint branch: pinned
// client/callback/PKCE/state/nonce, intent gating by mount, uniform creation, result redirects, and concurrency
// (parallel decisions, parallel creation against caps, parallel code redemption).
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {MemoryMessagingStore} from '../packages/messaging/store.mjs';
import {AuthorizationEntries} from '../packages/federation/authorization-entries.mjs';
import {handleAuthorizationEntry,ENTRY_TOKEN_HEADER} from '../packages/runtime/federation-entry-http.mjs';
import {incrementalRunner,handleIncrementalToken,incrementalMountable} from '../packages/runtime/incremental-authorization.mjs';
import {SuppressionAdd} from '../packages/federation/suppression.mjs';
import {fixture,issuer,owner,subject,otherOwner,tasks,CAL,SUMMARY,CALENDAR,calRequest,pkce,b64,engine} from './incremental-authorization-helpers.mjs';

const config={INCREMENTAL_AUTH_ENABLED:'true',FEDERATION_ENABLED:'true',FEDERATION_ENTRY_ENABLED:'true'};
function stack({flag=true,limits}={}){
 const f=fixture({limits});f.p.grant(tasks.id,CAL,{fields:['color'],methods:{}});f.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});f.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday'}});f.p.newest.set(`${subject}|${tasks.id}`,{expiresAt:null,authTime:5});
 const port=incrementalRunner({config:{...config,INCREMENTAL_AUTH_ENABLED:flag?'true':'false'},incremental:f.incremental,clock:{now:f.time}});
 const sessions=new Set([`${owner}.${'s'.repeat(43)}`,`${otherOwner}.${'s'.repeat(43)}`]);
 const begun=[],authority={begun,entryIdentity:async(context,id)=>{if(!sessions.has(context?.sessionToken))throw Object.assign(new Error('Sign in.'),{code:'unauthorized'});return {subject:`${issuer}/entities/${id}`,authTime:f.time()};},beginEntryAuthorization:async(context,input)=>{begun.push(structuredClone(input.entry.requests));return {requestId:input.requestId};},approve:async()=>({redirectUri:`${tasks.redirectUris[0]}?code=login-code&state=s&iss=${encodeURIComponent(issuer)}`})};
 const entries=new AuthorizationEntries({store:new MemoryMessagingStore(),issuer,clients:[tasks],authority,crypto:webcrypto,clock:f.time,dpop:true,incremental:port});
 const fetch=async(url,{method='GET',headers={},body}={})=>{const request=new Request(url,{method,headers,...body!==undefined?{body}:{}});return await handleIncrementalToken(request,{port,issuer,proofs:{verify:async proof=>proof==='valid-proof'?'k'.repeat(43):null}})??await handleAuthorizationEntry(request,{entries,issuer,remote:async()=>'remote-1',ownerContext:async r=>({sessionToken:r.headers.get('X-Test-Session')??undefined})});};
 const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 return {f,port,entries,fetch,post,authority};
}
const session=(id=owner)=>`${id}.${'s'.repeat(43)}`;
async function create(s,overrides={}){const verifier=b64(48),body={clientId:tasks.id,redirectUri:tasks.redirectUris[0],challenge:pkce(verifier),challengeMethod:'S256',state:b64(24),intent:'grant-more',subjectConstraint:subject,requests:[calRequest()],presentation:'redirect',...overrides};for(const [k,v] of Object.entries(body))if(v===undefined)delete body[k];const response=await s.post(`${issuer}/api/oauth/entries`,body,{Origin:tasks.origin});return {response,json:await response.json(),verifier,body};}
async function page(s,entryId,id=owner){const view=await (await s.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{'Sec-Fetch-Site':'same-origin'}})).json();const headers={Origin:issuer,'Sec-Fetch-Site':'same-origin',[ENTRY_TOKEN_HEADER]:view.pageToken,'X-Test-Session':session(id)};const selected=await s.post(`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce},headers);return {view,headers,selected:await selected.json(),status:selected.status,decide:body=>s.post(`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...body},headers)};}
const token=(s,{code,verifier,proof,clientId=tasks.id})=>s.fetch(`${issuer}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...proof?{DPoP:proof}:{}},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:tasks.redirectUris[0],client_id:clientId,code_verifier:verifier}).toString()});

test('the intents are accepted and listed only when the flag is on and the port is mounted',async()=>{
 assert.equal(incrementalMountable(config),true);assert.equal(incrementalMountable({...config,INCREMENTAL_AUTH_ENABLED:'false'}),false);
 const on=stack(),off=stack({flag:false});assert.equal(off.port,null);
 assert.deepEqual(on.entries.manifest().features['authorization-entry.v1'].intents,['login','select-account','reauthenticate','grant-more','configure']);
 assert.deepEqual(off.entries.manifest().features['authorization-entry.v1'].intents,['login','select-account','reauthenticate']);
 assert.equal((await create(off)).response.status,400);assert.equal((await create(on)).response.status,201);
 for(const extra of [{reason:'x'},{target:{fragment:SUMMARY}}])assert.equal((await create(on,{intent:'login',subjectConstraint:undefined,requests:[],...extra})).response.status,400,'incremental members are refused on other intents');
 assert.equal((await create(on,{intent:'login',subjectConstraint:undefined,requests:[]})).response.status,201,'existing intents are unaffected');
});

test('grant-more over HTTP: pinned binding, armed decision, code redirect and token outcomes with a capped session',async()=>{
 const s=stack(),{json,verifier,body}=await create(s,{reason:'To add due dates to your calendar.'}),p=await page(s,json.entryId);
 assert.equal(p.view.entry.reason,'To add due dates to your calendar.');assert.equal(p.status,200);assert.deepEqual(p.selected.incremental.requests[0].delta.fields,['calendar']);
 const early=await p.decide({approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]});assert.equal(early.status,400);assert.equal((await early.json()).error,'decision_not_armed');
 s.f.time.advance(1500);const decision={approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]},done=await (await p.decide(decision)).json();
 const url=new URL(done.redirectUri);assert.deepEqual([...url.searchParams.keys()].sort(),['code','iss','state']);assert.equal(url.searchParams.get('state'),body.state);assert.equal(url.origin+url.pathname,tasks.redirectUris[0]);
 assert.deepEqual(await (await p.decide(decision)).json(),done,'a retried identical decision returns the stored answer');
 assert.equal((await p.decide({denied:true})).status,400,'a different decision after completion is refused');
 const response=await token(s,{code:url.searchParams.get('code'),verifier}),tokens=await response.json();assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.equal(tokens.fragment_outcomes[0].outcome,'granted');assert.equal(tokens.access_token,'at-1');assert.equal(s.f.p.calls.lastIssue.authTime,5);
 assert.equal((await token(s,{code:url.searchParams.get('code'),verifier})).status,400);
});

test('configure over HTTP: no PKCE, exactly result/state/iss, and the account is constrained',async()=>{
 const s=stack();assert.equal((await create(s,{intent:'configure',requests:undefined,target:{fragment:SUMMARY},suggestion:{values:{day:'monday'}}})).response.status,400,'configure carries no challenge');
 const {json}=await create(s,{intent:'configure',requests:undefined,challenge:undefined,challengeMethod:undefined,target:{fragment:SUMMARY},suggestion:{values:{day:'monday'}}});assert(json.entryId);
 const wrong=await page(s,json.entryId,otherOwner);assert.equal(wrong.status,409);assert.equal(wrong.selected.error,'account_mismatch');
 const p=await page(s,json.entryId);assert.equal(p.selected.incremental.fields[0].suggested,'monday');s.f.time.advance(1500);
 const done=await (await p.decide({changes:[{field:'day',take:'suggested',via:'field'}]})).json(),url=new URL(done.redirectUri);
 assert.deepEqual([...url.searchParams.keys()].sort(),['iss','result','state']);assert.equal(url.searchParams.get('result'),'configured');assert.equal(s.f.p.calls.commit,0);
 assert.equal((await create(s,{intent:'configure',requests:undefined,challenge:undefined,challengeMethod:undefined,target:{fragment:SUMMARY},dpopJkt:'k'.repeat(43)})).response.status,400,'configure takes no DPoP key');
});

test('creation answers identically whether or not the request is suppressed; limits answer 429 with Retry-After',async t=>{
 const plain=stack(),blocked=stack(),e=await engine(t,blocked.f);await e.perform(new SuppressionAdd({input:{clientId:tasks.id,scope:'app'},actor:{kind:'owner',owner}}));
 const a=await create(plain),b=await create(blocked);assert.equal(a.response.status,b.response.status);assert.deepEqual(Object.keys(a.json),Object.keys(b.json));
 const p=await page(blocked,b.json.entryId);assert.equal(p.selected.incremental.blocked,true);blocked.f.time.advance(1500);
 const done=await (await p.decide({notice:'return'})).json();assert.deepEqual([...new URL(done.redirectUri).searchParams.keys()].sort(),['code','iss','state']);
 const limited=await create(blocked);assert.equal(limited.response.status,429);assert.equal(limited.response.headers.get('Retry-After'),String(24*3600));assert.equal(limited.json.error,'rate_limited');
 const tooMany=await create(plain,{requests:[calRequest({required:true})]});assert.equal(tooMany.response.status,400);assert.equal(tooMany.json.error,'invalid_request');
});

test('the token branch ignores everything but incremental codes and binds the pinned DPoP key',async()=>{
 const s=stack(),other=new Request(`${issuer}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=authorization_code&code=abc'});
 assert.equal(await handleIncrementalToken(other,{port:s.port,issuer,proofs:{verify:async()=>null}}),null);assert.equal(await handleIncrementalToken(other,{port:null,issuer}),null);
 const {json,verifier}=await create(s,{dpopJkt:'k'.repeat(43)}),p=await page(s,json.entryId);s.f.time.advance(1500);
 const code=new URL((await (await p.decide({approved:[{fragment:CAL,fields:['calendar']}]})).json()).redirectUri).searchParams.get('code');
 assert.equal((await (await token(s,{code,verifier,proof:'forged'})).json()).error,'invalid_dpop_proof');assert.equal((await token(s,{code,verifier})).status,400,'missing proof for a key-bound code');
 const tokens=await (await token(s,{code,verifier,proof:'valid-proof'})).json();assert.equal(tokens.token_type,'DPoP');assert.equal(tokens.fragment_outcomes[0].outcome,'partial');
});

test('concurrency: parallel decisions commit once; parallel creation respects caps and leaves one open entry',async()=>{
 const s=stack(),{json}=await create(s),p=await page(s,json.entryId);s.f.time.advance(1500);
 const decision={approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]};
 const results=await Promise.all(Array.from({length:6},()=>p.decide(decision).then(async r=>({status:r.status,body:await r.json()}))));
 assert.equal(s.f.p.calls.commit,1,'exactly one grant commit');const ok=results.filter(r=>r.status===200);assert(ok.length>=1);
 for(const r of ok)assert.equal(r.body.redirectUri,ok[0].body.redirectUri,'every successful answer is the one stored completion');
 for(const r of results.filter(r=>r.status!==200))assert(['decision_in_progress','invalid_request'].includes(r.body.error),r.body.error);
 const c=stack({limits:{requests:{hour:3}}}),created=await Promise.all(Array.from({length:6},()=>create(c)));
 assert.equal(created.filter(x=>x.response.status===201).length,3);assert.equal(created.filter(x=>x.response.status===429).length,3);
 const opened=[];for(const x of created.filter(x=>x.response.status===201)){const q=await page(c,x.json.entryId);opened.push(q.selected.incremental?.superseded?'superseded':q.selected.incremental?'open':q.selected.error);}
 assert.deepEqual(opened.sort(),['open','superseded','superseded'],'one open incremental entry per app and account');
});

test('concurrency: parallel redemption of one code yields one session and revokes it on replay',async()=>{
 const s=stack(),{json,verifier}=await create(s),p=await page(s,json.entryId);s.f.time.advance(1500);
 const code=new URL((await (await p.decide({approved:[{fragment:CAL,fields:['calendar']}]})).json()).redirectUri).searchParams.get('code');
 const answers=await Promise.all(Array.from({length:4},()=>token(s,{code,verifier}).then(r=>r.json())));
 assert.equal(answers.filter(a=>a.access_token).length<=1,true);assert.equal(s.f.p.calls.issue<=1,true);
 // Revocation is logical and serialized: the sole issued family is revoked exactly once, however replays interleave.
 assert.deepEqual(s.f.p.calls.revoke.map(r=>r.family),s.f.p.calls.issue===1?['family-1']:[],'a replay revokes the issued family exactly once');
 assert.equal(answers.filter(a=>a.error==='invalid_grant').length>=3,true);
});

test('owner suppression routes answer only when the flag is on and the port mounted',async()=>{
 const {stages}=await import('../packages/runtime/routes/incremental.mjs'),s=stack(),url=new URL(`${issuer}/api/incremental/suppressions?client=${encodeURIComponent(tasks.id)}`);
 const call=(env,request,path=url.pathname,u=url)=>stages.beforeActivity({request,env,path,url:u,id:owner});
 assert.equal(await call({INCREMENTAL_AUTH_ENABLED:'false',INCREMENTAL_AUTHORIZATION:s.port},new Request(url)),undefined);assert.equal(await call({INCREMENTAL_AUTH_ENABLED:'true'},new Request(url)),undefined);
 const env={INCREMENTAL_AUTH_ENABLED:'true',INCREMENTAL_AUTHORIZATION:s.port};
 const added=await call(env,new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:tasks.id,scope:'kind',kind:'configure'})}));assert.equal(added.status,201);const record=await added.json();
 assert.deepEqual((await (await call(env,new Request(url))).json()).map(r=>r.id),[record.id]);
 const one=new URL(`${issuer}/api/incremental/suppressions/${record.id}?client=${encodeURIComponent(tasks.id)}`);assert.deepEqual(await (await call(env,new Request(one,{method:'DELETE'}),one.pathname,one)).json(),{removed:true});
 assert.equal((await call(env,new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:tasks.id,scope:'nope'})}))).status,400);
});

// IA-R2: a plain login on an existing connection that asks for more is a grant-more for suppression, caps and the ladder.
const login=(s,requests)=>create(s,{intent:'login',subjectConstraint:undefined,requests});
const loginRequest=(over={})=>({fragment:CAL,required:true,purpose:'Calendar',fields:['color','calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}},...over});
async function declineGrantMore(s){const {json}=await create(s),p=await page(s,json.entryId);s.f.time.advance(1500);await p.decide({denied:true});}

test('IA-R2: login deltas inherit cooldowns and suppression; blocked items are narrowed to held access and made optional',async t=>{
 const s=stack();await declineGrantMore(s);
 const {json}=await login(s,[loginRequest(),{fragment:SUMMARY,required:true,purpose:'Summary',fields:['day'],methods:{}}]),p=await page(s,json.entryId);
 assert.deepEqual(s.authority.begun.at(-1),[{fragment:CAL,required:false,purpose:'Calendar',fields:['color'],methods:{}},{fragment:SUMMARY,required:false,purpose:'Summary',fields:['day'],methods:{}}],'the cooling calendar delta is pre-declined; already-held access stays; nothing is required');
 assert.deepEqual(p.selected.incrementalLogin,{additions:[],predeclined:[CAL]});
 const g=stack(),e=await engine(t,g.f);await e.perform(new SuppressionAdd({input:{clientId:tasks.id,scope:'fragment',fragment:CAL},actor:{kind:'owner',owner}}));
 await page(g,(await login(g,[loginRequest({fields:['calendar']})])).json.entryId);assert.deepEqual(g.authority.begun.at(-1),[],'a fully suppressed addition leaves an identity-only login');
 const h=stack();await page(h,(await login(h,[loginRequest({fields:['color'],methods:{}})])).json.entryId);assert.deepEqual(h.authority.begun.at(-1)[0].fields,['color'],'no delta: unchanged except optional');
});

test('IA-R2: an addition is shown as such; declining it steps the shared ladder only after arming, approving it does not',async()=>{
 const s=stack(),{json}=await login(s,[loginRequest()]),p=await page(s,json.entryId);
 assert.deepEqual(p.selected.incrementalLogin.additions,[{fragment:CAL,delta:{fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}}]);
 s.f.time.advance(1500);await p.decide({denied:true});const limited=await create(s);assert.equal(limited.response.status,429,'a login decline cools the grant-more target');
 const early=stack(),q=await page(early,(await login(early,[loginRequest()])).json.entryId);await q.decide({denied:true});assert.equal((await create(early)).response.status,201,'a cancel before arming counts caps only');
 const ok=stack(),r=await page(ok,(await login(ok,[loginRequest()])).json.entryId);ok.f.time.advance(1500);
 await r.decide({approved:[{fragment:CAL,fields:['color','calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]});assert.equal((await create(ok)).response.status,201,'approval starts no cooldown');
});

test('IA-R2: wider methods, new resources and buses, alternating intents and caps share one budget',async()=>{
 const s=stack({limits:{requests:{hour:3}}});s.f.p.grant(tasks.id,CAL,{fields:['color','calendar'],methods:{calendar:{[CALENDAR]:['readEvents']}}});
 // Wider methods on a held field are a delta; a new bus fragment is a delta too.
 const BUS='https://tasks.example/buses/task-changes/v1';
 await page(s,(await login(s,[loginRequest({methods:{calendar:{[CALENDAR]:['readEvents','createEvent']}}})])).json.entryId);assert.deepEqual(s.authority.begun.at(-1)[0].methods,{calendar:{[CALENDAR]:['readEvents','createEvent']}});
 await page(s,(await login(s,[{fragment:BUS,required:false,purpose:'Feed',fields:['bus'],methods:{bus:{'https://spec.bindle.example/contracts/event-bus/v1':['read']}}}])).json.entryId);
 assert.equal((await create(s)).response.status,201,'third counted request (grant-more)');
 const fourth=await login(s,[loginRequest({methods:{calendar:{[CALENDAR]:['readEvents','createEvent']}}})]),p=await page(s,fourth.json.entryId);
 assert.deepEqual(s.authority.begun.at(-1)[0].methods,{calendar:{[CALENDAR]:['readEvents']}},'over the cap a login delta is pre-declined');assert.deepEqual(p.selected.incrementalLogin.predeclined,[CAL]);
 assert.equal((await create(s)).response.status,429,'and grant-more is limited by the same counters');
});
