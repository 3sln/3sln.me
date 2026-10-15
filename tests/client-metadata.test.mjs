// client-id-metadata.v1: URL client IDs resolved from OAuth client ID metadata documents through a fake SSRF-safe
// egress port, plus the provider runtime (manifest, entries, redirect flow, tokens, CORS, blocks) and admin blocking.
// Fixtures use reserved .example hosts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientDirectory,metadataClientURL,validateClientMetadata,validClientSnapshot,memoryLimiter,CLIENT_METADATA_FEATURE} from '../packages/federation/client-metadata.mjs';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {federationAuthority,federationClients,federationClientDirectory,federationEntriesRemote} from '../packages/runtime/federation.mjs';
import {webcrypto} from 'node:crypto';
import {AuthorizationEntries} from '../packages/federation/authorization-entries.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {AdminStorage} from '../packages/identity/admin-store.mjs';
import {AdminService,adminClientBlocked} from '../packages/identity/admin.mjs';
import {adminRoutes} from '../packages/runtime/admin-http.mjs';

import {issuer,appOrigin,clientId,redirectUri,reviewedId,reviewedOrigin,metadata,b64,pkce,body,fakeEgress,cimdProvider} from './client-metadata-helpers.mjs';
const directory=(documents,options={})=>{const egress=fakeEgress(documents);let now=1_800_000_000_000;const clock=()=>now;
 const value=new ClientDirectory({clients:options.clients??[],enabled:true,fetch:egress.fetch,clock,limiter:options.limiter??memoryLimiter({clock}),blocked:options.blocked,limits:options.limits});
 return {directory:value,egress,advance:ms=>{now+=ms;}};};
const rejects=(promise,code='invalid_client')=>assert.rejects(promise,error=>error.code===code);

test('client ID syntax: canonical HTTPS URL with a path; no query, fragment, userinfo, port, dot segments, IPs or special hosts',()=>{
 assert.ok(metadataClientURL(clientId));
 for(const bad of ['http://app.example/c','https://app.example/','https://app.example','https://app.example/c?x=1','https://app.example/c#f','https://u:p@app.example/c','https://app.example:443/c','https://app.example:8443/c',
  'https://app.example/a/../c','https://app.example/%2e%2e/c','https://app.example/a%2fb','https://127.0.0.1/c','https://[::1]/c','https://localhost/c','https://app.local/c','https://svc.internal/c','https://APP.example/c','https://app.example/'+'x'.repeat(200),'not a url',42,null])
  assert.equal(metadataClientURL(bad),null,String(bad));
});

test('document validation is exact: client_id equality, same-origin exact redirect URIs, public auth only; presentation is optional text',()=>{
 const client=validateClientMetadata(metadata({client_uri:'https://app.example/',logo_uri:'https://app.example/logo.png'}),clientId);
 assert.deepEqual(client,{id:clientId,name:'app.example',origin:appOrigin,redirectUris:[redirectUri],reviewed:false,claimedName:'Example App',clientUri:'https://app.example/',logoUri:'https://app.example/logo.png'});
 assert.ok(validClientSnapshot(client));assert.equal(validClientSnapshot({...client,name:'Example App'}),false);assert.equal(validClientSnapshot({...client,reviewed:true}),false);
 const invalid=[
  metadata({client_id:'https://app.example/other.json'}),metadata({client_id:clientId+' '}),metadata({redirect_uris:['https://evil.example/callback']}),metadata({redirect_uris:['https://sub.app.example/callback']}),
  metadata({redirect_uris:['http://app.example/callback']}),metadata({redirect_uris:['https://app.example/callback#x']}),metadata({redirect_uris:[]}),metadata({redirect_uris:'https://app.example/callback'}),metadata({redirect_uris:[redirectUri,redirectUri]}),
  metadata({token_endpoint_auth_method:'client_secret_basic'}),metadata({token_endpoint_auth_method:'private_key_jwt'}),metadata({client_secret:'s'}),metadata({client_secret_expires_at:0}),metadata({jwks:{keys:[]}}),metadata({jwks_uri:'https://app.example/jwks'}),
  metadata({grant_types:['client_credentials']}),metadata({grant_types:['refresh_token']}),metadata({response_types:['token']}),[],'x',null];
 for(const document of invalid)assert.throws(()=>validateClientMetadata(document,clientId),{code:'invalid_client'},JSON.stringify(document));
 // Hostile presentation is dropped, never rendered: bidi overrides, control characters, oversize names, foreign URIs.
 for(const name of ['Bank‮ppa','Line\nbreak','x'.repeat(101),' padded',{toString:()=>'x'}])assert.equal(validateClientMetadata(metadata({client_name:name}),clientId).claimedName,undefined);
 const foreign=validateClientMetadata(metadata({client_uri:'https://bank.example/',logo_uri:'https://tracker.example/pixel.gif'}),clientId);assert.equal(foreign.clientUri,undefined);assert.equal(foreign.logoUri,undefined);
});

test('resolution: one bounded GET, cached under the exact ID; static registrations win and are never fetched',async()=>{
 const reviewed={id:clientId,name:'Reviewed App',origin:appOrigin,redirectUris:[redirectUri]};
 const {directory:pinned,egress:none}=directory({[clientId]:metadata({client_name:'Spoof'})},{clients:[reviewed]});
 assert.deepEqual(await pinned.resolve(clientId),reviewed);assert.equal(none.calls.length,0);assert.equal(pinned.isMetadataId(clientId),false);
 const {directory:d,egress,advance}=directory({[clientId]:()=>new Response(body(metadata()),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'max-age=999999999'}})});
 const client=await d.resolve(clientId);assert.equal(client.reviewed,false);assert.equal(client.name,'app.example');assert.equal(egress.calls.length,1);
 const [{init}]=egress.calls;assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.ok(init.signal instanceof AbortSignal);
 client.redirectUris.push('https://evil.example/');assert.deepEqual((await d.resolve(clientId)).redirectUris,[redirectUri],'callers get copies');assert.equal(egress.calls.length,1);
 // max-age is clamped to 24 hours.
 advance(86_400_000+1);await d.resolve(clientId);assert.equal(egress.calls.length,2);
 // Concurrent resolutions share one request.
 const {directory:shared,egress:once}=directory({[clientId]:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return new Response(body(metadata()),{status:200,headers:{'Content-Type':'application/json'}});}});
 await Promise.all([shared.resolve(clientId),shared.resolve(clientId),shared.resolve(clientId)]);assert.equal(once.calls.length,1);
});

test('hostile responses: redirects, wrong types, oversize, slow, malformed and mismatched documents are refused and briefly negatively cached',async()=>{
 const cases={
  redirect:()=>new Response(null,{status:302,headers:{Location:'http://169.254.169.254/latest/meta-data'}}),
  redirect307:()=>new Response(body(metadata()),{status:307,headers:{Location:'https://app.example/x','Content-Type':'application/json'}}),
  notFound:()=>new Response('no',{status:404}),
  html:()=>new Response('<html>',{status:200,headers:{'Content-Type':'text/html'}}),
  jsonish:()=>new Response(body(metadata()),{status:200,headers:{'Content-Type':'application/jrd+json'}}),
  declaredLarge:()=>new Response(body(metadata()),{status:200,headers:{'Content-Type':'application/json','Content-Length':'16385'}}),
  streamedLarge:()=>new Response(new ReadableStream({start(c){for(let i=0;i<40;i++)c.enqueue(new Uint8Array(1024).fill(32));c.close();}}),{status:200,headers:{'Content-Type':'application/json'}}),
  compressed:()=>new Response(body(metadata()),{status:200,headers:{'Content-Type':'application/json','Content-Encoding':'gzip'}}),
  malformed:()=>new Response('{"client_id":',{status:200,headers:{'Content-Type':'application/json'}}),
  badUtf8:()=>new Response(new Uint8Array([0x7b,0xff,0x7d]),{status:200,headers:{'Content-Type':'application/json'}}),
  mismatched:()=>new Response(body(metadata({client_id:'https://app.example/other.json'})),{status:200,headers:{'Content-Type':'application/json'}}),
  throws:()=>{throw new Error('connect ECONNREFUSED');},
 };
 for(const [name,respond] of Object.entries(cases)){
  const {directory:d,egress,advance}=directory({[clientId]:respond});
  await rejects(d.resolve(clientId));await rejects(d.resolve(clientId));assert.equal(egress.calls.length,1,`${name}: negatively cached`);
  advance(60_001);await rejects(d.resolve(clientId));assert.equal(egress.calls.length,2,`${name}: retried after the negative window`);
 }
 // Slow headers and a slow (never-ending) body both hit the deadline, and the request is aborted.
 for(const respond of [init=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')))),()=>new Promise(()=>{}),()=>new Response(new ReadableStream({start(c){c.enqueue(body('{'));}}),{status:200,headers:{'Content-Type':'application/json'}})]){
  const {directory:d,egress}=directory({[clientId]:respond},{limits:{timeoutMs:30}});const started=Date.now();
  await rejects(d.resolve(clientId));assert.ok(Date.now()-started<1000);assert.equal(egress.calls[0].init.signal.aborted,true);
 }
});

test('cache poisoning: a document is cached only under its own exact client_id',async()=>{
 const victim='https://app.example/victim.json';
 const {directory:d,egress}=directory({[clientId]:metadata({client_id:victim,redirect_uris:['https://app.example/evil']}),[victim]:metadata({client_id:victim})});
 await rejects(d.resolve(clientId));const resolved=await d.resolve(victim);assert.deepEqual(resolved.redirectUris,[redirectUri]);assert.deepEqual(egress.calls.map(c=>c.url),[clientId,victim]);
 // A static registration is not displaced by a later document either.
 const {directory:pinned}=directory({[reviewedId]:metadata({client_id:reviewedId,redirect_uris:['https://reviewed.example/evil']})},{clients:[{id:reviewedId,name:'Reviewed',origin:reviewedOrigin,redirectUris:['https://reviewed.example/cb']}]});
 assert.deepEqual((await pinned.resolve(reviewedId)).redirectUris,['https://reviewed.example/cb']);
});

test('budgets come before egress: per client host and global limits, and blocked hosts are never fetched',async()=>{
 const ids=Array.from({length:8},(_,i)=>`https://app.example/c${i}.json`),docs=Object.fromEntries(ids.map(id=>[id,metadata({client_id:id})]));
 const {directory:d,egress}=directory(docs);
 for(const id of ids.slice(0,6))await d.resolve(id);await rejects(d.resolve(ids[6]),'rate_limited');assert.equal(egress.calls.length,6);
 const {directory:g,egress:global}=directory(Object.fromEntries(Array.from({length:4},(_,i)=>[`https://h${i}.example/c`,metadata({client_id:`https://h${i}.example/c`,redirect_uris:[`https://h${i}.example/cb`]})])),{limits:{global:{windowMs:60000,limit:3}}});
 for(let i=0;i<3;i++)await g.resolve(`https://h${i}.example/c`);await rejects(g.resolve('https://h3.example/c'),'rate_limited');assert.equal(global.calls.length,3);
 const blockedHosts=new Set(['app.example']);let lookups=0;
 const {directory:b,egress:none}=directory({[clientId]:metadata()},{blocked:async host=>{lookups++;return blockedHosts.has(host);}});
 await rejects(b.resolve(clientId));await rejects(b.assertAllowed(clientId));assert.equal(none.calls.length,0);assert.equal(lookups,1,'block decisions are cached briefly');
 const {directory:broken,egress:closed}=directory({[clientId]:metadata()},{blocked:async()=>{throw new Error('admin store down');}});
 await rejects(broken.resolve(clientId));assert.equal(closed.calls.length,0,'an unreadable block list fails closed');
 const {directory:off}=directory({});const disabled=new ClientDirectory({enabled:true});assert.equal(disabled.enabled,false,'no egress port, no feature');await rejects(off.resolve('https://app.example/'));
});

// ---- provider runtime ----
const post=(p,url,value,headers={})=>p.fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
const form=(p,url,fields,headers={})=>p.fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields)});
const pageHeaders=(view,extra={})=>({Origin:issuer,'Sec-Fetch-Site':'same-origin','X-Bindle-Entry-Token':view.pageToken,...extra});
function entryInput(overrides={}){const verifier=b64(48);return {verifier,input:{clientId,redirectUri,challenge:pkce(verifier),challengeMethod:'S256',state:b64(32),intent:'login',requests:[],presentation:'popup',...overrides}};}
async function signInThroughEntry(p,{origin=appOrigin}={}){
 const {verifier,input}=entryInput(),created=await post(p,`${issuer}/api/oauth/entries`,input,{Origin:origin});const {entryId}=await created.json();assert.equal(created.status,201);
 const view=await(await p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}})).json(),session=p.signIn(),headers=pageHeaders(view,{Cookie:session.cookie,'X-CSRF-Token':session.csrf});
 const selection=await(await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce},headers)).json();
 const inspect=await(await p.fetch(`${issuer}/api/oauth/requests/${selection.requestId}`,{headers:{Origin:issuer,Cookie:session.cookie}})).json();
 const decided=await(await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,approved:[]},headers)).json();
 return {view,inspect,decided,verifier,code:new URL(decided.redirectUri).searchParams.get('code'),session};
}

test('manifest declares client-id-metadata.v1 only when enabled with an egress port',async()=>{
 const on=await cimdProvider();const manifest=await(await on.fetch(`${issuer}/.well-known/bindle/manifest.json`)).json();assert.deepEqual(manifest.features[CLIENT_METADATA_FEATURE],{});assert.ok(manifest.features['authorization-entry.v1']);
 const off=await cimdProvider({enabled:false});const plain=await(await off.fetch(`${issuer}/.well-known/bindle/manifest.json`)).json();assert.equal(plain.features?.[CLIENT_METADATA_FEATURE],undefined);
 const noPort=federationAuthority({config:{...on.config},repository:{},shard:()=>null,directory:federationClientDirectory(on.config,{})});assert.equal(noPort.manifest().features,undefined);
 // Disabled: a URL client ID is just an unregistered client and nothing is fetched.
 const {input}=entryInput();const refused=await post(off,`${issuer}/api/oauth/entries`,input,{Origin:appOrigin});assert.equal(refused.status,403);assert.equal(off.egress.calls.length,0);
});

test('entry sign-in with an unregistered URL client: verified origin labels the app, its name is unverified, and tokens work',async()=>{
 const p=await cimdProvider({documents:{[clientId]:metadata({client_name:'Your Bank — Official'})}});
 const preflight=await p.fetch(`${issuer}/api/oauth/entries`,{method:'OPTIONS',headers:{Origin:appOrigin,'Access-Control-Request-Method':'POST'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),appOrigin);
 const {view,inspect,code,verifier}=await signInThroughEntry(p);
 assert.deepEqual(view.entry.client,{id:clientId,name:'app.example',origin:appOrigin,reviewed:false,claimedName:'Your Bank — Official'});
 assert.equal(inspect.client.reviewed,false);assert.equal(inspect.client.name,'app.example');assert.equal(p.egress.calls.length,1);
 const exchanged=await form(p,`${issuer}/oauth/token`,{grant_type:'authorization_code',code,code_verifier:verifier,client_id:clientId,redirect_uri:redirectUri},{Origin:appOrigin});
 const tokens=await exchanged.json();assert.equal(exchanged.status,200,JSON.stringify(tokens));assert.equal(exchanged.headers.get('Access-Control-Allow-Origin'),appOrigin);assert.equal(tokens.client_id,clientId);
 // The approved snapshot persists in the owner's shard: a fresh controller (restart) still knows the client offline.
 const owner=p.accounts[0].owner,stored=await p.shards.get(owner).metadata.transaction(tx=>tx.list('federation/client/'));assert.equal(stored.length,1);assert.equal(stored[0].value.id,clientId);
 p.restart(owner);
 const refreshed=await form(p,`${issuer}/oauth/token`,{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:clientId},{Origin:appOrigin});assert.equal(refreshed.status,200,await refreshed.clone().text());
 const rpcPreflight=await p.fetch(`${issuer}/bindle/rpc`,{method:'OPTIONS',headers:{Origin:appOrigin}});assert.equal(rpcPreflight.status,204);
 const fromApp=await p.fetch(`${issuer}/bindle/rpc`,{method:'POST',headers:{Origin:appOrigin,Authorization:`Bearer ${(await refreshed.json()).access_token}`,'Content-Type':'application/json'},body:'{}'});assert.notEqual(fromApp.status,403);
 const fromOther=await p.fetch(`${issuer}/bindle/rpc`,{method:'POST',headers:{Origin:'https://evil.example',Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:'{}'});assert.equal(fromOther.status,403);
 assert.equal(p.egress.calls.length,1,'no refetch for tokens');
});

test('entry creation refuses look-alike origins, unknown callbacks, failed documents and blocked hosts without detail',async()=>{
 const p=await cimdProvider({documents:{[clientId]:metadata(),'https://other.example/c':metadata({client_id:'https://other.example/c',redirect_uris:['https://evil.example/cb']})}});
 const attempt=async(overrides,headers={Origin:appOrigin})=>{const {input}=entryInput(overrides);const response=await post(p,`${issuer}/api/oauth/entries`,input,headers);return {status:response.status,body:await response.json()};};
 assert.equal((await attempt({},{Origin:'https://app.example.evil.example'})).status,400);
 assert.equal((await attempt({redirectUri:'https://app.example/other'})).status,400);
 assert.equal((await attempt({clientId:'https://other.example/c',redirectUri:'https://evil.example/cb'},{Origin:'https://other.example'})).status,400);
 assert.equal((await attempt({clientId:'https://missing.example/c',redirectUri:'https://missing.example/cb'},{Origin:'https://missing.example'})).status,400);
 const generic=await attempt({redirectUri:'https://app.example/other'});assert.deepEqual(generic.body,{error:'invalid_request',message:'The authorization entry could not be created.'});
 p.blocked.add('app.example');p.directory.invalidate('app.example');const blocked=await attempt({});assert.equal(blocked.status,400);
 // A reviewed client keeps working whatever the block list says, and is never fetched.
 const reviewed=await attempt({clientId:reviewedId,redirectUri:'https://reviewed.example/callback'},{Origin:reviewedOrigin});assert.equal(reviewed.status,201);assert.ok(p.egress.calls.every(c=>c.url!==reviewedId));
});

test('blocking a host stops code exchange, refresh and cross-origin calls for issued URL-client grants',async()=>{
 const p=await cimdProvider();const {code,verifier}=await signInThroughEntry(p);
 p.blocked.add('app.example');p.directory.invalidate('app.example');
 const exchanged=await form(p,`${issuer}/oauth/token`,{grant_type:'authorization_code',code,code_verifier:verifier,client_id:clientId,redirect_uri:redirectUri});assert.equal(exchanged.status,400);assert.equal((await exchanged.json()).error,'invalid_client');
 p.blocked.delete('app.example');p.directory.invalidate('app.example');
 const second=await signInThroughEntry(p),tokens=await(await form(p,`${issuer}/oauth/token`,{grant_type:'authorization_code',code:second.code,code_verifier:second.verifier,client_id:clientId,redirect_uri:redirectUri})).json();assert.ok(tokens.refresh_token);
 p.blocked.add('app.example');p.directory.invalidate('app.example');
 assert.equal((await form(p,`${issuer}/oauth/token`,{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:clientId})).status,400);
 assert.equal((await p.fetch(`${issuer}/bindle/rpc`,{method:'POST',headers:{Origin:appOrigin,Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:'{}'})).status,403);
 // Revocation stays available from a server (no Origin).
 assert.equal((await form(p,`${issuer}/oauth/revoke`,{token:tokens.refresh_token,client_id:clientId})).status,200);
});

test('redirect flow: the authority resolves the client; a caller cannot inject a client snapshot',async()=>{
 const p=await cimdProvider(),host=new URL(issuer).host,verifier=b64(48);
 const begin=fields=>post(p,`${issuer}/api/oauth/requests`,{clientId,redirectUri,challenge:pkce(verifier),challengeMethod:'S256',state:b64(16),requests:[],identity:`alex@${host}`,...fields},{Origin:appOrigin});
 const ok=await begin({});const json=await ok.json();assert.equal(ok.status,201,JSON.stringify(json));assert.equal(json.view.client.reviewed,false);assert.equal(json.view.client.name,'app.example');
 const injected=await begin({client:{id:clientId,name:'Trusted Bank',origin:appOrigin,redirectUris:['https://app.example/evil'],reviewed:false}});assert.equal(injected.status,400);
 // Direct controller callers cannot smuggle an arbitrary snapshot either.
 await assert.rejects(p.shard(p.accounts[0].owner).beginAuthorization({clientId,redirectUri:'https://app.example/evil',challenge:pkce(verifier),challengeMethod:'S256',state:'s',requests:[]},{client:{id:clientId,name:'Trusted Bank',origin:appOrigin,redirectUris:['https://app.example/evil'],reviewed:false}}),{code:'invalid_client'});
 // A static registration of the same ID would take precedence over any snapshot.
 await assert.rejects(p.shard(p.accounts[0].owner).beginAuthorization({clientId:reviewedId,redirectUri:'https://reviewed.example/evil',challenge:pkce(verifier),challengeMethod:'S256',state:'s',requests:[]},{client:{id:reviewedId,name:'reviewed.example',origin:reviewedOrigin,redirectUris:['https://reviewed.example/evil'],reviewed:false}}),{code:'invalid_client'});
});

test('Worker facade: budgets on the caller and client-host shards precede resolution; the shard accepts only a validated snapshot',async()=>{
 const p=await cimdProvider(),calls=[],stores=new Map();
 const shardEntries=shard=>{if(!stores.has(shard))stores.set(shard,new AuthorizationEntries({store:new MemoryFederationStore(),shard,issuer,clients:federationClients(p.config),authority:p.authority,crypto:webcrypto,clientMetadata:true}));return stores.get(shard);};
 const facade=federationEntriesRemote({config:p.config,directory:p.directory,invoke:async(shard,method,args)=>{calls.push(method);try{return {ok:true,result:await shardEntries(shard)[method](...structuredClone(args))};}catch(error){return {ok:false,error:{code:error.code,message:error.message}};}}});
 const {input}=entryInput();const {entryId}=await facade.create(input,{origin:appOrigin,remote:'r1'});assert.ok(entryId);assert.deepEqual(calls,['admit','admitHost','create']);
 const view=await facade.view(entryId);assert.equal(view.entry.client.reviewed,false);
 // A shard never trusts a forged snapshot.
 const forged={id:clientId,name:'Trusted Bank',origin:appOrigin,redirectUris:[redirectUri],reviewed:false};
 await assert.rejects(shardEntries('00').create(input,{origin:appOrigin,remote:'r1',admitted:true,client:forged}),{code:'invalid_request'});
 const hostLimited=new AuthorizationEntries({store:new MemoryFederationStore(),issuer,clients:[],authority:p.authority,crypto:webcrypto,clientMetadata:true,limits:{perClientHost:2}});
 await hostLimited.admitHost({clientId});await hostLimited.admitHost({clientId});await assert.rejects(hostLimited.admitHost({clientId}),{code:'rate_limited'});
});

test('admin blockClient: narrow, validated, audited, and read by the federation port',async()=>{
 const store=new AdminStorage(new SqliteMetadata(':memory:'));let now=1_800_000_000_000;
 const admin=new AdminService({store,identity:{repository:{},crypto:{},origin(){}},webauthn:{},passwordHasher:{},rateLimiter:{check:async()=>true},clock:()=>now,config:{APP_ORIGIN:issuer}});
 admin.actor=async()=>({kind:'admin',owner:'00000000-0000-4000-8000-000000000001',rate:'admin-x',expect:{},audit:{kind:'admin',owner:'00000000-0000-4000-8000-000000000001',handle:'ops',session:'s'}});
 assert.equal(await adminClientBlocked(store,'app.example'),false);
 assert.deepEqual(await admin.blockClient({host:'App.Example.',blocked:true,reason:'Phishing reports'},{}),{host:'app.example',blocked:true,block:{host:'app.example',reason:'Phishing reports',blockedAt:now,updatedAt:now,by:{kind:'admin',owner:'00000000-0000-4000-8000-000000000001',handle:'ops',session:'s'}}});
 assert.equal(await adminClientBlocked(store,'app.example'),true);assert.equal(await adminClientBlocked(store,'sub.app.example'),false);assert.equal(await adminClientBlocked(store,'BAD HOST'),true);
 for(const input of [{host:'127.0.0.1',blocked:true},{host:'nodot',blocked:true},{host:'app.example',blocked:'yes'},{host:'app.example',blocked:true,reason:'x'.repeat(201)},{host:'app.example',blocked:true,reason:'a‮b'},{host:'app.example',blocked:true,extra:1}])
  await assert.rejects(admin.blockClient(input,{}),error=>['invalid_host','invalid_request'].includes(error.code),JSON.stringify(input));
 const listed=await admin.clientBlocks({},{});assert.deepEqual(listed.blocks.map(b=>b.host),['app.example']);
 now+=1000;assert.deepEqual(await admin.blockClient({host:'app.example',blocked:false},{}),{host:'app.example',blocked:false});assert.equal(await adminClientBlocked(store,'app.example'),false);
 const audit=(await store.list('audit/',{limit:100})).map(r=>r.value);assert.deepEqual(audit.map(e=>e.action),['client.block','client.blocks','client.unblock']);assert.equal(audit[0].target,'app.example');assert.deepEqual(audit[0].after,{reason:'Phishing reports'});
 assert.equal((await store.verifyAudit()).valid,true);
 // HTTP: mounted as same-origin POST operations.
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
 const response=await adminRoutes({path:'/api/admin/clients/block',request:new Request(`${issuer}/api/admin/clients/block`,{method:'POST',headers:{Origin:issuer,'X-Bindle-Admin-Actor':'admin'}}),env:{APP_ORIGIN:issuer,ADMIN_SERVICE:async()=>admin},local:false,context:{},body:async()=>({host:'spam.example',blocked:true}),json});
 assert.equal(response.status,200);assert.equal(await adminClientBlocked(store,'spam.example'),true);
});

test('review hardening: parent-domain blocks, provider hosts refused, site budgets, stale-good under budget pressure',async()=>{
 // A block on a parent domain covers every subdomain (wildcard DNS cannot sidestep it).
 const blocked=new Set(['evil.example']);
 const {directory:b,egress}=directory({'https://x1.evil.example/c':metadata({client_id:'https://x1.evil.example/c',redirect_uris:['https://x1.evil.example/cb']})},{blocked:async host=>blocked.has(host)});
 await rejects(b.resolve('https://x1.evil.example/c'));await rejects(b.assertAllowed('https://a.b.evil.example/c'));assert.equal(egress.calls.length,0);
 // The provider's own hosts and their subdomains are never third-party clients.
 const own=new ClientDirectory({enabled:true,fetch:async()=>{throw new Error('no');},reservedHosts:['provider.example','embed.example']});
 for(const id of ['https://provider.example/api/x','https://sub.provider.example/c','https://embed.example/c'])assert.equal(own.isMetadataId(id),false,id);
 assert.equal(own.isMetadataId('https://notprovider.example/c'),true);
 const configured=federationClientDirectory({APP_ORIGIN:issuer,EMBED_ORIGIN:'https://embed.provider.example',CLIENT_METADATA_ENABLED:'true',FEDERATION_CLIENTS:'[]'},{fetch:async()=>{}});assert.equal(configured.isMetadataId(issuer+'/api/x'),false);
 // Subdomain churn shares one site budget.
 const ids=Array.from({length:7},(_,i)=>`https://s${i}.churn.example/c`),{directory:s,egress:site}=directory(Object.fromEntries(ids.map(id=>[id,metadata({client_id:id,redirect_uris:[new URL(id).origin+'/cb']})])));
 for(const id of ids.slice(0,6))await s.resolve(id);await rejects(s.resolve(ids[6]),'rate_limited');assert.equal(site.calls.length,6);
 // A known-good document is served (briefly) past expiry when budgets refuse the refetch.
 let allow=true;const {directory:g,advance}=directory({[clientId]:metadata()},{limiter:{consume:async()=>allow}});
 await g.resolve(clientId);advance(3_600_001);allow=false;assert.equal((await g.resolve(clientId)).id,clientId);advance(3_600_000);await rejects(g.resolve(clientId),'rate_limited');
 // More invisible or confusable code points are dropped from claimed names.
 for(const name of ['A؜B','soft­hyphen','tag\u{E0041}','vs️'])assert.equal(validateClientMetadata(metadata({client_name:name}),clientId).claimedName,undefined,JSON.stringify(name));
 assert.equal(validateClientMetadata(metadata({client_name:'\u{1F600}'.repeat(100)}),clientId).claimedName.length,200,'100 code points are allowed');
});
