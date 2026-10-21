import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,B,encoder} from './receive-fixtures.test.mjs';
import {createArchiveMesh,rejected} from './archive-fixtures.test.mjs';
import {stageBody,readBody} from '../../packages/bindlebox-engine/store/bodies.mjs';
import {createMailbox} from '../../apps/bindlebox/worker/mailbox.mjs';
import {memoryStore} from './helpers/engine.mjs';
import {createNodeShell} from '../../apps/bindlebox/node/server.mjs';
import {objectStorage} from './archive-fixtures.test.mjs';
import {objectStoragePort} from '../../apps/bindlebox/worker/archive-ports.mjs';

test('BB6-S7: link admission and shell conversation/control ingress are held until control import commits',async t=>{
 const w=await createWorld();t.after(()=>w.dispose());const link=await w.link('bob'),store=w.peer('bob').store;
 await store.put('archive/hold',true);let result=await w.deliver('alice','bob',link);assert.equal(result.status,503);assert.equal(result.json.error,'recipient_storage_unavailable');assert.equal((await w.items('bob')).length,0);
 await store.delete('archive/hold');await store.put('archive/import',{done:false,phase:1,source:{checkpointAt:w.clock.now()-500}});
 result=await w.deliver('alice','bob',link,{createdAt:w.clock.now()-1000});assert.equal(result.json.error,'not_authorized');
 result=await w.deliver('alice','bob',link,{createdAt:w.clock.now()});assert.equal(result.status,200);
 const box=createMailbox({store,BINDLEBOX_ENABLED:true});t.after(()=>box.dispose());await store.put('archive/hold',true);
 for(const name of ['conversations.receive','conversations.respond','shell.public-intake'])await assert.rejects(box.run(w.peer('bob').owner,name,{input:{}}),{code:'recipient_storage_unavailable'});
});

test('BB6-S7: traffic during archive reads is held before any control rows are applied, then resumes',async t=>{
 const a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());await a.conversation('alice',['bob']);const anchor=await a.archive('bob','archive.export');await a.switchApp('bob');const p=a.party('bob');let observed=false;
 p.storage.before=async({method})=>{if(method!=='get'||observed)return;observed=true;assert.equal(await p.store.get('archive/hold'),true);};
 await a.archive('bob','archive.import',{expect:anchor});assert.equal(observed,true);assert.equal(await p.store.get('archive/hold'),undefined);
});

test('BB6-S8: a signed archive with a forged inner envelope is refused before imported rows commit',async t=>{
 const a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());const cid=await a.conversation('alice',['bob']);await a.run('alice','conversations.send',{conversationId:cid,text:'authentic'});await a.settle();const p=a.party('bob'),entry=[...(await p.store.list({prefix:'conv/event/'}))].find(([,v])=>v.type==='message');
 assert.ok(entry[1].envelope);entry[1].envelope.proof.signature='A'.repeat(86);await p.store.put(...entry);const anchor=await a.archive('bob','archive.export');await a.switchApp('bob');await rejected(a.archive('bob','archive.import',{expect:anchor}),'archive_invalid');assert.equal((await p.store.list({prefix:'conv/event/'})).size,0);
});

test('BB-B2: staged large bodies are ciphertext in the object-storage contract, authenticate every part and remain readable',async()=>{
 const objects=objectStorage(),store=memoryStore([['owner','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]),port=objectStoragePort({store,services:{objectStorage:({method,args})=>objects.call(method,args)}}),text='private staged body '.repeat(50000),body=encoder.encode(text),ref=await stageBody(port,'bindlebox/v1/items/test/random',body);
 assert.ok(ref.seal.parts.length>1);assert.equal([...objects.objects.values()].some(o=>new TextDecoder().decode(o.bytes).includes('private staged body')),false);assert.deepEqual(await readBody(port,ref),body);
 const name=ref.seal.parts[0].key,bytes=objects.bytes(name).slice();bytes[0]^=1;objects.set(name,bytes);await assert.rejects(readBody(port,ref),{code:'body_unavailable'});
});

test('B9 shell and owner web RPC mount only behind the existing default-off flag',async t=>{
 const off=await createNodeShell();t.after(()=>off.close());assert.equal((await off.fetch(new Request('https://messages.example/'))).status,404);
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),directory=await mkdtemp(join(tmpdir(),'bb-wave4-')),owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const shell=await createNodeShell({directory,BINDLEBOX_ENABLED:true,localTestArchiveKeys:true,services:{authenticate:async()=>({kind:'owner',owner})}});t.after(async()=>{await shell.close();await rm(directory,{recursive:true,force:true});});
 const [first,second]=await Promise.all([shell.mailbox(owner),shell.mailbox(owner)]);assert.equal(first.box,second.box);
 assert.match(await (await shell.fetch(new Request('https://messages.example/'))).text(),/app.mjs/);
 const response=await shell.fetch(new Request('https://messages.example/api/web/operation',{method:'POST',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({name:'contacts.list',input:{}})}));assert.equal(response.status,200);assert.deepEqual((await response.json()).contacts,[]);
});

test('B9 timeline pages bound transfer and body reads, preserving stable older/newer offsets',async t=>{
 const a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());const cid=await a.conversation('alice',['bob']);for(let n=0;n<42;n++)await a.run('bob','conversations.send',{conversationId:cid,text:'entry '+n});
 const latest=await a.run('bob','conversations.get',{conversationId:cid});assert.equal(latest.pagination.total,43);assert.equal(latest.pagination.offset,40);assert.equal(latest.timeline.length,3);
 const earlier=await a.run('bob','conversations.get',{conversationId:cid,offset:0,limit:40});assert.equal(earlier.timeline.length,40);assert.equal(earlier.pagination.next,40);assert.equal(earlier.timeline.at(-1).text,'entry 38');
 await assert.rejects(a.run('bob','conversations.get',{conversationId:cid,limit:101}),{code:'invalid_input'});
});

test('B9 new conversations resolve stored contacts through live verified identity and messaging descriptor ports',async t=>{
 const a=await createArchiveMesh({names:['alice','bob','carol']});t.after(()=>a.dispose());const alice=a.party('alice'),bob=a.party('bob'),contact=await a.run('bob','contacts.add',{link:await a.link('alice'),label:'Alice'});let corrupt=false;
 const box=createMailbox({store:bob.store,BINDLEBOX_ENABLED:true,clock:a.clock,ports:{directory:{...a.directory,resolveContact:async()=>({principal:corrupt?a.party('carol').principal:alice.principal,keyId:alice.keyId,ingress:alice.ingress})},delegateKeys:{current:()=>bob.current()}}});t.after(()=>box.dispose());
 await box.run(bob.owner,'shell.authorization',{input:{revision:1,active:true,recipients:[alice.principal]}});
 corrupt=true;await assert.rejects(box.run(bob.owner,'shell.conversation-create',{input:{contacts:[contact.id],subject:'Verified conversation',text:'Hello'}}),{code:'author_unverifiable'});
 corrupt=false;const created=await box.run(bob.owner,'shell.conversation-create',{input:{contacts:[contact.id],subject:'Verified conversation',text:'Hello'}});assert.ok(created.conversationId);
});

test('B9 owner Rejected body reads decrypt staged content and reject quarantined items',async t=>{
 const objects=objectStorage(),store=memoryStore([['owner','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]),port=objectStoragePort({store,services:{objectStorage:({method,args})=>objects.call(method,args)}}),w=await createWorld({userStorage:port});t.after(()=>w.dispose());
 const link=await w.link('bob',{public:true}),body=encoder.encode('private rejected content '.repeat(5000)),result=await w.deliver('alice','bob',link,{body});assert.equal(result.status,200);const item=(await w.items('bob'))[0];item.state='rejected';item.imported={verified:false};item.rejectedAt=w.clock.now();await w.peer('bob').store.put('rejected/'+String(item.rejectedAt).padStart(16,'0')+'/'+item.id,{id:item.id});await w.peer('bob').store.put('item/'+item.id,item);
 assert.equal((await w.run('bob','intake.rejected'))[0].author.verified,false);
 const read=await w.run('bob','receive.body',{id:item.id});assert.ok(read.text.startsWith('private rejected content'));assert.equal(read.truncated,true);
 item.quarantined=true;await w.peer('bob').store.put('item/'+item.id,item);await assert.rejects(w.run('bob','receive.body',{id:item.id}),{code:'not_found'});
});

test('BB6-S8: imported body bytes and projected genesis authors remain bound to their verified proofs',async t=>{
 for(const corrupt of ['body','genesis-author']){
  const a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());const cid=await a.conversation('alice',['bob']),sent=await a.run('alice','conversations.send',{conversationId:cid,text:'authentic'});await a.settle();const bob=a.party('bob');
  if(corrupt==='body')await bob.store.put(`conv/body/${cid}/${sent.eventId}`,Array.from(encoder.encode('altered body')));
  else{const entry=[...(await bob.store.list({prefix:`conv/event/${cid}/`}))].find(([,v])=>v.type==='genesis');entry[1].author.principal.subject='99999999-9999-4999-8999-999999999999';await bob.store.put(...entry);}
  const anchor=await a.archive('bob','archive.export');await a.switchApp('bob');await rejected(a.archive('bob','archive.import',{expect:anchor}),'archive_invalid');assert.equal((await bob.store.list({prefix:'conv/event/'})).size,0);
 }
});

test('BB6-S7: refusing import on an existing writer does not leave a live ingress hold',async t=>{
 const a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());await a.conversation('alice',['bob']);const anchor=await a.archive('bob','archive.export');await rejected(a.archive('bob','archive.import',{expect:anchor}),'archive_conflict');assert.equal(await a.party('bob').store.get('archive/hold'),undefined);
});

test('B9 timeline transfer caps revision bodies independently of the message page limit',async t=>{
 const a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());const cid=await a.conversation('alice',['bob']),sent=await a.run('alice','conversations.send',{conversationId:cid,text:'initial'});
 for(let n=0;n<25;n++)await a.run('alice','conversations.edit',{conversationId:cid,target:sent.eventId,text:'revision '+n});
 const page=await a.run('alice','conversations.get',{conversationId:cid,limit:1}),event=page.timeline[0];assert.equal(event.history.length,20);assert.equal(event.historyTruncated,true);assert.equal(event.text,'revision 24');
});

test('BB6-S7: public intake rechecks the import hold after asynchronous provenance verification',async t=>{
 const {bridgeConsumer,P,uuidOf}=await import('./receive-fixtures.test.mjs'),w=await createWorld();t.after(()=>w.dispose());const consumer=await bridgeConsumer(),args=await consumer.args({recipient:P.bob.principal,receivedAt:w.clock.now(),text:'channel request'}),store=w.peer('bob').store;
 w.links.bob.state.consumers.set(consumer.origin,consumer);let paused,release;const entered=new Promise(resolve=>paused=resolve),wait=new Promise(resolve=>release=resolve),original=w.links.bob.consumerKey;
 w.links.bob.consumerKey=async q=>{paused();await wait;return original(q);};const pending=w.intake('bob',{contract:B.INTAKE_CONTRACT,consumer:consumer.origin,tx:uuidOf(900),args});await entered;await store.put('archive/hold',true);release();await assert.rejects(pending,{code:'recipient_storage_unavailable'});assert.equal((await w.items('bob')).length,0);
 await store.delete('archive/hold');await w.intake('bob',{contract:B.INTAKE_CONTRACT,consumer:consumer.origin,tx:uuidOf(901),args});const item=(await w.items('bob'))[0];item.state='rejected';await store.put('item/'+item.id,item);assert.equal((await w.run('bob','receive.body',{id:item.id})).text,'channel request');
});

test('B6 shell composes archive ports and schedules a fixed checkpoint deadline plus durable failure retry',async t=>{
 const {nextWake}=await import('../../apps/bindlebox/worker/storage.mjs'),a=await createArchiveMesh({names:['alice','bob']});t.after(()=>a.dispose());const bob=a.party('bob'),box=createMailbox({store:bob.store,BINDLEBOX_ENABLED:true,clock:a.clock,ports:{directory:a.directory,userStorage:bob.storage,ownerKeys:bob.custody,delegateKeys:{current:()=>bob.current()}}});t.after(()=>box.dispose());
 await box.provision(bob.owner,{authorization:{revision:1,active:true,recipients:[],connection:bob.cnx,generation:1}});const start=a.clock.now();assert.equal(await nextWake(bob.store,start),start+15*60000);a.clock.advance(1000);assert.equal(await nextWake(bob.store,a.clock.now()),start+15*60000);
 assert.equal((await box.run(bob.owner,'archive.status')).enabled,true);assert.equal((await box.run(bob.owner,'archive.checkpoint')).kind,'snapshot');a.clock.advance(16*60000);await bob.store.put('shell:archive-retry',a.clock.now()+60000);assert.equal(await nextWake(bob.store,a.clock.now()),a.clock.now()+60000);
});

test('encrypted body reads bound chunk count and ciphertext bytes before decryption',async()=>{
 const ref=await stageBody({put:async()=>{}},'body',new Uint8Array([1]));let reads=0;const storage={get:async()=>{reads++;return new Uint8Array(786449);}};
 await assert.rejects(readBody(storage,{...ref,seal:{...ref.seal,parts:[...ref.seal.parts,...ref.seal.parts,...ref.seal.parts]}}),{code:'body_unavailable'});assert.equal(reads,0);
 await assert.rejects(readBody(storage,ref),{code:'body_unavailable'});assert.equal(reads,1);
 await assert.rejects(stageBody({put:()=>{throw new Error('must not write');}},'body',new Uint8Array(1048577)),{code:'too_large'});
});
