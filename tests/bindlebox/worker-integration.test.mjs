import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTestEngine,memoryStore} from './helpers/engine.mjs';
import {party,claimsFor,world,NOW} from './vectors/fixtures.mjs';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
import {ReceiveDomain} from '../../packages/bindlebox-engine/store/mailbox.mjs';
import {SHELL_OPERATIONS} from '../../apps/bindlebox/worker/operations.mjs';
import {INTEGRATION_OPERATIONS,resourceId} from '../../apps/bindlebox/worker/integration.mjs';
import {sealedDelegateKeys} from '../../apps/bindlebox/worker/delegate-keys.mjs';
import {clientMetadata,metadataPort} from '../../apps/bindlebox/worker/metadata.mjs';
import {createHTTP} from '../../apps/bindlebox/worker/http.mjs';
import {SqliteMailboxStore} from '../../apps/bindlebox/node/storage.mjs';
import {bridgeConsumer} from './receive-fixtures.test.mjs';
import {validateSlotManifest,slotDigest} from '../../packages/federation/extensions.mjs';
import {validateIntegrationManifest} from '../../packages/federation/integrations.mjs';
const vectors=JSON.parse(await readFile(new URL('./vectors/vectors.json',import.meta.url))),alice=await party('alice',vectors.keys),owner=alice.principal.subject,config={principal:alice.principal,ingress:alice.ingress,plan:'free'},resource=resourceId(config),encoder=new TextEncoder();
const grant={revision:1,active:true,recipients:[],connection:'connection-1',generation:3},verified={owner,issuer:alice.principal.issuer,connection:grant.connection,generation:3,purpose:'invoke',resource,grant:'grant-1',methods:['describe','linkRevoked','deliver'],consumer:'https://bridge.example',live:true};
function engine(t,{providers={}}={}){const h=createTestEngine({owner,store:memoryStore([['owner',owner],['config',config],['shell:authorization',grant]]),registry:{...SHELL_OPERATIONS,...INTEGRATION_OPERATIONS},providers:{receive:ReceiveDomain,providerLink:null,...providers}});t.after(()=>h.dispose());return h;}
const event=(type,payload,over={})=>({owner,issuer:alice.principal.issuer,connection:grant.connection,jti:crypto.randomUUID(),seq:1,type,payload,...over});

test('BB-B8 client metadata carries a confidential integration manifest and exact pinned slot documents',async()=>{
 const client=clientMetadata();assert.equal(client.token_endpoint_auth_method,'private_key_jwt');
 const slots=new Map();for(const name of ['messaging-ingress','public-message-intake','item-classifier']){const schema=JSON.parse(await readFile(new URL(`../../apps/bindlebox/slots/${name}-v1.json`,import.meta.url))),contracts={'https://spec.bindle.example/contracts/decision-model/v1':{digest:'test-only-contract-pin',schema:{$id:'https://spec.bindle.example/contracts/decision-model/v1','x-methods':{decide:{effect:'pure'}}}}};assert.equal(validateSlotManifest(schema,schema.id,{contracts}).status,'valid');slots.set(schema.id,{schema,digest:await slotDigest(crypto,schema)});}
 for(const entry of client.bindle_integration.extensions)assert.equal(entry.digest,slots.get(entry.slot).digest);
 const parsed=validateIntegrationManifest(client.bindle_integration,{clientId:client.client_id,confidential:true,slots,contracts:{'https://spec.bindle.example/contracts/decision-model/v1':{digest:'test-only-contract-pin',schema:{$id:'https://spec.bindle.example/contracts/decision-model/v1','x-methods':{decide:{effect:'pure'}}}}}});assert.equal(parsed.status,'valid');assert.equal(parsed.manifest.extensions.length,3);
 assert.equal((await metadataPort()('/bindle/client.json')).bindle_integration.v,1);
 await assert.rejects(metadataPort()('/bindle/jwks.json'),e=>e.code==='recipient_unavailable');
 const publicSet=await metadataPort({services:{publicJwks:async()=>({keys:[{...alice.identity.publicJwk,kid:'client-1',untrusted:'omitted'}]})}})('/bindle/jwks.json');assert.equal(publicSet.keys[0].untrusted,undefined);assert.equal(publicSet.keys[0].alg,'ES256');
 await assert.rejects(metadataPort({services:{publicJwks:async()=>({keys:[{...vectors.keys.alice.identity,kid:'private'}]})}})('/bindle/jwks.json'),e=>e.code==='recipient_unavailable');
});

test('BB-B8 delegation renewal seals one key, verifies provider certificates and persists the half-life alarm',async t=>{
 const h=engine(t),secret=B.base64url(new Uint8Array(32).fill(7)),clientId='https://alice.box.example/client.json',directory=world({alice});let calls=0,firstJkt;
 const certify=async({owner:subject,input,renew})=>{
  assert.equal(subject,owner);assert.equal(renew,calls>0);const jkt=await B.thumbprint(input.delegate);firstJkt??=jkt;assert.equal(jkt,firstJkt);
  const publicKey=await B.importVerifyKey(input.delegate),pop=encoder.encode('bindle-key-delegation-pop-v1\n'+JSON.stringify({aud:alice.principal.issuer,client_id:clientId,iat:input.proof.iat,jkt,sub:owner}));
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,B.fromBase64url(input.proof.signature),pop),true);calls++;
  const claims=claimsFor('alice',input.delegate,jkt,{now:h.clock.now(),iat:Math.floor(h.clock.now()/1000),purposes:input.purposes});return {certificate:await B.encodeDelegation(claims,{privateKey:alice.identityPrivate,keyId:alice.keyId})};
 };
 // Use the same harness engine with the real key provider, including the actual renewal Action/audit.
 const keys=sealedDelegateKeys({store:h.store,secret,clientId,certify,directory,clock:h.clock}),run=createTestEngine({owner,store:h.store,clock:h.clock,registry:SHELL_OPERATIONS,providers:{delegateKeys:keys}});t.after(()=>run.dispose());
 const first=await run.run('shell.delegation-renew'),saved=await h.store.get('shell:delegate'),alarm=await h.store.get('shell:renewal');assert.equal(first.jkt,firstJkt);assert.equal(alarm.at,h.clock.now()+43200000);assert.equal(JSON.stringify(saved).includes('"d":'),false);
 const reopened=sealedDelegateKeys({store:h.store,secret,clientId,certify,directory,clock:h.clock}),snapshot=await reopened.current();assert.equal(snapshot.privateKey.extractable,false);assert.equal(snapshot.kid,`jkt:${firstJkt}`);
 await reopened.renew();assert.equal(calls,2);assert.equal((await h.store.get('shell:delegate')).sealed,saved.sealed,'renewal preserves the private key and immutable send identity');
 await assert.rejects(sealedDelegateKeys({store:h.store,secret:B.base64url(new Uint8Array(32).fill(8)),clientId,certify,directory,clock:h.clock}).current(),e=>e.code==='recipient_unavailable');
});

test('BB-B8 broker Queries bind issuer, connection, generation, resource and methods; writes require live checks',async t=>{
 const h=engine(t),description=await h.run('shell.describe',{input:{verified,resource}});assert.equal(description.ingress,alice.ingress);assert.equal(description.expiresAt,undefined);
 const discovery=await h.run('shell.discover',{input:{verified:{...verified,purpose:'discover'},query:{v:1,contracts:[B.MAILBOX_CONTRACT],limit:0}}});assert.deepEqual(discovery,{v:1,items:[],exists:true});
 for(const patch of [{issuer:'https://other.example'},{connection:'foreign'},{generation:4},{resource:'https://other.example/r'},{methods:[]}])await assert.rejects(h.run('shell.describe',{input:{verified:{...verified,...patch},resource}}),e=>e.code==='not_authorized');
 await assert.rejects(h.run('shell.discover',{input:{verified:{...verified,purpose:'discover'},query:{v:1,contracts:[B.MAILBOX_CONTRACT],facets:{unknown:{}}}}}),e=>e.code==='unsupported_facet');
 await h.store.put('parent/link-1',{iss:alice.principal.issuer,jti:'link-1',claimsDigest:'digest',revoked:false});await h.store.put('decision/link-1/subject',{state:'eligible'});
 await assert.rejects(h.run('shell.link-revoked',{input:{verified:{...verified,live:false},resource,args:{jti:'link-1'}}}),e=>e.code==='not_authorized');
 assert.deepEqual(await h.run('shell.link-revoked',{input:{verified,resource,args:{jti:'link-1'}}}),{});assert.equal((await h.store.get('parent/link-1')).revoked,true);assert.equal(await h.store.get('decision/link-1/subject'),undefined);assert.equal((await h.store.list({prefix:'edge-outbox/'})).size,1);
 await h.run('shell.link-revoked',{input:{verified,resource,args:{jti:'link-1'}}});assert.equal((await h.store.list({prefix:'edge-outbox/'})).size,1);
 await assert.rejects(h.run('shell.public-intake',{input:{verified:{...verified,live:false},resource}}),e=>e.code==='not_authorized');
});

test('BB-B8 authenticated SETs are idempotent, keep generation floors monotonic and never revive old consent',async t=>{
 const h=engine(t),fragment='https://messages.example/preferences/message-storage/v1',newer=event('preferences-updated',{fragment,values:{store:'new'}},{seq:2});await h.run('shell.integration-event',{input:{event:newer}});await h.run('shell.integration-event',{input:{event:newer}});await h.run('shell.integration-event',{input:{event:event('preferences-updated',{fragment,values:null})}});
 assert.deepEqual((await h.store.get('shell:preferences/'+encodeURIComponent(fragment))).values,{store:'new'});
 await h.run('shell.integration-event',{input:{event:event('credential-revoked',{grants:['grant-1'],until:NOW+360000})}});
 await assert.rejects(h.run('shell.describe',{input:{verified,resource}}),e=>e.code==='not_authorized');
 await h.run('shell.integration-event',{input:{event:event('connection-revoked',{generation_floor:3,terminal:true})}});assert.equal((await h.store.get('shell:authorization')).active,true,'an old terminal event does not sever the current generation');
 await h.run('shell.integration-event',{input:{event:event('connection-revoked',{generation_floor:4,terminal:true})}});assert.equal((await h.store.get('shell:authorization')).active,false);
 await h.run('shell.integration-event',{input:{event:event('connection-resumed',{})}});assert.equal((await h.store.get('shell:authorization')).active,false);
 await assert.rejects(h.run('shell.integration-event',{input:{event:event('unknown',{}, {connection:'foreign'})}}),e=>e.code==='not_authorized');
});

test('BB-B8 public intake uses the Node SQLite provider and checks broker authority again inside custody commit',async t=>{
 const store=new SqliteMailboxStore(':memory:');await store.put('owner',owner);await store.put('config',config);await store.put('shell:authorization',grant);
 const consumer=await bridgeConsumer('https://bridge.example'),h=createTestEngine({owner,store,registry:INTEGRATION_OPERATIONS,providers:{receive:ReceiveDomain,providerLink:{consumerKey:async()=>({keyId:consumer.keyId,publicJwk:consumer.publicJwk})}}});t.after(async()=>{await h.dispose();await store.close();});
 const input={verified,resource,tx:crypto.randomUUID(),contract:B.INTAKE_CONTRACT,consumer:consumer.origin,args:await consumer.args({recipient:alice.principal,receivedAt:h.clock.now()-1000})},actor={kind:'ingress',owner};
 assert.deepEqual(await h.run('shell.public-intake',{actor,input}),{disposition:'stored-receipt'});assert.deepEqual(await h.run('shell.public-intake',{actor,input}),{disposition:'stored-receipt'});assert.equal((await store.list({prefix:'item/'})).size,1);
 // The provenance-key fetch happens outside the transaction. A disconnect that wins during that fetch must
 // prevent the already-authenticated invocation from committing a second item.
 let release,started;const fetched=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>release=resolve);
 const racing=createTestEngine({owner,store,registry:INTEGRATION_OPERATIONS,providers:{receive:ReceiveDomain,providerLink:{consumerKey:async()=>{started();await hold;return {keyId:consumer.keyId,publicJwk:consumer.publicJwk};}}}});t.after(()=>racing.dispose());
 const pending=racing.run('shell.public-intake',{actor,input:{...input,tx:crypto.randomUUID(),args:await consumer.args({recipient:alice.principal,receivedAt:h.clock.now()-1000})}});await fetched;await store.put('shell:authorization',{...grant,active:false});release();await assert.rejects(pending,e=>e.code==='not_authorized');assert.equal((await store.list({prefix:'item/'})).size,1);
});

test('BB-B8 integration HTTP never accepts a body-supplied verifier, and translates authenticated RPC/SET to dispatch',async()=>{
 const calls=[],http=createHTTP({BINDLEBOX_ENABLED:true,mailbox:async()=>({run:async(...args)=>{calls.push(args);return {accepted:true};}}),services:{verifyIntegration:async()=>verified,verifyEvent:async()=>event('unknown',{})}}),headers={'Content-Type':'application/json',Authorization:'Bearer broker-test'};
 const request=B.rpcRequest({resource,contract:B.MAILBOX_CONTRACT,method:'describe',args:{},tx:crypto.randomUUID()}),response=await http(new Request('https://messages.example/bindle/rpc',{method:'POST',headers,body:JSON.stringify(request)}));assert.equal(response.status,200);assert.equal(calls[0][1],'shell.describe');assert.deepEqual(calls[0][2].input.verified,verified);
 assert.equal((await http(new Request('https://messages.example/bindle/events',{method:'POST',headers:{'Content-Type':'application/secevent+jwt'},body:'signed-test-token'}))).status,202);assert.equal(calls.at(-1)[1],'shell.integration-event');
 const closed=createHTTP({BINDLEBOX_ENABLED:true});assert.equal((await closed(new Request('https://messages.example/bindle/rpc',{method:'POST',headers,body:JSON.stringify(request)}))).status,503);
});
