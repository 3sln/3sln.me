import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryMessagingStore,ContactTokenService,ContactEndpointService,MessagingService} from '../packages/messaging/index.mjs';
import {contactTagPolicy} from '../packages/messaging/tag-policy.mjs';
import {SYSTEM_TAGS,TAG_CATEGORIES,validTagId,validIntakeTagIds,escapeLegacyTag,migrateTags,tagDisplay,seedDefaultRules,defaultRules,heuristicSuspectedTags,normalizeAutomatedResult,classificationOf} from '../packages/messaging/tags.mjs';
import {normalizeIncomingFilter,normalizeIncomingUpdate} from '../packages/runtime/message-views.mjs';
import {catalogues} from '../packages/i18n/catalogues.mjs';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://space.example',enc=new TextEncoder();
async function fixture(policy={requiredTags:['spam'],optionalTags:['bug']}){
 const store=new MemoryMessagingStore(),tokens=new ContactTokenService({store,issuer:origin}),pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);await tokens.registerKey(owner,{kid:'one',alg:'ES256',publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey)});
 const endpoints=new ContactEndpointService({tokens,signer:()=>pair.privateKey}),messages=new MessagingService({store,tokens:endpoints}),collection=await messages.createCollection(owner,'All messages');
 const link=await endpoints.create(owner,{kid:'one',handle:'n.abc',collections:[collection.id],mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,...policy});let n=0;
 const send=async(tags=[])=>{const {token}=await endpoints.mint(link.url);return (await messages.receive(token,{collection:collection.id,mimeType:'text/plain',bytes:enc.encode('hello '+n),idempotencyKey:'k'+n++,senderMetadata:{tags}})).id;};
 return {store,messages,send,read:id=>messages.read(owner,id),classify:(id,labels,source='classifier')=>messages.applyAutomatedTags(owner,id,{source,version:'v1',...source==='classifier'?{model:'@cf/cloudflare/clef-flash'}:{},labels})};
}
test('tag IDs: reserved sys: namespace, look-alikes rejected, legacy escaping, localized system labels, literal user labels',()=>{
 for(const id of ['sys:spam','sys:suspected.recruitment','work','priority:paid','sys_x'])assert(validTagId(id),id);
 for(const id of ['sys:bogus','SYS:spam','ｓｙｓ：spam','​sys:spam',' sys:spam','sys:','x'.repeat(65),''])assert(!validTagId(id),id);
 assert.equal(escapeLegacyTag('sys:spam'),'sys_spam');assert.equal(escapeLegacyTag('SYS:spam'),'sys_spam');assert.equal(escapeLegacyTag('work'),'work');
 assert.equal(Object.keys(SYSTEM_TAGS).length,TAG_CATEGORIES.length*2+2);assert(!validIntakeTagIds(['sys:suspected.spam']));assert(validIntakeTagIds(['sys:spam','bug']));
 for(const {label} of Object.values(SYSTEM_TAGS))for(const locale of ['en','es'])assert(Object.hasOwn(catalogues[locale][''],label),`${locale}: ${label}`);
 assert.equal(catalogues.es['']['Suspected Spam'],'Posible spam');
 assert.deepEqual(tagDisplay('sys:suspected.social'),{id:'sys:suspected.social',label:'Suspected Social',system:true,suspected:true});
 assert.deepEqual(tagDisplay('t.abc',{'t.abc':'{name} <b>'}),{id:'t.abc',label:'{name} <b>',system:false,suspected:false});assert.equal(tagDisplay('__proto__',{}).label,'__proto__');
 // Signed (legacy) claims hold user tags only.
 assert.throws(()=>contactTagPolicy({requiredTags:['sys:spam'],optionalTags:[]}),{code:'invalid_contact_tags'});
});
test('legacy classification folds into system tags lazily and idempotently',()=>{
 const legacy={id:'m',tags:['sys:spam','a'],deliveryTags:['sys:spam'],classification:'work',receivedAt:5},m=migrateTags(legacy);
 assert.deepEqual(m.tags,['sys_spam','a','sys:work']);assert.deepEqual(m.deliveryTags,['sys_spam']);assert.equal(m.classification,'work');assert.deepEqual(m.tagProvenance['sys:work'],{source:'migration',at:5});assert.equal(migrateTags(m),m);assert.equal(legacy.tags[0],'sys:spam');
 assert.equal(classificationOf(['sys:automation','sys:work'],{'sys:automation':{source:'app'}}),'work');assert.equal(classificationOf(['sys:automation','sys:work']),'automation');
});
test('contact link tags are applied as-is, never rewritten to suspected and never promoted',async()=>{
 const f=await fixture(),id=await f.send(['bug']),m=await f.read(id);
 assert.deepEqual(m.tags,['spam','bug']);assert.equal(m.tagProvenance.spam.source,'intake');assert.equal(m.quarantined,false);assert(!m.tags.some(t=>t.startsWith('sys:')));
 await assert.rejects(f.send(['sys:suspected.spam']),{code:'forbidden_tags'});await assert.rejects(f.send(['sys:spam']),{code:'forbidden_tags'});
 const rules=await f.messages.rules(owner);assert.equal(rules.filter(r=>r.default).length,TAG_CATEGORIES.length);assert(rules.every(r=>r.enabled));
});
test('classifier applies only suspected tags; default rules finalize them once with provenance and recoverable quarantine',async()=>{
 const f=await fixture(),id=await f.send();
 for(const labels of [[{tag:'sys:spam'}],[{tag:'sys:suspected.bogus'}],[{tag:'work'}],[{tag:'sys:suspected.spam',probability:2}],[{tag:'sys:suspected.spam'},{tag:'sys:suspected.spam'}]])await assert.rejects(f.classify(id,labels),{code:'invalid_classification'});
 assert.throws(()=>normalizeAutomatedResult({source:'owner',version:'1',labels:[]}),{code:'invalid_classification'});assert.throws(()=>normalizeAutomatedResult({source:'classifier',version:'1',labels:[],actions:{quarantined:true}}),{code:'invalid_classification'});
 let m=await f.classify(id,[{tag:'sys:suspected.spam',probability:0.93},{tag:'sys:suspected.recruitment',probability:0.7}]);
 assert(m.tags.includes('sys:spam')&&m.tags.includes('sys:recruitment'));assert(!m.tags.some(t=>t.startsWith('sys:suspected.')));assert.equal(m.quarantined,true);assert.equal(m.classification,'spam');
 assert.deepEqual(m.tagProvenance['sys:spam'],{source:'rule',ruleId:'default:promote.spam',ruleRevision:1,from:'sys:suspected.spam',at:m.tagProvenance['sys:spam'].at});
 assert.equal(m.automated['sys:suspected.spam'].classifier.probability,0.93);assert.equal(m.classificationResult.classifier.model,'@cf/cloudflare/clef-flash');
 const replay=await f.classify(id,[{tag:'sys:suspected.spam',probability:0.93}]);assert.deepEqual(replay.tags,m.tags);assert.equal(replay.tagHistory.length,m.tagHistory.length);
 assert.equal((await f.store.transaction(tx=>tx.get(`notification-event/${owner}/${id}/`))),undefined);
});
test('sender-controlled heuristics stay suspected; owner removal and quarantine release are never undone by automation',async()=>{
 const f=await fixture(),hint=heuristicSuspectedTags({'List-Unsubscribe':'<mailto:x@list.example>','Auto-Submitted':'auto-generated'});
 assert.deepEqual(hint.labels.map(l=>l.tag),['sys:suspected.automation','sys:suspected.promotional']);assert.deepEqual(heuristicSuspectedTags({'Auto-Submitted':'no'}).labels,[]);
 const id=await f.send();let m=await f.messages.applyAutomatedTags(owner,id,hint);assert(m.tags.includes('sys:suspected.promotional')&&!m.tags.includes('sys:promotional'));
 m=await f.messages.update(owner,id,{removeTags:['sys:suspected.automation']});assert(m.tagSuppressed.includes('sys:suspected.automation'));
 m=await f.classify(id,[{tag:'sys:suspected.automation'},{tag:'sys:suspected.promotional'}]);assert(!m.tags.includes('sys:suspected.automation')&&!m.tags.includes('sys:automation'));assert(m.tags.includes('sys:promotional'));
 const other=await f.send();await f.messages.update(owner,other,{quarantined:false});m=await f.classify(other,[{tag:'sys:suspected.spam'}]);assert(m.tags.includes('sys:spam'));assert.equal(m.quarantined,false);
 await assert.rejects(f.messages.update(owner,other,{addTags:['sys:suspected.social']}),{code:'invalid_actions'});await assert.rejects(f.messages.update(owner,other,{tags:['sys:bogus']}),{code:'invalid_actions'});
});
test('rules: no chains, once per message, server-owned default markers, deletion respected, restore available',async()=>{
 const f=await fixture(),defaults=(await f.messages.rules(owner)).filter(r=>r.id!=='default:promote.social');
 await assert.rejects(f.messages.setRules(owner,[{id:'bad',enabled:true,match:{},actions:{addTags:['sys:suspected.spam']}}]),{code:'invalid_actions'});
 await assert.rejects(f.messages.setRules(owner,[{id:'default:mine',enabled:true,match:{},actions:{}}]),{code:'invalid_rules'});
 await assert.rejects(f.messages.setRules(owner,[{id:'src',enabled:true,match:{tagsAll:['bug'],source:'classifier'},actions:{}}]),{code:'invalid_rules'});
 const rules=[{id:'a',enabled:true,match:{tagsAll:['sys:suspected.social']},actions:{addTags:['chained']}},{id:'b',enabled:true,match:{tagsAll:['chained']},actions:{addTags:['never']}},...defaults.map(r=>({...r,default:{version:1,base:'forged'},revision:99}))];
 const saved=await f.messages.setRules(owner,rules);assert(saved.find(r=>r.id==='default:promote.spam').default.base!=='forged');assert.equal(saved.find(r=>r.id==='default:promote.spam').revision,1);assert.equal(saved.find(r=>r.id==='a').revision,1);
 assert(!(await f.messages.rules(owner)).some(r=>r.id==='default:promote.social'));
 await assert.rejects(f.messages.setRules(owner,[...saved,{id:'default:promote.social',enabled:true,match:{tagsAll:['sys:suspected.social']},actions:{}}]),{code:'invalid_rules'});
 const id=await f.send();let m=await f.messages.applyAutomatedTags(owner,id,{source:'heuristic',version:'h',labels:[{tag:'sys:suspected.social'}]});assert(m.tags.includes('chained')&&!m.tags.includes('never'));
 await f.messages.update(owner,id,{removeTags:['chained']});m=await f.classify(id,[{tag:'sys:suspected.social'}]);assert(!m.tags.includes('chained'));assert.deepEqual(m.firedRules,['a']);
 const restored=await f.messages.restoreDefaultRule(owner,'default:promote.social');assert.equal(restored.default.version,1);assert((await f.messages.rules(owner)).some(r=>r.id==='default:promote.social'));
});
test('default rule upgrades keep owner edits and never re-add deleted defaults',()=>{
 const first=seedDefaultRules([{id:'mine',enabled:true,match:{tagsAll:['sys:legacy']},actions:{tags:['sys:old']}}],null);
 assert.deepEqual(first.rules[0].match.tagsAll,['sys_legacy']);assert.deepEqual(first.rules[0].actions.tags,['sys_old']);assert.equal(seedDefaultRules(first.rules,first.state),null);
 const stale={version:0,seeded:Object.fromEntries(defaultRules().map(r=>[r.id,0]))},rules=first.rules.filter(r=>r.id!=='default:promote.code').map(r=>r.id==='default:promote.social'?{...r,actions:{addTags:['mine']},default:{...r.default,version:0}}:r.default?{...r,enabled:r.id!=='default:promote.spam',default:{...r.default,version:0}}:r);
 const up=seedDefaultRules(rules,stale),spam=up.rules.find(r=>r.id==='default:promote.spam'),social=up.rules.find(r=>r.id==='default:promote.social');
 assert(!up.rules.some(r=>r.id==='default:promote.code'));assert.equal(spam.default.version,1);assert.equal(spam.revision,2);assert.equal(spam.enabled,false);
 assert.equal(social.default.updateAvailable,1);assert.equal(social.default.version,0);assert.deepEqual(social.actions,{addTags:['mine']});
});
test('classification compatibility writes map to system tags; Views accept registered IDs only',async()=>{
 const f=await fixture({requiredTags:[],optionalTags:[]}),id=await f.send();
 let m=await f.messages.update(owner,id,{classification:'spam'});assert(m.tags.includes('sys:spam'));assert.equal(m.classification,'spam');
 m=await f.messages.update(owner,id,{classification:'work',tags:['mine']});assert.deepEqual(m.tags,['mine','sys:work']);m=await f.messages.update(owner,id,{tags:[]});assert.deepEqual(m.tags,['sys:work']);
 m=await f.messages.update(owner,id,{classification:'unclassified'});assert.deepEqual(m.tags,[]);assert.equal(m.classification,'unclassified');
 assert.deepEqual(normalizeIncomingFilter({version:1,tagsAll:['sys:spam','a']}),{version:1,tagsAll:['a','sys:spam']});assert.throws(()=>normalizeIncomingFilter({version:1,tagsAll:['sys:bogus']}),{code:'invalid_view'});
 assert.throws(()=>normalizeIncomingUpdate({id:'conversation:x',expectedRevision:1,addTags:['sys:suspected.spam']}),{code:'invalid_view'});assert.deepEqual(normalizeIncomingUpdate({id:'conversation:x',expectedRevision:1,removeTags:['sys:suspected.spam']}).removeTags,['sys:suspected.spam']);
});
test('owner index re-projects legacy rows so classification and escaped tags reach the tag index',async t=>{
 const {SqliteMetadata}=await import('../apps/node/resources.mjs'),{AccountItemIndex}=await import('../packages/runtime/item-index.mjs'),metadata=new SqliteMetadata(':memory:');t.after(()=>metadata.close());
 const index=new AccountItemIndex(metadata.sql),legacy={id:'legacy',owner,receivedAt:1,readAt:null,collection:'c',tags:['sys:old'],classification:'spam',mimeType:'text/plain',size:1};
 metadata.sql.exec('INSERT INTO incoming_members(id,owner,item_id,received_at,unread,record,sequence) VALUES(?,?,?,?,?,?,0)','legacy',owner,'legacy',1,1,JSON.stringify(legacy));index.setIncomingState('ready','1');
 assert.equal((await index.incomingPage(owner,{filter:{version:1,tagsAll:['sys:spam']}})).items.length,0);assert.equal(index.migrateIncoming(),true);assert.equal(index.incomingState('tag-model'),'1');
 const page=await index.incomingPage(owner,{filter:{version:1,tagsAll:['sys:spam','sys_old'],classifications:['spam']}});assert.deepEqual(page.items.map(i=>i.id),['legacy']);
});
