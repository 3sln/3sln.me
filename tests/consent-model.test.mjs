import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTestEngine} from './helpers/app-engine.mjs';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';
import {slotDigest} from '../packages/federation/extensions.mjs';
import {createConsentProvider,ConsentMethod,ConsentContract,ConsentBus,ConsentGrant,ConsentModel,CONSENT_OPERATIONS,REVIEWED_CONTRACTS,EVENT_BUS_CONTRACT,chooseLocale} from '../packages/consent/index.mjs';

const app='https://tasks.example/client',unreviewed='https://unknown.example/client',base='https://3sln.me/artefacts/contracts/',storage=base+'object-storage/v1',third='https://calendar.example/contracts/v1',self='https://api.tasks.example/contracts/v1',feed='https://calendar.example/feeds/v1',ownFeed='https://api.tasks.example/feeds/v1',settings='https://calendar.example/settings/v1';
// Fixture resolver only; production composition must supply a PSL resolver.
const registrableDomain=host=>({'3sln.me':'3sln.me','app.owner.co.test.example':'owner.co.test.example','contracts.owner.co.test.example':'owner.co.test.example','other.co.test.example':'other.co.test.example'})[host]??(host.endsWith('.example')?host.split('.').slice(-2).join('.'):undefined);
const pin=(id,methods)=>({schema:{$id:id,'x-methods':methods},digest:'sha256-fixture-unreviewed'});
const bus=(id,categories=[])=>({schema:{id,title:'Changes',publisher:'https://forged.example',slot:{bus:{v:1,categories,effects:{read:{en:'See calendar changes',es:'Ver cambios del calendario'},write:{en:'Trigger the connected apps'}}}}},digest:'fixture'});
async function harness(t,options={}){
 const contracts={};for(const [id,entry] of Object.entries(REVIEWED_CONTRACTS))contracts[id]={schema:JSON.parse(await readFile(new URL('../'+entry.source,import.meta.url))),digest:entry.digest};
 contracts[third]=pin(third,{read:{effect:'read',summary:{en:'See your calendar events',es:'Ver tus eventos'}},write:{effect:'write',summary:{en:'Add events'}},remove:{effect:'destructive'},unknown:{},pure:{effect:'pure'},future:{effect:'future'},constructor:{effect:'constructor'}});
 contracts[self]=pin(self,{read:{effect:'read',summary:{en:'Only read harmless data'}}});
 const manifests={[feed]:bus(feed),[ownFeed]:bus(ownFeed),[settings]:{schema:{id:settings,fields:{day:{type:'string',title:'Send day'},where:{type:'string',title:'Location',categories:['location']},resource:{type:'resource',title:'Calendar'}}}}};
 const apps={[app]:{reviewed:true},[unreviewed]:{reviewed:false}},facts={contracts,manifests,apps,registrableDomain,...options.facts};
 const provider=createConsentProvider(facts),e=await createTestEngine({providers:{consent:provider,config:{INCREMENTAL_AUTH_ENABLED:true},...options.providers}});t.after(()=>e.dispose());
 const read=(Query,input)=>e.read(new Query({input:{app,...input}}));return {e,facts,provider,read,method:input=>read(ConsentMethod,input),contract:input=>read(ConsentContract,input),bus:input=>read(ConsentBus,input),grant:input=>read(ConsentGrant,input),model:input=>read(ConsentModel,input)};
}

test('catalogue pins match exact local artefacts and ship complete en/es text',async()=>{
 for(const [id,entry] of Object.entries(REVIEWED_CONTRACTS)){const schema=JSON.parse(await readFile(new URL('../'+entry.source,import.meta.url)));assert.equal(schema.$id,id);assert.equal(await slotDigest(crypto,schema),entry.digest);for(const row of Object.values(entry.methods)){assert.deepEqual(Object.keys(row.text),['en','es']);assert(row.text.en&&row.text.es);assert(Object.isFrozen(row));}}
});

test('all five engine queries are default off before provider methods run and remain unmounted',async t=>{
 for(const flag of [undefined,false,'false',1,'1',null]){let calls=0;const consent=Object.fromEntries(['method','contract','bus','grant','model'].map(name=>[name,()=>{calls++;}])),e=await createTestEngine({providers:{config:{INCREMENTAL_AUTH_ENABLED:flag},consent}});t.after(()=>e.dispose());
  for(const Query of Object.values(CONSENT_OPERATIONS)){await assert.rejects(e.read(new Query({input:{}})),{code:'consent_disabled'});assert(!Object.hasOwn(ACCOUNT_OPERATIONS,Query.operation));}assert.equal(calls,0);
 }
 const {read}=await harness(t,{providers:{config:{INCREMENTAL_AUTH_ENABLED:'true'}}});assert.equal((await read(ConsentMethod,{contract:storage,method:'get'})).risk.tier,1);
});

test('effect classification covers read, pure, write, destructive and missing/unknown effects',async t=>{
 const {method}=await harness(t);for(const [name,tier] of Object.entries({read:1,pure:1,write:2,remove:3,unknown:2,future:2,constructor:2,toString:2})){const row=await method({contract:third,method:name});assert.equal(row.risk.tier,tier,name);assert.equal(row.risk.preselected,false);assert(row.risk.label);assert(row.risk.icon);assert(row.risk.ruleWeight);}
 for(const name of ['unknown','future','constructor','toString'])assert.equal((await method({contract:third,method:name})).risk.missingEffect,true);
});

test('every sensitivity category only raises risk and preserves text/icon/chip facts',async t=>{
 const methods=Object.fromEntries(['personal-data','location','send-as-you','money','identity','public','future-category'].map(category=>[category,{effect:'read',categories:[category]}])),{method}=await harness(t,{facts:{contracts:{[third]:pin(third,methods)}}});
 for(const category of Object.keys(methods)){const row=await method({contract:third,method:category});assert.equal(row.risk.tier,['send-as-you','money','identity','public'].includes(category)?4:1);assert.equal(row.risk.privateInfo,['personal-data','location'].includes(category));assert.equal(row.risk.expanded,category!=='future-category');assert.equal(row.risk.confirmationRequired,row.risk.tier>=3);assert.equal(row.risk.chips.length,category==='future-category'?0:1);}
});

test('categories cannot hide deletion; multiple tier-four powers retain each label',async t=>{
 const {method}=await harness(t,{facts:{contracts:{[third]:pin(third,{remove:{effect:'destructive',categories:['personal-data','future']},act:{effect:'read',categories:['send-as-you','money','identity','public']}})}}});
 assert.equal((await method({contract:third,method:'remove'})).risk.tier,3);const row=await method({contract:third,method:'act'});assert.equal(row.risk.tier,4);assert.equal(row.risk.labels.length,4);assert(row.risk.label.includes('Can spend money'));assert(row.risk.label.includes('Can change sign-in'));
});

test('card risk aggregates every capability category rather than hiding equal-tier powers',async t=>{
 const {contract}=await harness(t,{facts:{contracts:{[third]:pin(third,{spend:{effect:'write',categories:['money']},signIn:{effect:'write',categories:['identity']}})}}});const card=await contract({contract:third,methods:['spend','signIn']});assert.equal(card.risk.tier,4);assert.deepEqual(card.risk.labels,['Can spend money','Can change sign-in']);assert.equal(card.risk.preselected,card.preselected);
});

test('exact catalogue copy wins over publisher and request copy; catalogue floors survive omissions',async t=>{
 const {method,facts}=await harness(t);const row=await method({contract:storage,method:'delete',summary:{en:'Harmless'},purpose:'Read only',reviewed:true,effect:'read'});assert.equal(row.text.source,'catalogue');assert.equal(row.risk.tier,3);assert.equal(row.risk.preselected,false);assert.equal(row.text.attribution,"Description from 3sln.me's catalogue");assert(!JSON.stringify(row).includes('Checked by'));
 facts.contracts[storage].schema['x-methods']={delete:{effect:'read',summary:{en:'Harmless'}}};assert.deepEqual(await method({contract:storage,method:'delete'}),row,'provider snapshots cannot be mutated by callers');
 const profile=await method({contract:base+'profile/v1',method:'read'});assert.equal(profile.risk.tier,1);assert.equal(profile.risk.privateInfo,true);assert.equal(profile.risk.preselected,false);
});

test('catalogue matching requires both exact contract identifier and digest, without a host-wide badge',async t=>{
 const spoof='https://3sln.me/artefacts/contracts/other/v1',{method}=await harness(t,{facts:{contracts:{[storage]:pin(storage,{get:{effect:'read',summary:{en:'Publisher version'}}}),[spoof]:{schema:{$id:spoof,'x-methods':{get:{effect:'read'}}},digest:REVIEWED_CONTRACTS[storage].digest}}}});
 assert.equal((await method({contract:storage,method:'get'})).text.source,'publisher');assert.equal((await method({contract:spoof,method:'get'})).text.source,'fallback');
 const unknown=await method({contract:'https://new.example/v1',method:'new'});assert.equal(unknown.risk.tier,2);assert.equal(unknown.risk.reviewed,false);assert.equal(unknown.risk.missingEffect,true);
});

test('publisher copy is attributed to the identifier host; app input cannot override metadata or review',async t=>{
 const {method}=await harness(t);const row=await method({contract:third,method:'read',summary:{en:'App claims'},categories:['money'],effect:'destructive',reviewed:true});assert.equal(row.text.text,'See your calendar events');assert.equal(row.text.host,'calendar.example');assert.equal(row.text.attribution,'Description from calendar.example');assert.equal(row.risk.tier,1);assert.deepEqual(row.warnings,['Not checked by 3sln.me']);
 const write=await method({contract:third,method:'write'});assert(write.warnings.includes('Not checked: could send, spend or publish as you'));
});

test('self-published unreviewed contracts use a Change floor across sibling hosts and multi-label suffixes',async t=>{
 const {method}=await harness(t);const own=await method({contract:self,method:'read'});assert.equal(own.risk.tier,2);assert.equal(own.text.attribution,"Description from the app's own site");assert.equal((await method({contract:third,method:'read'})).risk.tier,1);
 const id='https://contracts.owner.co.test.example/v1',{method:other}=await harness(t,{facts:{contracts:{[id]:pin(id,{read:{effect:'read'}})}}});assert.equal((await other({app:'https://app.owner.co.test.example/client',contract:id,method:'read'})).risk.tier,2);
 assert.throws(()=>createConsentProvider(),/registrableDomain/);const {method:unknown}=await harness(t,{facts:{registrableDomain:()=>null}});await assert.rejects(unknown({contract:third,method:'read'}),{code:'invalid_request'});
});

test('unreviewed apps cannot request tier-four powers from any known category',async t=>{
 for(const category of ['send-as-you','money','identity','public']){const {method,model}=await harness(t,{facts:{contracts:{[third]:pin(third,{act:{effect:'read',categories:[category]}})}}});await assert.rejects(method({app:unreviewed,contract:third,method:'act',reviewed:true}),{code:'invalid_request',status:400});await assert.rejects(model({app:unreviewed,grants:[{kind:'contract',contract:third,methods:['act']}]}),{code:'invalid_request'});assert.equal((await method({contract:third,method:'act'})).risk.tier,4);}
 const {method}=await harness(t);assert.equal((await method({app:unreviewed,contract:third,method:'read'})).risk.tier,1);
});

test('reviewed ordinary reads/writes preselect; private reads, deletion and unreviewed copy never do',async t=>{
 const {method,contract}=await harness(t);for(const name of ['get','put'])assert.equal((await method({contract:storage,method:name})).risk.preselected,true);for(const [id,name] of [[storage,'delete'],[third,'read'],[third,'unknown'],[base+'profile/v1','read']])assert.equal((await method({contract:id,method:name})).risk.preselected,false);
 assert.equal((await contract({contract:storage,methods:['get','put']})).preselected,true);assert.equal((await contract({contract:storage,methods:['get','delete']})).preselected,false);
});

test('fallbacks always include provider wording, method identity and a missing-description notice',async t=>{
 const {method}=await harness(t);const row=await method({contract:third,method:'unknown',summary:{en:'App attempt'}});assert.equal(row.text.source,'fallback');assert.equal(row.text.text,'Can change something');assert.equal(row.method,'unknown');assert(row.warnings.includes('No description provided'));
 for(const summary of [{es:'Solo español'},{en:''},{en:'x'.repeat(161)},{en:'Text\u0000'},{en:'Text',EN:'duplicate'},{en:'Text',en_US:'bad'}]){const {method:bad}=await harness(t,{facts:{contracts:{[third]:pin(third,{read:{effect:'read',summary}})}}});assert.equal((await bad({contract:third,method:'read'})).text.source,'fallback');}
});

test('locale choice falls through unsupported account, entry and browser choices',()=>{
 assert.equal(chooseLocale({account:'fr',uiLocales:'pt es-MX',browser:'en-US'}),'es');assert.equal(chooseLocale({account:'es-ES',uiLocales:'en'}),'es');assert.equal(chooseLocale({account:['fr'],uiLocales:['bad_tag'],browser:['es-AR']}),'es');assert.equal(chooseLocale({account:'fr',browser:'de'}),'en');assert.equal(chooseLocale({uiLocales:'en-US-u-ca-gregory'}),'en');
});

test('publisher BCP 47 lookup sets language and English fallback notes without translating claims',async t=>{
 const {method,model}=await harness(t);const spanish=await method({contract:third,method:'read',locale:{account:'fr',uiLocales:'es-MX'}});assert.equal(spanish.text.text,'Ver tus eventos');assert.equal(spanish.text.lang,'es');assert.equal(spanish.risk.label,'Puede ver');
 const fallback=await method({contract:third,method:'write',locale:{account:'es'}});assert.equal(fallback.text.lang,'en');assert.equal(fallback.text.languageNote,'(en inglés)');const result=await model({locale:{account:'es'},grants:[],reason:'日本語の理由'});assert.equal(result.reason.text,'日本語の理由');assert.equal(result.reason.lang,null);
});

test('valid private-use and grandfathered publisher tags preserve English fallback; null locale is absent',async t=>{
 const {method}=await harness(t,{facts:{contracts:{[third]:pin(third,{read:{effect:'read',summary:{en:'See events','x-test':'Private language','i-klingon':'Grandfathered language'}}})}}});const row=await method({contract:third,method:'read',locale:null});assert.equal(row.text.source,'publisher');assert.equal(row.text.lang,'en');assert.equal(row.text.text,'See events');
});

test('contract cards and grant models sort by risk stably and do not concatenate publisher summaries',async t=>{
 const {contract,model}=await harness(t);const card=await contract({contract:storage,methods:['get','put','delete','capabilities']});assert.deepEqual(card.rows.map(row=>row.method),['delete','put','get','capabilities']);assert.equal(card.risk.tier,3);assert.equal(card.expanded,true);assert.equal(card.summary,'See, change and delete information');
 const result=await model({grants:[{id:'first',kind:'contract',contract:third,methods:['read']},{id:'second',kind:'contract',contract:storage,methods:['get']},{id:'high',kind:'contract',contract:storage,methods:['delete']}]});assert.deepEqual(result.grants.map(grant=>grant.id),['high','first','second']);assert.equal(result.grants[1].summary,'1 capability: see details');
});

test('claims and labels remain separate, bounded, plain, isolated and host-labelled',async t=>{
 const {model}=await harness(t),purpose='😀'.repeat(201),label='X'.repeat(41),result=await model({reason:'Read only \u202E<script>claim</script>',grants:[{id:'files',kind:'contract',contract:storage,methods:['delete'],purpose,label}]});const grant=result.grants[0];assert.equal([...grant.purpose.text].length,200);assert.equal([...grant.label.text].length,40);assert.equal(grant.purpose.source,'app-claim');assert.equal(grant.purpose.host,'tasks.example');assert.equal(grant.purpose.label,'tasks.example says why:');assert.equal(grant.purpose.dir,'auto');assert.equal(grant.label.isolate,true);assert.equal(grant.label.quoted,true);assert.equal(grant.risk.tier,3);assert(!result.reason.text.includes('\u202E'));assert(result.reason.text.includes('<script>'));assert.equal(result.reason.lang,null);
});

test('feed read/write/readwrite risk keeps catalogue sentences separate from manifest effects',async t=>{
 const {bus}=await harness(t);for(const [mode,tier,count] of [['read',1,1],['write',2,1],['readwrite',2,2]]){const card=await bus({fragment:feed,mode});assert.equal(card.risk.tier,tier);assert.equal(card.rows.length,count);assert.equal(card.preselected,false);for(const row of card.rows){assert.equal(row.text.source,'catalogue');assert.equal(row.publisherDescription.source,'publisher');assert.equal(row.publisherDescription.host,'calendar.example');assert.equal(row.publisherDescription.attribution,'Description from calendar.example');assert(!row.publisherDescription.attribution.includes('catalogue'));assert(!JSON.stringify(row).includes('forged.example'));}}
 assert.equal((await bus({fragment:ownFeed,mode:'read'})).risk.tier,2);
});

test('feed categories raise both modes, while subscriptions on the pinned feed contract remain reads',async t=>{
 for(const category of ['personal-data','send-as-you','public']){const {bus:classify}=await harness(t,{facts:{manifests:{[feed]:bus(feed,[category])}}});for(const mode of ['read','write'])assert.equal((await classify({fragment:feed,mode})).risk.tier,category==='personal-data'?(mode==='read'?1:2):4);}
 const {method}=await harness(t);for(const name of ['read','subscribe','unsubscribe'])assert.equal((await method({contract:EVENT_BUS_CONTRACT,method:name})).risk.tier,1);assert.equal((await method({contract:EVENT_BUS_CONTRACT,method:'publish'})).risk.tier,2);
});

test('feed writes inherit current readers tier-four powers, with factual reader attribution',async t=>{
 const money='https://payments.example/contract/v1',{bus,method}=await harness(t,{facts:{contracts:{[money]:pin(money,{spend:{effect:'write',categories:['money']}})},readers:{[feed]:[{app:'https://wallet.example/client',capabilities:[{contract:money,method:'spend'}]}]}}});
 const write=await bus({fragment:feed,mode:'write'});assert.equal(write.risk.tier,4);assert.equal(write.risk.label,'Can spend money');assert.equal(write.rows[0].readerEffects[0].host,'wallet.example');assert(write.rows[0].readerEffects[0].text.includes('Can spend money'));assert.equal((await bus({fragment:feed,mode:'read'})).risk.tier,1);await assert.rejects(bus({app:unreviewed,fragment:feed,mode:'write'}),{code:'invalid_request'});assert.equal((await method({contract:money,method:'spend'})).risk.tier,4);
});

test('settings reads retain field identities and publisher attribution without using app purpose as wording',async t=>{
 const {grant}=await harness(t);const result=await grant({kind:'settings',fragment:settings,fields:['day','where'],purpose:'Spend money'});assert.equal(result.risk.tier,1);assert.equal(result.risk.privateInfo,true);assert.equal(result.rows[0].text.text,'See these shared settings');assert.deepEqual(result.rows[0].fields.map(field=>field.name),['day','where']);assert.equal(result.publisher.host,'calendar.example');assert.equal(result.preselected,false);await assert.rejects(grant({kind:'settings',fragment:settings,fields:['resource']}),{code:'invalid_request'});
});

test('broker disclosures use verified descriptors and never alter risk',async t=>{
 const resource='https://calendar.example/resource/one',{grant}=await harness(t,{facts:{resources:{[resource]:{brokerOrigin:'https://calendar.example'}}}});const input={kind:'contract',contract:storage,methods:['get']},ordinary=await grant(input),brokered=await grant({...input,resource,brokerOrigin:'https://forged.example'});assert.deepEqual(brokered.risk,ordinary.risk);assert.equal(brokered.broker.text,'Your requests go directly to calendar.example');assert.equal((await grant({...input,brokerOrigin:'https://forged.example'})).broker,undefined);
});

test('malformed/duplicate/oversized requests fail with domain faults through the engine',async t=>{
 const {method,contract,bus,grant,model}=await harness(t);for(const input of [{contract:'http://calendar.example/v1',method:'read'},{contract:'https://a@calendar.example/v1',method:'read'},{contract:third,method:''},{contract:third,method:'\u0000'}])await assert.rejects(method(input),{code:'invalid_request'});
 for(const methods of [[],['get','get'],['*'.repeat(129)],Array(129).fill('get')])await assert.rejects(contract({contract:storage,methods}),{code:'invalid_request'});
 await assert.rejects(bus({fragment:feed,mode:'admin'}),{code:'invalid_request'});await assert.rejects(bus({fragment:'https://missing.example/v1',mode:'read'}),{code:'invalid_request'});await assert.rejects(grant({kind:'unknown'}),{code:'invalid_request'});await assert.rejects(model({grants:Array(129).fill({kind:'contract',contract:storage,methods:['get']})}),{code:'invalid_request'});
});

test('seeded combinations preserve effect floors and never let categories lower risk',async t=>{
 const {e,method,facts}=await harness(t),random=e.random,methods={};for(let n=0;n<80;n++){const effect=random.pick(['read','pure','write','destructive',undefined,'unknown']),categories=random.shuffle(['personal-data','location','send-as-you','money','identity','public','unknown']).slice(0,random.int(8));methods['m'+n]={effect,categories};}
 const {method:classify}=await harness(t,{facts:{contracts:{[third]:pin(third,methods)}}});for(const [name,metadata] of Object.entries(methods)){const row=await classify({contract:third,method:name}),floor={read:1,pure:1,write:2,destructive:3}[metadata.effect]??2;assert(row.risk.tier>=floor);assert(row.risk.tier>=1&&row.risk.tier<=4);assert.equal(row.risk.preselected,false);if(metadata.categories.some(category=>['send-as-you','money','identity','public'].includes(category)))assert.equal(row.risk.tier,4);}
 const first=await method({contract:storage,method:'get'});first.risk.categories.push('money');assert.equal((await method({contract:storage,method:'get'})).risk.tier,1);assert.equal(facts.contracts[storage].digest,REVIEWED_CONTRACTS[storage].digest);
});
