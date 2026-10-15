import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMessagingStore, ContactTokenService, ContactEndpointService, MessagingService, signContactToken } from '../packages/messaging/index.mjs';
import { fromBase64url, strictText } from '../packages/messaging/store.mjs';
import { replayDigest } from '../packages/messaging/bindle-links.mjs';
import { LinkReplayRecord } from '../packages/messaging/link-replay.mjs';
import { prepareLinkResponse, signLinkResponse, verifyLinkResponse } from '../packages/identity/link-response.mjs';
import { SqliteMetadata } from '../apps/node/resources.mjs';

const ORIGIN='https://3sln.example',BOB='55555555-5555-4555-8555-555555555555';
async function fixture() {
  let now=1800000000000;const clock=()=>now;const store=new MemoryMessagingStore();
  const tokens=new ContactTokenService({store,issuer:ORIGIN,clock});
  const ownerKey=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const owner='11111111-1111-4111-8111-111111111111';await tokens.registerKey(owner,{kid:'one',alg:'ES256',publicJwk:await crypto.subtle.exportKey('jwk',ownerKey.publicKey)});
  const endpoints=new ContactEndpointService({tokens,signer:async()=>ownerKey.privateKey});
  const messages=new MessagingService({store,tokens:endpoints,clock});const collection=await messages.createCollection(owner,'Inbox');
  const issued=await endpoints.createLink(owner,{handle:'alice',kid:'one',collections:[collection.id],mimeTypes:['text/plain'],expiresAt:now+86400000,audience:{}});
  const bob=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const bobJwk=await crypto.subtle.exportKey('jwk',bob.publicKey);
  const accounts={[BOB]:{active:true,handle:'bob',key:{kid:'bob-key',alg:'ES256',active:true,purpose:'signing',publicJwk:{kty:'EC',crv:'P-256',x:bobJwk.x,y:bobJwk.y}}}};
  const calls=[];const resolve=async({sub,handle,kid})=>{calls.push({sub,handle,kid});return structuredClone(accounts[sub])??null;};
  const inspect=async url=>(await endpoints.inspect(url,{allowData:true}));
  const sign=(meta,options={})=>signLinkResponse({meta,principal:{iss:ORIGIN,sub:BOB,handle:'bob@3sln.example'},key:{kid:'bob-key',privateKey:bob.privateKey},clock,...options});
  const verify=(inspected,data=inspected.data)=>verifyLinkResponse({meta:inspected.meta,data,origin:ORIGIN,resolve,clock});
  return {endpoints,owner,issued,bob,accounts,calls,resolve,inspect,sign,verify,clock,set:ms=>{now=ms;},advance:ms=>{now+=ms;}};
}
const claimsOf=data=>JSON.parse(strictText(fromBase64url(data.split('.')[1])));
const resign=async(f,data,changes,header={})=>{const [h]=data.split('.');return signContactToken({header:{...JSON.parse(strictText(fromBase64url(h))),...header},claims:{...claimsOf(data),...changes},privateKey:f.bob.privateKey});};

test('§11.2 same-host response: constructed from parsed meta, completes to aud, verifies and yields the replay key',async()=>{
  const f=await fixture();const meta=prepareLinkResponse(f.issued.url);
  const response=await f.sign(meta);assert.equal(response.url,`${f.issued.url}&bindle_data=${response.data}`);assert.equal(response.expiresAt,f.clock()+300000);
  const claims=claimsOf(response.data);assert.deepEqual(Object.keys(claims).sort(),['aud','bindle','exp','handle','iat','iss','md','nonce','sub','type','v']);assert.equal(claims.nonce.length,22);
  const inspected=await f.inspect(response.url);const verified=await f.verify(inspected);
  assert.deepEqual(verified.principal,{iss:ORIGIN,sub:BOB});assert.equal(verified.replay.expiresAt,(claims.exp+60)*1000);
  assert.equal(verified.replay.key,await replayDigest(crypto,{jti:f.issued.grant.id,iss:ORIGIN,sub:BOB,nonce:claims.nonce}));
  assert.deepEqual(f.calls,[{sub:BOB,handle:'bob',kid:'bob-key'}]);
  assert.notEqual(claimsOf((await f.sign(meta)).data).nonce,claims.nonce);
  // Callers cannot pair altered claims with the real signing input: meta is re-parsed from its exact value.
  const tampered=claimsOf((await f.sign({...meta,claims:{...meta.claims,aud:'https://evil.example/x'}})).data);assert.equal(tampered.aud,meta.claims.aud);
});
test('§9 provider pre-checks: exactly one bindle_meta component, aud equals origin/path, supported type, audience present',async()=>{
  const f=await fixture();const plain=await f.endpoints.createLink(f.owner,{handle:'alice',kid:'one',collections:f.issued.grant.claims.collections,mimeTypes:['text/plain'],expiresAt:f.clock()+1000});
  for(const link of [`${f.issued.url}&utm=1`,`${f.issued.url}#x`,f.issued.url.replace('/alice/','/bob/'),plain.url])assert.throws(()=>prepareLinkResponse(link),{code:'link_invalid'},link.slice(-20));
  assert.throws(()=>prepareLinkResponse(`${f.issued.url}&bindle_data=a.b.c`),{code:'link_invalid'});assert.throws(()=>prepareLinkResponse(`${f.issued.url}&sig=x`),{code:'link_malformed'});
  assert.throws(()=>prepareLinkResponse(f.issued.url,{types:['https://spec.bindle.example/links/other/v1']}),{code:'link_invalid'});
  for(const principal of [{iss:ORIGIN,sub:BOB,handle:'bob@evil.example'},{iss:ORIGIN+'/',sub:BOB,handle:'bob@3sln.example'},{iss:ORIGIN,sub:'bob',handle:'bob@3sln.example'}])await assert.rejects(f.sign(prepareLinkResponse(f.issued.url),{principal}),{code:'invalid_link_response'});
  await assert.rejects(f.sign(prepareLinkResponse(f.issued.url),{lifetime:301}),{code:'invalid_link_response'});
  await assert.rejects(f.sign(prepareLinkResponse(f.issued.url),{types:['https://spec.bindle.example/links/other/v1']}),{code:'invalid_link_response'});
  assert.throws(()=>prepareLinkResponse(f.issued.url+'#'),{code:'link_invalid'});
});
test('§11.7 md from another or a rotated meta is audience_stale',async()=>{
  const f=await fixture();const response=await f.sign(prepareLinkResponse(f.issued.url));
  const rotated=await f.endpoints.rotateChallenge(f.owner,f.issued.grant.id);
  await assert.rejects(f.verify(await f.inspect(`${rotated.url}&bindle_data=${response.data}`)),{code:'audience_stale'});
  const other=await f.endpoints.createLink(f.owner,{handle:'alice',kid:'one',collections:f.issued.grant.claims.collections,mimeTypes:['text/plain'],expiresAt:f.clock()+1000,audience:{}});
  const moved=await resign(f,response.data,{aud:other.endpoint});await assert.rejects(f.verify(await f.inspect(`${other.url}&bindle_data=${moved}`)),{code:'audience_stale'});
  assert.deepEqual(f.calls,[]);
});
test('§11.8 validity boundaries: ±60 s skew, 300 s lifetime, iat after meta.iat − 60',async()=>{
  const f=await fixture();const t=f.clock()/1000;const base=(await f.sign(prepareLinkResponse(f.issued.url))).data;const inspected=await f.inspect(`${f.issued.url}&bindle_data=${base}`);
  const at=async(changes,nowSeconds)=>{const data=await resign(f,base,changes);f.set(nowSeconds*1000);try{return await f.verify(inspected,data);}finally{f.set(t*1000);}};
  assert.ok(await at({iat:t+100,exp:t+400},t+40));await assert.rejects(at({iat:t+100,exp:t+400},t+39.999),{code:'audience_stale'});
  assert.ok(await at({iat:t,exp:t+300},t+359.999));await assert.rejects(at({iat:t,exp:t+300},t+360),{code:'audience_stale'});
  await assert.rejects(at({iat:t,exp:t+301},t),{code:'audience_stale'});await assert.rejects(at({iat:t,exp:t},t),{code:'audience_stale'});
  assert.ok(await at({iat:t-60,exp:t+200},t));await assert.rejects(at({iat:t-61,exp:t+200},t),{code:'audience_stale'});
  assert.deepEqual(f.calls.length,3,'identity lookup happens only after validity');
});
test('§11.8 data schema: nonce, members, aud, type, handle host and alg are audience_malformed',async()=>{
  const f=await fixture();const base=(await f.sign(prepareLinkResponse(f.issued.url))).data;const inspected=await f.inspect(`${f.issued.url}&bindle_data=${base}`);
  const claims=claimsOf(base);const {nonce,...withoutNonce}=claims;
  for(const changes of [{nonce:'short'},{nonce:'A'.repeat(23)},{nonce:'AAAAAAAAAAAAAAAAAAAAAB'},{extra:1},{aud:claims.aud+'x'},{type:'https://spec.bindle.example/links/other/v1'},{handle:'bob@other.example'},{handle:'bob'},{sub:'not-a-uuid'},{iss:'https://3sln.example/'},{v:2}])
    await assert.rejects(f.verify(inspected,await resign(f,base,changes)),{code:'audience_malformed'},JSON.stringify(changes));
  const [h,,s]=base.split('.');await assert.rejects(f.verify(inspected,`${h}.${Buffer.from(JSON.stringify(withoutNonce)).toString('base64url')}.${s}`),{code:'audience_malformed'});
  await assert.rejects(f.verify(inspected,await resign(f,base,{},{typ:'bindle-link-meta+jwt'})),{code:'audience_malformed'});
  await assert.rejects(f.verify(inspected,f.issued.url.split('bindle_meta=')[1]),{code:'audience_malformed'});
  assert.deepEqual(f.calls,[]);
});
test('§11.9 handle/sub/key binding failures and foreign issuers are audience_unverifiable',async()=>{
  const f=await fixture();const base=(await f.sign(prepareLinkResponse(f.issued.url))).data;const inspected=await f.inspect(`${f.issued.url}&bindle_data=${base}`);
  await assert.rejects(f.verify(inspected,await resign(f,base,{handle:'carol@3sln.example'})),{code:'audience_unverifiable'});
  await assert.rejects(f.verify(inspected,await resign(f,base,{sub:'66666666-6666-4666-8666-666666666666'})),{code:'audience_unverifiable'});
  await assert.rejects(f.verify(inspected,await resign(f,base,{},{kid:'other-key'})),{code:'audience_unverifiable'});
  for(const mutate of [a=>{a.active=false;},a=>{a.key.active=false;},a=>{a.key.purpose='encryption';},a=>{a.key.alg='EdDSA';},a=>{a.key.publicJwk.d='x';}]){const saved=structuredClone(f.accounts[BOB]);mutate(f.accounts[BOB]);await assert.rejects(f.verify(inspected,base),{code:'audience_unverifiable'});f.accounts[BOB]=saved;}
  const intruder=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']);
  const [h,p]=base.split('.');const forged=await signContactToken({header:JSON.parse(strictText(fromBase64url(h))),claims:claimsOf(base),privateKey:intruder.privateKey});
  assert.equal(forged.split('.')[1],p);await assert.rejects(f.verify(inspected,forged),{code:'audience_unverifiable'});
  const before=f.calls.length;await assert.rejects(f.verify(inspected,await resign(f,base,{iss:'https://other.example',handle:'bob@other.example'})),{code:'audience_unverifiable'});
  assert.equal(f.calls.length,before,'foreign issuers never reach a resolver or network');
  assert.ok(await f.verify(inspected,base));
});
test('§11.8 replay: a second evaluation of the same response is audience_stale; a fresh nonce on the same link is accepted',async()=>{
  const f=await fixture();const db=new SqliteMetadata(':memory:');const replay=new LinkReplayRecord({metadata:db,clock:f.clock});
  const evaluate=async url=>{const inspected=await f.inspect(url);const verified=await f.verify(inspected);return replay.consume({parent:inspected.grant.id,...verified.principal,key:verified.replay.key,expiresAt:verified.replay.expiresAt});};
  const first=await f.sign(prepareLinkResponse(f.issued.url));assert.equal((await evaluate(first.url)).consumed,true);
  await assert.rejects(evaluate(first.url),{code:'audience_stale'});
  assert.equal((await evaluate((await f.sign(prepareLinkResponse(f.issued.url))).url)).consumed,true);
  db.close();
});
