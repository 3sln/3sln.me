// Regression tests for the BB-B6 security review (docs/release/bindlebox-archive-review.md): key-holder unwrap with
// proof of possession, anchored imports, rollback without self-fencing, a revoked key's backdated manifest, manifest
// metadata, invitation capabilities, explicit occupancy before takeover, and the lock lease.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchiveMesh,rejected,B} from './archive-fixtures.test.mjs';
import {MANIFEST_KEY,signManifest,unwrapProof,lineOf,parseLine} from '../../packages/bindlebox-engine/store/archive-writer.mjs';

const mesh=async(t,options)=>{const a=await createArchiveMesh(options);t.after(()=>a.dispose());return a;};
const HOUR=3600000,te=new TextEncoder();
const header=storage=>{const s=storage.payload().segments[0],bytes=storage.bytes(s.name),n=new DataView(bytes.buffer,bytes.byteOffset).getUint32(4);return {name:s.name,...JSON.parse(new TextDecoder().decode(bytes.subarray(8,8+n)))};};

test('BB6-S1/S2: the key holder returns one content key, and only to a fresh proof of possession, never to the public certificate',async t=>{
 const a=await mesh(t,{names:['alice','bob']}),cid=await a.conversation('alice',['bob']),bob=a.party('bob');
 await a.run('alice','conversations.send',{conversationId:cid,text:'custody'});await a.settle();await a.archive('bob','archive.checkpoint');
 const h=header(bob.storage),q={kid:h.kid,epk:h.epk,name:h.name,owner:h.owner,wiv:h.wiv,wct:h.wct},delegation=bob.storage.payload().delegation,signer=await bob.current();
 assert.equal(typeof bob.custody.derive,'undefined','no raw ECDH oracle');
 // The certificate is public (it is in the plaintext manifest): alone, or with a stale or foreign proof, it opens nothing.
 await rejected(bob.custody.unwrap({...q,delegation}),'forbidden');
 await rejected(bob.custody.unwrap({...q,delegation,proof:await unwrapProof(signer,{name:h.name,kid:h.kid,at:a.clock.now()-120000})}),'forbidden');
 const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']);
 await rejected(bob.custody.unwrap({...q,delegation,proof:await unwrapProof({privateKey:other.privateKey,jkt:signer.jkt},{name:h.name,kid:h.kid,at:a.clock.now()})}),'forbidden');
 // A proof for one object does not open another.
 await rejected(bob.custody.unwrap({...q,name:`${h.name}x`,delegation,proof:await unwrapProof(signer,{name:h.name,kid:h.kid,at:a.clock.now()})}),'forbidden');
 const key=await bob.custody.unwrap({...q,delegation,proof:await unwrapProof(signer,{name:h.name,kid:h.kid,at:a.clock.now()})});assert.equal(key.length,32);
});

test('BB6-S3/S4/S5: rollback and a revoked key\'s backdated manifest are refused without fencing the real writer',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob'),storage=bob.storage;
 const doomed=await a.run('alice','conversations.send',{conversationId:cid,text:'regrettable'});await a.settle();
 await a.archive('bob','archive.checkpoint');const stale=storage.payload();
 a.clock.advance(2*HOUR);await a.run('alice','conversations.retract',{conversationId:cid,target:doomed.eventId});await a.settle({advance:true});
 const anchor=await a.archive('bob','archive.export');const sw=await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 // The revoked previous key signs a "newer" generation, backdated before its revocation, listing pre-retraction state.
 const old=sw.oldSigner,iat=B.parseDelegation(old.delegation).claims.iat*1000;
 const forged=await signManifest({...stale,generation:anchor.generation+1,previous:anchor.digest,writtenAt:iat+1000,leaseUntil:iat+HOUR,delegation:old.delegation},old);
 const genuine=storage.bytes(MANIFEST_KEY).slice();storage.set(MANIFEST_KEY,te.encode(forged));
 await rejected(a.archive('bob','archive.import',{expect:anchor}),'archive_stale');
 assert.equal((await bob.store.list({prefix:'conv/'})).size,0);
 // Unanchored imports need the owner's explicit confirmation.
 storage.set(MANIFEST_KEY,genuine);await rejected(a.archive('bob','archive.import'),'archive_anchor_required');
 await a.archive('bob','archive.import',{expect:anchor});await a.archive('bob','archive.checkpoint');
 const current=storage.bytes(MANIFEST_KEY).slice();
 // Storage replays an older genuine manifest, or the revoked key's forgery: B reports a rollback and stays the writer.
 for(const replay of [genuine,te.encode(forged)]){
  // (The old export is also inside the revoked key's quarantine hour, so it is refused as untrusted first.)
  storage.set(MANIFEST_KEY,replay);await assert.rejects(a.archive('bob','archive.checkpoint'),e=>['archive_rolled_back','archive_untrusted'].includes(e.code));
  assert.equal((await a.archive('bob','archive.status')).fenced,false);
 }
 storage.set(MANIFEST_KEY,current);await a.run('bob','contacts.block',{principal:{issuer:'https://spam.provider.example',subject:'99999999-9999-4999-8999-999999999999'}});
 assert.equal((await a.archive('bob','archive.checkpoint')).kind,'delta');assert.equal((await a.archive('bob','archive.verify')).ok,true);
 // The genuinely newer writer (B) still fences A.
 await rejected(sw.oldApp.run('archive.checkpoint'),'archive_fenced');
});

test('BB6-S6/S9: the plaintext manifest names no mailbox key; invitations lose the secret and the return capability',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob');
 await a.run('bob','contacts.block',{principal:{issuer:'https://spam.provider.example',subject:'99999999-9999-4999-8999-999999999999'}});await a.settle();
 await a.archive('bob','archive.checkpoint');const manifest=JSON.stringify(bob.storage.payload());
 for(const needle of ['conv/','block/',cid,'spam.provider','"first"','"last"'])assert.ok(!manifest.includes(needle),needle);
 const item={id:'i',envelope:{payload:{conversation:{sharedSecret:'s',returnControl:{resource:'https://a.example/return/t',nonce:'n'},creatorBinding:{ingress:'https://a.example/i'},genesis:{}}}}};
 const out=parseLine(lineOf('item/i',item)).value;
 assert.deepEqual(Object.keys(out.envelope.payload.conversation),['genesis']);assert.equal(out.secretRedacted,true);assert.equal(out.needsReinvite,true);
});

test('BB6-S10: taking over requires an explicit occupancy proof, even for an archive with no segments',async t=>{
 const a=await mesh(t,{names:['alice','bob']});await a.conversation('alice',['bob']);const bob=a.party('bob');
 await a.archive('bob','archive.checkpoint');
 // An empty, validly signed manifest: nothing to open, so no unwrap would ever ask the key holder.
 const signer=await bob.current(),empty=await signManifest({...bob.storage.payload(),segments:[],retired:[],generation:9,writtenAt:a.clock.now(),leaseUntil:a.clock.now()+HOUR},signer);
 const anchor=await a.archive('bob','archive.export');void anchor;
 await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 const occupant=await bob.current();bob.storage.set(MANIFEST_KEY,te.encode(await signManifest({...JSON.parse(new TextDecoder().decode(B.fromBase64url(empty.split('.')[1]))),writer:{client_id:B.parseDelegation(occupant.delegation).claims.client.client_id,cnx:occupant.cnx,jkt:occupant.jkt},delegation:occupant.delegation},occupant)));
 // A certified key of this owner that is not the occupant's (a second installation) is refused by the key holder.
 const ES={name:'ECDSA',namedCurve:'P-256'},pair=await crypto.subtle.generateKey(ES,true,['sign','verify']),saved={jwk:bob.delegateJwk,key:bob.delegatePrivate};
 const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey);bob.delegateJwk={kty,crv,x,y};bob.delegatePrivate=pair.privateKey;const stranger=await a.certifyAll('bob');bob.delegateJwk=saved.jwk;bob.delegatePrivate=saved.key;
 const engine=a.engineFor('bob',{delegateKeys:{current:async()=>stranger}});t.after(()=>engine.dispose());
 const attests=bob.custody.calls.attest;
 await rejected(engine.run('archive.import',{input:{unanchored:true}}),'archive_not_occupant');assert.equal(bob.custody.calls.attest,attests+1);
 assert.equal(await bob.store.get('archive/state'),undefined);
});

test('BB6-S11: a writer whose lock lease expired cannot commit after another writer took the lock',async t=>{
 const a=await mesh(t,{names:['alice','bob'],limits:{segmentBytes:4096}}),cid=await a.conversation('alice',['bob']),bob=a.party('bob');
 for(let i=0;i<6;i++)await a.run('alice','conversations.send',{conversationId:cid,text:`lease ${i} `+'q'.repeat(300)});await a.settle();
 let second=null;
 bob.storage.before=async({method,args})=>{if(second||method!=='put'||!args.key.includes('/segments/'))return;a.clock.advance(11*60000);bob.storage.before=null;second=await a.archive('bob','archive.checkpoint');};
 await rejected(a.archive('bob','archive.checkpoint'),'archive_busy');
 assert.equal(second.kind,'snapshot');assert.equal((await a.archive('bob','archive.verify')).ok,true);
});
