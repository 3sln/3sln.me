// EXT-X3: integration manifest parsing, AMD-C7 confidential clients, key pinning and §2.3 change classification.
// Reserved .example hosts only; the egress port is a fake that records every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {ClientDirectory,validateClientMetadata,validClientSnapshot,memoryLimiter,CLIENT_METADATA_LIMITS} from '../packages/federation/client-metadata.mjs';
import {validateIntegrationManifest,validIntegrationValue,validateJwks,jwkThumbprint,pinnedKeys,integrationSnapshot,classifyIntegrationChange,promotePendingKeys,prefixedURL,createIntegrationsProvider,IntegrationManifest,IntegrationClient,IntegrationRevalidation,PREFERENCES_UPDATED_EVENT,INTEGRATION_LIMITS} from '../packages/federation/integrations.mjs';
import {slotDigest} from '../packages/federation/extensions.mjs';
import {createTestEngine} from './helpers/app-engine.mjs';
import {fakeEgress,body} from './client-metadata-helpers.mjs';

const ID='https://inbox.example/bindle/client.json',JWKS='https://inbox.example/bindle/jwks.json',P='https://inbox.example/bindle/';
const CONTRACT='https://spec.bindle.example/contracts/public-intake/v1',OTHER='https://spec.bindle.example/contracts/other/v1';
const SLOT='https://spec.bindle.example/slots/public-message-intake/v1',CLASSIFIER='https://spec.bindle.example/slots/item-classifier/v1';
const strip=value=>JSON.parse(JSON.stringify(value));
const manifest=(over={})=>strip({v:1,setup:{fragments:[{id:'https://inbox.example/preferences/inbox-settings/v1',required:true,purpose:'Where to store your messages.',fields:['store','retention']}]},management_url:P+'manage',events_endpoint:P+'events',events:[PREFERENCES_UPDATED_EVENT],
 resources:{rpc_endpoint:P+'rpc',discovery_endpoint:P+'resources',contracts:[CONTRACT],dpop:'supported'},extensions:[{slot:SLOT,role:'occupant',ref:'inbox'},{slot:CLASSIFIER,role:'consumer',ref:'triage',purpose:'Sort incoming messages.'}],...over});
const document=(over={},integration=manifest())=>strip({client_id:ID,client_name:'Example Inbox',redirect_uris:[P+'callback'],token_endpoint_auth_method:'private_key_jwt',jwks_uri:JWKS,grant_types:['authorization_code','refresh_token'],response_types:['code'],...integration===undefined?{}:{bindle_integration:integration},...over});
const confidential={clientId:ID,confidential:true,redirectUris:[P+'callback'],jwksUri:JWKS};
const json=(value,headers={},status=200)=>()=>new Response(typeof value==='string'?value:body(value),{status,headers:{'Content-Type':'application/json',...headers}});
async function ecKey(){const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const {kty,crv,x,y}=await webcrypto.subtle.exportKey('jwk',pair.publicKey);return {kty,crv,x,y,use:'sig',alg:'ES256'};}
function directory(documents,{start=Date.UTC(2026,9,20),integrations=true,...options}={}){
 let now=start;const clock=()=>now,egress=fakeEgress(documents);
 const dir=new ClientDirectory({enabled:true,fetch:egress.fetch,clock,limiter:memoryLimiter({clock}),integrations,crypto:webcrypto,reservedHosts:['provider.example'],...options});
 return {dir,egress,advance:ms=>{now+=ms;},calls:url=>egress.calls.filter(call=>call.url===url).length};
}

test('a confidential manifest normalizes to known members only; unknown members are ignored',()=>{
 const result=validateIntegrationManifest(manifest({future_member:{x:1},resources:{...manifest().resources,extra:true}}),confidential);
 assert.equal(result.status,'valid');assert.equal(result.manifest.future_member,undefined);assert.equal(result.manifest.resources.extra,undefined);
 assert.deepEqual(result.manifest.setup.fragments[0],{fragment:'https://inbox.example/preferences/inbox-settings/v1',required:true,purpose:'Where to store your messages.',fields:['store','retention']});
 assert.deepEqual(result.manifest.resources,{rpc_endpoint:P+'rpc',discovery_endpoint:P+'resources',contracts:[CONTRACT],dpop:'supported'});
 assert.equal(result.manifest.extensions.length,2);assert.equal(validateIntegrationManifest(result.manifest,confidential).status,'valid');
 assert.deepEqual(validateIntegrationManifest(result.manifest,confidential),result,'normalization is idempotent, so snapshots re-derive');
 const defaults=validateIntegrationManifest(manifest({events:undefined,resources:{rpc_endpoint:P+'rpc',discovery_endpoint:P+'resources',contracts:[CONTRACT]}}),confidential).manifest;
 assert.deepEqual(defaults.events,[PREFERENCES_UPDATED_EVENT]);assert.equal(defaults.resources.dpop,'none');
 assert.deepEqual(validateIntegrationManifest(undefined,confidential),{status:'absent'});
});

test('hostile manifests: foreign origins, path-prefix escapes, collisions and confidential members in public clients',()=>{
 for(const url of ['https://evil.example/bindle/events','https://inbox.example/other/events','https://inbox.example/bindle/../admin','https://inbox.example/bindle/%2e%2e/admin','https://inbox.example/bindle/a%2fb','https://inbox.example/bindle/x?y=1','https://inbox.example/bindle/x#f','https://u:p@inbox.example/bindle/x','http://inbox.example/bindle/x','https://inbox.example:8443/bindle/x','https://INBOX.example/bindle/x','https://inbox.example/bindle\\x','https://inbox.example/bindle/'+'a'.repeat(2100)]){
  assert.equal(prefixedURL(url,ID),undefined,url);const m=validateIntegrationManifest(manifest({management_url:url,events_endpoint:url}),confidential).manifest;assert.equal(m.management_url,undefined,url);assert.equal(m.events_endpoint,undefined,url);
 }
 assert.equal(validateIntegrationManifest(manifest({resources:{...manifest().resources,rpc_endpoint:'https://evil.example/rpc'}}),confidential).manifest.resources,undefined,'invalid resources means no brokered resources');
 assert.equal(validateIntegrationManifest(manifest({resources:{...manifest().resources,contracts:[]}}),confidential).manifest.resources,undefined);
 assert.equal(validateIntegrationManifest(manifest({resources:{...manifest().resources,dpop:'optional'}}),confidential).manifest.resources,undefined);
 assert.deepEqual(validateIntegrationManifest(manifest({events_endpoint:P+'rpc'}),confidential),{status:'invalid',reason:'endpoint_collision'});
 assert.deepEqual(validateIntegrationManifest(manifest({resources:{...manifest().resources,discovery_endpoint:P+'rpc'}}),confidential),{status:'invalid',reason:'endpoint_collision'});
 assert.deepEqual(validateIntegrationManifest(manifest({management_url:P+'events'}),confidential),{status:'invalid',reason:'endpoint_collision'});
 const pub={clientId:ID,redirectUris:[P+'callback']};
 for(const over of [{events_endpoint:P+'events'},{resources:'garbage'},{extensions:[{slot:SLOT,role:'occupant',ref:'inbox'}]}])assert.deepEqual(validateIntegrationManifest({v:1,...over},pub),{status:'invalid',reason:'confidential_required'},JSON.stringify(over));
 assert.equal(validateIntegrationManifest({v:1,extensions:[{slot:CLASSIFIER,role:'consumer',ref:'triage'}],management_url:P+'manage'},pub).status,'valid','public clients may declare setup and consumers');
 assert.deepEqual(validateIntegrationManifest({v:1},{...pub,redirectUris:['https://inbox.example/elsewhere/cb']}),{status:'invalid',reason:'path_prefix'});
 assert.deepEqual(validateIntegrationManifest({v:1},{...confidential,jwksUri:'https://inbox.example/keys.json'}),{status:'invalid',reason:'path_prefix'});
 assert.deepEqual(validateIntegrationManifest({v:1},{...pub,clientId:'https://provider.example/bindle/c.json',redirectUris:[],reserved:['provider.example']}),{status:'invalid',reason:'issuer_origin'});
 assert.deepEqual(validateIntegrationManifest({v:1},{...pub,clientId:'https://sub.provider.example/c.json',redirectUris:[],reserved:['provider.example']}),{status:'invalid',reason:'issuer_origin'});
 for(const v of [0,'1',1.5,null,undefined,-2])assert.deepEqual(validateIntegrationManifest({v},pub),{status:'invalid',reason:'invalid_version'},String(v));
 assert.deepEqual(validateIntegrationManifest({v:2,anything:true},pub),{status:'unrecognized',v:2});
 for(const value of [null,[],'x',7])assert.equal(validateIntegrationManifest(value,pub).status,'invalid');
 assert.deepEqual(validateIntegrationManifest(manifest({padding:'x'.repeat(INTEGRATION_LIMITS.manifestBytes)}),confidential),{status:'invalid',reason:'manifest_too_large'},'the 8 KiB bound counts unknown members too');
 const hostile=JSON.parse('{"v":1,"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"setup":{"fragments":[{"id":"https://inbox.example/f/v1","purpose":"Bank‮ppa","fields":["a"]}]}}');
 const parsed=validateIntegrationManifest(hostile,pub);assert.equal(parsed.status,'valid');assert.equal(parsed.manifest.setup,undefined,'bidi text invalidates setup');assert.equal({}.admin,undefined);assert.deepEqual(Object.keys(parsed.manifest),['v']);
 for(const fragments of [Array(9).fill({id:'https://inbox.example/f/v1',purpose:'p',fields:['a']}),[{id:'https://inbox.example/f/v1',purpose:'p',fields:[]}],[{id:'https://inbox.example/f/v1',fragment:'https://inbox.example/g/v1',purpose:'p',fields:['a']}],[{id:'https://inbox.example/f/v1',purpose:'p',fields:['a'],methods:{[CONTRACT]:'deliver'}}],[{id:'https://inbox.example/f/v1',purpose:'p',fields:['a'],digest:'sha1-x'}],[{id:'https://inbox.example/f/v1',purpose:'p',fields:['a']},{fragment:'https://inbox.example/f/v1',purpose:'q',fields:['b']}]])
  assert.equal(validateIntegrationManifest({v:1,setup:{fragments}},pub).manifest.setup,undefined,JSON.stringify(fragments).slice(0,80));
 assert.deepEqual(validateIntegrationManifest({v:1,get management_url(){throw new Error('getter');}},pub),{status:'invalid',reason:'invalid_manifest'},'a throwing accessor is reported invalid, never propagated');
});

test('extension claims: syntax-only without pins, and validated against trusted slot pins when supplied',async()=>{
 const slot={id:SLOT,title:'Intake',description:'Public intake',publisher:'https://spec.bindle.example/',fields:{target:{title:'Target',type:'resource',cardinality:{min:0,max:1},contracts:[CONTRACT]}},slot:{v:1,field:'target',selection:'exclusive',consumers:['application','provider']}};
 const digest=await slotDigest(webcrypto,slot),slots=new Map([[SLOT,{schema:slot,digest}]]);
 const entries=[{slot:SLOT,role:'occupant',ref:'inbox',digest},{slot:SLOT,role:'occupant',ref:'bad',digest:'sha256-'+'A'.repeat(43)},{slot:SLOT,role:'occupant',ref:'Bad Ref'},{slot:'http://spec.bindle.example/s',role:'consumer',ref:'x'},{slot:CLASSIFIER,role:'consumer',ref:'triage',required:true,purpose:'Sort.'},{slot:CLASSIFIER,role:'consumer',ref:'triage'}];
 const plain=validateIntegrationManifest({v:1,extensions:entries},confidential).manifest.extensions;
 assert.deepEqual(plain.map(e=>e.ref),['inbox','bad'],'malformed and duplicate triples are dropped; unfetched slots stay unknown');
 const pinned=validateIntegrationManifest({v:1,extensions:entries},{...confidential,slots}).manifest.extensions;
 assert.deepEqual(pinned.map(e=>e.ref),['inbox'],'a digest mismatch against the trusted pin is dropped');
 assert.equal(validateIntegrationManifest({v:1,extensions:Array(33).fill(entries[0])},confidential).manifest.extensions,undefined,'over-long arrays are ignored');
 const providerOnly={...slot,slot:{...slot.slot,consumers:['provider']}};
 assert.equal(validateIntegrationManifest({v:1,extensions:[{slot:SLOT,role:'consumer',ref:'c'}]},{...confidential,slots:new Map([[SLOT,{schema:providerOnly,digest:await slotDigest(webcrypto,providerOnly)}]])}).manifest.extensions,undefined,'apps cannot claim provider-only consumption');
});

test('AMD-C7: confidential clients only with integrations.v1; origin/path-bound jwks_uri; secrets and inline keys always refused',()=>{
 const doc=document();
 assert.throws(()=>validateClientMetadata(doc,ID),{code:'invalid_client'},'without integrations.v1 a confidential document is refused outright');
 const client=validateClientMetadata(doc,ID,{integrations:true});
 assert.equal(client.authMethod,'private_key_jwt');assert.equal(client.jwksUri,JWKS);assert.equal(client.integration.status,'valid');assert.equal(client.reviewed,false);
 for(const over of [{jwks_uri:'https://evil.example/bindle/jwks.json'},{jwks_uri:'https://inbox.example/jwks.json'},{jwks_uri:undefined},{jwks_uri:ID},{jwks_uri:JWKS+'?x'},{jwks:{keys:[]}},{client_secret:'s'},{token_endpoint_auth_method:'client_secret_basic'},{token_endpoint_auth_method:'none'},{token_endpoint_auth_method:'private_key_jwt',redirect_uris:['https://inbox.example/callback']},{jwks_uri:'https://inbox.example/bindle/'+'k'.repeat(200)}])
  assert.throws(()=>validateClientMetadata(document(over),ID,{integrations:true}),{code:'invalid_client'},JSON.stringify(over).slice(0,90));
 const pub=validateClientMetadata(document({token_endpoint_auth_method:'none',jwks_uri:undefined},{v:1,management_url:P+'manage'}),ID,{integrations:true});
 assert.equal(pub.authMethod,undefined);assert.equal(pub.integration.status,'valid');
 assert.deepEqual(validateClientMetadata(document({token_endpoint_auth_method:'none',jwks_uri:undefined}),ID,{integrations:true}).integration,{status:'invalid',reason:'confidential_required'},'a public document cannot carry confidential manifest members');
 assert.deepEqual(validateClientMetadata(doc,ID,{integrations:true,sharedHost:true}).integration,{status:'invalid',reason:'shared_host'});
 const off=validateClientMetadata(document({token_endpoint_auth_method:'none',jwks_uri:undefined}),ID);assert.equal(off.integration,undefined,'without integrations the member is not even parsed');
});

test('client snapshots re-derive exactly; a manifest that disagrees with its client fields is rejected',()=>{
 const client=validateClientMetadata(document(),ID,{integrations:true});
 assert.equal(validClientSnapshot(client,{integrations:true}),true);assert.equal(validClientSnapshot(client),false,'integration members need the integrations flag');
 const tamper=(fn)=>{const copy=structuredClone(client);fn(copy);return validClientSnapshot(copy,{integrations:true});};
 assert.equal(tamper(c=>{c.integration.manifest.events_endpoint='https://evil.example/events';}),false);
 assert.equal(tamper(c=>{c.integration.manifest.granted=true;}),false);
 assert.equal(tamper(c=>{delete c.authMethod;delete c.jwksUri;}),false,'confidential manifest on a public snapshot');
 assert.equal(tamper(c=>{c.jwksUri='https://inbox.example/bindle/other.json';}),true,'a different in-prefix key URL is still a valid shape; the pin, not the snapshot, carries continuity');
 assert.equal(tamper(c=>{c.jwksUri='https://evil.example/bindle/jwks.json';}),false);
 assert.equal(tamper(c=>{c.authMethod='none';}),false);
 assert.equal(tamper(c=>{c.integration={status:'invalid',reason:'manifest_invalid'};}),true);
 assert.equal(tamper(c=>{c.integration={status:'invalid',reason:'<script>'};}),false);
 assert.equal(tamper(c=>{c.integration={status:'unrecognized',v:1};}),false);
 assert.equal(validIntegrationValue({status:'valid',manifest:{v:1},extra:1},{clientId:ID}),false);
});

test('key sets: private members reject the set; unusable keys are skipped; thumbprints follow RFC 7638',async()=>{
 const a=await ecKey(),b=await ecKey();
 const set=await validateJwks(webcrypto,{keys:[a,b,{...a,kid:'dup'},{kty:'EC',crv:'P-256',x:'A'.repeat(43),y:'A'.repeat(43)},{...b,use:'enc'},{kty:'RSA',n:'short',e:'AQAB'},{kty:'OKP',crv:'X25519',x:'A'.repeat(43)}]});
 assert.equal(set.keys.length,2,'duplicates, off-curve points, encryption keys, weak RSA and non-signing curves are skipped');
 assert.deepEqual(set.thumbprints,[await jwkThumbprint(webcrypto,a),await jwkThumbprint(webcrypto,b)].sort());
 // RFC 7638 §3.1 example.
 const rsa={kty:'RSA',n:'0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',e:'AQAB',alg:'RS256',kid:'2011-04-29'};
 assert.equal(await jwkThumbprint(webcrypto,rsa),'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
 for(const bad of [{keys:[{...a,d:'x'}]},{keys:[a,{kty:'oct',k:'secret'}]},{keys:[]},{keys:Array(17).fill(a)},{},null,{keys:[{...b,use:'enc'}]}])assert.equal(await validateJwks(webcrypto,bad),null,JSON.stringify(bad)?.slice(0,60));
 assert.deepEqual(pinnedKeys(set,[set.thumbprints[0]]).map(k=>k.thumbprint),[set.thumbprints[0]]);assert.deepEqual(pinnedKeys(set,undefined),[]);
});

test('directory: documents and key sets share the SSRF egress, budgets, bounds and per-client cache',async()=>{
 const key=await ecKey(),jwks={keys:[key]};
 const {dir,egress,advance,calls}=directory({[ID]:json(document(),{'Cache-Control':'max-age=600'}),[JWKS]:json(jwks,{'Content-Type':'application/jwk-set+json','Cache-Control':'max-age=900'})});
 const client=await dir.resolve(ID);assert.equal(client.integration.status,'valid');assert.ok(validClientSnapshot(client,{integrations:true}));
 const keys=await dir.resolveKeys(client);assert.equal(keys.thumbprints.length,1);
 assert.deepEqual(egress.calls.map(c=>[c.url,c.init.redirect,c.init.credentials,c.init.method]),[[ID,'manual','omit','GET'],[JWKS,'manual','omit','GET']]);
 await dir.resolveKeys(client);advance(899_000);await dir.resolveKeys(client);assert.equal(calls(JWKS),1,'fresh key sets are served from cache');
 advance(2_000);await dir.resolveKeys(client);assert.equal(calls(JWKS),2,'expired key sets are refetched');
 const twin='https://inbox.example/bindle/twin.json';
 const shared=directory({[twin]:json(document({client_id:twin})),[ID]:json(document()),[JWKS]:json(jwks)});await shared.dir.resolveKeys(await shared.dir.resolve(twin));
 await shared.dir.resolveKeys(await shared.dir.resolve(ID));assert.equal(shared.calls(JWKS),2,'cache entries are keyed by (client_id, jwks_uri), never by URL alone');
 await assert.rejects(dir.resolveKeys({id:ID,authMethod:'private_key_jwt',jwksUri:'https://evil.example/bindle/jwks.json'}),{code:'invalid_client'},'a caller-supplied key URL that differs from the resolved client is never fetched');
 await assert.rejects(dir.resolveKeys({id:ID,authMethod:'none'}),{code:'invalid_client'});
 const off=directory({[ID]:json(document())},{integrations:false});await assert.rejects(off.dir.resolve(ID),{code:'invalid_client'},'integrations off refuses confidential documents');await assert.rejects(off.dir.resolveKeys(client),{code:'invalid_client'});
 dir.invalidate('inbox.example');await dir.resolveKeys(client);assert.equal(calls(JWKS),3,'administrator invalidation drops cached key sets');
});

test('directory: oversized, mistyped, redirected and slow key sets are transient or replaced, never trusted',async()=>{
 const key=await ecKey(),big={keys:[{...key,kid:'x'.repeat(100)}],pad:'x'.repeat(CLIENT_METADATA_LIMITS.maxBytes)};
 const cases=[[json(big),undefined],[json({keys:[key]},{'Content-Type':'text/html'}),undefined],[json({keys:[key]},{Location:'https://evil.example/k'},302),undefined],[json('{"keys":[',{}),undefined],[json('gone',{},404),null],[json('gone',{},410),null],[json({keys:[{...key,d:'leak'}]}),null],[json('oops',{},503),undefined],[json({keys:[key]},{'Content-Length':'99999999'}),undefined]];
 for(const [response,expected] of cases){const {dir}=directory({[ID]:json(document()),[JWKS]:response});assert.equal(await dir.resolveKeys(await dir.resolve(ID)),expected);}
 const slow=directory({[ID]:json(document()),[JWKS]:init=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted'))))},{limits:{timeoutMs:20}});
 assert.equal(await slow.dir.resolveKeys(await slow.dir.resolve(ID)),undefined,'deadline exceeded is transient');
 const oversized=directory({[ID]:json({...document(),pad:'x'.repeat(CLIENT_METADATA_LIMITS.maxBytes)})});await assert.rejects(oversized.dir.resolve(ID),{code:'invalid_client'},'documents stay within the 16 KiB client-metadata bound');
 const budget=directory({[ID]:json(document()),[JWKS]:json({keys:[key]})},{limits:{perHost:{windowMs:60000,limit:1}}});const c=await budget.dir.resolve(ID);
 assert.equal(await budget.dir.resolveKeys(c),undefined,'key fetches spend the same per-site budget as documents');assert.equal(budget.calls(JWKS),0);
 const blocked=directory({[ID]:json(document()),[JWKS]:json({keys:[key]})},{blocked:async host=>host==='inbox.example'});await assert.rejects(blocked.dir.resolveKeys({id:ID,authMethod:'private_key_jwt',jwksUri:JWKS}),{code:'invalid_client'});assert.equal(blocked.calls(JWKS),0);
});

test('key pinning: rotation with overlap is adopted; replacement or a jwks_uri change is staged and adopts nothing',async()=>{
 const a=await ecKey(),b=await ecKey(),c=await ecKey(),docs={[ID]:json(document(),{'Cache-Control':'max-age=300'}),[JWKS]:json({keys:[a]},{'Cache-Control':'max-age=300'})};
 const {dir,advance}=directory(docs),client=await dir.resolve(ID),pin=integrationSnapshot(client,await dir.resolveKeys(client));
 assert.equal(pin.thumbprints.length,1);assert.equal((await dir.revalidateIntegration(ID,pin)).decision,'unchanged');
 docs[JWKS]=json({keys:[a,b]},{'Cache-Control':'max-age=300'});advance(301_000);
 const added=await dir.revalidateIntegration(ID,pin);assert.equal(added.decision,'adopt');assert.deepEqual(added.changes,['keys_pending']);
 assert.equal(added.next.thumbprints.length,1,'X3-S1: an added public key is pending, never pinned on appearance');assert.equal(added.next.pendingThumbprints.length,1);
 assert.deepEqual(promotePendingKeys(added.next,{signedBy:added.next.pendingThumbprints[0]}),added.next,'the new key cannot vouch for itself');
 const rotated={next:promotePendingKeys(added.next,{signedBy:pin.thumbprints[0]})};assert.equal(rotated.next.thumbprints.length,2);assert.equal(rotated.next.pendingThumbprints,undefined);
 docs[JWKS]=json({keys:[c]},{'Cache-Control':'max-age=300'});docs[ID]=json(document({},manifest({management_url:P+'manage2',events_endpoint:P+'events2'})),{'Cache-Control':'max-age=300'});advance(301_000);
 const replaced=await dir.revalidateIntegration(ID,rotated.next);assert.equal(replaced.decision,'review');assert.ok(replaced.changes.includes('keys_replaced'));
 assert.deepEqual(replaced.next,rotated.next,'an unknown key set adopts no endpoint move (expired-domain takeover)');assert.equal(replaced.staged.manifest.events_endpoint,P+'events2');
 assert.equal(pinnedKeys(await dir.resolveKeys(await dir.resolve(ID)),replaced.next.thumbprints).length,0,'no pinned key: nothing may authenticate the client');
 // X3-S1 PoC: a takeover domain republishes the archived public key next to its own and moves endpoints.
 const evil=await ecKey();docs[JWKS]=json({keys:[a,evil]},{'Cache-Control':'max-age=300'});advance(301_000);
 const copied=await dir.revalidateIntegration(ID,pin);assert.deepEqual(copied.changes,['keys_pending']);assert.deepEqual(copied.next.manifest,pin.manifest,'no endpoint move while keys are pending');
 assert.deepEqual(pinnedKeys(await dir.resolveKeys(await dir.resolve(ID)),copied.next.thumbprints).map(k=>k.thumbprint),pin.thumbprints,'the attacker key never authenticates');
 docs[JWKS]=json({keys:[evil]},{'Cache-Control':'max-age=300'});advance(301_000);assert.equal((await dir.revalidateIntegration(ID,copied.next)).decision,'review','dropping the copied key is a replacement');
 docs[JWKS]=json({keys:[b]},{'Cache-Control':'max-age=300'});docs[ID]=json(document(),{'Cache-Control':'max-age=300'});advance(301_000);
 const dropped=await dir.revalidateIntegration(ID,rotated.next);assert.deepEqual(dropped.changes,['keys_removed']);assert.equal(dropped.next.thumbprints.length,1);
 docs[ID]=json(document({jwks_uri:P+'keys2.json'}),{'Cache-Control':'max-age=300'});docs[P+'keys2.json']=json({keys:[a,b]});advance(301_000);
 const moved=await dir.revalidateIntegration(ID,rotated.next);assert.equal(moved.decision,'review');assert.deepEqual(moved.changes,['identity_changed']);assert.deepEqual(moved.next,rotated.next);
 docs[ID]=json(document({redirect_uris:[P+'callback',P+'callback2']}),{'Cache-Control':'max-age=300'});advance(301_000);
 assert.deepEqual((await dir.revalidateIntegration(ID,rotated.next)).changes,['identity_changed'],'redirect URI changes are identity changes');
});

test('§2.3 classification: narrowing adopted, widening staged, transient failures change nothing, 404 invalidates',async()=>{
 const key=await ecKey(),docs={[ID]:json(document()),[JWKS]:json({keys:[key]})};
 const {dir,advance}=directory(docs),client=await dir.resolve(ID),keys=await dir.resolveKeys(client),pin=integrationSnapshot(client,keys);
 const next=(integration,over={})=>classifyIntegrationChange(pin,{client:validateClientMetadata(document(over,integration),ID,{integrations:true})},keys);
 const wide=manifest({resources:{...manifest().resources,contracts:[CONTRACT,OTHER]}});pin.manifest.resources.contracts=[CONTRACT,OTHER];
 const narrowed=next(manifest());assert.equal(narrowed.decision,'adopt');assert.deepEqual(narrowed.changes,['contracts_narrowed']);assert.deepEqual(narrowed.next.manifest.resources.contracts,[CONTRACT]);
 pin.manifest.resources.contracts=[CONTRACT];
 const widened=next(wide);assert.equal(widened.decision,'review');assert.deepEqual(widened.next.manifest.resources.contracts,[CONTRACT],'the pinned list governs until approval');
 assert.deepEqual(next(manifest({resources:{...manifest().resources,dpop:'none'}})).changes,['dpop_weakened']);
 const strong=next(manifest({resources:{...manifest().resources,dpop:'required'}}));assert.equal(strong.decision,'adopt');assert.equal(strong.next.manifest.resources.dpop,'required');
 const moved=next(manifest({resources:{...manifest().resources,rpc_endpoint:P+'rpc2'},management_url:P+'m2'}));assert.equal(moved.decision,'adopt');assert.deepEqual(moved.changes.sort(),['management_url_changed','rpc_endpoint_changed']);
 for(const integration of [manifest({setup:{fragments:[]}}),manifest({extensions:[]}),manifest({events:[]}),manifest({setup:{fragments:[{id:'https://inbox.example/f/v2',purpose:'New.',fields:['a']}]}})])assert.equal(next(integration).decision,'review');
 assert.deepEqual(next(manifest({resources:undefined})).changes,['resources_removed']);assert.equal(next(manifest({events_endpoint:undefined,events:undefined})).decision,'adopt');
 const pubPin={...pin,manifest:{v:1}};assert.ok(classifyIntegrationChange(pubPin,{client:validateClientMetadata(document(),ID,{integrations:true})},keys).changes.includes('resources_added'));
 assert.deepEqual(next({v:3}).decision,'review');assert.deepEqual(next({v:3}).next,pin,'an unknown version keeps the pin and never degrades');
 const removed=classifyIntegrationChange(pin,{client:validateClientMetadata(strip({...document(),bindle_integration:undefined}),ID,{integrations:true})},keys);assert.equal(removed.decision,'invalid');assert.deepEqual(removed.changes,['manifest_removed']);assert.equal(next({v:1,management_url:P+'events',events_endpoint:P+'events'}).decision,'invalid','a colliding manifest is invalid');
 assert.equal(classifyIntegrationChange(pin,{client:{...validateClientMetadata(document(),ID,{integrations:true}),id:'https://inbox.example/bindle/other.json'}},keys).decision,'invalid','a pin never follows another client');
 assert.equal(classifyIntegrationChange(pin,{client:validateClientMetadata(document(),ID,{integrations:true})},undefined).decision,'unchanged','a transient key failure changes nothing');
 docs[ID]=json('down',{},503);advance(CLIENT_METADATA_LIMITS.maxMs+1);assert.equal((await dir.revalidateIntegration(ID,pin)).decision,'unchanged','transient fetch failure keeps the pin');
 docs[ID]=json('gone',{},404);advance(CLIENT_METADATA_LIMITS.negativeMs+1);const gone=await dir.revalidateIntegration(ID,pin);assert.equal(gone.decision,'invalid');assert.deepEqual(gone.changes,['client_gone']);
 await assert.rejects(dir.revalidateIntegration(ID,{...pin,clientId:'https://inbox.example/bindle/x.json'}),{code:'invalid_client'});
});

test('reviewed static registrations keep working and are never fetched; their manifest is validated, never passed raw',async()=>{
 const reviewed={id:'https://reviewed.example/app/client',name:'Reviewed',origin:'https://reviewed.example',redirectUris:['https://reviewed.example/app/cb']};
 const withManifest={...reviewed,id:'https://reviewed.example/app/two',bindle_integration:{v:1,management_url:'https://reviewed.example/app/manage',events_endpoint:'https://reviewed.example/app/events'},authMethod:'private_key_jwt',jwksUri:'https://reviewed.example/app/jwks.json'};
 const on=directory({},{clients:[reviewed,withManifest]});assert.deepEqual(await on.dir.resolve(reviewed.id),reviewed);
 const two=await on.dir.resolve(withManifest.id);assert.equal(two.bindle_integration,undefined);assert.equal(two.integration.status,'valid');assert.equal(two.integration.manifest.events_endpoint,'https://reviewed.example/app/events');assert.equal(two.authMethod,'private_key_jwt');
 assert.equal(on.egress.calls.length,0);
 const {authMethod,jwksUri,...publicManifest}=withManifest;
 const off=directory({},{clients:[reviewed,{...publicManifest,bindle_integration:{v:1}}],integrations:false});const plain=await off.dir.resolve(withManifest.id);assert.equal(plain.bindle_integration,undefined);assert.equal(plain.integration,undefined);
 // X3-S5: declared client authentication that cannot be honored fails construction instead of downgrading.
 assert.throws(()=>directory({},{clients:[withManifest],integrations:false}),TypeError);
 assert.throws(()=>directory({},{clients:[{...withManifest,jwksUri:'https://other.example/jwks.json'}]}),TypeError);assert.throws(()=>directory({},{clients:[{...withManifest,authMethod:'client_secret_basic'}]}),TypeError);
 assert.deepEqual((await directory({},{clients:[{...publicManifest}]}).dir.resolve(withManifest.id)).integration,{status:'invalid',reason:'confidential_required'});
 const issuerHosted=directory({},{clients:[{...publicManifest,id:'https://provider.example/app/c',redirectUris:[],bindle_integration:{v:1}}]});assert.deepEqual((await issuerHosted.dir.resolve('https://provider.example/app/c')).integration,{status:'invalid',reason:'issuer_origin'});
 const shared=directory({['https://tenant.host.example/app/c.json']:json(document({client_id:'https://tenant.host.example/app/c.json',redirect_uris:['https://tenant.host.example/app/cb'],jwks_uri:'https://tenant.host.example/app/jwks.json'},{v:1}))},{sharedHosts:['host.example']});
 assert.deepEqual((await shared.dir.resolve('https://tenant.host.example/app/c.json')).integration,{status:'invalid',reason:'shared_host'});
});

test('X3-S3/S4: an invalid 200 document invalidates; validated key sets survive budget floods and transient failures',async()=>{
 const key=await ecKey(),docs={[ID]:json(document()),[JWKS]:json({keys:[key]},{'Cache-Control':'max-age=300'})};
 const {dir,advance,calls}=directory(docs),client=await dir.resolve(ID),keys=await dir.resolveKeys(client),pin=integrationSnapshot(client,keys);
 docs[JWKS]=json('down',{},503);advance(301_000);assert.deepEqual(await dir.resolveKeys(client),keys,'a transient failure serves the last validated set');
 advance(CLIENT_METADATA_LIMITS.negativeMs+1);assert.deepEqual(await dir.resolveKeys(client),keys,'and never overwrote it');assert.equal(calls(JWKS),3);
 advance(3_600_000);assert.equal(await dir.resolveKeys(client),undefined,'stale grace is bounded to one hour');
 const flood=directory({[ID]:json(document(),{'Cache-Control':'max-age=300'}),[JWKS]:json({keys:[key]},{'Cache-Control':'max-age=300'})},{limits:{perHost:{windowMs:600000,limit:2}}});const c=await flood.dir.resolve(ID),k=await flood.dir.resolveKeys(c);
 flood.advance(301_000);assert.deepEqual(await flood.dir.resolveKeys(c),k,'budget refusal serves the stale validated set');
 docs[ID]=json(document({client_secret:'now-a-secret'}));advance(CLIENT_METADATA_LIMITS.maxMs+1);const invalid=await dir.revalidateIntegration(ID,pin);
 assert.equal(invalid.decision,'invalid');assert.deepEqual(invalid.changes,['client_invalid']);
});

test('engine harness: gated manifest, client and revalidation Queries over an injected integrations provider',async t=>{
 const key=await ecKey(),{dir}=directory({[ID]:json(document()),[JWKS]:json({keys:[key]})}),provider=createIntegrationsProvider({directory:dir});
 const e=await createTestEngine({providers:{config:{INTEGRATIONS_ENABLED:'true'},integrations:provider}});t.after(()=>e.dispose());
 assert.equal((await e.read(new IntegrationManifest({input:{manifest:manifest(),...confidential}}))).status,'valid');
 const client=await e.read(new IntegrationClient({input:{clientId:ID}}));const pin=integrationSnapshot(client,await dir.resolveKeys(client));
 assert.equal((await e.read(new IntegrationRevalidation({input:{clientId:ID,pinned:pin}}))).decision,'unchanged');
 const disabled=await createTestEngine({providers:{config:{INTEGRATIONS_ENABLED:'false'},integrations:provider}});t.after(()=>disabled.dispose());
 for(const query of [new IntegrationManifest({input:{manifest:manifest(),...confidential}}),new IntegrationClient({input:{clientId:ID}}),new IntegrationRevalidation({input:{clientId:ID,pinned:pin}})])await assert.rejects(disabled.read(query),{code:'integrations_disabled'});
 const noFlag=await createTestEngine({providers:{config:{INTEGRATIONS_ENABLED:'true'},integrations:createIntegrationsProvider({directory:directory({},{integrations:false}).dir})}});t.after(()=>noFlag.dispose());
 await assert.rejects(noFlag.read(new IntegrationClient({input:{clientId:ID}})),{code:'integrations_disabled'},'a directory without integrations.v1 cannot be used through the provider');
 assert.throws(()=>integrationSnapshot({...client,integration:{status:'invalid',reason:'x'}},null),{code:'invalid_integration'});assert.throws(()=>integrationSnapshot(client,null),{code:'invalid_integration'});
});
