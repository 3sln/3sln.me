import test from 'node:test';
import assert from 'node:assert/strict';
import {provider,post,createEntry,entryBody,providerPage,exchange,codeOf,issuer,appOrigin,embedOrigin,clientId,redirectUri,fragment,b64,pkce} from './authorization-entry-helpers.mjs';

test('entry creation pins client, exact callback, PKCE, state, scopes, intent, nonce and expiry without storing the entry ID',async()=>{
 const p=await provider(),{response,entryId,body}=await createEntry(p,{requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}],loginHint:'alex@provider.example',uiLocales:['es'],colorScheme:'dark'});
 assert.equal(response.status,201);assert.match(entryId,/^[A-Za-z0-9_-]{43}$/);assert.equal(response.headers.get('Access-Control-Allow-Origin'),appOrigin);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const stored=JSON.stringify(await p.entries.store.transaction(tx=>tx.list('')));assert.equal(stored.includes(entryId),false);
 const [record]=(await p.entries.store.transaction(tx=>tx.list('entry/'))).map(r=>r.value);
 assert.deepEqual({clientId:record.clientId,redirectUri:record.redirectUri,challenge:record.challenge,state:record.state,intent:record.intent,requests:record.requests},{clientId,redirectUri,challenge:body.challenge,state:body.state,intent:'login',requests:body.requests});
 assert.match(record.nonce,/^[A-Za-z0-9_-]{22}$/);assert.equal(record.expiresAt-record.createdAt,600000);
 const view=await(await p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}})).json();
 assert.equal(view.entry.client.name,'Example app');assert.equal(view.entry.loginHint,'alex@provider.example');assert.equal(view.entry.nonce,record.nonce);assert.equal(JSON.stringify(view).includes(body.challenge),false);assert.equal(view.entry.state,undefined);
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
 const view=await p.entries.view(entryId),select=(session,headers={})=>post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce},{Origin:issuer,Cookie:session.cookie,'X-CSRF-Token':session.csrf,...headers});
 // Forged owner prefixes, missing CSRF and a wrong nonce record nothing.
 assert.equal((await select({cookie:`__Host-bindle_session=${p.accounts[1].owner}.forged`,csrf:'x'})).status,401);
 assert.equal((await select(alex,{'X-CSRF-Token':''})).status,403);
 assert.equal((await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:'wrong'},{Origin:issuer,Cookie:alex.cookie,'X-CSRF-Token':alex.csrf})).status,400);
 // The owner shard fails after the entry recorded the choice: the retry resumes that request ID.
 p.failures.beginEntry=1;assert.equal((await select(alex)).status,503);
 const [record]=(await p.entries.store.transaction(tx=>tx.list('entry/'))).map(r=>r.value);assert.equal(record.selection.owner,p.accounts[0].owner);assert.match(record.selection.requestId,new RegExp(`^${p.accounts[0].owner}\\.`));
 const first=await(await select(alex)).json(),second=await(await select(alex)).json();assert.equal(first.requestId,record.selection.requestId);assert.equal(second.requestId,first.requestId);
 assert.equal((await select(sam)).status,409);
 // A direct decision on the entry-bound owner request is refused; only the entry route decides.
 const direct=await post(p,`${issuer}/api/oauth/requests/${first.requestId}/decision`,{requestId:first.requestId,approved:[]},{Origin:issuer,Cookie:alex.cookie,'X-CSRF-Token':alex.csrf});assert.equal(direct.status,400);
 const page=await providerPage(p,entryId,alex);assert.equal(page.selection.requestId,first.requestId);
 const callback=new URL(page.result.redirectUri);assert.equal(callback.origin+callback.pathname,redirectUri);assert.equal(callback.searchParams.get('iss'),issuer);assert.equal(page.result.claim,undefined);
 // PKCE S256: a wrong verifier fails without consuming; the right one succeeds once.
 assert.equal((await exchange(p,codeOf(page.result.redirectUri),b64(48))).status,400);
 const token=await exchange(p,codeOf(page.result.redirectUri),verifier);assert.equal(token.status,200);const json=await token.json();assert.equal(json.subject,p.accounts[0].subject);assert.equal(json.auth_time,undefined);
 assert.equal((await exchange(p,codeOf(page.result.redirectUri),verifier)).status,400);
 // A completed entry cannot be replayed.
 assert.equal((await select(alex)).status,400);
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

test('reauthenticate requires the constrained account and a session within maxAge, then returns auth_time',async()=>{
 const p=await provider(),[alex,sam]=p.accounts;
 const reauth=()=>createEntry(p,{intent:'reauthenticate',subjectConstraint:alex.subject,maxAge:60});
 const wrong=await reauth(),samPage=await providerPage(p,wrong.entryId,p.signIn(sam));assert.equal(samPage.selected.status,409);assert.equal(samPage.selection.error,'account_mismatch');
 const stale=await reauth(),old=await providerPage(p,stale.entryId,p.signIn(alex,p.clock()-120000));assert.equal(old.selected.status,401);assert.equal(old.selection.error,'reauthentication_required');
 const fresh=await reauth(),session=p.signIn(alex),page=await providerPage(p,fresh.entryId,session);
 const token=await(await exchange(p,codeOf(page.result.redirectUri),fresh.verifier)).json();assert.equal(token.subject,alex.subject);assert.ok(Math.abs(token.auth_time-Math.floor(p.clock()/1000))<=2);
});

test('end-session confirms on the provider page, returns completed or canceled once, and is advertised only with a hook',async()=>{
 const p=await provider({endSession:true}),alex=p.signIn();assert.deepEqual(p.entries.intents(),['login','select-account','reauthenticate','end-session']);
 const finish=async(confirmed,session=alex)=>{const {entryId,body}=await createEntry(p,{intent:'end-session',subjectConstraint:p.accounts[0].subject});const view=await p.entries.view(entryId);const response=await post(p,`${issuer}/api/oauth/entries/${entryId}/end-session`,{nonce:view.entry.nonce,confirmed},{Origin:issuer,'X-CSRF-Token':session?.csrf??'none',...session?{Cookie:session.cookie}:{}});return {entryId,body,view,response,json:await response.json()};};
 const done=await finish(true),url=new URL(done.json.redirectUri);assert.equal(url.searchParams.get('result'),'completed');assert.equal(url.searchParams.get('state'),done.body.state);assert.equal(url.searchParams.has('code'),false);assert.equal(p.ended.length,1);assert.equal(p.ended[0].subject,p.accounts[0].subject);
 assert.equal((await post(p,`${issuer}/api/oauth/entries/${done.entryId}/end-session`,{nonce:done.view.entry.nonce,confirmed:true},{Origin:issuer,'X-CSRF-Token':alex.csrf})).status,400);
 assert.equal(new URL((await finish(false)).json.redirectUri).searchParams.get('result'),'canceled');
 // Without any provider session the result is still completed.
 assert.equal(new URL((await finish(true,null)).json.redirectUri).searchParams.get('result'),'completed');
 const select=await createEntry(p,{intent:'end-session',subjectConstraint:p.accounts[0].subject});assert.equal((await providerPage(p,select.entryId,alex)).selected.status,400);
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
