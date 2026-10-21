import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine} from './helpers/engine.mjs';
import {createTagsProvider} from '../../packages/bindlebox-engine/domains/tags.mjs';
import {organizationProviders} from '../../packages/bindlebox-engine/domains/views.mjs';
import {base64url} from '../../packages/bindlebox-protocol/index.mjs';
const MODEL={model:'triage',version:'1',schema:'categories-v1'},pin={...MODEL,thresholds:{social:.8,spam:.97,automation:.9,promotional:.8}},encoder=new TextEncoder();
const fresh=(t,classifier=null,extra={})=>{const e=createTestEngine({providers:{...organizationProviders({BINDLEBOX_ENABLED:true,classifier}),...extra}});t.after(()=>e.dispose());return e;};
const put=(e,id='a',extra={})=>e.store.put('item/'+id,{id,origin:'channel',kind:'channel',subject:'',receivedAt:10,state:'inbox',tags:[],notification:'push',asserted:{automation:['auto-submitted','list-id'],sender:{headerFrom:'private@sender.example'}},message:{parts:[{mimeType:'text/plain',dataBase64url:base64url(encoder.encode('Hello 123456 https://signed.example/token?secret=private bearer secretBearerValue bindle_meta=capability '+'😀'.repeat(3000)))}]},...extra});
const enable=e=>e.run('classify.settings',{input:{consent:true,pin}});
const fake=(labels={social:.9},evidence=MODEL)=>({calls:[],async decide(input){this.calls.push(input);return {labels,evidence};}});

test('classification without a classifier, consent or allowance yields header hints only and never finalizes/rejects',async t=>{
 for(const mode of ['absent','consent','allowance','throw','malformed','requiresConsent']){
  const c=fake();if(mode==='throw')c.decide=async()=>{c.calls.push({});throw new Error('Unavailable');};if(mode==='malformed')c.decide=async()=>({labels:{'sys:spam':1},evidence:MODEL});if(mode==='requiresConsent')c.decide=async()=>({requiresConsent:true});
  const e=fresh(t,mode==='absent'?undefined:c);await put(e);if(!['absent','consent'].includes(mode))await enable(e);if(mode==='allowance')await e.run('classify.settings',{input:{allowance:0}});
  const r=await e.run('classify.item',{id:'a'});assert.equal(r.source,'heuristic');assert.deepEqual([...r.item.tags].sort(),['sys:suspected.automation','sys:suspected.promotional']);assert.equal(r.item.quarantined,undefined);assert.equal(r.item.state,'inbox');
  if(['absent','consent','allowance'].includes(mode))assert.equal(c.calls.length,0);
 }
});
test('a consented host classifier sees minimized text only, model-bound thresholds select suspected tags and owner rules promote',async t=>{
 const c=fake({social:.91,spam:.96,promotional:.2}),e=fresh(t,c);await put(e);await enable(e);
 const status=await e.run('classify.status');assert.equal(status.consent,true);assert.deepEqual(status.pins,[pin]);
 const r=await e.run('classify.item',{id:'a'});assert.equal(r.source,'classifier');assert.deepEqual(r.item.tags,['sys:social']);assert.equal(r.item.tagProvenance['sys:social'].source,'rule');assert.equal(r.item.tagProvenance['sys:social'].from,'sys:suspected.social');assert.equal(r.item.automated['sys:suspected.social'].classifier.probability,.91);
 assert.deepEqual(Object.keys(c.calls[0]).sort(),['hints','text']);assert.ok(encoder.encode(c.calls[0].text).byteLength<=2000);assert.equal(c.calls[0].text.includes('\ufffd'),false);for(const secret of ['123456','signed.example','secretBearerValue','capability','private@sender.example'])assert.equal(c.calls[0].text.includes(secret),false,secret);
 const before=await e.store.get('item/a');await e.run('classify.item',{id:'a'});assert.deepEqual(await e.store.get('item/a'),before,'repeated identical evidence has no state changes');
});
test('new model/version/schema is calibration only; disabled defaults leave genuine suspected tags',async t=>{
 for(const field of ['model','version','schema']){
  const c=fake({social:1},{...MODEL,[field]:'changed'}),e=fresh(t,c);await put(e);await enable(e);
  const r=await e.run('classify.item',{id:'a'});assert.equal(r.status,'calibration');assert.ok(r.item.tags.every(t=>t.startsWith('sys:suspected.')));assert.equal(r.item.automated?.['sys:suspected.social'],undefined);
 }
 const c=fake(),e=fresh(t,c);await put(e);await enable(e);const rules=await e.run('rules.list');await e.run('rules.replace',{input:{rules:rules.map(r=>({...r,enabled:false}))}});
 const r=await e.run('classify.item',{id:'a'});assert.deepEqual(r.item.tags,['sys:suspected.social']);assert.equal(r.item.tagProvenance['sys:suspected.social'].source,'classifier');
});
test('owner suppression, manual category choices and quarantine release survive later classifier results',async t=>{
 const c=fake({social:1,spam:1}),e=fresh(t,c);await put(e);await enable(e);
 const initial=await e.run('classify.item',{id:'a'});assert.equal(initial.item.quarantined,true);assert.equal((await e.store.get('item/a')).notification,null);
 await e.run('incoming.update',{input:{id:'a',expectedRevision:initial.item.organizationRevision,removeTags:['sys:social','sys:spam'],classification:'work',quarantined:false}});
 const rules=await e.run('rules.list');await e.run('rules.replace',{input:{rules:[...rules,{id:'later',enabled:true,match:{tagsAll:['sys:suspected.automation']},actions:{addTags:['sys:social'],classification:'spam',quarantined:true}}]}});
 c.decide=async()=>({labels:{automation:1},evidence:MODEL});const r=await e.run('classify.item',{id:'a'});assert.equal(r.item.classification,'work');assert.equal(r.item.quarantined,false);assert.equal(r.item.tags.includes('sys:social'),false);
});
test('automation runs only newly matched rules; an owner-removed suspected tag cannot later promote',async t=>{
 const c=fake(),e=fresh(t,c);await put(e);await enable(e);await e.run('rules.delete',{id:'default:promote.social'});
 const r=await e.run('classify.item',{id:'a'});await e.run('incoming.update',{input:{id:'a',expectedRevision:r.item.organizationRevision,removeTags:['sys:suspected.social']}});
 await e.run('rules.restore-default',{id:'default:promote.social'});await e.run('classify.item',{id:'a'});
 assert.equal((await e.store.get('item/a')).tags.some(t=>t.id==='sys:social'),false);
 await e.run('rules.replace',{input:{rules:[{id:'new-social',enabled:true,match:{tagsAll:['sys:suspected.social']},actions:{addTags:['too-late']}}]}});
 c.decide=async()=>({labels:{social:1,automation:1},evidence:MODEL});const next=await e.run('classify.item',{id:'a'});assert.equal(next.item.tags.includes('too-late'),false);
});
test('public intake retains BB-B2 tiers; conversations require explicit local opt-in; metering reserves atomically',async t=>{
 const c=fake(),e=fresh(t,c);await enable(e);
 for(const [id,extra] of [['pending',{state:'pending',request:true}],['rejected',{state:'rejected',request:true}],['conversation',{kind:'conversation',type:'conversation'}]]){
  await put(e,id,extra);assert.equal((await e.run('classify.item',{id})).status,'skipped');
 }
 assert.equal(c.calls.length,0);await e.run('classify.settings',{input:{conversation:{id:'conversation',enabled:true}}});assert.equal((await e.run('classify.item',{id:'conversation'})).source,'classifier');
 await put(e,'first');await put(e,'second');await e.run('classify.settings',{input:{allowance:2}});
 const results=await Promise.all(['first','second'].map(id=>e.run('classify.item',{id})));assert.equal(results.filter(r=>r.source==='classifier').length,1);assert.equal(c.calls.length,2);
});
test('in-flight classification is fenced by owner edits/consent changes and never triggers failover after a timeout',async t=>{
 let resolve,started;const ready=new Promise(r=>{started=r;}),c={calls:0,async decide(){this.calls++;started();return new Promise(r=>{resolve=r;});}},e=fresh(t,c);await put(e);await enable(e);
 const pending=e.run('classify.item',{id:'a'});await ready;await e.run('classify.settings',{input:{consent:false}});resolve({labels:{spam:1},evidence:MODEL});
 assert.equal((await pending).reason,'changed');assert.deepEqual((await e.store.get('item/a')).tags,[]);assert.equal(c.calls,1);
});
test('classifier operation flag and threshold validation fail closed',async t=>{
 const e=fresh(t,fake(),{tags:createTagsProvider()});await put(e);await assert.rejects(e.run('classify.status'),{code:'not_found'});await assert.rejects(e.run('classify.item',{id:'a'}),{code:'not_found'});
 const on=fresh(t,fake());for(const input of [{pin:{...pin,thresholds:{social:0}}},{pin:{...pin,version:''}},{pin:{...pin,thresholds:{unknown:.5}}},{consent:'yes'}])await assert.rejects(on.run('classify.settings',{input}),{code:'invalid_classification'});
});
test('post-intake tag overflow skips tag changes while retaining evidence and quarantine; intake overflow rolls back',async t=>{
 const c=fake(),e=fresh(t,c);await put(e,'a',{tags:Array.from({length:32},(_,n)=>({id:'tag'+n,source:'intake'}))});await enable(e);
 await e.run('rules.replace',{input:{rules:[{id:'overflow',enabled:true,match:{tagsAll:['sys:suspected.social']},actions:{addTags:['overflow'],quarantined:true}}]}});
 const result=await e.run('classify.item',{id:'a'});assert.equal(result.item.quarantined,true);assert.ok(result.item.automated['sys:suspected.social']);assert.equal(result.item.tags.includes('overflow'),false);assert.ok(result.item.tagHistory.some(h=>h.op==='skip'&&h.reason==='tag_limit'));
 await put(e,'intake',{tags:Array.from({length:32},(_,n)=>({id:'tag'+n,source:'intake'}))});
 await e.run('rules.replace',{input:{rules:[{id:'intake-overflow',enabled:true,match:{tagsAll:['tag0']},actions:{addTags:['overflow']}}]}});
 await assert.rejects(e.run('rules.apply',{id:'intake'}),{code:'invalid_actions'});assert.equal((await e.store.get('item/intake')).firedRules,undefined);
});
