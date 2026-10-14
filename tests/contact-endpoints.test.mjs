import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMessagingStore, ContactTokenService, ContactEndpointService, MessagingService, CONTACT_TOKEN_MIME, signContactToken, validateSenderMetadata } from '../packages/messaging/index.mjs';
import { key, fromBase64url, strictText } from '../packages/messaging/store.mjs';

async function fixture(alg='EdDSA',issuer='https://3sln.example',allowInsecureLocalhost=false) {
  let now=1800000000000; const clock=()=>now; const store=new MemoryMessagingStore();
  const tokens=new ContactTokenService({store,issuer,clock,allowInsecureLocalhost});
  const pair=await crypto.subtle.generateKey(alg==='EdDSA'?{name:'Ed25519'}:{name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const owner='owner';await tokens.registerKey(owner,{kid:'one',alg,publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey)});
  const endpoints=new ContactEndpointService({tokens,signer:async()=>pair.privateKey});
  const messages=new MessagingService({store,tokens:endpoints,clock});
  const collection=await messages.createCollection(owner,'Inbox');
  const issued=await endpoints.create(owner,{handle:'alice',kid:'one',collections:[collection.id],mimeTypes:['text/plain'],expiresAt:now+86400000,maxMessages:2});
  const receive=(token,idempotencyKey='send')=>messages.receive(token,{collection:collection.id,mimeType:'text/plain',bytes:new TextEncoder().encode('Hello'),idempotencyKey});
  return {store,tokens,endpoints,messages,owner,issued,pair,receive,clock,advance:ms=>{now+=ms;}};
}
const rejectUnauthorized=promise=>assert.rejects(promise,{code:'unauthorized'});
for(const alg of ['EdDSA','ES256'])test(`${alg} signed endpoint verifies separately and mints five-minute inbox bearer`,async()=>{
  const f=await fixture(alg);const url=new URL(f.issued.url);
  assert.equal(url.pathname,`/users/alice/contact/${f.issued.grant.id}`);assert.ok(url.searchParams.has('sig'));assert.equal(url.hash,'');
  const inspection=await f.endpoints.inspect(url.href);assert.equal(inspection.grant.id,f.issued.grant.id);
  await rejectUnauthorized(f.endpoints.verify(url.searchParams.get('sig')));
  const minted=await f.endpoints.mint(url.href);assert.equal(minted.contentType,CONTACT_TOKEN_MIME);assert.equal(minted.expiresAt,f.clock()+300000);
  const verified=await f.endpoints.verify(minted.token);assert.equal(verified.header.typ,'bindle-inbox+jwt');assert.equal(verified.claims.parent,f.issued.grant.id);
  await f.receive(minted.token);assert.equal((await f.messages.list(f.owner)).length,1);
});
test('GET representation inspection and repeated bearer minting never deliver or accumulate bearer records',async()=>{
  const f=await fixture();const before=await f.store.transaction(tx=>tx.list(''));
  const minted=await Promise.all(Array.from({length:12},()=>f.endpoints.mint(f.issued.url)));
  assert.equal(new Set(minted.map(value=>value.token)).size,12);
  assert.deepEqual(await f.store.transaction(tx=>tx.list('')),before);
  assert.deepEqual(await f.messages.list(f.owner),[]);
});
test('endpoint signature is bound to exact recipient URL and rejects query ambiguity',async()=>{
  const f=await fixture();
  for(const invalid of [f.issued.url.replace('/alice/','/bob/'),f.issued.url.replace('3sln.example','evil.example'),f.issued.url+'&sig=another',f.issued.url+'&extra=1',f.issued.url+'#fragment',f.issued.endpoint])await rejectUnauthorized(f.endpoints.inspect(invalid));
  const url=new URL(f.issued.url);const parts=url.searchParams.get('sig').split('.');parts[2]='A'.repeat(86);url.searchParams.set('sig',parts.join('.'));await rejectUnauthorized(f.endpoints.inspect(url.href));
});
test('all bearer instances share parent quotas and idempotency; revocation blocks mint and replay',async()=>{
  const f=await fixture();const a=await f.endpoints.mint(f.issued.url);const b=await f.endpoints.mint(f.issued.url);
  assert.deepEqual(await f.receive(a.token),await f.receive(b.token));await f.receive(b.token,'second');await assert.rejects(f.receive(a.token,'third'),{code:'quota_exceeded'});
  await f.endpoints.revoke(f.owner,f.issued.grant.id);
  await rejectUnauthorized(f.endpoints.mint(f.issued.url));await rejectUnauthorized(f.receive(a.token));
});
test('minted claims cannot expand scope, exceed five minutes, change parent or start in future',async()=>{
  const f=await fixture();const minted=await f.endpoints.mint(f.issued.url);const verified=await f.endpoints.verify(minted.token);
  for(const changes of [{maxMessages:10000},{exp:verified.claims.exp+1},{iat:verified.claims.iat+1},{parent:'missing'},{endpoint:'https://3sln.example/users/bob/contact/other'},{extra:'unsupported'}]){
    const token=await signContactToken({header:verified.header,claims:{...verified.claims,...changes},privateKey:f.pair.privateKey});await rejectUnauthorized(f.endpoints.verify(token));
  }
  f.advance(300000);await rejectUnauthorized(f.endpoints.verify(minted.token));assert.ok((await f.endpoints.mint(f.issued.url)).token);
});
test('mint expiry cannot outlive parent; live key retirement invalidates endpoints and inbox tokens',async()=>{
  const f=await fixture();f.advance(86400000-10000);const minted=await f.endpoints.mint(f.issued.url);assert.equal(minted.expiresAt,f.clock()+10000);
  await f.tokens.revokeKey(f.owner,'one');await rejectUnauthorized(f.endpoints.inspect(f.issued.url));await rejectUnauthorized(f.endpoints.verify(minted.token));
});
test('parent quarantine is live for already-minted bearer and owner-scoped',async()=>{
  const f=await fixture();const minted=await f.endpoints.mint(f.issued.url);const verified=await f.endpoints.verify(minted.token);
  await f.endpoints.quarantine(f.owner,f.issued.grant.id,true);
  assert.equal((await f.store.transaction(tx=>f.endpoints.live(tx,verified))).quarantined,true);
  const received=await f.receive(minted.token);assert.equal((await f.messages.read(f.owner,received.id)).quarantined,true);
  assert.deepEqual(await f.store.transaction(tx=>tx.list(key('notification-event',f.owner))),[]);
  await assert.rejects(f.endpoints.quarantine('other',f.issued.grant.id,false),{code:'not_found'});
  await f.endpoints.quarantine(f.owner,f.issued.grant.id,false);assert.equal((await f.store.transaction(tx=>f.endpoints.live(tx,verified))).quarantined,false);
});
test('legacy sender annotations remain separate and participate in message idempotency',async()=>{
  const f=await fixture();
  // Reproduce a pre-tag-policy persisted endpoint and its original signed URL.
  const legacy=await f.store.transaction(tx=>tx.get(key('contact-grant',f.issued.grant.id)));
  for(const claims of [legacy.claims,legacy.endpoint.claims]){delete claims.requiredTags;delete claims.optionalTags;}
  const url=new URL(f.issued.url);url.searchParams.set('sig',await signContactToken({header:legacy.endpoint.header,claims:legacy.endpoint.claims,privateKey:f.pair.privateKey}));
  await f.store.transaction(tx=>tx.set(key('contact-grant',legacy.id),legacy));
  const minted=await f.endpoints.mint(url.href);const request={collection:f.issued.grant.claims.collections[0],mimeType:'text/plain',bytes:new TextEncoder().encode('Hello'),idempotencyKey:'metadata',senderMetadata:{title:'A title',tags:['trusted-admin']}};
  const result=await f.messages.receive(minted.token,request);const message=await f.messages.read(f.owner,result.id);
  assert.deepEqual(message.senderMetadata,{subject:'A title',tags:['trusted-admin']});assert.deepEqual(message.tags,[]);assert.equal(message.classification,'unclassified');
  request.senderMetadata={subject:'Changed',tags:['trusted-admin']};await assert.rejects(f.messages.receive(minted.token,request),{code:'idempotency_conflict'});
});
test('sender metadata is bounded untrusted annotation and cannot provide owner actions',()=>{
  const original={subject:'<b>Untrusted subject</b>',tags:['priority']};const checked=validateSenderMetadata(original);original.tags.push('changed');assert.deepEqual(checked,{subject:'<b>Untrusted subject</b>',tags:['priority']});
  for(const metadata of [{subject:'new\r\nheader'}, {tags:['a','a']}, {tags:['x'.repeat(65)]}])assert.throws(()=>validateSenderMetadata(metadata),{code:'invalid_message_metadata'});
});
test('explicit local development issuer works without admitting insecure remote issuers',async()=>{
  const f=await fixture('EdDSA','http://localhost:8787',true);assert.ok(f.issued.url.startsWith('http://localhost:8787/users/alice/contact/'));assert.ok((await f.endpoints.mint(f.issued.url)).token);
  assert.throws(()=>new ContactTokenService({store:new MemoryMessagingStore(),issuer:'http://localhost:8787'}),{code:'invalid_issuer'});
  assert.throws(()=>new ContactTokenService({store:new MemoryMessagingStore(),issuer:'http://evil.example',allowInsecureLocalhost:true}),{code:'invalid_issuer'});
});
