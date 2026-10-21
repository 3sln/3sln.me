import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceClient,deviceDeclaration,deviceGrant,DEVICE_OPERATIONS,StartDeviceAuthorization,PollDeviceAuthorization,CancelDeviceAuthorization,DeviceAuthorizationDisplay,RefreshDeviceSession,DeviceResourceRequest,RevokeDeviceSession} from '../src/device.mjs';
import {thumbprint} from '../src/dpop.mjs';

const issuer='https://provider.example',subject=issuer+'/entities/alice',clientId='https://acme.example/cli';
const manifest={version:'0',issuer,device_authorization_endpoint:issuer+'/device',token_endpoint:issuer+'/token',rpc_endpoint:issuer+'/rpc',revocation_endpoint:issuer+'/revoke',preferences_contract:'https://contracts.example/preferences/v1',features:{'device-authorization.v1':{}},grant_types_supported:[deviceGrant,'refresh_token'],dpop_signing_alg_values_supported:['ES256']};
const authorization={device_code:'d'.repeat(43),user_code:'BCDF-GHJK',verification_uri:issuer+'/approve',expires_in:600,interval:5};
const token=(patch={})=>({issuer,subject,client_id:clientId,audience:manifest.rpc_endpoint,access_token:'access-secret',token_type:'DPoP',expires_in:300,refresh_token:'refresh-secret',refresh_expires_in:3600,refresh_idle_expires_in:1800,grants:[],granted_fragments:[],...patch});
const reply=(json,status=200,headers={})=>new Response(JSON.stringify(json),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function dispatch(engine,action){const feed=engine.dispatch(action);let result;feed.addEventListener('result',event=>{result=event.detail;},{once:true});await feed.next('complete');return result;}
// A real ngin harness: production operations, non-extractable keys and real
// signature verification; only the network, clock and user interaction are fake.
function harness({polls=[],device=authorization,confirm=async()=>true,onToken,onRefresh,onResource,onDevice,wait,keys}={}){
 const calls=[],proofs=[],sleeps=[],confirmations=[];let now=1000,binding,poll=0,refresh=0;
 const fetcher=async(url,options)=>{
  const headers=new Headers(options.headers),body=url===manifest.rpc_endpoint?JSON.parse(options.body):new URLSearchParams(options.body),call={url,options,headers,body,at:now};calls.push(call);
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(headers.has('Origin'),false);assert.equal([...headers.keys()].some(key=>key.startsWith('sec-fetch-')),false);
  if(url===manifest.device_authorization_endpoint){assert.equal(headers.get('Content-Type'),'application/x-www-form-urlencoded');assert.equal(body.has('scope'),false);binding=body.get('dpop_jkt');return onDevice?onDevice(call):reply(device);}
  if(url===manifest.revocation_endpoint)return new Response(null,{status:200});
  const proof=headers.get('DPoP');assert.ok(proof,'DPoP is mandatory');const [h,p,s]=proof.split('.'),header=JSON.parse(Buffer.from(h,'base64url')),payload=JSON.parse(Buffer.from(p,'base64url'));
  assert.equal(header.alg,'ES256');assert.equal(header.typ,'dpop+jwt');assert.equal(header.jwk.d,undefined);assert.equal(await thumbprint(header.jwk),binding);
  const key=await crypto.subtle.importKey('jwk',header.jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(s,'base64url'),new TextEncoder().encode(h+'.'+p)),true);
  assert.equal(payload.htm,'POST');assert.equal(payload.htu,url);assert.equal(payload.iat,Math.floor(now/1000));assert.ok(!proofs.some(prior=>prior.jti===payload.jti));proofs.push(payload);
  if(url===manifest.rpc_endpoint){assert.equal(headers.get('Authorization'),'DPoP access-secret');assert.equal(payload.ath,Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('access-secret'))).toString('base64url'));return onResource?onResource(call):reply({result:{ok:true}});}
  assert.equal(url,manifest.token_endpoint);assert.equal(headers.get('Content-Type'),'application/x-www-form-urlencoded');assert.equal(payload.ath,undefined);assert.equal(body.get('client_id'),clientId);
  if(body.get('grant_type')==='refresh_token'){refresh++;return onRefresh?onRefresh(call):reply(token({access_token:'access-refreshed',refresh_token:'refresh-rotated',refresh_expires_in:3600,refresh_idle_expires_in:1800}));}
  assert.equal(body.get('grant_type'),deviceGrant);assert.equal(body.get('device_code'),authorization.device_code);return onToken?onToken(call):poll<polls.length?polls[poll++](call):reply(token());
 };
 const options={issuer,manifest,clientId,fetcher,clock:()=>now,sleep:async(ms,signal)=>{sleeps.push(ms);if(wait)return wait(ms,signal);if(signal.aborted)throw Object.assign(new Error('Canceled'),{code:'canceled'});now+=ms;},confirm:confirm?async(account,options)=>{confirmations.push(account);return confirm(account,options);}:undefined,...keys?{keys}:{}};
 const client=createDeviceClient(options);
 return {client,options,engine:client.engine,calls,proofs,sleeps,confirmations,get now(){return now;},advance:ms=>{now+=ms;},get refreshes(){return refresh;}};
}
const start=h=>dispatch(h.engine,new StartDeviceAuthorization());
const signIn=async h=>{await start(h);return dispatch(h.engine,new PollDeviceAuthorization());};

test('engine harness covers every SDK operation; display has a URL, readable code and no secrets',async()=>{
 assert.deepEqual(DEVICE_OPERATIONS.map(op=>op.operation),['sdk.device.start','sdk.device.poll','sdk.device.cancel','sdk.device.refresh','sdk.device.request','sdk.device.revoke','sdk.device.display']);
 const h=harness(),view=await start(h);assert.equal(view.userCode,'BCDF-GHJK');assert.equal(view.verificationUri,issuer+'/approve');assert.equal(view.codeLabel,'Sign-in code: B C D F G H J K');assert.match(view.text,/Type or paste/);assert.match(view.text,/Approve only/);assert.equal(Object.isFrozen(view),true);assert.equal(JSON.stringify(view).includes('device_code'),false);assert.equal(JSON.stringify(view).includes(authorization.device_code),false);
 assert.deepEqual(await h.engine.query(new DeviceAuthorizationDisplay()).peek(),view);assert.equal(await dispatch(h.engine,new CancelDeviceAuthorization()),true);assert.equal(await h.client.display(),null);assert.equal(await h.client.cancel(),false);
});
test('profile declaration requires every member and rejects endpoint delegation before I/O',()=>{
 for(const patch of [{features:{}},{features:{'device-authorization.v1':[]}},{grant_types_supported:[deviceGrant]},{grant_types_supported:4},{dpop_signing_alg_values_supported:['RS256']},{revocation_endpoint:undefined},{device_authorization_endpoint:'https://other.example/device'},{token_endpoint:issuer+'/token#x'},{rpc_endpoint:'http://provider.example/rpc'},{issuer:'https://other.example'},{version:'1'}])assert.throws(()=>deviceDeclaration({...manifest,...patch},issuer),{code:'unsupported_provider'});
 assert.throws(()=>deviceDeclaration(manifest,issuer+'/'),{code:'unsupported_provider'});assert.equal(deviceDeclaration(manifest,issuer).issuer,issuer);
});
test('pending and repeated slow_down increase all later poll intervals; nonce proofs are fresh',async()=>{
 const h=harness({polls:[()=>reply({error:'authorization_pending'},400),()=>reply({error:'slow_down',interval:6},400),()=>reply({error:'slow_down',interval:22},400),()=>reply({error:'use_dpop_nonce'},400,{'DPoP-Nonce':'server-nonce'}),()=>reply({error:'authorization_pending'},400)]});
 const signed=await signIn(h);assert.deepEqual(h.sleeps,[5000,5000,10000,22000,22000,22000]);assert.equal(h.proofs[4].nonce,'server-nonce');assert.equal(signed.tokenType,'DPoP');assert.equal(h.confirmations.length,1);assert.equal(h.confirmations[0].subject,subject);assert.equal('access_token' in h.confirmations[0],false);assert.equal(await h.client.display(),null);
});
test('keys default to non-extractable and platform key adapters can supply opaque handles',async()=>{
 const {createKey,createProof}=await import('../src/dpop.mjs');let key,proofs=0;
 const native=await createKey();assert.equal(native.privateKey.extractable,false);await assert.rejects(crypto.subtle.exportKey('jwk',native.privateKey));
 const client=createDeviceClient({issuer,manifest,clientId,clock:()=>1000,sleep:async()=>{},confirm:async()=>true,keys:{create:async()=>{key={jwk:native.jwk,jkt:native.jkt,handle:'os-key-1'};return key;},proof:async(handle,options)=>{assert.equal(handle,key);proofs++;return createProof(native,options);}},fetcher:async(url)=>url===manifest.device_authorization_endpoint?reply(authorization):reply(token())});
 await client.start();await client.poll();assert.equal(proofs,1);
});
test('explicit identity requires a trusted subject; matching subject skips confirmation',async()=>{
 const h=harness({confirm:null});await assert.rejects(h.client.start({identity:'alice@provider.example'}),{code:'invalid_identity'});assert.equal(h.calls.length,0);
 await h.client.start({identity:'alice@provider.example',expectedSubject:subject,requests:[{fragment:'https://acme.example/preferences',required:false,purpose:'CLI settings',fields:['theme']}],uiLocales:'en es'});assert.equal(h.calls[0].body.get('identity'),'alice@provider.example');assert.equal(h.calls[0].body.get('ui_locales'),'en es');assert.equal(JSON.parse(h.calls[0].body.get('bindle_requests'))[0].fields[0],'theme');assert.equal((await h.client.poll()).subject,subject);assert.equal(h.confirmations.length,0);
});
test('subject mismatch and declined confirmation revoke issued tokens before returning an error',async()=>{
 for(const mismatch of [true,false]){const h=harness({confirm:async()=>false});await h.client.start(mismatch?{identity:'bob@provider.example',expectedSubject:issuer+'/entities/bob'}:{});await assert.rejects(h.client.poll(),{code:mismatch?'subject_mismatch':'access_denied'});assert.equal(h.calls.at(-1).url,manifest.revocation_endpoint);assert.equal(h.calls.at(-1).body.get('token'),'refresh-secret');await assert.rejects(h.client.request({}),{code:'sign_in_required'});}
 const h=harness({confirm:null});await assert.rejects(h.client.start(),{code:'confirmation_required'});assert.equal(h.calls.length,0);
});
test('cancel interrupts a polling wait without a second request',async()=>{
 const waiting=deferred(),h=harness({wait:async(ms,signal)=>{waiting.resolve();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Canceled'),{code:'canceled'})),{once:true}));}});await start(h);const pending=h.client.poll();await waiting.promise;await h.client.cancel();await assert.rejects(pending,{code:'canceled'});assert.equal(h.calls.length,1);assert.equal(await h.client.display(),null);
});
test('cancel during a late token response revokes it and cannot erase a newer flow',async()=>{
 const entered=deferred(),held=deferred(),h=harness({onToken:async()=>{entered.resolve();return held.promise;}});await start(h);const pending=h.client.poll();await entered.promise;await h.client.cancel();const newer=await h.client.start();held.resolve(reply(token()));await assert.rejects(pending,{code:'canceled'});assert.equal(h.calls.at(-1).url,manifest.revocation_endpoint);assert.deepEqual(await h.client.display(),newer);await h.client.cancel();
});
test('cancel while account confirmation is open revokes credentials even when prompt ignores abort',async()=>{
 const entered=deferred(),held=deferred(),h=harness({confirm:async()=>{entered.resolve();return held.promise;}});await start(h);const pending=h.client.poll();await entered.promise;await h.client.cancel();await assert.rejects(pending,{code:'canceled'});assert.equal(h.calls.at(-1).url,manifest.revocation_endpoint);held.resolve(true);await assert.rejects(h.client.request({}),{code:'sign_in_required'});
});
test('caller AbortSignal lives through polling, and abort during start clears pending state',async()=>{
 const controller=new AbortController(),h=harness();await h.client.start({signal:controller.signal});controller.abort();await assert.rejects(h.client.poll(),{code:'canceled'});assert.equal(h.calls.length,1);assert.equal(await h.client.display(),null);
 const entered=deferred(),held=deferred(),late=harness({onDevice:async()=>{entered.resolve();return held.promise;}}),starting=late.client.start();await entered.promise;await late.client.cancel();held.resolve(reply(authorization));await assert.rejects(starting,{code:'canceled'});assert.equal(await late.client.display(),null);
});
test('expiry stops at the local deadline and terminal OAuth errors stop polling',async()=>{
 const h=harness({device:{...authorization,expires_in:9},polls:[()=>reply({error:'authorization_pending'},400)]});await start(h);await assert.rejects(h.client.poll(),{code:'expired_token'});assert.deepEqual(h.sleeps,[5000,4000]);assert.equal(h.calls.length,2);
 for(const code of ['expired_token','access_denied','invalid_grant','invalid_dpop_proof']){const f=harness({polls:[()=>reply({error:code},400)]});await start(f);await assert.rejects(f.client.poll(),{code});assert.equal(f.calls.length,2);assert.equal(await f.client.display(),null);}
});
test('a second poll cannot race the first; uncertain network loss is not replayed',async()=>{
 const entered=deferred(),held=deferred(),h=harness({onToken:async()=>{entered.resolve();return held.promise;}});await start(h);const pending=h.client.poll();await entered.promise;await assert.rejects(h.client.poll(),{code:'polling_in_progress'});await assert.rejects(h.client.start(),{code:'authorization_in_progress'});held.resolve(reply(token()));await pending;
 const f=harness({onToken:async()=>{throw Error('response lost');}});await start(f);await assert.rejects(f.client.poll(),/response lost/);assert.equal(f.calls.length,2);await assert.rejects(f.client.poll(),{code:'no_device_authorization'});
});
test('bad device responses, URI controls and oversized requests are rejected',async()=>{
 for(const patch of [{interval:4},{interval:undefined},{expires_in:601},{expires_in:0},{user_code:'bad\u001b[31m'},{device_code:''},{verification_uri:issuer+'/approve?code=x'},{verification_uri:'https://other.example/approve'},{verification_uri_complete:'https://other.example/approve#BCDF'}]){const h=harness({device:{...authorization,...patch}});await assert.rejects(h.client.start());assert.equal(await h.client.display(),null);}
 const h=harness();await assert.rejects(h.client.start({scope:'openid'}),{code:'invalid_scope'});await assert.rejects(h.client.start({requests:Array(9).fill({})}),{code:'invalid_request'});await assert.rejects(h.client.start({requests:[{purpose:'x'.repeat(9000)}]}),{code:'invalid_request'});assert.equal(h.calls.length,0);
 const f=harness({device:{...authorization,verification_uri_complete:issuer+'/approve#BCDF-GHJK'}}),view=await start(f);assert.equal(view.verificationUri,authorization.verification_uri);assert.equal(JSON.stringify(view).includes('verification_uri_complete'),false);
});
test('Bearer, missing refresh bounds and invalid token metadata are refused and revoked',async()=>{
 for(const patch of [{token_type:'Bearer'},{refresh_token:undefined},{refresh_idle_expires_in:undefined},{expires_in:3601},{issuer:'https://other.example'},{audience:'https://other.example/rpc'},{subject:'https://other.example/entities/alice'},{client_id:'wrong'},{grants:undefined}]){const h=harness({onToken:async()=>reply(token(patch))});await start(h);await assert.rejects(h.client.poll(),{code:'invalid_token_response'});assert.equal(h.confirmations.length,0);assert.equal(h.calls.at(-1).url,manifest.revocation_endpoint);}
});
test('resource requests bind the access token with ath and never replay a write',async()=>{
 const h=harness({onResource:()=>reply({error:'use_dpop_nonce'},401,{'DPoP-Nonce':'rpc-nonce','WWW-Authenticate':'DPoP error="use_dpop_nonce"'})});await signIn(h);const result=await dispatch(h.engine,new DeviceResourceRequest({body:{method:'write'}}));assert.equal(result.response.status,401);assert.equal(h.calls.filter(call=>call.url===manifest.rpc_endpoint).length,1);await h.client.request({method:'read'});assert.equal(h.proofs.at(-1).nonce,'rpc-nonce');h.advance(300001);await assert.rejects(h.client.request({}),{code:'sign_in_required'});
});
test('refresh uses the same key, handles a nonce, rotates once and renews the idle deadline',async()=>{
 let count=0;const h=harness({onRefresh:()=>++count===1?reply({error:'use_dpop_nonce'},400,{'DPoP-Nonce':'refresh-nonce'}):reply(token({refresh_token:'rotated',refresh_expires_in:3600}))});const initial=await signIn(h);h.advance(10000);const renewed=await dispatch(h.engine,new RefreshDeviceSession());assert.equal(renewed.refresh_token,'rotated');assert.equal(renewed.refreshExpiresAt,initial.refreshExpiresAt+10000);assert.equal(h.proofs.at(-1).nonce,'refresh-nonce');assert.equal(h.refreshes,2);assert.equal(await dispatch(h.engine,new RevokeDeviceSession()),true);assert.equal(h.calls.at(-1).body.get('token'),'rotated');await assert.rejects(h.client.refresh(),{code:'sign_in_required'});
});
test('invalid_grant and grant-expanding or Bearer refresh require a new flow',async()=>{
 for(const bad of [()=>reply({error:'invalid_grant'},400),()=>reply(token({token_type:'Bearer',refresh_token:'rotated'})),()=>reply(token({refresh_token:'rotated',grants:['new']}))]){const h=harness({onRefresh:bad});await signIn(h);await assert.rejects(h.client.refresh());await assert.rejects(h.client.request({}),{code:'sign_in_required'});assert.equal(h.refreshes,1);}
});
test('browser clients are refused before transport, while display can be consumed by native TV UI',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');try{Object.defineProperty(globalThis,'document',{configurable:true,value:{}});assert.throws(()=>createDeviceClient({issuer,manifest,clientId}),{code:'browser_not_supported'});}finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});
test('terminal adapter opens only the base URI on Enter, requires typed-code guidance and confirms account',async()=>{
 const {signInFromTerminal}=await import('../../../examples/device-authorization-cli.mjs');
 for(const choice of ['','wait']){const h=harness(),opened=[],writes=[],questions=[],answers=[choice,'y'];const signed=await signInFromTerminal({options:h.options,terminal:{write:text=>writes.push(text),question:async text=>{questions.push(text);return answers.shift();}},openBrowser:async url=>opened.push(url)});assert.equal(signed.session.subject,subject);assert.match(writes.join(''),/Type or paste/);assert.match(writes.join(''),/B C D F G H J K/);assert.match(questions[1],new RegExp(subject));assert.deepEqual(opened,choice===''?[authorization.verification_uri]:[]);await signed.client.dispose();}
 const h=harness(),answers=['wait',''];await assert.rejects(signInFromTerminal({options:h.options,terminal:{write:()=>{},question:async()=>answers.shift()}}),{code:'access_denied'});assert.equal(h.calls.at(-1).url,manifest.revocation_endpoint);
});
test('repeated nonce challenges stop rather than polling forever',async()=>{
 const h=harness({polls:[()=>reply({error:'use_dpop_nonce'},400,{'DPoP-Nonce':'one'}),()=>reply({error:'use_dpop_nonce'},400,{'DPoP-Nonce':'two'})]});await start(h);await assert.rejects(h.client.poll(),{code:'use_dpop_nonce'});assert.equal(h.calls.length,3);assert.deepEqual(h.sleeps,[5000,5000]);
});
test('a nonce challenge needs a valid nonce on that response, not a stale cached one',async()=>{
 const h=harness({polls:[()=>reply({error:'authorization_pending'},400,{'DPoP-Nonce':'cached'}),()=>reply({error:'use_dpop_nonce'},400)]});await start(h);await assert.rejects(h.client.poll(),{code:'use_dpop_nonce'});assert.equal(h.calls.length,3);
});
test('invalid cancellation signals do not strand engine state',async()=>{
 const h=harness();await assert.rejects(h.client.start({signal:'invalid'}));assert.equal(await h.client.display(),null);await h.client.start();await assert.rejects(h.client.poll({signal:'invalid'}));assert.equal(await h.client.display(),null);await h.client.start();await h.client.cancel();
});
test('refresh and resource-proof races cannot pair an old proof with a new token',async()=>{
 const {createKey,createProof}=await import('../src/dpop.mjs'),entered=deferred(),held=deferred();const h=harness({keys:{create:createKey,proof:async(key,options)=>{if(options.accessToken){entered.resolve();await held.promise;}return createProof(key,options);}}});await signIn(h);const request=h.client.request({method:'write'});await entered.promise;await h.client.refresh();held.resolve();await assert.rejects(request,{code:'canceled'});assert.equal(h.calls.filter(call=>call.url===manifest.rpc_endpoint).length,0);
});
test('revocation during refresh prevents a late rotated credential from restoring the session',async()=>{
 const entered=deferred(),held=deferred(),h=harness({onRefresh:async()=>{entered.resolve();return held.promise;}});await signIn(h);const refresh=h.client.refresh();await entered.promise;await assert.rejects(h.client.refresh(),{code:'refresh_in_progress'});await h.client.revoke();held.resolve(reply(token({refresh_token:'late-rotation'})));await assert.rejects(refresh,{code:'canceled'});assert.equal(h.calls.at(-1).body.get('token'),'late-rotation');await assert.rejects(h.client.request({}),{code:'sign_in_required'});
});
test('native Node transport sends no browser headers on the wire and does not follow redirects',async()=>{
 const {createServer,request}=await import('node:http'),{createNodeDeviceFetch}=await import('../../../examples/device-authorization-node-transport.mjs');const received=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({headers:req.headers,body,path:req.url});if(req.url==='/redirect'){res.writeHead(302,{Location:'https://other.example/device'});res.end();}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  // Only the test maps reserved HTTPS endpoints onto a real loopback HTTP socket.
  const fetcher=createNodeDeviceFetch({requester:(url,options,callback)=>request({...options,hostname:'127.0.0.1',port:server.address().port,path:url.pathname},callback)});
  const response=await fetcher(issuer+'/device',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',DPoP:'proof'},body:new URLSearchParams({client_id:clientId}),signal:AbortSignal.timeout(1000)});assert.deepEqual(await response.json(),{ok:true});assert.equal(received[0].headers.origin,undefined);assert.equal(Object.keys(received[0].headers).some(name=>name.startsWith('sec-fetch-')),false);assert.equal(received[0].headers.dpop,'proof');assert.equal(new URLSearchParams(received[0].body).get('client_id'),clientId);
  assert.equal((await fetcher(issuer+'/redirect')).status,302);assert.equal(received.length,2);
  for(const headers of [{Origin:issuer},{'Sec-Fetch-Mode':'cors'}])await assert.rejects(fetcher(issuer+'/device',{headers}),/browser headers/);assert.equal(received.length,2);
 }finally{await new Promise(resolve=>server.close(resolve));}
 assert.throws(()=>createDeviceClient({issuer,manifest,clientId}),{code:'invalid_transport'});
});
