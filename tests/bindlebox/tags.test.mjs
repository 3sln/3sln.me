import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,OTHER} from './helpers/engine.mjs';
import {createTagsProvider,validTagId,validUserTagId,tagDisplay,normalizeAutomatedResult} from '../../packages/bindlebox-engine/domains/tags.mjs';
const fresh=(t,enabled=true)=>{const e=createTestEngine({providers:{tags:createTagsProvider({BINDLEBOX_ENABLED:enabled})}});t.after(()=>e.dispose());return e;};
const put=(e,id='a')=>e.store.put('item/'+id,{id,receivedAt:10,origin:'native',kind:'one-off',state:'inbox',tags:[{id:'topic',source:'intake'},{id:'sys:automation',source:'app'}],notification:'push'});

test('labels are revisioned presentation only, opaque IDs are stable and literal labels never retag stored items',async t=>{
 const e=fresh(t);await put(e);const before=await e.store.get('item/a');
 assert.deepEqual(await e.run('tags.labels'),{revision:0,labels:{}});
 const tag=await e.run('tags.set-label',{input:{label:'{literal.template}',expectedRevision:0}});assert.match(tag.id,/^t\.[a-f0-9]{20}$/);
 const renamed=await e.run('tags.set-label',{input:{id:tag.id,label:'Trabajo',expectedRevision:1}});assert.equal(renamed.id,tag.id);
 await e.run('tags.set-label',{input:{id:'topic',label:'Tema',expectedRevision:2}});assert.deepEqual(await e.store.get('item/a'),before);
 assert.equal((await e.run('tags.labels')).labels.topic,'Tema');
 await assert.rejects(e.run('tags.set-label',{input:{id:'topic',label:'Stale',expectedRevision:1}}),{code:'tag_label_conflict'});
 await e.run('tags.set-label',{input:{id:tag.id,label:null,expectedRevision:3}});assert.equal(Object.hasOwn((await e.run('tags.labels')).labels,tag.id),false);
 // Prototype-looking opaque user IDs are literal own properties.
 await e.run('tags.set-label',{input:{id:'__proto__',label:'Literal'}});assert.equal((await e.run('tags.labels')).labels.__proto__,'Literal');
 assert.equal(tagDisplay('topic',{topic:'Literal'}).label,'Literal');assert.equal(tagDisplay('sys:spam',{'sys:spam':'Forged'}).label,'Spam');
});
test('owner edits record provenance/suppression, preserve structural tags, require revisions and local read watermark',async t=>{
 const e=fresh(t);await put(e);
 const a=await e.run('incoming.update',{input:{id:'a',expectedRevision:1,tags:['mine'],classification:'work',quarantined:true}});
 assert.ok(a.tags.includes('sys:automation'));assert.ok(a.tags.includes('sys:work'));assert.equal(a.classification,'work');assert.equal(a.tagProvenance.mine.source,'owner');assert.ok(a.tagSuppressed.includes('topic'));
 assert.equal((await e.store.get('item/a')).notification,null);
 await assert.rejects(e.run('incoming.update',{input:{id:'a',expectedRevision:1,read:false}}),{code:'incoming_conflict'});
 await assert.rejects(e.run('incoming.update',{input:{id:'a',expectedRevision:2,read:true}}),{code:'incoming_conflict'});
 const b=await e.run('incoming.update',{input:{id:'a',expectedRevision:2,expectedActivityRevision:0,read:true,quarantined:false,addTags:['topic']}});
 assert.equal(b.quarantineReleased,true);assert.equal(b.tagSuppressed.includes('topic'),false);assert.equal(b.readAt,e.clock.now());
 assert.equal((await e.store.get('item/a')).sharedReadReceipt,undefined);
});
test('reserved tags/lookalikes, automated finals, excessive tags and owner-created suspected tags are rejected',async t=>{
 const e=fresh(t);await put(e);
 for(const id of ['sys:unknown','SYS:spam','ｓｙｓ：spam','\u200bsys:spam','sys :spam']){assert.equal(validTagId(id),false,id);await assert.rejects(e.run('tags.set-label',{input:{id,label:'Bad'}}),{code:'invalid_tag_label'});}
 assert.equal(validUserTagId('sys:spam'),false);assert.equal(validUserTagId('literal:topic'),true);
 for(const input of [{addTags:['sys:suspected.spam']},{tags:['sys:suspected.spam']},{addTags:Array.from({length:33},(_,n)=>'u'+n)},{unknown:true}])await assert.rejects(e.run('incoming.update',{input:{id:'a',expectedRevision:1,...input}}),{code:'invalid_actions'});
 assert.throws(()=>normalizeAutomatedResult({source:'classifier',version:'1',labels:[{tag:'sys:spam',probability:1}]}),{code:'invalid_classification'});
 assert.equal((await e.store.get('item/a')).organizationRevision,undefined,'failed tag updates roll back');
 await assert.rejects(e.run('tags.labels',{actor:e.actor(OTHER)}),{code:'forbidden'});
 const off=fresh(t,false);await assert.rejects(off.run('tags.labels'),{code:'not_found'});await assert.rejects(off.run('tags.set-label',{input:{label:'x'}}),{code:'not_found'});
});
