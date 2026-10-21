import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,OWNER,OTHER,memoryStore} from './helpers/engine.mjs';
import {createViewsProvider} from '../../packages/bindlebox-engine/domains/views.mjs';
import {createTagsProvider} from '../../packages/bindlebox-engine/domains/tags.mjs';
import {projectIncoming,removeIncoming} from '../../packages/bindlebox-engine/store/item-index.mjs';
const providers=enabled=>({views:createViewsProvider({BINDLEBOX_ENABLED:enabled}),tags:createTagsProvider({BINDLEBOX_ENABLED:enabled})});
const fresh=(t,options={})=>{const e=createTestEngine({providers:providers(true),...options});t.after(()=>e.dispose());return e;};
const item=(id,extra={})=>({id,kind:'one-off',origin:'native',subject:id,receivedAt:10,activityAt:10,state:'inbox',tags:[{id:'work',source:'intake'}],...extra});
const index=async(e,row)=>{await e.store.put('item/'+row.id,row);return e.run('incoming.index',{id:row.id});};

test('Views create idempotently after reply loss, conflict on changed retry, update/delete only definitions',async t=>{
 const e=fresh(t,{faults:{mailboxStore:[{method:'transaction',when:1,mode:'after'}]}}),input={operationId:OTHER,name:'Work',filter:{version:1,tagsAll:['work']}};
 await assert.rejects(e.run('views.create',{input}),{code:'injected_fault'});
 const view=await e.run('views.create',{input});assert.deepEqual(await e.run('views.create',{input}),view);
 assert.equal((await e.run('views.list')).views.length,4);
 await assert.rejects(e.run('views.create',{input:{...input,name:'Other'}}),{code:'view_operation_conflict'});
 await index(e,item('a'));const page=await e.run('incoming.query',{input:{view:view.id,viewRevision:1}});assert.equal(page.total,1);
 const updated=await e.run('views.update',{id:view.id,input:{name:'Renamed',filter:{version:1},expectedRevision:1}});assert.equal(updated.revision,2);
 await assert.rejects(e.run('incoming.query',{input:{view:view.id,viewRevision:1}}),{code:'view_conflict'});
 await assert.rejects(e.run('views.delete',{id:view.id,input:{expectedRevision:1}}),{code:'view_conflict'});
 assert.deepEqual(await e.run('views.delete',{id:view.id,input:{expectedRevision:2}}),{deleted:true});
 assert.ok(await e.store.get('item/a'));assert.equal((await e.run('incoming.query')).total,1);
 await assert.rejects(e.run('incoming.query',{input:{view:view.id,viewRevision:2}}),{code:'view_not_found'});
});
test('Views overlap without content duplication; filters are metadata-only and cursor handles bind query and revision',async t=>{
 const e=fresh(t);for(let n=0;n<4;n++)await index(e,item('m'+n,{receivedAt:n,activityAt:4-n}));
 const view=await e.run('views.create',{input:{name:'Work',filter:{version:1,tagsAll:['work']}}});
 let page=await e.run('incoming.query',{input:{limit:2}});assert.deepEqual(page.items.map(i=>i.id),['m0','m1']);assert.equal(page.total,4);assert.ok(page.cursor);
 assert.deepEqual((await e.run('incoming.query',{input:{cursor:page.cursor,limit:2}})).items.map(i=>i.id),['m2','m3']);
 await assert.rejects(e.run('incoming.query',{input:{cursor:page.cursor,sort:'received-desc'}}),{code:'cursor_stale'});
 await assert.rejects(e.run('incoming.query',{input:{cursor:page.cursor+'x'}}),{code:'cursor_stale'});
 assert.equal((await e.run('incoming.query',{input:{view:view.id,viewRevision:1}})).total,4);
 const unread=await e.run('incoming.query',{input:{filter:{version:1,read:false}}});assert.equal(unread.total,4);
 await e.run('incoming.update',{input:{id:'m0',expectedRevision:1,expectedActivityRevision:0,read:true}});
 assert.equal((await e.run('incoming.query',{input:{filter:{version:1,read:false}}})).total,3);
 await assert.rejects(e.run('incoming.query',{input:{cursor:page.cursor}}),{code:'cursor_stale'});
 const store=memoryStore([['owner',OWNER]]);await store.transaction(tx=>projectIncoming(tx,item('metadata')));
 const guarded=fresh(t,{store,wrap:{mailboxStore:s=>({...s,get:key=>{assert.ok(!key.startsWith('body/'));return s.get(key);},transaction:work=>s.transaction(tx=>work({...tx,get:key=>{assert.ok(!key.startsWith('body/')&&!key.startsWith('item/'));return tx.get(key);},list:q=>{assert.equal(q.prefix,'bb:incoming:row/');return tx.list(q);}}))})}});
 assert.equal((await guarded.run('incoming.query')).total,1);
});
test('conversation projection keeps one card and owner overlay/read watermark through event changes and removal',async t=>{
 const e=fresh(t),summary=item('conversation:one',{type:'conversation',kind:'conversation',activityRevision:1});
 await e.store.transaction(tx=>projectIncoming(tx,summary));
 await e.run('incoming.update',{input:{id:summary.id,expectedRevision:1,expectedActivityRevision:1,read:true,addTags:['mine']}});
 await e.run('incoming.update',{input:{id:summary.id,expectedRevision:2,addTags:['other']}});
 await e.store.transaction(tx=>projectIncoming(tx,{...summary,activityAt:50,activityRevision:2}));
 const page=await e.run('incoming.query');assert.equal(page.total,1);assert.ok(page.items[0].tags.includes('mine'));assert.equal(page.items[0].readAt,null);
 await assert.rejects(e.run('incoming.update',{input:{id:summary.id,expectedRevision:3,expectedActivityRevision:1,read:true}}),{code:'incoming_conflict'});
 await e.store.transaction(tx=>removeIncoming(tx,summary.id));assert.equal((await e.run('incoming.query')).total,0);
 await e.store.transaction(tx=>projectIncoming(tx,{...summary,activityRevision:3}));assert.ok((await e.run('incoming.query')).items[0].tags.includes('other'));
});
test('View grammar, owner binding and default-off provider gates reject invalid or unauthorized calls',async t=>{
 const e=fresh(t);
 for(const filter of [{version:2},{version:1,tagsAny:['a']},{version:1,tagsAll:['SYS:spam']},{version:1,tagsAll:['x','x']},{version:1,receivedAfter:10,receivedBefore:1}])await assert.rejects(e.run('incoming.query',{input:{filter}}),{code:'invalid_view'});
 await assert.rejects(e.run('views.list',{actor:e.actor(OTHER)}),{code:'forbidden'});
 await assert.rejects(e.run('views.list',{actor:{kind:'app',owner:OWNER}}),{code:'unauthorized'});
 const off=fresh(t,{providers:providers(false)});await assert.rejects(off.run('views.list'),{code:'not_found'});await assert.rejects(off.run('incoming.query'),{code:'not_found'});
});
