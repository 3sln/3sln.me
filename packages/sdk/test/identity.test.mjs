import { test } from 'node:test';
import assert from 'node:assert/strict';
const manifest = {version:'0',issuer:'https://self.example',authorization_endpoint:'https://self.example/login',token_endpoint:'https://self.example/token',rpc_endpoint:'https://self.example/rpc',jwks_uri:'https://self.example/keys',authorization_request_endpoint:'https://self.example/api/oauth/requests',preferences_contract:'https://contracts.example/preferences/v1',login_presentation:['redirect']};
const reply = value => ({status:200,ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(value),json:async()=>value});
import { parseIdentity, discoverIdentity } from '../src/identity.mjs';
test('default host applies only before an explicit @', () => {
  assert.equal(parseIdentity('alex').handle, 'alex@3sln.me');
  assert.equal(parseIdentity('alex@self.example').manifestUrl, 'https://self.example/.well-known/bindle/manifest.json');
  assert.throws(() => parseIdentity('alex@'));
  assert.throws(() => parseIdentity('alex@evil.example/path'));
  for(const handle of ['alex@127.0.0.1','alex@2130706433','alex@0x7f000001','a\u0001@self.example'])assert.throws(()=>parseIdentity(handle));
});
test('only definite missing manifest allows email fallback', async () => {
  assert.equal((await discoverIdentity('alex@mail.example', { fetcher: async () => ({ status: 404 }) })).kind, 'email-fallback');
  await assert.rejects(discoverIdentity('alex@mail.example', { fetcher: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(discoverIdentity('alex@mail.example', { fetcher: async () => ({status:500,ok:false}) }), /500/);
});
test('discovery never embeds handle as HTTP URL credentials', async () => {
  let requested;
  await discoverIdentity('alex@self.example', { fetcher: async url => { requested=url; return reply(manifest); } });
  assert.equal(requested, 'https://self.example/.well-known/bindle/manifest.json');
});

test('rejects unsupported metadata and cross-origin endpoint delegation', async () => {
  for (const patch of [{version:'1'}, {issuer:'https://attacker.example'}, {rpc_endpoint:'https://attacker.example/rpc'}, {login_presentation:['iframe']}, {token_endpoint:7}]) {
    await assert.rejects(discoverIdentity('alex@self.example', {fetcher:async()=>reply({...manifest,...patch})}));
  }
});

import {BindleClient} from '../src/identity.mjs';
// Pending transactions are keyed by (callback, state), so several can be pending at once.
const key=(state='s')=>'bindle.pending-login:'+JSON.stringify(['https://app.example/callback',state]);
function storage(){const items=new Map();return {get length(){return items.size;},key:i=>[...items.keys()][i]??null,getItem:k=>items.get(k)??null,setItem:(k,v)=>items.set(k,v),removeItem:k=>items.delete(k)};}
test('SDK executes PKCE login without cookies, validates callback and keeps bearer in memory',async()=>{
 const saved=storage(),calls=[],id='r'.repeat(43),code='c'.repeat(43);let request;
 const client=new BindleClient({clientId:'https://app.example',redirectUri:'https://app.example/callback',storage:saved,fetcher:async(url,options)=>{calls.push({url,options});if(url.endsWith('manifest.json'))return reply(manifest);if(url.endsWith('/api/oauth/requests')){request=JSON.parse(options.body);return reply({requestId:id});}if(url.endsWith('/token'))return reply({access_token:'secret',token_type:'Bearer',expires_in:300,issuer:manifest.issuer,client_id:'https://app.example',subject:'https://self.example/entities/10000000-0000-4000-8000-000000000001',audience:manifest.rpc_endpoint,granted_fragments:[]});return reply({version:'0',tx:JSON.parse(options.body).tx,result:{}});}});
 const begun=await client.beginLogin('alex@self.example',{requests:[{fragment:'https://app.example/preferences'}]});assert.equal(new URL(begun.authorizationUrl).searchParams.get('request_id'),id);assert.equal(request.identity,'alex@self.example');assert.equal(request.challengeMethod,'S256');assert.equal(request.challenge.length,43);
 await assert.rejects(client.completeLogin(`https://app.example/callback?code=${code}&state=wrong`),/pending/);assert.ok(saved.getItem(key(request.state)));
 const token=await client.completeLogin(`https://app.example/callback?code=${code}&state=${request.state}&iss=${encodeURIComponent(manifest.issuer)}`);assert.equal(token.access_token,'secret');assert.equal(saved.getItem(key(request.state)),null);assert.equal(new URLSearchParams(calls[2].options.body).get('code_verifier').length,43);assert.ok(calls.every(c=>c.options.credentials==='omit'));await client.rpc({resource:'x',contract:'https://app.example/contract',method:'read'});assert.equal(calls[3].options.headers.Authorization,'Bearer secret');client.signOut();await assert.rejects(client.rpc({}),/Sign in/);
});
test('SDK rejects repeated callback parameters, expired state and code reuse',async()=>{
 const saved=storage(),client=new BindleClient({clientId:'app',redirectUri:'https://app.example/callback',storage:saved,clock:()=>1000});const pending={state:'s',clientId:'app',redirectUri:client.redirectUri,expiresAt:2000};saved.setItem(key(),JSON.stringify(pending));await assert.rejects(client.completeLogin('https://app.example/callback?state=s&state=s&code=x'),/pending/);saved.setItem(key(),JSON.stringify({...pending,expiresAt:999}));await assert.rejects(client.completeLogin('https://app.example/callback?state=s&code=x'),/expired/);
});
test('cancelled discovery and token exchange cannot restore credentials',async()=>{
 const saved=storage();let resolveDiscovery;
 const client=new BindleClient({clientId:'app',redirectUri:'https://app.example/callback',storage:saved,fetcher:()=>new Promise(resolve=>{resolveDiscovery=resolve;})});
 const login=client.beginLogin('alex@self.example',{requests:[]});await Promise.resolve();client.cancelLogin();resolveDiscovery(reply(manifest));await assert.rejects(login,/canceled/);assert.equal(saved.getItem(key()),null);
 let resolveToken;client.fetcher=()=>new Promise(resolve=>{resolveToken=resolve;});saved.setItem(key(),JSON.stringify({state:'s',verifier:'v'.repeat(43),issuer:manifest.issuer,tokenEndpoint:manifest.token_endpoint,rpcEndpoint:manifest.rpc_endpoint,clientId:'app',redirectUri:client.redirectUri,expiresAt:Date.now()+600000}));const complete=client.completeLogin('https://app.example/callback?state=s&iss=https%3A%2F%2Fself.example&code='+ 'c'.repeat(43));while(!resolveToken)await new Promise(resolve=>setTimeout(resolve,1));client.signOut();resolveToken(reply({access_token:'secret',token_type:'Bearer',expires_in:300,issuer:manifest.issuer,client_id:'app',subject:'https://self.example/entities/10000000-0000-4000-8000-000000000001',audience:manifest.rpc_endpoint,granted_fragments:[]}));await assert.rejects(complete,/canceled/);assert.equal(client.session,null);
});
test('starting another identity login invalidates the previous pending callback even on discovery failure',async()=>{
 const saved=storage();saved.setItem(key(),JSON.stringify({state:'s',redirectUri:'https://app.example/callback',expiresAt:Date.now()+60000}));const client=new BindleClient({clientId:'app',redirectUri:'https://app.example/callback',storage:saved,fetcher:async()=>{throw Error('offline');}});await assert.rejects(client.beginLogin('alex@self.example',{requests:[]}),/offline/);assert.equal(saved.getItem(key()),null);
});
test('local development discovery requires explicit localhost opt-in',()=>{assert.throws(()=>parseIdentity('alex@localhost:8787'));assert.equal(parseIdentity('alex@localhost:8787','3sln.me',{allowInsecureLocalhost:true}).manifestUrl,'http://localhost:8787/.well-known/bindle/manifest.json');assert.throws(()=>parseIdentity('alex@self.example:8080','3sln.me',{allowInsecureLocalhost:true}));});
test('resource reference from another provider never sends its token to the current provider',async()=>{let calls=0;const client=new BindleClient({clientId:'app',redirectUri:'https://app.example/callback',storage:storage(),fetcher:async()=>{calls++;throw Error('must not send');}});client.session={issuer:'https://second.example',expiresAt:Date.now()+300000,rpcEndpoint:'https://second.example/rpc',access_token:'second-token'};await assert.rejects(client.callResource({id:'https://first.example/entities/owner/resource',token:'first-secret'},{contract:'https://contract.example/v1',method:'read'}),/different identity provider/);assert.equal(calls,0);});
async function renewableFixture({onRefresh,changedReference=false}={}){
 const saved=storage(),time={now:1000},calls=[],subject='https://self.example/entities/10000000-0000-4000-8000-000000000001',fragment='https://app.example/preferences',id=subject+'/scoped-resource/stable';
 const grant={grant:'grant-1',fragment,digest:'digest',fields:['files']},access=(generation=1)=>({access_token:'access-'+generation,refresh_token:'refresh-'+generation,refresh_expires_in:Math.floor((28801000-time.now)/1000),token_type:'Bearer',expires_in:300,issuer:manifest.issuer,client_id:'app',subject,audience:manifest.rpc_endpoint,grants:['grant-1'],granted_fragments:[grant]});let generation=1;
 const client=new BindleClient({clientId:'app',redirectUri:'https://app.example/callback',storage:saved,clock:()=>time.now,fetcher:async(url,options)=>{calls.push({url,options});if(url===manifest.token_endpoint){if(new URLSearchParams(options.body).get('grant_type')==='refresh_token'){generation++;if(onRefresh)return onRefresh({access:()=>access(generation),options,time});}return reply(access(generation));}const input=JSON.parse(options.body);if(input.resource==='@preferences')return reply({version:'0',tx:input.tx,result:{fragment,values:{files:[{id:changedReference&&generation>1?id+'-changed':id,token:'child-'+generation,contracts:['https://contract.example/v1']}]}}});return reply({version:'0',tx:input.tx,result:{ok:true}});}});
 saved.setItem(key(),JSON.stringify({state:'s',verifier:'v'.repeat(43),issuer:manifest.issuer,tokenEndpoint:manifest.token_endpoint,rpcEndpoint:manifest.rpc_endpoint,preferencesContract:manifest.preferences_contract,clientId:'app',redirectUri:client.redirectUri,expiresAt:600000}));await client.completeLogin('https://app.example/callback?state=s&iss=https%3A%2F%2Fself.example&code='+'c'.repeat(43));return {client,calls,time,access,fragment,id};
}
test('parallel RPC renewals rotate once and refresh credentials remain memory-only',async()=>{
 let release;const held=new Promise(resolve=>release=resolve);const f=await renewableFixture({onRefresh:async({access})=>{await held;return reply(access());}});f.time.now+=280000;const first=f.client.rpc({resource:'test',contract:'https://contract.example/v1',method:'read'}),second=f.client.rpc({resource:'test',contract:'https://contract.example/v1',method:'read'});release();await Promise.all([first,second]);assert.equal(f.calls.filter(c=>c.url===manifest.token_endpoint).length,2);assert.equal(f.client.session.refresh_token,'refresh-2');assert.equal(f.calls.at(-1).options.headers.Authorization,'Bearer access-2');assert.equal(f.client.storage.getItem(f.client.pendingKey),null);
});
test('canceling one renewal waiter does not cancel the shared rotation',async()=>{
 let release,networkSignal;const held=new Promise(resolve=>release=resolve);const f=await renewableFixture({onRefresh:async({access,options})=>{networkSignal=options.signal;await held;return reply(access());}});f.time.now+=280000;const abort=new AbortController(),first=f.client.refresh({signal:abort.signal}),second=f.client.refresh();abort.abort();await assert.rejects(first,{name:'AbortError'});while(!networkSignal)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(networkSignal.aborted,false);release();await second;assert.equal(f.client.session.access_token,'access-2');assert.equal(f.calls.filter(c=>c.url===manifest.token_endpoint).length,2);
});
test('signout during renewal rejects a late response without restoring credentials',async()=>{let release;const held=new Promise(resolve=>release=resolve);const f=await renewableFixture({onRefresh:async({access})=>{await held;return reply(access());}});const pending=f.client.refresh();f.client.signOut();release();await assert.rejects(pending,/canceled/);assert.equal(f.client.session,null);});
test('scoped reference renewal reacquires only the exact same opaque assignment',async()=>{const f=await renewableFixture(),preferences=await f.client.readPreferences(f.fragment),ref=preferences.values.files[0];f.time.now+=280000;await f.client.callResource(ref,{contract:'https://contract.example/v1',method:'read'});assert.equal(f.calls.at(-1).options.headers.Authorization,'Bearer child-2');assert.equal(f.calls.filter(c=>c.url===manifest.rpc_endpoint&&JSON.parse(c.options.body).resource==='@preferences').length,2);await assert.rejects(f.client.callResource({...ref},{contract:'https://contract.example/v1',method:'read'}),/expired/);
 const changed=await renewableFixture({changedReference:true}),old=(await changed.client.readPreferences(changed.fragment)).values.files[0];changed.time.now+=280000;await assert.rejects(changed.client.callResource(old,{contract:'https://contract.example/v1',method:'read'}),/assignment changed/);assert.ok(!changed.calls.some(c=>c.url===manifest.rpc_endpoint&&JSON.parse(c.options.body).resource===old.id));});
test('failed or grant-expanding renewal requires new login without replaying a rotation',async()=>{const failed=await renewableFixture({onRefresh:async()=>{throw Error('response lost');}});await assert.rejects(failed.client.refresh(),/response lost/);assert.equal(failed.client.session,null);await assert.rejects(failed.client.refresh(),/Sign in/);assert.equal(failed.calls.filter(c=>c.url===manifest.token_endpoint).length,2);const expanded=await renewableFixture({onRefresh:async({access})=>reply({...access(),granted_fragments:[{grant:'grant-1',fragment:'https://app.example/preferences',digest:'digest',fields:['files','private']} ]})});await assert.rejects(expanded.client.refresh(),/expand/);assert.equal(expanded.client.session,null);});
test('renewal anchors the issued refresh lifetime before response transit',async()=>{const f=await renewableFixture({onRefresh:async({access,time})=>{const token=access();time.now+=12000;return reply(token);}}),deadline=f.client.session.refreshExpiresAt;await f.client.refresh();assert.equal(f.client.session.refreshExpiresAt,deadline);assert.ok(f.client.session.expiresAt<=deadline);});
test('an old renewal cannot wipe a newer completed login',async()=>{let release;const held=new Promise(resolve=>release=resolve);const f=await renewableFixture({onRefresh:async({access})=>{await held;return reply(access());}}),pending=f.client.refresh();f.client.storage.setItem(key('new'),JSON.stringify({state:'new',verifier:'v'.repeat(43),issuer:manifest.issuer,tokenEndpoint:manifest.token_endpoint,rpcEndpoint:manifest.rpc_endpoint,preferencesContract:manifest.preferences_contract,clientId:'app',redirectUri:f.client.redirectUri,expiresAt:600000}));const newer=await f.client.completeLogin('https://app.example/callback?state=new&iss=https%3A%2F%2Fself.example&code='+'d'.repeat(43));release();await assert.rejects(pending,/canceled/);assert.equal(f.client.session,newer);});
test('RPC write-rate faults expose validated retry metadata without retrying the mutation',async()=>{const {client}=await renewableFixture();let calls=0;client.fetcher=async(url,options)=>{calls++;const input=JSON.parse(options.body);return reply({version:'0',tx:input.tx,error:{code:'rate_limit',message:'Storage writes are arriving too quickly. Try again shortly.',retryAfter:60}});};await assert.rejects(client.rpc({resource:'resource',contract:'https://storage.example/v1',method:'put'}),error=>error.code==='rate_limit'&&error.retryAfter===60);assert.equal(calls,1);});

test('userMessage binds native browser origin to the registered callback and keeps transaction identity exact',async()=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'window');let calls=[];
 try{
  Object.defineProperty(globalThis,'window',{configurable:true,value:{origin:'https://wrong.example',location:{origin:'https://wrong.example'}}});
  const client=new BindleClient({clientId:'https://registry.example/apps/notes',redirectUri:'https://notes.example/callback',storage:storage()});
  client.callResource=async(reference,call,options)=>{calls.push({reference,call,options});return {result:{accepted:true}};};
  const ref={id:'https://self.example/resource',token:'scoped'};
  await assert.rejects(client.userMessage(ref,{subject:'Reminder',body:'Plain text'}),/registered app origin/);assert.equal(calls.length,0);
  window.location.origin='https://notes.example';window.origin='null';await assert.rejects(client.userMessage(ref,{subject:'Opaque frame',body:'No write'}),/registered app origin/);window.origin='https://notes.example';const tx='10000000-0000-4000-8000-000000000001';
  await client.userMessage(ref,{subject:'Reminder',body:'<b>literal text</b>',transactionId:tx,createdAt:1000});
  assert.equal(calls.length,1);assert.equal(calls[0].call.tx,tx);assert.deepEqual(calls[0].call.args,{transactionId:tx,createdAt:1000,subject:'Reminder',mimeType:'text/plain',body:'<b>literal text</b>',tags:[]});assert.equal(calls[0].call.method,'createOwn');
  for(const value of [{subject:'',body:'ok'},{subject:'x',body:'x'.repeat(12001)},{subject:'x'.repeat(121),body:'x'},{subject:'x',body:'x',transactionId:'not-a-uuid'}])await assert.rejects(client.userMessage(ref,value),/bounded app message/);
  await assert.rejects(client.userMessage(ref,{subject:'Unsupported',body:'No silent action',actions:[]}),/Unsupported app message fields/);await assert.rejects(client.userMessage(ref,{subject:'Tag spoof',body:'No',tags:['app-message']}),/bounded app message/);
  assert.equal(calls.length,1);
  client.callResource=async()=>{throw Error('Network outcome unknown');};const failure=await client.userMessage(ref,{subject:'Retry',body:'Same payload',transactionId:tx,createdAt:1000}).catch(error=>error);assert.equal(failure.transactionId,tx);assert.equal(failure.createdAt,1000);
 }finally{if(prior)Object.defineProperty(globalThis,'window',prior);else delete globalThis.window;}
});
test('discovery returns the floor-checked manifest (frozen, unknown members kept) next to the normalized declaration',async()=>{
 const declared={...manifest,features:{'intents.v1':{intents:['send-message'],login_endpoint:'https://self.example/console'},'future.v9':{x:1}}};
 const found=await discoverIdentity('alex@self.example',{fetcher:async()=>reply(declared)});
 assert.equal(found.kind,'provider');assert.deepEqual(found.manifest.features['future.v9'],{x:1});assert.ok(Object.isFrozen(found.manifest.features));
 assert.deepEqual(found.declaration.features.intents.intents,['send-message']);assert.equal(found.declaration.features.future,undefined);
});
