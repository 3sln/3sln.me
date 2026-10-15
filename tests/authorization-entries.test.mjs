import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {provider,post,createEntry,entryBody,providerPage,pageHeaders,viewOf,exchange,codeOf,issuer,appOrigin,embedOrigin,clientId,redirectUri,fragment,b64,pkce} from './authorization-entry-helpers.mjs';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {AuthorizationEntries,ENTRY_SHARDS,entryShard,remoteShard} from '../packages/federation/authorization-entries.mjs';
import {federationEntriesRemote} from '../packages/runtime/federation.mjs';

test('entry creation pins client, exact callback, PKCE, state, scopes, intent, nonce and expiry without storing the entry ID',async()=>{
 const p=await provider(),{response,entryId,body}=await createEntry(p,{requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}],loginHint:'alex@provider.example',uiLocales:['es'],colorScheme:'dark'});
 assert.equal(response.status,201);assert.match(entryId,/^[A-Za-z0-9_-]{43}$/);assert.equal(response.headers.get('Access-Control-Allow-Origin'),appOrigin);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const stored=JSON.stringify(await p.entries.store.transaction(tx=>tx.list('')));assert.equal(stored.includes(entryId),false);
 const [record]=(await p.entries.store.transaction(tx=>tx.list('entry/'))).map(r=>r.value);
 assert.deepEqual({clientId:record.clientId,redirectUri:record.redirectUri,challenge:record.challenge,state:record.state,intent:record.intent,requests:record.requests},{clientId,redirectUri,challenge:body.challenge,state:body.state,intent:'login',requests:body.requests});
 assert.match(record.nonce,/^[A-Za-z0-9_-]{22}$/);assert.equal(record.expiresAt-record.createdAt,600000);
 const view=await(await p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}})).json();
 assert.equal(view.entry.client.name,'Example app');assert.match(view.pageToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(stored.includes(view.pageToken),false,'the page token is derived from the unstored entry ID');assert.equal(view.entry.loginHint,'alex@provider.example');assert.equal(view.entry.nonce,record.nonce);assert.equal(JSON.stringify(view).includes(body.challenge),false);assert.equal(view.entry.state,undefined);
 // Cross-origin readers get nothing; the view carries no session or owner state.
 assert.equal((await p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:appOrigin}})).status,403);
 const foreign=await createEntry(p,{loginHint:'alex@other.example'});assert.equal((await p.entries.view(foreign.entryId)).entry.loginHint,undefined);
});

test('entry creation fails generically for unregistered callbacks, plain PKCE, cookies, unknown fields and misplaced bindings',async()=>{
 const p=await provider(),url=`${issuer}/api/oauth/entries`,generic=async(response,status=400)=>{assert.equal(response.status,status);const json=await response.json();if(status===400)assert.equal(json.message,'The authorization entry could not be created.');};
 const subject=p.accounts[0].subject,jkt=b64(32);
 for(const overrides of [{redirectUri:`${redirectUri}?x=1`},{challengeMethod:'plain'},{challenge:'short'},{intent:'impersonate'},{subjectConstraint:subject},{intent:'reauthenticate',subjectConstraint:subject},{intent:'reauthenticate',maxAge:60},{intent:'end-session',subjectConstraint:subject},{presentation:'iframe'},{embedJkt:jkt},{delivery:'embed-popup',embedJkt:jkt},{extra:1},{requests:[{fragment:'http://schema.example/x',required:true,purpose:'x',fields:['a']}]}])
  await generic(await post(p,url,entryBody(overrides).body,{Origin:appOrigin}));
 await generic(await post(p,url,entryBody().body,{Origin:appOrigin,Cookie:'__Host-bindle_session=x'}));
 await generic(await post(p,url,entryBody().body,{Origin:'https://evil.example'}),403);
 await generic(await post(p,url,entryBody().body,{Origin:embedOrigin}));
 assert.equal((await post(p,url,entryBody({intent:'reauthenticate',subjectConstraint:subject,maxAge:60}).body,{Origin:appOrigin})).status,201);
 // End-session is not offered without a configured session-ending hook.
 assert.deepEqual(p.entries.intents(),['login','select-account','reauthenticate']);
});

test('preflight allows registered client and embed origins only, and creation is rate limited per caller, per client from that caller and globally',async()=>{
 const p=await provider({limits:{perClient:2,perRemote:3,global:5}}),url=`${issuer}/api/oauth/entries`;
 assert.equal((await p.fetch(url,{method:'OPTIONS',headers:{Origin:embedOrigin}})).headers.get('Access-Control-Allow-Origin'),embedOrigin);
 assert.equal((await p.fetch(url,{method:'OPTIONS',headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'a'})).status,201);
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'a'})).status,201);
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'a'})).status,429);
 // Another caller's budget for the same client is untouched by caller a.
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'b'})).status,201);
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'c'})).status,201);
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'d'})).status,201);
 assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin,'X-Test-Remote':'e'})).status,429);
 p.time.advance(600000);assert.equal((await post(p,url,entryBody().body,{Origin:appOrigin})).status,201);
 // Without a caller address from the adapter, creation is refused rather than unbudgeted.
 await assert.rejects(p.entries.create(entryBody().body,{origin:appOrigin}),{code:'temporarily_unavailable'});
});

test('owner selection is authenticated, records owner and request ID durably, and retries resume the same request',async()=>{
 const p=await provider(),{entryId,verifier}=await createEntry(p),alex=p.signIn(p.accounts[0]),sam=p.signIn(p.accounts[1]);
 const view=await viewOf(p,entryId),select=(session,headers={},body={nonce:view.entry.nonce})=>post(p,`${issuer}/api/oauth/entries/${entryId}/select`,body,pageHeaders(view,{Cookie:session.cookie,'X-CSRF-Token':session.csrf,...headers}));
 // Forged owner prefixes, missing CSRF and a wrong nonce record nothing.
 assert.equal((await select({cookie:`__Host-bindle_session=${p.accounts[1].owner}.forged`,csrf:'x'})).status,401);
 assert.equal((await select(alex,{'X-CSRF-Token':''})).status,403);
 assert.equal((await select(alex,{},{nonce:'wrong'})).status,400);
 // Provider-page binding: exact Origin, Fetch Metadata and the page token from the view (never the public nonce).
 for(const headers of [{'X-Bindle-Entry-Token':''},{'X-Bindle-Entry-Token':view.entry.nonce},{'X-Bindle-Entry-Token':b64(32)},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':''},{Origin:appOrigin}])assert.equal((await select(alex,headers)).status,403,JSON.stringify(headers));
 assert.equal((await p.entries.store.transaction(tx=>tx.list('selection/'))).length,0);
 // The owner shard fails after the entry recorded the choice: the retry resumes that request ID.
 p.failures.beginEntry=1;assert.equal((await select(alex)).status,503);
 const [record]=(await p.entries.store.transaction(tx=>tx.list('selection/'))).map(r=>r.value);assert.equal(record.owner,p.accounts[0].owner);assert.match(record.requestId,new RegExp(`^${p.accounts[0].owner}\\.`));
 const first=await(await select(alex)).json(),second=await(await select(alex)).json();assert.equal(first.requestId,record.requestId);assert.equal(second.requestId,first.requestId);
 // Another account gets its own selection and learns nothing about the first one.
 const other=await select(sam);assert.equal(other.status,200);const samRequest=(await other.json()).requestId;assert.match(samRequest,new RegExp(`^${p.accounts[1].owner}\\.`));
 // A direct decision on the entry-bound owner request is refused; only the entry route decides.
 const direct=await post(p,`${issuer}/api/oauth/requests/${first.requestId}/decision`,{requestId:first.requestId,approved:[]},{Origin:issuer,Cookie:alex.cookie,'X-CSRF-Token':alex.csrf});assert.equal(direct.status,400);
 const page=await providerPage(p,entryId,alex);assert.equal(page.selection.requestId,first.requestId);
 const callback=new URL(page.result.redirectUri);assert.equal(callback.origin+callback.pathname,redirectUri);assert.equal(callback.searchParams.get('iss'),issuer);assert.equal(page.result.claim,undefined);
 // PKCE S256: a wrong verifier fails without consuming; the right one succeeds once.
 assert.equal((await exchange(p,codeOf(page.result.redirectUri),b64(48))).status,400);
 const token=await exchange(p,codeOf(page.result.redirectUri),verifier);assert.equal(token.status,200);const json=await token.json();assert.equal(json.subject,p.accounts[0].subject);assert.equal(json.auth_time,undefined);
 assert.equal((await exchange(p,codeOf(page.result.redirectUri),verifier)).status,400);
 // A completed entry cannot be replayed, and the other account cannot decide it any more.
 assert.equal((await select(alex)).status,400);
 const late=await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,approved:[]},pageHeaders(view,{Cookie:sam.cookie,'X-CSRF-Token':sam.csrf}));assert.equal(late.status,400);assert.equal((await late.json()).message,'This sign-in expired. Start again from the application.');
});

test('one decision per entry: a second account deciding during another decision sees an ended entry',async()=>{
 const p=await provider(),{entryId}=await createEntry(p),alex=p.signIn(p.accounts[0]),sam=p.signIn(p.accounts[1]),view=await viewOf(p,entryId);
 const as=session=>pageHeaders(view,{Cookie:session.cookie,'X-CSRF-Token':session.csrf});
 for(const session of [alex,sam])assert.equal((await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce},as(session))).status,200);
 let release;const held=new Promise(r=>release=r),approve=p.authority.approve;p.authority.approve=async(...args)=>{await held;return approve(...args);};
 const first=post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,approved:[]},as(alex));await new Promise(r=>setTimeout(r,20));
 const second=await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,approved:[]},as(sam));assert.equal(second.status,400);assert.equal((await second.json()).message,'This sign-in expired. Start again from the application.');
 release();const done=await first;assert.equal(done.status,200);assert.ok(codeOf((await done.json()).redirectUri));
 // A double submit by the deciding account never releases the hold, even when its retry is refused (review finding 2).
 const twice=await createEntry(p),v3=await viewOf(p,twice.entryId),h3=session=>pageHeaders(v3,{Cookie:session.cookie,'X-CSRF-Token':session.csrf});
 for(const session of [alex,sam])await post(p,`${issuer}/api/oauth/entries/${twice.entryId}/select`,{nonce:v3.entry.nonce},h3(session));
 let late;const slow=new Promise(r=>late=r);p.authority.approve=async(...args)=>{const result=await approve(...args);await slow;return result;};
 const one=post(p,`${issuer}/api/oauth/entries/${twice.entryId}/decision`,{nonce:v3.entry.nonce,approved:[]},h3(alex));await new Promise(r=>setTimeout(r,20));
 p.authority.approve=approve;assert.equal((await post(p,`${issuer}/api/oauth/entries/${twice.entryId}/decision`,{nonce:v3.entry.nonce,approved:[]},h3(alex))).status,400,'the retry finds the request no longer pending');
 assert.equal((await post(p,`${issuer}/api/oauth/entries/${twice.entryId}/decision`,{nonce:v3.entry.nonce,approved:[]},h3(sam))).status,400,'no second code for the entry');
 late();assert.equal((await one).status,200);
 // A typed refusal releases the hold so another chosen account can still decide.
 const again=await createEntry(p),v2=await viewOf(p,again.entryId),h=session=>pageHeaders(v2,{Cookie:session.cookie,'X-CSRF-Token':session.csrf});
 for(const session of [alex,sam])await post(p,`${issuer}/api/oauth/entries/${again.entryId}/select`,{nonce:v2.entry.nonce},h(session));
 p.authority.approve=async()=>{throw Object.assign(new Error('stale'),{code:'stale_consent'});};assert.equal((await post(p,`${issuer}/api/oauth/entries/${again.entryId}/decision`,{nonce:v2.entry.nonce,approved:[]},h(alex))).status,409);
 p.authority.approve=approve;assert.equal((await post(p,`${issuer}/api/oauth/entries/${again.entryId}/decision`,{nonce:v2.entry.nonce,approved:[]},h(sam))).status,200);
});

test('scopes pinned at creation must match the owner shard pin, and denial returns access_denied with state and issuer',async()=>{
 const p=await provider(),alex=p.signIn();await p.shard(p.accounts[0].owner).configure({sessionToken:alex.token,csrfToken:alex.csrf,origin:issuer},{fragment,values:{theme:'dark'}});
 const {entryId,body}=await createEntry(p,{requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}]});
 const approved=await providerPage(p,entryId,alex);const callback=new URL(approved.result.redirectUri);assert.equal(callback.searchParams.has('code'),true);
 const denied=await createEntry(p),page=await providerPage(p,denied.entryId,alex,{decision:'deny'}),url=new URL(page.result.redirectUri);
 assert.equal(url.searchParams.get('error'),'access_denied');assert.equal(url.searchParams.get('state'),denied.body.state);assert.equal(url.searchParams.has('code'),false);
 assert.notEqual(body.state,denied.body.state);
 // A fragment whose bytes changed between entry creation and owner selection fails closed.
 p.entries.pinSchema=async()=>({digest:'substituted-digest'});const changed=await createEntry(p,{requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}]});
 const refused=await providerPage(p,changed.entryId,alex);assert.equal(refused.selected.status,400);assert.equal(refused.selection.error,'schema_changed');
});

test('reauthenticate requires the constrained account and a fresh credential: within maxAge, or verified inside the entry flow',async()=>{
 const p=await provider(),[alex,sam]=p.accounts;
 const reauth=(maxAge=60)=>createEntry(p,{intent:'reauthenticate',subjectConstraint:alex.subject,maxAge});
 const wrong=await reauth(),samPage=await providerPage(p,wrong.entryId,p.signIn(sam));assert.equal(samPage.selected.status,409);assert.equal(samPage.selection.error,'account_mismatch');
 const stale=await reauth(),old=await providerPage(p,stale.entryId,p.signIn(alex,p.clock()-120000));assert.equal(old.selected.status,401);assert.equal(old.selection.error,'reauthentication_required');
 const fresh=await reauth(),session=p.signIn(alex),page=await providerPage(p,fresh.entryId,session);
 const token=await(await exchange(p,codeOf(page.result.redirectUri),fresh.verifier)).json();assert.equal(token.subject,alex.subject);assert.ok(Math.abs(token.auth_time-Math.floor(p.clock()/1000))<=2);
 // maxAge 0: a session from before the entry never satisfies it; a sign-in (or step-up) after the entry was created does,
 // even when the user takes longer than maxAge to finish.
 const zero=await reauth(0),before=p.signIn(alex,p.clock()-1000);assert.equal((await providerPage(p,zero.entryId,before)).selection.error,'reauthentication_required');
 p.time.advance(5000);const after=p.signIn(alex);p.time.advance(3000);const done=await providerPage(p,zero.entryId,after);assert.equal(done.decided.status,200,JSON.stringify(done.result));
 const zeroToken=await(await exchange(p,codeOf(done.result.redirectUri),zero.verifier)).json();assert.equal(zeroToken.auth_time,Math.floor((p.clock()-3000)/1000));
});

test('end-session confirms on the provider page through the adapter hook, returns completed or canceled once, and is advertised only with a hook',async()=>{
 const p=await provider({endSession:true}),alex=p.signIn();assert.deepEqual(p.entries.intents(),['login','select-account','reauthenticate','end-session']);
 const finish=async(confirmed,session=alex,extra={})=>{const {entryId,body}=await createEntry(p,{intent:'end-session',subjectConstraint:p.accounts[0].subject});const view=await viewOf(p,entryId);const response=await post(p,`${issuer}/api/oauth/entries/${entryId}/end-session`,{nonce:view.entry.nonce,confirmed},pageHeaders(view,{...session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{},...extra}));return {entryId,body,view,response,json:await response.json()};};
 const done=await finish(true),url=new URL(done.json.redirectUri);assert.equal(url.searchParams.get('result'),'completed');assert.equal(url.searchParams.get('state'),done.body.state);assert.equal(url.searchParams.has('code'),false);assert.equal(p.ended.length,1);assert.equal(p.ended[0].subject,p.accounts[0].subject);
 assert.equal((await post(p,`${issuer}/api/oauth/entries/${done.entryId}/end-session`,{nonce:done.view.entry.nonce,confirmed:true},pageHeaders(done.view,{'X-CSRF-Token':alex.csrf}))).status,400);
 assert.equal(new URL((await finish(false,null)).json.redirectUri).searchParams.get('result'),'canceled');assert.equal(p.ended.length,1,'staying signed in calls no hook');
 // Without the page token nothing ends; the hook's refusal (for example a wrong member CSRF) completes nothing.
 assert.equal((await finish(true,alex,{'X-Bindle-Entry-Token':b64(32)})).response.status,403);assert.equal(p.ended.length,1);
 const refusing=await provider({endSession:async()=>{throw Object.assign(new Error('csrf'),{code:'csrf'});}}),r=await createEntry(refusing,{intent:'end-session',subjectConstraint:refusing.accounts[0].subject}),rv=await viewOf(refusing,r.entryId);
 assert.equal((await post(refusing,`${issuer}/api/oauth/entries/${r.entryId}/end-session`,{nonce:rv.entry.nonce,confirmed:true},pageHeaders(rv))).status,403);assert.equal((await viewOf(refusing,r.entryId)).entry.intent,'end-session','the entry is still open for a retry');
 // Set-Cookie values from the hook reach the browser.
 const clearing=await provider({endSession:async()=>['bindle_account_x=; Max-Age=0','bindle_default=; Max-Age=0']}),c=await createEntry(clearing,{intent:'end-session',subjectConstraint:clearing.accounts[0].subject}),cv=await viewOf(clearing,c.entryId);
 assert.deepEqual((await post(clearing,`${issuer}/api/oauth/entries/${c.entryId}/end-session`,{nonce:cv.entry.nonce,confirmed:true},pageHeaders(cv))).headers.getSetCookie(),['bindle_account_x=; Max-Age=0','bindle_default=; Max-Age=0']);
 const select=await createEntry(p,{intent:'end-session',subjectConstraint:p.accounts[0].subject});assert.equal((await providerPage(p,select.entryId,alex)).selected.status,400);
 // Without a hook the store neither offers nor accepts the intent.
 const bare=await provider();assert.equal((await createEntry(bare,{intent:'end-session',subjectConstraint:bare.accounts[0].subject})).response.status,400);
});

test('the entry document is static, never redirects, and keeps its opener only for embed popups',async()=>{
 const p=await provider(),app=await createEntry(p),embed=await createEntry(p,{delivery:'embed-popup',embedJkt:b64(32)},{Origin:embedOrigin});
 const page=async(query)=>p.fetch(`${issuer}/oauth/authorize?${query}`);
 const plain=await page(`entry=${app.entryId}`);assert.equal(plain.status,200);assert.equal(plain.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.equal(plain.headers.get('Referrer-Policy'),'no-referrer');assert.match(plain.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
 assert.equal((await page(`entry=${embed.entryId}`)).headers.get('Cross-Origin-Opener-Policy'),'unsafe-none');
 assert.equal((await page(`entry=${embed.entryId}&mode=plain`)).headers.get('Cross-Origin-Opener-Policy'),'same-origin');
 assert.equal((await page(`entry=${b64(32)}`)).headers.get('Cross-Origin-Opener-Policy'),'same-origin');
 assert.equal((await page(`entry=${app.entryId}&extra=1`)).status,400);
});

test('manifest advertises entry, intents, revocation, embed profile and DPoP algorithms only when configured',async()=>{
 const p=await provider(),manifest=await(await p.fetch(`${issuer}/.well-known/bindle/manifest.json`)).json();
 // Core feature and components-profile shapes (protocol §2, components-profile §3.3); no flat draft members remain.
 assert.deepEqual(manifest.features['authorization-entry.v1'],{endpoint:`${issuer}/api/oauth/entries`,intents:['login','select-account','reauthenticate']});assert.equal(manifest.revocation_endpoint,`${issuer}/oauth/revoke`);assert.deepEqual(manifest.dpop_signing_alg_values_supported,['ES256']);assert.equal(manifest.fedcm_config_url,undefined);
 assert.deepEqual(manifest.profiles,{'https://3sln.me/artefacts/profiles/components/v1':{embed_origin:embedOrigin,protocol:[1],parts:{avatar:{versions:[1]},'account-switcher':{versions:[1]},'sign-in':{versions:[1]}},credential_binding:['key-binding.v1']}});
 for(const flat of ['authorization_entry_endpoint','authorization_entry_intents','embed_profiles_supported','embed_origin'])assert.equal(manifest[flat],undefined);
 // The authority alone never advertises entry routes: only an adapter that mounts them adds the feature (F8).
 assert.equal((await p.authority.manifest()).features,undefined);assert.equal(p.entries.manifest().profiles,undefined);
 const bare=await provider({entryConfig:false}),plain=await(await bare.fetch(`${issuer}/.well-known/bindle/manifest.json`)).json();
 assert.equal(plain.features,undefined);assert.equal(plain.profiles,undefined);assert.equal(plain.revocation_endpoint,`${issuer}/oauth/revoke`);
 assert.equal(clientId,'https://app.example/client');assert.equal(pkce('x'.repeat(43)).length,43);
});

test('the entry view carries the embed origin for embed entries only',async()=>{
 const p=await provider(),embed=await createEntry(p,{delivery:'embed-popup',embedJkt:b64(32)},{Origin:embedOrigin}),plain=await createEntry(p);
 assert.deepEqual((await viewOf(p,embed.entryId)).entry.embed,{attested:false,plain:false,origin:embedOrigin});assert.equal((await viewOf(p,plain.entryId)).entry.embed,undefined);
});

// ---- S1: nothing a client can observe depends on the selection state until consent completes ------------------
test('S1: every client-reachable entry endpoint answers identically, with the same work, whatever was chosen',async()=>{
 // A fresh provider per selection state keeps each account under its outstanding-request bound.
 const world=async()=>{
 const base=new MemoryFederationStore(),counts={tx:0},store={transaction:op=>{counts.tx++;return base.transaction(op);}};
 const p=await provider({handles:['alex','sam','mallory'],store}),[alex,sam,mallory]=p.accounts;
 for(const method of ['entryIdentity','beginEntryAuthorization','approve']){const original=p.authority[method];p.authority[method]=(...args)=>{counts[method]=(counts[method]??0)+1;return original(...args);};}
 const user={alex:p.signIn(alex),sam:p.signIn(sam)},app=p.signIn(mallory),forged={cookie:`__Host-bindle_session=${alex.owner}.${b64(32)}`,csrf:user.alex.csrf};
 // The user's possible states before consent completes.
 const state='S'.repeat(32);let n=0;async function prepare(choices,embedded){const {entryId}=await createEntry(p,{state,...embedded?{delivery:'embed-popup',embedJkt:b64(32)}:{}},{Origin:embedded?embedOrigin:appOrigin,'X-Test-Remote':`caller-${n++}`});const view=await viewOf(p,entryId);
  // An embed entry opened in plain mode: the plain page declares it as it loads, before any choice.
  if(embedded)assert.equal((await post(p,`${issuer}/api/oauth/entries/${entryId}/plain`,{},pageHeaders(view))).status,200);
  for(const choice of choices){if(choice==='inspect'){const rows=(await p.entries.store.transaction(tx=>tx.list('selection/'))).map(r=>r.value).filter(r=>r.owner===alex.owner);assert.equal((await p.fetch(`${issuer}/api/oauth/requests/${rows.at(-1).requestId}`,{headers:{Origin:issuer,Cookie:user.alex.cookie}})).status,200);continue;}
   const response=await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...embedded?{plain:true}:{}},pageHeaders(view,{Cookie:user[choice].cookie,'X-CSRF-Token':user[choice].csrf}));assert.equal(response.status,200);}
  return {entryId,view,extra:embedded?{plain:true}:{}};}
 // What an app backend can send: it knows the entry ID, can forge the view's headers, holds its own account and can
 // forge cookie prefixes, but never has the user's cookies.
 const as=(view,session)=>pageHeaders(view,session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{});
 const probes={
  document:({entryId})=>p.fetch(`${issuer}/oauth/authorize?entry=${entryId}`),
  view:({entryId})=>p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}}),
  'select anonymous':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...extra},as(view)),
  'select forged prefix':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...extra},as(view,forged)),
  'select own account':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...extra},as(view,app)),
  'approve anonymous':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,approved:[]},as(view)),
  'approve forged prefix':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,approved:[]},as(view,forged)),
  'approve own account unchosen':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,approved:[]},as(view,app)),
  'approve own account chosen':async({entryId,view,extra})=>{await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...extra},as(view,app));return post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,approved:[],...extra},as(view,app));},
  'cancel anonymous':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,denied:true},as(view)),
  'cancel forged prefix':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,denied:true},as(view,forged)),
  'cancel own account':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,denied:true},as(view,app)),
  'cancel then view':async({entryId,view,extra})=>{await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,denied:true,...extra},as(view));return p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}});},
  'embed challenge':({entryId,view})=>post(p,`${issuer}/oauth/entries/${entryId}/embed-challenge`,{},as(view)),
  'embed verify':({entryId,view})=>post(p,`${issuer}/oauth/entries/${entryId}/embed-verify`,{proof:'a.b.c'},as(view)),
  'end-session':({entryId,view})=>post(p,`${issuer}/api/oauth/entries/${entryId}/end-session`,{nonce:view.entry.nonce,confirmed:false},as(view)),
  'select without page token':({entryId,view,extra})=>post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...extra},{Origin:issuer,'Sec-Fetch-Site':'same-origin',Cookie:app.cookie,'X-CSRF-Token':app.csrf}),
 };
 return {p,counts,prepare,probes};};
 // The user's possible states before consent completes.
 const states={none:[],alex:['alex'],'alex+sam':['alex','sam'],'alex, reviewing':['alex','inspect']};
 for(const embedded of [false,true]){const observed={};
 // Values that are random per entry or per request are masked; everything else must match byte for byte.
 const mask=text=>text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}/g,'<locator>').replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,'<random>').replace(/"nonce":"[A-Za-z0-9_-]{22}"/g,'"nonce":"<nonce>"').replace(/"expiresAt":\d+/g,'"expiresAt":0');
 for(const [label,choices] of Object.entries(states)){const {counts,prepare,probes}=await world();for(const [name,probe] of Object.entries(probes)){
  let entry,response;try{entry=await prepare(choices,embedded);for(const key of Object.keys(counts))counts[key]=0;
  response=await probe(entry);}catch(error){throw new Error(`${label} / ${name}: ${error.message}`);}const work=JSON.stringify(Object.fromEntries(Object.entries(counts).filter(([,count])=>count).sort()));
  observed[name]??={};observed[name][label]={status:response.status,headers:mask(JSON.stringify([...response.headers].filter(([k])=>k!=='date'))),body:mask(await response.text()),work};
 }}
 for(const [name,byState] of Object.entries(observed)){const [first,...rest]=Object.values(byState);for(const [label,value] of Object.entries(byState))assert.deepEqual(value,first,`${embedded?'embed plain ':''}${name}: state "${label}" differs from "none"`);void rest;}
 // Sanity: the probes reach real outcomes, not one blanket error.
 assert.equal(observed['cancel anonymous'].none.status,200);assert.match(observed['cancel anonymous'].none.body,/error=access_denied/);
 assert.equal(observed['select own account'].none.status,200);assert.equal(observed['approve own account chosen'].none.status,200);
 assert.equal(observed['select forged prefix'].none.status,401);assert.equal(observed['approve anonymous'].none.status,401);assert.equal(observed['select without page token'].none.status,403);
 }
});

// ---- Already approved: one click for returning apps -------------------------------------------------------------
test('already approved: select returns the selections that resubmit access this account already granted this client',async()=>{
 const p=await provider(),alex=p.signIn(),requests=[{fragment,required:true,purpose:'Theme',fields:['theme']}];
 await p.shard(p.accounts[0].owner).configure({sessionToken:alex.token,csrfToken:alex.csrf,origin:issuer},{fragment,values:{theme:'dark'}});
 const first=await createEntry(p,{requests}),page=await providerPage(p,first.entryId,alex);assert.equal(page.selection.approved,undefined,'nothing granted yet');assert.ok(codeOf(page.result.redirectUri));
 const second=await createEntry(p,{requests}),view=await viewOf(p,second.entryId),headers=pageHeaders(view,{Cookie:alex.cookie,'X-CSRF-Token':alex.csrf});
 const selected=await(await post(p,`${issuer}/api/oauth/entries/${second.entryId}/select`,{nonce:view.entry.nonce},headers)).json();
 assert.equal(selected.approved.length,1);assert.equal(selected.approved[0].fragment,fragment);assert.deepEqual(selected.approved[0].fields,['theme']);
 // The page inspects (reviewing the connection) and resubmits on the same click.
 await p.fetch(`${issuer}/api/oauth/requests/${selected.requestId}`,{headers:{Origin:issuer,Cookie:alex.cookie}});
 const decided=await post(p,`${issuer}/api/oauth/entries/${second.entryId}/decision`,{nonce:view.entry.nonce,approved:selected.approved},headers);assert.equal(decided.status,200);
 const token=await(await exchange(p,codeOf((await decided.json()).redirectUri),second.verifier)).json();assert.equal(token.granted_fragments[0].fragment,fragment);
 // Another account has no grant; asking for more fields than were granted is not "already approved".
 const sam=p.signIn(p.accounts[1]);await p.shard(p.accounts[1].owner).configure({sessionToken:sam.token,csrfToken:sam.csrf,origin:issuer},{fragment,values:{theme:'light'}});
 const third=await createEntry(p,{requests}),v3=await viewOf(p,third.entryId);assert.equal((await(await post(p,`${issuer}/api/oauth/entries/${third.entryId}/select`,{nonce:v3.entry.nonce},pageHeaders(v3,{Cookie:sam.cookie,'X-CSRF-Token':sam.csrf}))).json()).approved,undefined);
 // Changed preferences make the stored revision stale: approve refuses, so the page falls back to the review.
 await p.shard(p.accounts[0].owner).configure({sessionToken:alex.token,csrfToken:alex.csrf,origin:issuer},{fragment,values:{theme:'light'}});
 const fourth=await createEntry(p,{requests}),v4=await viewOf(p,fourth.entryId),h4=pageHeaders(v4,{Cookie:alex.cookie,'X-CSRF-Token':alex.csrf}),s4=await(await post(p,`${issuer}/api/oauth/entries/${fourth.entryId}/select`,{nonce:v4.entry.nonce},h4)).json();
 assert.ok(s4.approved,'the grant still covers the fragment');await p.fetch(`${issuer}/api/oauth/requests/${s4.requestId}`,{headers:{Origin:issuer,Cookie:alex.cookie}});
 assert.equal((await post(p,`${issuer}/api/oauth/entries/${fourth.entryId}/decision`,{nonce:v4.entry.nonce,approved:[{...s4.approved[0],revision:'stale'}]},h4)).status,409);
});

test('already approved never covers a resource reconnected (new generation) or rescoped since the grant (review finding 4)',async()=>{
 const p=await provider(),owner=p.accounts[0].owner,subject=p.accounts[0].subject,service=p.shard(owner).service,contract='https://contract.example/storage/v1',id=`${subject}/resources/r1`;
 const request={fragment,required:true,purpose:'Files',fields:['folder'],methods:{folder:{[contract]:['get']}},digest:'d1',schema:{fields:{folder:{title:'Folder',type:'resource',contracts:[contract]}}}};
 const rows=generation=>({[`federation/preferences/${subject}|${fragment}`]:{digest:'d1',revision:'r1',values:{folder:{resource:id,scope:{readOnly:true}}}},[`federation/resource/${id}`]:{id,owner:subject,generation,contracts:{[contract]:['get']}}});
 const grant={id:'g',active:true,subject,clientId,fragment,digest:'d1',epoch:'epoch-1',fields:['folder'],resources:{folder:[id]},methods:{folder:{[contract]:['get']}},resourceGenerations:{[id]:'1'},resourceScopes:{folder:{[id]:{readOnly:true}}}};
 const tx=(data,g=grant)=>({get:async key=>structuredClone(data[key]),list:async prefix=>prefix==='federation/grant/'?[{key:'federation/grant/g',value:structuredClone(g)}]:[]});
 service.connections=undefined;
 assert.deepEqual((await service.priorApproval(tx(rows('1')),subject,'epoch-1',clientId,[request]))[0].resources,{folder:[id]});
 assert.equal(await service.priorApproval(tx(rows('2')),subject,'epoch-1',clientId,[request]),null,'reconnected resource');
 assert.equal(await service.priorApproval(tx(rows('1'),{...grant,resourceScopes:{folder:{[id]:{}}}}),subject,'epoch-1',clientId,[request]),null,'scope changed since the grant');
 assert.equal(await service.priorApproval(tx(rows('1')),subject,'epoch-2',clientId,[request]),null,'another account epoch');
});

test('reauthentication freshness counts credential sign-ins and step-ups, never device-approval sessions alone (review finding 6)',async()=>{
 const {sessionAuthTime}=await import('../packages/runtime/federation.mjs');
 assert.equal(sessionAuthTime({createdAt:10,source:'credential'}),10);assert.equal(sessionAuthTime({createdAt:10}),10);assert.equal(sessionAuthTime({createdAt:10,stepUpAt:20}),20);
 assert.equal(sessionAuthTime({createdAt:10,source:'device-approval'}),undefined);assert.equal(sessionAuthTime({createdAt:10,source:'device-approval',stepUpAt:30}),30);
});

// ---- M5: sharded storage keeps every retry on the same records --------------------------------------------------
test('M5: a sharded store keeps each entry, its selections and decision on the shard named by its ID',async()=>{
 const shards=new Map(),store=shard=>{assert.match(shard,/^\d{2}$/);if(!shards.has(shard))shards.set(shard,new MemoryFederationStore());return shards.get(shard);};
 const p=await provider({store}),alex=p.signIn();
 const ids=[];for(let n=0;n<6;n++)ids.push((await createEntry(p,{},{Origin:appOrigin,'X-Test-Remote':'r'+n})).entryId);
 for(const id of ids){const rows=await store(entryShard(id)).transaction(tx=>tx.list('entry/'));assert.ok(rows.length>=1);}
 const remote=await remoteShard(webcrypto,'r0');assert.ok((await store(remote).transaction(tx=>tx.list('budget/remote/'))).length,'creation budgets live on the caller shard');
 p.failures.beginEntry=1;const view=await viewOf(p,ids[0]),headers=pageHeaders(view,{Cookie:alex.cookie,'X-CSRF-Token':alex.csrf});
 assert.equal((await post(p,`${issuer}/api/oauth/entries/${ids[0]}/select`,{nonce:view.entry.nonce},headers)).status,503);
 const page=await providerPage(p,ids[0],alex);assert.ok(codeOf(page.result.redirectUri),'the retry resumed the durable selection on the same shard');
 const shard=store(entryShard(ids[0]));assert.equal((await shard.transaction(tx=>tx.list('selection/'))).length,1);
 await assert.rejects(p.entries.cleanup(),TypeError);p.time.advance(1300000);assert.ok((await p.entries.cleanup({shard:entryShard(ids[0])})).removed>=2);
});

test('M5: the Worker facade routes creation to a random shard and every later call to the entry shard',async()=>{
 const p=await provider(),hosts=new Map(),calls=[];
 const host=shard=>{if(!hosts.has(shard))hosts.set(shard,new AuthorizationEntries({store:new MemoryFederationStore(),shard,issuer,clients:[...p.entries.clients.values()],authority:p.authority,embedOrigin,crypto:webcrypto,clock:p.clock,dpop:true}));return hosts.get(shard);};
 const facade=federationEntriesRemote({config:p.config,invoke:async(shard,method,args)=>{calls.push([shard,method]);try{return {ok:true,result:await host(shard)[method](...structuredClone(args))};}catch(error){return {ok:false,error:{code:error.code,message:error.message}};}}});
 assert.deepEqual(facade.intents(),['login','select-account','reauthenticate']);assert.ok(federationEntriesRemote({config:p.config,endSession:true,invoke:()=>{}}).intents().includes('end-session'));
 const {body}=entryBody(),{entryId}=await facade.create(body,{origin:appOrigin,remote:'caller'});const shard=entryShard(entryId);
 assert.deepEqual(calls.map(c=>c[1]),['admit','create']);assert.equal(calls[0][0],await remoteShard(webcrypto,'caller'));assert.equal(calls[1][0],shard,'the host mints IDs on its own shard');
 const view=await facade.view(entryId),alex=p.signIn(),context={sessionToken:alex.token,csrfToken:alex.csrf,origin:issuer},page={token:view.pageToken};
 p.failures.beginEntry=1;await assert.rejects(facade.select(entryId,context,{nonce:view.entry.nonce},page),{code:'temporarily_unavailable'});
 const {requestId}=await facade.select(entryId,context,{nonce:view.entry.nonce},page),again=await facade.select(entryId,context,{nonce:view.entry.nonce},page);assert.equal(again.requestId,requestId);
 await p.fetch(`${issuer}/api/oauth/requests/${requestId}`,{headers:{Origin:issuer,Cookie:alex.cookie}});
 assert.ok(codeOf((await facade.decide(entryId,context,{nonce:view.entry.nonce,approved:[]},page)).redirectUri));
 assert.ok(calls.slice(2).every(([s])=>s===shard),'every entry call reached the entry shard');
 // A host refuses IDs of another shard, and unknown IDs never need the store for the document policy.
 const foreign=entryId[0]==='A'?'B'+entryId.slice(1):'A'+entryId.slice(1);await assert.rejects(host(shard).view(foreign),{code:'invalid_request'});
 assert.equal(await facade.documentPolicy('short'),'same-origin');assert.equal(ENTRY_SHARDS,64);
});
