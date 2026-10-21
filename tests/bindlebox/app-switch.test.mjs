// BB-B6 app switch over the conversation mesh: the owner moves from app instance A to a fresh app instance B (new
// mailbox, key, connection and ingress, same storage resource). B imports the archive and contacts, re-occupies the
// slot, rejoins without looking like a forger, and A is fenced. Deleted rows stay deleted; exports and imports resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchiveMesh,rejected} from './archive-fixtures.test.mjs';
import {memoryStore} from './helpers/engine.mjs';
import {MANIFEST_KEY} from '../../packages/bindlebox-engine/store/archive-writer.mjs';

const mesh=async(t,options)=>{const a=await createArchiveMesh(options);t.after(()=>a.dispose());return a;};
const HOUR=3600000;
const edgeKey=(iss,jti)=>`link/${encodeURIComponent(iss)}/${encodeURIComponent(jti)}`;

test('full switch from app A to app B keeps history, contacts and links, rejoins without looking like a forger, and fences A',async t=>{
 const a=await mesh(t,{names:['alice','bob','carol','dave']}),cid=await a.conversation('alice',['bob','carol','dave']);
 const own=await a.run('bob','conversations.send',{conversationId:cid,text:'from the old app'});
 await a.run('carol','conversations.send',{conversationId:cid,text:'carol before'});
 await a.run('bob','contacts.add',{link:await a.link('alice'),label:'Alice Work'});
 const link=await a.run('bob','contacts.create-link',{kinds:['one-off'],label:'Public'});
 const spammer={issuer:'https://spam.provider.example',subject:'99999999-9999-4999-8999-999999999999'};await a.run('bob','contacts.block',{principal:spammer});
 await a.settle();await a.archive('bob','archive.checkpoint');
 await a.run('dave','conversations.send',{conversationId:cid,text:'after the checkpoint'});await a.settle();
 const before={texts:await a.texts('bob',cid),contacts:await a.run('bob','contacts.list'),order:await a.order('bob',cid)},edgeBefore=(await a.edgeStore.get(edgeKey(link.resource?a.party('bob').principal.issuer:'',link.jti)))?.generation;
 const anchor=await a.archive('bob','archive.export');
 const sw=await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 // B starts empty and cannot start a second archive over the existing one.
 assert.equal((await a.run('bob','conversations.list')).conversations.length,0);
 await rejected(a.archive('bob','archive.checkpoint'),'archive_exists');
 const result=await a.archive('bob','archive.import',{expect:{generation:anchor.generation,digest:anchor.digest}});
 assert.equal(result.anchored,true);assert.equal(result.source,anchor.generation);assert.equal(result.generation,anchor.generation+1);assert.deepEqual(result.next,['conversations.rejoin']);
 // The takeover manifest names B; importing twice returns the finished result.
 const payload=a.party('bob').storage.payload();assert.equal(payload.writer.cnx,'cnx-bob-next');assert.equal(payload.takeover.digest,anchor.digest);
 assert.deepEqual(await a.archive('bob','archive.import',{expect:{generation:anchor.generation,digest:anchor.digest}}),result);
 // History, contacts, own links (without their metas) and blocks are back before any peer answers.
 assert.deepEqual(await a.texts('bob',cid),before.texts);assert.deepEqual(await a.order('bob',cid),before.order);
 const contacts=await a.run('bob','contacts.list');
 assert.deepEqual(contacts.contacts,before.contacts.contacts);
 assert.deepEqual(contacts.links.map(l=>[l.jti,l.label,l.revoked]),before.contacts.links.map(l=>[l.jti,l.label,l.revoked]));assert.ok(contacts.links.every(l=>!l.link));
 assert.ok(await a.party('bob').store.get(`block/${encodeURIComponent(spammer.issuer)}|${encodeURIComponent(spammer.subject)}`));
 // Own contact links keep routing: B republishes them to the edge index above A's generations.
 await a.flush();const edge=await a.edgeStore.get(edgeKey(a.party('bob').principal.issuer,link.jti));assert.equal(edge.owner,a.party('bob').owner);assert.ok(!edgeBefore||edge.generation>edgeBefore);
 // Rejoin under B's own key: secrets come back from peers, never from the archive.
 assert.equal((await a.run('bob','conversations.rejoin')).rejoins,3);assert.equal((await a.get('bob',cid)).awaitingSecret,true);
 await a.settle({advance:true});assert.equal((await a.get('bob',cid)).awaitingSecret,false);
 const after=await a.run('bob','conversations.send',{conversationId:cid,text:'from the new app'});await a.settle({advance:true});
 for(const name of ['alice','carol','dave']){
  const v=await a.get(name,cid);assert.equal(v.quarantinedStreams,0,`${name} saw no equivocation`);
  const e=v.timeline.find(x=>x.eventId===after.eventId);assert.equal(e?.text,'from the new app');assert.equal(e.author.subject,a.party('bob').owner);
  assert.equal((await a.party(name).store.list({prefix:`conv/evidence/${cid}/`})).size,0);assert.deepEqual(await a.order(name,cid),await a.order('bob',cid));
 }
 await a.run('carol','conversations.send',{conversationId:cid,text:'welcome back'});await a.settle({advance:true});assert.ok((await a.texts('bob',cid)).includes('welcome back'));
 // Honest status of an event sent by A survives as a summary.
 const status=await a.run('bob','conversations.status',{conversationId:cid,eventId:own.eventId});assert.deepEqual([status.delivered,status.pending],[3,0]);
 // A is fenced: it can no longer write the archive.
 await rejected(sw.oldApp.run('archive.checkpoint'),'archive_fenced');
 // B's first checkpoint is its own snapshot; A's objects are reclaimed after the grace period.
 const aObjects=payload.segments.map(s=>s.name),firstB=await a.archive('bob','archive.checkpoint');assert.equal(firstB.kind,'snapshot');
 a.clock.advance(25*HOUR);const gc=await a.archive('bob','archive.reclaim');assert.ok(gc.deleted>=aObjects.length,JSON.stringify(gc));
 assert.ok(aObjects.every(n=>!a.party('bob').storage.objects.has(n)));assert.equal((await a.archive('bob','archive.verify')).ok,true);
});

test('a retracted message and a removed contact stay deleted through import, replay, compaction and a rolled-back manifest',async t=>{
 const a=await mesh(t),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob');
 const doomed=await a.run('alice','conversations.send',{conversationId:cid,text:'regrettable'});await a.run('alice','conversations.send',{conversationId:cid,text:'kept'});
 const contact=await a.run('bob','contacts.add',{link:await a.link('carol'),label:'Carol Old'});await a.settle();
 await a.archive('bob','archive.checkpoint');const stale=bob.storage.bytes(MANIFEST_KEY).slice();
 // Two hours later the message is retracted and the contact removed; the delta carries both.
 a.clock.advance(2*HOUR);
 await a.run('alice','conversations.retract',{conversationId:cid,target:doomed.eventId});await a.run('bob','contacts.remove',{id:contact.id});await a.settle({advance:true});
 assert.equal((await a.get('bob',cid)).timeline.find(e=>e.eventId===doomed.eventId).deleted,true);
 const delta=await a.archive('bob','archive.checkpoint');assert.equal(delta.kind,'delta');
 const anchor={generation:delta.generation,digest:delta.digest},current=bob.storage.bytes(MANIFEST_KEY).slice();
 await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 // Storage rolled back to the older, genuinely signed manifest: refused against the handoff anchor.
 bob.storage.set(MANIFEST_KEY,stale);await rejected(a.archive('bob','archive.import',{expect:anchor}),'archive_stale');
 assert.equal((await bob.store.list({prefix:'conv/'})).size,0);
 // Without an anchor, a manifest written just before the previous key's revocation is not trusted.
 bob.storage.set(MANIFEST_KEY,current);await rejected(a.archive('bob','archive.import'),'archive_anchor_required');await rejected(a.archive('bob','archive.import',{unanchored:true}),'archive_untrusted');
 await a.archive('bob','archive.import',{expect:anchor});
 const deleted=async()=>{const v=await a.get('bob',cid),e=v.timeline.find(x=>x.eventId===doomed.eventId);return e.deleted===true&&e.text===null&&v.timeline.some(x=>x.text==='kept');};
 assert.ok(await deleted(),'retraction imported');assert.ok(!(await a.run('bob','contacts.list')).contacts.some(c=>c.label==='Carol Old'),'removed contact not resurrected');
 // Replaying the original message at B changes nothing, before and after rejoin.
 const early=await a.deliverPrepared('alice',doomed.operationId,'bob');assert.notEqual(early.status,500);assert.ok(await deleted());
 await a.run('bob','conversations.rejoin');await a.settle({advance:true});
 await a.deliverPrepared('alice',doomed.operationId,'bob');await a.run('alice','outbox.catch-up',{principal:bob.principal});await a.settle({advance:true});assert.ok(await deleted());
 // Compaction keeps the tombstone: B's snapshot, exported again and imported by a third app instance.
 await a.archive('bob','archive.compact');const again=await a.archive('bob','archive.export');
 await a.switchApp('bob',{ingress:'https://bob-third.box.example/ingress'});await a.archive('bob','archive.import',{expect:again});
 assert.ok(await deleted(),'still deleted after compaction and a second switch');assert.ok(!(await a.run('bob','contacts.list')).contacts.some(c=>c.label==='Carol Old'));
});

test('an interrupted export resumes without re-uploading finished segments',async t=>{
 const a=await mesh(t,{limits:{segmentBytes:4096}}),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob'),storage=bob.storage;
 for(let i=0;i<12;i++)await a.run(i%2?'carol':'alice','conversations.send',{conversationId:cid,text:`export ${i} `+'z'.repeat(300)});await a.settle();
 await a.archive('bob','archive.checkpoint');
 const segmentPuts=()=>storage.log.filter(l=>l.method==='put'&&l.key.includes('/segments/')).length;
 // The fourth segment of the handoff snapshot fails; the manifest is untouched.
 const start=segmentPuts(),manifest=storage.objects.get(MANIFEST_KEY).version;let n=0;
 storage.faults.push({method:'put',when:({args})=>args.key.includes('/segments/')&&++n===4,once:true});
 await rejected(a.archive('bob','archive.export'),'archive_storage_unavailable');
 assert.equal(storage.objects.get(MANIFEST_KEY).version,manifest);assert.equal((await a.archive('bob','archive.status')).interrupted,true);assert.equal(segmentPuts()-start,4);
 const resumed=await a.archive('bob','archive.export');assert.equal(resumed.reused,3);
 assert.equal(segmentPuts()-start,4+resumed.segments-3,'only unfinished segments are uploaded again');
 assert.equal(storage.payload().handoff,true);assert.equal((await a.archive('bob','archive.status')).interrupted,false);
 const expected=await a.texts('bob',cid);
 await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});await a.archive('bob','archive.import',{expect:resumed});
 assert.deepEqual(await a.texts('bob',cid),expected);
 // The failed attempt left no unreferenced object behind once reclaimed.
 a.clock.advance(25*HOUR);await a.archive('bob','archive.reclaim');
 assert.deepEqual(new Set(storage.segmentKeys()),new Set(storage.payload().segments.map(s=>s.name)));
});

test('an interrupted import resumes from its last batch, and rows written meanwhile win',async t=>{
 const a=await mesh(t,{limits:{batchRows:8}}),cid=await a.conversation('alice',['bob','carol']),bob=a.party('bob');
 for(let i=0;i<10;i++)await a.run('alice','conversations.send',{conversationId:cid,text:`import ${i}`});await a.settle();
 const expected=await a.texts('bob',cid),anchor=await a.archive('bob','archive.export');
 // B's mailbox store crashes on one transaction mid-import (a process restart).
 let crashAt=null,count=0;const base=memoryStore([['owner',bob.owner]]);
 const store=new Proxy(base,{get(target,prop){if(prop==='transaction')return work=>{if(crashAt!==null&&++count===crashAt){crashAt=null;return Promise.reject(Object.assign(new Error('crash'),{code:'crash'}));}return target.transaction(work);};const v=target[prop];return typeof v==='function'?v.bind(target):v;}});
 await a.switchApp('bob',{ingress:'https://bob-next.box.example/ingress',store});
 count=0;crashAt=5;await rejected(a.archive('bob','archive.import',{expect:anchor}),'crash');
 const status=await a.archive('bob','archive.status');assert.equal(status.importing,true);
 const job=await bob.store.get('archive/import');assert.ok(job.phase<1||job.batch>0,'stopped inside the import');
 // A row written while the import was paused is newer and must not be rolled back.
 await bob.store.put('conv/settings',{maxParticipants:7,identityDocument:null});
 const result=await a.archive('bob','archive.import',{expect:anchor});assert.equal(result.source,anchor.generation);
 assert.deepEqual(await a.texts('bob',cid),expected);assert.equal((await bob.store.get('conv/settings')).maxParticipants,7);
 assert.equal((await a.archive('bob','archive.status')).importing,false);
 // Resumed batches did not double-charge the hot allowance or duplicate anything.
 const usage=await bob.store.get('usage/v1');assert.ok(!usage||usage.hotItems>=0);
 assert.equal((await a.run('bob','conversations.rejoin')).rejoins,2);await a.settle({advance:true});assert.equal((await a.get('bob',cid)).awaitingSecret,false);
});
