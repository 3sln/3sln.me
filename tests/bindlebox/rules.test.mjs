import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,OTHER} from './helpers/engine.mjs';
import {createRulesProvider} from '../../packages/bindlebox-engine/domains/rules.mjs';
import {createTagsProvider} from '../../packages/bindlebox-engine/domains/tags.mjs';
const fresh=(t,enabled=true)=>{const e=createTestEngine({providers:{rules:createRulesProvider({BINDLEBOX_ENABLED:enabled}),tags:createTagsProvider({BINDLEBOX_ENABLED:enabled})}});t.after(()=>e.dispose());return e;};
const rule=(id,tags,actions)=>({id,enabled:true,match:{tagsAll:tags},actions});
const put=(e,id='a',extra={})=>e.store.put('item/'+id,{id,receivedAt:10,origin:'native',kind:'one-off',state:'inbox',tags:[{id:'original',source:'intake'}],...extra});

test('rules match one immutable snapshot with no chains or loops and fire once across repeated intake passes',async t=>{
 const e=fresh(t);await put(e);
 await e.run('rules.replace',{input:{rules:[rule('first',['original'],{addTags:['next'],removeTags:['original']}),rule('chain',['next'],{addTags:['loop']}),rule('loop',['loop'],{addTags:['original']})]}});
 const a=await e.run('rules.apply',{id:'a'});assert.deepEqual(a.tags,['next']);assert.deepEqual(a.firedRules,['first']);
 const b=await e.run('rules.apply',{id:'a'});assert.deepEqual(b.tags,['next']);assert.deepEqual(b.firedRules,['first']);
});
test('owner removals, additions, classification, collection and quarantine release survive later rules',async t=>{
 const e=fresh(t);await put(e);
 await e.run('incoming.update',{input:{id:'a',expectedRevision:1,removeTags:['original'],addTags:['kept'],classification:'work',collection:'owner',quarantined:false}});
 await e.run('rules.replace',{input:{rules:[rule('later',['original'],{addTags:['original'],removeTags:['kept'],classification:'spam',collection:'rule',quarantined:true})]}});
 const result=await e.run('rules.apply',{id:'a'});assert.deepEqual([...result.tags].sort(),['kept','sys:work']);assert.equal(result.classification,'work');assert.equal(result.collection,'owner');assert.equal(result.quarantined,false);
});
test('default rules are seeded, editable, deletable without resurrection and explicitly restorable',async t=>{
 const e=fresh(t),rules=await e.run('rules.list');assert.equal(rules.length,11);assert.ok(rules.every(r=>r.default&&r.revision===1));
 const spam=rules.find(r=>r.id==='default:promote.spam');
 const edited=await e.run('rules.replace',{input:{rules:rules.map(r=>r.id===spam.id?{...r,enabled:false,actions:{addTags:['review']},revision:999,default:{forged:true}}:r)}});
 assert.equal(edited.find(r=>r.id===spam.id).revision,2);assert.deepEqual(edited.find(r=>r.id===spam.id).default,spam.default);
 await e.run('rules.delete',{id:spam.id});assert.equal((await e.run('rules.list')).some(r=>r.id===spam.id),false);
 assert.equal((await e.run('rules.restore-default',{id:spam.id})).actions.quarantined,true);
 await assert.rejects(e.run('rules.restore-default',{id:'unknown'}),{code:'not_found'});
 await assert.rejects(e.run('rules.replace',{input:{rules:[rule('default:forged',['a'],{})]}}),{code:'invalid_rules'});
});
test('concurrent rule deletion is atomic; invalid input and default-off rules fail closed',async t=>{
 const e=fresh(t);await e.run('rules.replace',{input:{rules:[rule('a',['one'],{}),rule('b',['two'],{})]}});
 await Promise.all(['a','b'].map(id=>e.run('rules.delete',{id})));assert.ok((await e.run('rules.list')).every(r=>!['a','b'].includes(r.id)));
 for(const rules of [undefined,[rule('x',['one'],{read:true})],[rule('x',['one'],{addTags:['sys:suspected.spam']})],[{...rule('x',['one'],{}),match:{eval:'bad'}}]])await assert.rejects(e.run('rules.replace',{input:{rules}}));
 await assert.rejects(e.run('rules.list',{actor:e.actor(OTHER)}),{code:'forbidden'});
 const off=fresh(t,false);await assert.rejects(off.run('rules.list'),{code:'not_found'});
});
test('first-write suspected rule IDs stay intact, owner reassertion wins and delivery collection stays immutable',async t=>{
 const e=fresh(t);await put(e,'a',{collection:undefined,tags:[{id:'existing',source:'rule'}]});
 const rules=await e.run('rules.replace',{input:{rules:[{id:'suspected',enabled:true,match:{tagsAll:['sys:suspected.social'],source:'classifier'},actions:{addTags:['sys:social']}}]}});
 assert.deepEqual(rules[0].match.tagsAll,['sys:suspected.social']);
 await e.run('incoming.update',{input:{id:'a',expectedRevision:1,addTags:['existing'],collection:'owner'}});
 await e.run('rules.replace',{input:{rules:[{id:'remove',enabled:true,match:{},actions:{removeTags:['existing']}},{id:'collection',enabled:true,match:{collection:'owner'},actions:{addTags:['bad-snapshot']}}]}});
 const result=await e.run('rules.apply',{id:'a'});assert.ok(result.tags.includes('existing'));assert.equal(result.tags.includes('bad-snapshot'),false);
});
