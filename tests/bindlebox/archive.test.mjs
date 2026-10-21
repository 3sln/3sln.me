// BB-B6 archive over the conversation mesh: sealed and signed segments, deltas, corruption and tampering detection,
// key rotation across generations, a large history with blob parts, crash safety, capacity reclamation and custody.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchiveMesh,storedText,rejected,B} from './archive-fixtures.test.mjs';
import {MAILBOX_OPERATIONS} from '../../packages/bindlebox-engine/operations.mjs';
import {ARCHIVE_OPERATIONS} from '../../packages/bindlebox-engine/domains/archive.mjs';
import {MANIFEST_KEY,openObject,signManifest,unwrapProof,lineOf,parseLine,classify} from '../../packages/bindlebox-engine/store/archive-writer.mjs';

const mesh=async(t,options)=>{const a=await createArchiveMesh(options);t.after(()=>a.dispose());return a;};
const td=new TextDecoder();
async function plaintextOf(a,name){
 const party=a.party(name),signer=await party.current(),out=[];
 const unwrap=async q=>party.custody.unwrap({...q,delegation:signer.delegation,proof:await unwrapProof(signer,{name:q.name,kid:q.kid,at:a.clock.now()})});
 for(const s of party.storage.payload().segments){const {plain}=await openObject(party.storage.bytes(s.name),{name:s.name,owner:party.principal,kind:'segment',unwrap});out.push(td.decode(plain));}
 return out.join('\n');
}

test('archive operations are registered engine operations behind the default-off flag',async t=>{
 assert.ok(ARCHIVE_OPERATIONS.every(O=>MAILBOX_OPERATIONS[O.operation]===O));
 const a=await mesh(t,{names:['alice','bob']}),bob=a.party('bob');
 // A provider built without BINDLEBOX_ENABLED refuses every operation.
 const {createArchiveProvider}=await import('../../packages/bindlebox-engine/domains/archive.mjs');
 const {createTestEngine}=await import('./helpers/engine.mjs');
 const disabled=createTestEngine({owner:bob.owner,clock:bob.peer.clock,store:bob.store,providers:{archive:createArchiveProvider({ownerKeys:bob.custody}),userStorage:bob.storage,delegateKeys:{current:()=>bob.current()},directory:a.directory}});t.after(()=>disabled.dispose());
 await rejected(disabled.run('archive.checkpoint'),'not_found');assert.equal(bob.storage.log.length,0);
});

test('checkpoints write sealed, signed segments; deltas carry only changes; no plaintext, secret or capability is archived',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']);
 await a.run('alice','conversations.send',{conversationId:cid,text:'secret plans alpha'});
 await a.run('bob','contacts.add',{link:await a.link('carol'),label:'Label Zeta'});await a.run('bob','contacts.create-link',{kinds:['one-off']});await a.settle();
 const first=await a.archive('bob','archive.checkpoint');assert.equal(first.kind,'snapshot');assert.equal(first.generation,1);
 const bob=a.party('bob'),storage=bob.storage,payload=storage.payload(),header=JSON.parse(td.decode(B.fromBase64url(storage.manifest().split('.')[0])));
 assert.deepEqual(header,{alg:'ES256',kid:(await bob.current()).kid,typ:'bindlebox-archive+jwt'});
 assert.equal(payload.writer.cnx,'cnx-bob');assert.equal(payload.owner.subject,bob.owner);assert.ok(payload.segments.every(s=>s.keyId===bob.custody.current().kid));
 // The storage resource holds ciphertext only: no message text, label, link or conversation secret.
 const secret=B.base64url(Uint8Array.from(await bob.store.get(`conv/secret/${cid}/${(await a.get('bob',cid)).epoch}`))),stored=storedText(storage);
 for(const needle of ['secret plans','Label Zeta','bindle_meta',secret,btoa('secret plans alpha')])assert.ok(!stored.includes(needle),needle);
 // Decrypted, the archive holds history and contacts but never secrets, link metas, routes, keys or app config.
 const plain=await plaintextOf(a,'bob');
 assert.ok(plain.includes('Label Zeta')&&plain.includes('"k":"contact/'));
 for(const needle of [secret,'conv/secret/','sharedSecret','"k":"config"','"k":"owner"','shell:','conv/route/','privateKey'])assert.ok(!plain.includes(needle),needle);
 // Other people's contact links are the owner's address book and travel (encrypted); the owner's own link metas do not.
 for(const line of plain.split('\n'))if(line.includes('bindle_meta'))assert.match(JSON.parse(line).k,/^contact\//);
 assert.ok(plain.split('\n').every(l=>classify(JSON.parse(l).k)));
 // Unchanged state writes nothing; one more message writes a small delta.
 assert.equal((await a.archive('bob','archive.checkpoint')).kind,'none');
 await a.run('carol','conversations.send',{conversationId:cid,text:'second beta'});await a.settle();
 const delta=await a.archive('bob','archive.checkpoint');assert.equal(delta.kind,'delta');assert.ok(delta.records<first.records/2,`${delta.records} of ${first.records}`);
 assert.equal(storage.payload().previous,first.digest);assert.deepEqual((await a.archive('bob','archive.verify')).ok,true);
 const status=await a.archive('bob','archive.status');assert.equal(status.generation,2);assert.equal(status.encrypted,true);assert.equal(status.endToEnd,false);assert.equal(status.segments,2);
 // Codec and sanitizer round trip: bytes stay bytes, and an archived op row cannot carry a secret back in.
 const op=parseLine(lineOf('conv/op/x',{operationId:'x',cid,submitted:true,secret:[1,2,3],prepared:[{envelope:{}}],recipients:[{principal:{issuer:'https://p.example',subject:'s'},credential:'BindleConversation e.t'}]}));
 assert.equal(op.value.secret,null);assert.equal(op.value.prepared,null);assert.deepEqual(op.value.recipients,[{principal:{issuer:'https://p.example',subject:'s'}}]);
 assert.deepEqual(parseLine(lineOf('body/x',Uint8Array.of(1,2,3))).value,Uint8Array.of(1,2,3));
 assert.equal(lineOf('conv/secret/x/y',[1,2,3]),null);assert.equal(lineOf('config',{}),null);
});

test('a corrupted, swapped, forged or foreign archive is detected before anything is imported',async t=>{
 const a=await mesh(t,{limits:{segmentBytes:4096}}),cid=await a.conversation('alice',['bob','carol']);
 for(let i=0;i<6;i++)await a.run('alice','conversations.send',{conversationId:cid,text:`message ${i} `+'x'.repeat(400)});await a.settle();
 await a.archive('bob','archive.checkpoint');
 const bob=a.party('bob'),storage=bob.storage,[s1,s2]=storage.payload().segments.map(s=>s.name);assert.ok(s2,'several segments');
 const original=new Map([...storage.objects].map(([k,v])=>[k,v.bytes.slice()]));const restore=()=>{for(const [k,b] of original)storage.set(k,b.slice());};
 // One flipped byte in a segment.
 const bytes=storage.bytes(s1).slice();bytes[bytes.length-5]^=1;storage.set(s1,bytes);
 await rejected(a.archive('bob','archive.verify'),'archive_corrupt');restore();assert.equal((await a.archive('bob','archive.verify')).ok,true);
 // Swapped segments: same sizes are not required; the sealed header binds each object to its name.
 storage.set(s1,original.get(s2).slice());storage.set(s2,original.get(s1).slice());await rejected(a.archive('bob','archive.verify'),'archive_corrupt');restore();
 // A truncated or missing segment.
 storage.objects.delete(s2);await rejected(a.archive('bob','archive.verify'),'archive_corrupt');restore();
 // A manifest re-signed by a key the owner never certified.
 const ES={name:'ECDSA',namedCurve:'P-256'},rogueIdentity=await crypto.subtle.generateKey(ES,true,['sign']),rogue=await crypto.subtle.generateKey(ES,true,['sign','verify']);
 const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',rogue.publicKey),jkt=await B.thumbprint({kty,crv,x,y}),iat=Math.floor(a.clock.now()/1000)-60;
 const delegation=await B.encodeDelegation({bindle:'key-delegation',v:1,iss:bob.principal.issuer,sub:bob.owner,delegate:{kty,crv,x,y},jkt,purposes:Object.values(B.PURPOSES).sort(),client:{client_id:'https://rogue.example/client.json',origin:'https://rogue.example',ingress:'https://rogue.example/ingress'},cnx:'rogue',since:iat,jti:'rogue',iat,exp:iat+3600},{privateKey:rogueIdentity.privateKey,keyId:bob.keyId});
 const forged=await signManifest({...storage.payload(),writer:{client_id:'https://rogue.example/client.json',cnx:'rogue',jkt},delegation,writtenAt:a.clock.now()},{kid:`jkt:${jkt}`,privateKey:rogue.privateKey});
 storage.set(MANIFEST_KEY,new TextEncoder().encode(forged));await rejected(a.archive('bob','archive.verify'),'archive_untrusted');
 // The old app is not fenced by a forgery: it refuses to proceed instead of trusting or overwriting it.
 await rejected(a.archive('bob','archive.checkpoint'),'archive_untrusted');restore();
 // Another owner's genuine manifest is not this owner's archive.
 await a.archive('alice','archive.checkpoint');storage.set(MANIFEST_KEY,a.party('alice').storage.bytes(MANIFEST_KEY));await rejected(a.archive('bob','archive.verify'),'archive_corrupt');restore();
 // A new app importing a corrupted archive writes nothing: no takeover, no rows.
 const anchor=await a.archive('bob','archive.export');const segment=storage.payload().segments[0].name,damaged=storage.bytes(segment).slice();damaged[40]^=0xff;storage.set(segment,damaged);
 const manifestVersion=storage.objects.get(MANIFEST_KEY).version;await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 await rejected(a.archive('bob','archive.import',{expect:anchor}),'archive_corrupt');
 assert.equal(storage.objects.get(MANIFEST_KEY).version,manifestVersion);assert.equal((await a.party('bob').store.list({prefix:'conv/'})).size,0);
 assert.equal((await a.archive('bob','archive.status')).generation,0);
});

test('key rotation across archives: owner encryption and delegate keys rotate and every generation still opens',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob');
 await a.run('alice','conversations.send',{conversationId:cid,text:'under the first keys'});await a.settle();await a.archive('bob','archive.checkpoint');
 const firstKid=bob.custody.current().kid;await bob.custody.rotate();
 await a.run('carol','conversations.send',{conversationId:cid,text:'under the second encryption key'});await a.settle();await a.archive('bob','archive.checkpoint');
 // Same installation, new delegate key: the previous key is revoked within this hour, yet this mailbox continues
 // from the manifest it recorded writing.
 const {old}=await a.m.switchApp('bob');assert.ok(a.revoked.has(old));
 await a.run('alice','conversations.send',{conversationId:cid,text:'after the delegate rotation'});await a.settle({advance:true});
 const third=await a.archive('bob','archive.checkpoint');assert.equal(third.kind,'delta');
 const payload=bob.storage.payload();assert.equal(payload.writer.jkt,bob.jkt);assert.notEqual(payload.writer.jkt,old);
 assert.deepEqual(new Set(payload.segments.map(s=>s.keyId)),new Set([firstKid,bob.custody.current().kid]));
 const expected=await a.texts('bob',cid),anchor=await a.archive('bob','archive.export');
 await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 await a.archive('bob','archive.import',{expect:anchor});assert.deepEqual(await a.texts('bob',cid),expected);
 // A key the holder does not know cannot open anything.
 bob.custody.keys.clear();await rejected(a.archive('bob','archive.verify'),'archive_keys_unavailable');
});

test('a large history spans many segments and blob parts, imports intact, and later checkpoints stay small',async t=>{
 const a=await mesh(t,{names:['alice','bob'],limits:{segmentBytes:16384}}),cid=await a.conversation('alice',['bob']);
 for(let round=0;round<4;round++){for(let i=0;i<50;i++)await a.run(i%2?'alice':'bob','conversations.send',{conversationId:cid,text:`history ${round}-${i}`});await a.settle();}
 await a.run('alice','conversations.send',{conversationId:cid,text:'L'.repeat(200000)});await a.settle();
 const first=await a.archive('bob','archive.checkpoint'),payload=a.party('bob').storage.payload();
 assert.ok(payload.segments.length>=20,`${payload.segments.length} segments`);assert.ok([...a.party('bob').storage.objects.keys()].some(k=>k.includes('/blobs/')),'oversized line stored as blob parts');
 assert.ok([...a.party('bob').storage.objects.values()].every(o=>o.bytes.length<=1048576));
 const expected=await a.texts('bob',cid);assert.equal(expected.length,202);
 await a.run('alice','conversations.send',{conversationId:cid,text:'one more'});await a.settle();
 const delta=await a.archive('bob','archive.checkpoint');assert.equal(delta.kind,'delta');assert.ok(delta.records<12&&delta.segments===1,JSON.stringify(delta));
 const full=await a.texts('bob',cid),anchor=await a.archive('bob','archive.export');assert.ok(anchor.records>=first.records);assert.equal(full.length,203);
 await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 const imported=await a.archive('bob','archive.import',{expect:anchor});assert.ok(imported.imported.item>300,JSON.stringify(imported.imported));
 assert.deepEqual(await a.texts('bob',cid),full);
});

test('crash safety: an interrupted checkpoint resumes, a manifest committed before a lost local commit is adopted, one writer runs',async t=>{
 const a=await mesh(t,{limits:{segmentBytes:4096}}),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob'),storage=bob.storage;
 for(let i=0;i<8;i++)await a.run('alice','conversations.send',{conversationId:cid,text:`crash ${i} `+'y'.repeat(300)});await a.settle();
 // The third segment put fails: nothing is published, and the retry reuses the finished segments.
 let puts=0;storage.faults.push({method:'put',when:({args})=>args.key.includes('/segments/')&&++puts===3,once:true});
 await rejected(a.archive('bob','archive.checkpoint'),'archive_storage_unavailable');assert.equal(storage.objects.has(MANIFEST_KEY),false);
 assert.equal((await a.archive('bob','archive.status')).interrupted,true);
 const resumed=await a.archive('bob','archive.checkpoint');assert.equal(resumed.reused,2);assert.equal((await a.archive('bob','archive.verify')).ok,true);
 // The manifest put commits but the reply is lost: the next checkpoint adopts it by plan ID, never fencing itself.
 await a.run('carol','conversations.send',{conversationId:cid,text:'lost reply'});await a.settle();
 storage.faults.push({method:'put',when:({args})=>args.key===MANIFEST_KEY,mode:'after',once:true});
 await rejected(a.archive('bob','archive.checkpoint'),'archive_storage_unavailable');const committed=storage.payload();assert.equal(committed.generation,2);
 assert.equal((await a.archive('bob','archive.status')).generation,1);
 const next=await a.archive('bob','archive.checkpoint');assert.equal(next.generation,3);assert.equal(storage.payload().previous!==null,true);
 assert.equal((await a.archive('bob','archive.status')).fenced,false);assert.equal((await a.archive('bob','archive.verify')).ok,true);
 // Two writers at once: the lock admits one.
 await a.run('alice','conversations.send',{conversationId:cid,text:'race'});await a.settle();
 const results=await Promise.allSettled([a.archive('bob','archive.checkpoint'),a.archive('bob','archive.checkpoint')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'archive_busy');
 // The abandoned attempt's reserved names are reclaimed; storage holds exactly the referenced segments.
 const swept=await a.archive('bob','archive.reclaim');assert.ok(swept.deleted>=1,JSON.stringify(swept));
 assert.deepEqual(new Set(storage.segmentKeys()),new Set(storage.payload().segments.map(s=>s.name)));
});

test('capacity reclamation: archived final obligations leave the send queue; superseded objects are deleted after the grace period',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob');
 const sent=[];for(let i=0;i<5;i++)sent.push(await a.run('bob','conversations.send',{conversationId:cid,text:`reclaim ${i}`}));await a.settle();
 const before=await bob.store.get('bb:send:queue');assert.ok(before.tasks>=10);
 // Nothing is reclaimed before it is archived.
 assert.equal((await a.archive('bob','archive.reclaim')).tasks,0);
 await a.archive('bob','archive.checkpoint');const freed=await a.archive('bob','archive.reclaim');
 const after=await bob.store.get('bb:send:queue');assert.ok(freed.tasks>=10&&after.tasks===0&&after.bytes===0,JSON.stringify({freed,after}));
 assert.equal((await bob.store.list({prefix:'bb:send:body/'})).size,0);
 const task=[...(await bob.store.list({prefix:'bb:send:task/'})).values()][0];assert.equal(task.envelope,null);assert.equal(task.credential,null);
 // Honest status survives: the summaries still report custody receipts.
 const status=await a.run('bob','conversations.status',{conversationId:cid,eventId:sent[0].eventId});assert.deepEqual([status.delivered,status.pending],[2,0]);
 // Compacted summaries equal what is archived, so the next checkpoint has nothing new to write for them.
 assert.equal((await a.archive('bob','archive.checkpoint')).kind,'none');
 // Compaction supersedes the old segments; they are deleted only after the grace period.
 await a.run('carol','conversations.send',{conversationId:cid,text:'more'});await a.settle();await a.archive('bob','archive.checkpoint');
 const old=bob.storage.payload().segments.map(s=>s.name);await a.archive('bob','archive.compact');
 assert.equal((await a.archive('bob','archive.reclaim')).deleted,0);assert.ok(old.every(n=>bob.storage.objects.has(n)));
 a.clock.advance(25*3600000);const gc=await a.archive('bob','archive.reclaim');assert.equal(gc.deleted,old.length);
 assert.deepEqual(new Set(bob.storage.segmentKeys()),new Set(bob.storage.payload().segments.map(s=>s.name)));
 // A backend without conditional deletion keeps superseded objects; the owner sees them as retained.
 const r=await mesh(t,{names:['alice','bob'],storage:{conditionalDelete:false}}),c2=await r.conversation('alice',['bob']);
 await r.archive('bob','archive.checkpoint');await r.run('alice','conversations.send',{conversationId:c2,text:'x'});await r.settle();await r.archive('bob','archive.compact');
 r.clock.advance(25*3600000);const kept=await r.archive('bob','archive.reclaim');assert.ok(kept.retained>=1&&kept.deleted===0);assert.ok((await r.archive('bob','archive.status')).retainedObjects>=1);
});

test('only the current occupant can sign, open or take over the archive',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob');
 await a.run('alice','conversations.send',{conversationId:cid,text:'occupant only'});await a.settle();await a.archive('bob','archive.checkpoint');
 // An installation without the archive purpose cannot sign or read.
 const noArchive=await a.certifyAll('bob',{purposes:[B.PURPOSES.author,B.PURPOSES.receipt]}),plain=a.engineFor('bob',{delegateKeys:{current:async()=>noArchive}});t.after(()=>plain.dispose());
 await rejected(plain.run('archive.checkpoint'),'signing_unavailable');await rejected(plain.run('archive.verify'),'signing_unavailable');await rejected(plain.run('archive.import',{input:{unanchored:true}}),'signing_unavailable');
 // A certified key that is not the occupant's: the key holder refuses to open anything.
 const ES={name:'ECDSA',namedCurve:'P-256'},other=await crypto.subtle.generateKey(ES,true,['sign','verify']),saved={jwk:bob.delegateJwk,key:bob.delegatePrivate};
 const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',other.publicKey);bob.delegateJwk={kty,crv,x,y};bob.delegatePrivate=other.privateKey;const stranger=await a.certifyAll('bob');bob.delegateJwk=saved.jwk;bob.delegatePrivate=saved.key;
 const foreign=a.engineFor('bob',{delegateKeys:{current:async()=>stranger}});t.after(()=>foreign.dispose());
 const refused=bob.custody.calls.refused;await rejected(foreign.run('archive.verify'),'archive_keys_unavailable');assert.ok(bob.custody.calls.refused>refused);
 // Another owner's mailbox pointed at this storage cannot read it as its own.
 const carol=a.party('carol');
 const {createTestEngine}=await import('./helpers/engine.mjs'),{createArchiveProvider}=await import('../../packages/bindlebox-engine/domains/archive.mjs');
 const misdirected=createTestEngine({owner:carol.owner,clock:carol.peer.clock,store:carol.store,providers:{archive:createArchiveProvider({BINDLEBOX_ENABLED:true,ownerKeys:carol.custody}),userStorage:bob.storage,delegateKeys:{current:()=>carol.current()},directory:a.directory}});t.after(()=>misdirected.dispose());
 await rejected(misdirected.run('archive.import',{input:{unanchored:true}}),'archive_corrupt');assert.equal((await carol.store.get('archive/state')),undefined);
});
