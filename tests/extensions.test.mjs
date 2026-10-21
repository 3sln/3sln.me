import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {validateSchema,pinSchema} from '../packages/federation/schema.mjs';
import {canonical,MemoryMessagingStore} from '../packages/messaging/store.mjs';
import {createTestEngine} from './helpers/app-engine.mjs';
import {validateSlotManifest,validateExtensions,slotDigest,validateExtensionDigest,pinSlotManifest,createSlotOperation,nextSlotDispatch,recordSlotOutcome,slotOperationResult,createExtensionsProvider,SlotManifest,ExtensionDeclarations,SlotSelection,PinSlotManifest} from '../packages/federation/extensions.mjs';

const url='https://slots.example/classifier/v1',contract='https://contracts.example/decision/v1',other='https://contracts.example/other/v1';
const manifest=(selection='ordered')=>({id:url,title:'Classifier',description:'Classifies incoming items.',publisher:'https://publisher.example',fields:{occupants:{title:'Classifiers',type:'resource',cardinality:{min:0,max:selection==='exclusive'?1:4},contracts:[contract]},enabled:{title:'Enabled',type:'boolean',cardinality:{min:0,max:1}}},slot:{v:1,field:'occupants',selection,consumers:['application','provider']}});
const contracts=(effect='read')=>({[contract]:{digest:'pinned-contract-digest',schema:{$id:contract,'x-methods':{decide:{effect},describe:{effect:'pure'}}}}});
const declaration=(extra={})=>({slot:url,role:'occupant',ref:'classifier',...extra});
const occupant=id=>({id:`https://resources.example/${id}`,status:'available',credentialCurrent:true});
const tx=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const valid=(schema,options)=>validateSlotManifest(schema,url,options).status;
const fixture=()=>{let document=manifest(),fetches=0;const store=new MemoryMessagingStore();return {store,crypto:webcrypto,schemaHosts:['slots.example'],contracts:contracts(),schemaFetcher:async()=>{fetches++;return structuredClone(document);},set:next=>document=next,get fetches(){return fetches;}};};

test('AMD-C1 tolerates and retains unknown top-level members, without widening fields or the field subset',async()=>{
 const schema=manifest();schema.future={arbitrary:['metadata']};schema.slot.v=77;
 const result=validateSchema(schema,url);assert.deepEqual(result,schema);assert.notEqual(result,schema);assert.deepEqual(Object.keys(result.fields),['occupants','enabled']);
 for(const extension of [null,[],false,'unknown',{v:90}]){schema.slot=extension;assert.deepEqual(validateSchema(schema,url),schema);}
 schema.fields.enabled.future=true;assert.throws(()=>validateSchema(schema,url));delete schema.fields.enabled.future;
 schema.fields.enabled.type='script';assert.throws(()=>validateSchema(schema,url));
 const f=fixture(),document=manifest();document.future={data:1};f.set(document);const pin=await pinSchema(f,url);document.future.data=2;f.set(document);
 await assert.rejects(pinSchema(f,url),{code:'schema_changed'});assert.equal((await f.store.transaction(t=>t.get(`federation/schema/${url}`))).digest,pin.digest);
});

test('recognizes the four policies and retains atomic owner settings and untrusted publisher metadata',()=>{
 for(const policy of ['exclusive','ordered','broadcast','consumer-choice']){const schema=manifest(policy),result=validateSlotManifest(schema,url);assert.equal(result.status,'valid');assert.equal(result.slot.selection,policy);assert.equal(result.schema.publisher,'https://publisher.example');}
 const ordinary=manifest();delete ordinary.slot;assert.equal(valid(ordinary),'absent');
});

test('slot invariants fail atomically while the ordinary fragment remains usable',()=>{
 const mutations=[
  s=>s.slot=null,s=>s.slot.field='missing',s=>s.slot.field='enabled',s=>s.slot.field='constructor',s=>s.slot.selection='random',
  s=>s.fields.occupants.cardinality.min=1,s=>s.fields.occupants.cardinality.max=9,s=>s.fields.occupants.cardinality.max=1,
  s=>s.fields.second=structuredClone(s.fields.occupants),s=>s.slot.consumers=[],s=>s.slot.consumers=['application','application'],s=>s.slot.consumers=['robot'],
  s=>s.slot.failover='always',s=>{s.slot.selection='broadcast';s.slot.failover='pre-dispatch';},s=>{s.slot.selection='exclusive';},
  s=>s.slot.supersedes=url,s=>s.slot.supersedes='https://other.example/v0',s=>s.slot.supersedes='http://slots.example/v0',
  s=>s.slot.options={consumer:{label:{type:'javascript'}}},s=>s.slot.options={consumer:[]},s=>s.slot.options={other:{}},
  s=>s.slot.options={consumer:{label:{type:'string',maxLength:2049}}},s=>s.slot.crit=['field','field'],s=>s.slot.crit=['supersedes'],s=>s.slot.crit='field',
  s=>s.padding='é'.repeat(8200),
 ];
 for(const mutate of mutations){const schema=manifest();mutate(schema);assert.doesNotThrow(()=>validateSchema(schema,url));const result=validateSlotManifest(schema,url);assert.equal(result.status,'invalid',String(mutate));assert.equal(Object.hasOwn(result,'slot'),false);}
 const good=manifest();good.slot.supersedes='https://slots.example/classifier/v0';assert.equal(valid(good),'valid');good.slot.supersedes=null;assert.equal(valid(good),'valid');
 const invalid=manifest();delete invalid.fields.occupants.contracts;assert.throws(()=>validateSlotManifest(invalid,url),'invalid ordinary fragment still rejects');
});

test('unknown versions and critical members are unrecognized; unlisted members are ignored and pinned',()=>{
 const schema=manifest();schema.slot.v=2;assert.equal(valid(schema),'unrecognized');schema.slot.v=1;schema.slot.crit=['future'];schema.slot.future=true;assert.equal(valid(schema),'unrecognized');
 delete schema.slot.crit;assert.equal(valid(schema),'valid');schema.slot.crit=['selection'];assert.equal(valid(schema),'valid');
});

test('any-error checks every method of every exact pinned contract, treating missing/unknown effects conservatively',()=>{
 const schema=manifest();schema.slot.failover='any-error';assert.equal(valid(schema),'invalid');assert.equal(valid(schema,{contracts:contracts()}),'valid');
 for(const effect of ['write','unknown',null])assert.equal(valid(schema,{contracts:contracts(effect)}),'invalid');
 const missingEffect=contracts();delete missingEffect[contract].schema['x-methods'].decide.effect;assert.equal(valid(schema,{contracts:missingEffect}),'invalid');
 for(const pin of [{$id:contract,'x-methods':{get:{effect:'read'}}},{schema:{$id:contract,'x-methods':{get:{effect:'read'}}}},{digest:'pin',schema:{$id:other,'x-methods':{get:{effect:'read'}}}},{digest:'pin',schema:{$id:contract,'x-methods':{}}}])assert.equal(valid(schema,{contracts:{[contract]:pin}}),'invalid');
 const pins=contracts();schema.fields.occupants.contracts.push(other);assert.equal(valid(schema,{contracts:pins}),'invalid');pins[other]={digest:'pin',schema:{$id:other,'x-methods':{get:{effect:'read'}}}};assert.equal(valid(schema,{contracts:pins}),'valid');
});

test('digest syntax is unpadded canonical SHA-256 base64url, computed over all members and stable object ordering',async()=>{
 const schema=manifest(),hash=await slotDigest(webcrypto,schema);assert.equal(hash,'sha256-'+createHash('sha256').update(canonical(schema)).digest('base64url'));assert.equal(validateExtensionDigest(hash),hash);
 for(const bad of [hash.slice(7),hash+'=',hash.slice(0,-1)+'B','sha256-'+'A'.repeat(42),'sha256-'+'A'.repeat(44),null])assert.throws(()=>validateExtensionDigest(bad),{code:'invalid_digest'});
 assert.equal(await slotDigest(webcrypto,Object.fromEntries(Object.entries(schema).reverse())),hash);schema.slot.future=true;assert.notEqual(await slotDigest(webcrypto,schema),hash);
});

test('slot pins share the ordinary fragment namespace, survive publication faults and reject request digest mismatches',async()=>{
 const f=fixture(),hash=await slotDigest(webcrypto,manifest());assert.equal((await pinSlotManifest(f,url,hash)).digest,hash);assert.equal((await pinSchema(f,url)).digest,hash.slice(7));
 const wrong=await slotDigest(webcrypto,{different:true});await assert.rejects(pinSlotManifest(f,url,wrong),{code:'digest_mismatch'});
 const changed=manifest();changed.slot.extra=true;f.set(changed);await assert.rejects(pinSlotManifest(f,url),{code:'schema_changed'});assert.deepEqual((await f.store.transaction(t=>t.get(`federation/schema/${url}`))).schema,manifest());
 f.schemaFetcher=async()=>{throw Error('publisher unavailable');};await assert.rejects(pinSlotManifest(f,url),/publisher unavailable/);assert.equal((await f.store.transaction(t=>t.get(`federation/schema/${url}`))).digest,hash.slice(7));
 const firstOrdinary=fixture();await pinSchema(firstOrdinary,url);assert.equal((await pinSlotManifest(firstOrdinary,url)).digest,hash);
 const mismatch=fixture();await assert.rejects(pinSlotManifest(mismatch,url,wrong),{code:'digest_mismatch'});assert.equal(await mismatch.store.transaction(t=>t.get(`federation/schema/${url}`)),undefined);
 await assert.rejects(pinSlotManifest(mismatch,'https://untrusted.example/v1'),{code:'untrusted_schema_host'});assert.equal(mismatch.fetches,1);
 const bad=manifest();bad.slot.v=2;mismatch.set(bad);await assert.rejects(pinSlotManifest(mismatch,url),{code:'unsupported_fragment'});
});

test('concurrent pins serialize globally per URL and cannot replace the first approved document',async()=>{
 const f=fixture(),a=manifest(),b=manifest();b.slot.extra='changed';let calls=0;f.schemaFetcher=async()=>++calls===1?a:b;
 const results=await Promise.allSettled([pinSlotManifest(f,url),pinSlotManifest(f,url)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'schema_changed');
});

test('declarations validate locally and lazily, ignore unknown members, and preserve exact identifiers',async()=>{
 const hash=await slotDigest(webcrypto,manifest()),entry=declaration({digest:hash,future:'ignored'});assert.deepEqual(validateExtensions([entry]),[{status:'unknown',entry:declaration({digest:hash})}]);
 const slots=new Map([[url,{schema:manifest(),digest:hash}]]);assert.equal(validateExtensions([entry],{slots})[0].status,'valid');assert.equal(validateExtensions([declaration({slot:url+'/lookalike'})],{slots})[0].status,'unknown');
 assert.equal(validateExtensions([entry],{slots:new Map([[url,{schema:manifest(),digest:hash.slice(7)}]])})[0].status,'valid','ordinary fragment storage pins use raw base64url');
 const mismatch=declaration({digest:'sha256-'+'A'.repeat(43)});assert.equal(validateExtensions([mismatch],{slots})[0].reason,'digest_mismatch');
 for(const slot of ['http://slots.example/v1',url+'?x=1',url+'?',url+'#',url+'#hash','https://user@slots.example/v1',url+'x'.repeat(256)])assert.equal(validateExtensions([declaration({slot})])[0].status,'invalid');
 for(const extra of [{role:'admin'},{ref:'Bad'},{ref:'a'.repeat(33)},{digest:'sha256-bad'},{options:[]},{purpose:'occupant purpose'},{required:false}])assert.equal(validateExtensions([declaration(extra)])[0].status,'invalid');
 assert.equal(validateExtensions([declaration({purpose:'Uses classifiers.',role:'consumer'})])[0].status,'unknown');assert.equal(validateExtensions([declaration({required:true,role:'consumer'})],{kind:'integration'})[0].status,'unknown');
});

test('declaration bounds and duplicate sets invalidate every affected entry without rejecting unrelated entries',()=>{
 const a=declaration(),b=declaration({ref:'second'}),elsewhere=declaration({slot:url+'/other'});
 assert.deepEqual(validateExtensions([a,{...a,future:true},b,elsewhere]).map(r=>r.status),['invalid','invalid','unknown','unknown']);
 assert.equal(validateExtensions([a,{...a,options:[]}])[0].status,'invalid','malformed duplicate does not let the first one win');
 assert.deepEqual(validateExtensions(Array.from({length:5},(_,i)=>declaration({ref:'r'+i})).concat(elsewhere)).map(r=>r.status),['invalid','invalid','invalid','invalid','invalid','unknown']);
 assert.equal(validateExtensions([declaration({future:'é'.repeat(1100)}),elsewhere])[0].status,'invalid');
 for(const entries of [null,{},Array.from({length:33},()=>a)])assert.deepEqual(validateExtensions(entries),[]);assert.deepEqual(validateExtensions(undefined),[]);
 assert.equal(validateExtensions([null,{},elsewhere])[2].status,'unknown');
});

test('declaration options follow the bounded fragment subset and consumers are restricted by manifest kind',()=>{
 const schema=manifest();schema.slot.options={occupant:{label:{type:'string',maxLength:4}},consumer:{}};const slots=new Map([[url,{schema,digest:'pin'}]]);
 assert.equal(valid(schema),'valid');assert.equal(validateExtensions([declaration({options:{label:'Host'}})],{slots})[0].status,'valid');
 for(const options of [undefined,{},null,{label:'longer'},{label:'Host',extra:true},{label:1}])assert.equal(validateExtensions([declaration({options})],{slots})[0].status,'invalid');
 const consumer=declaration({role:'consumer',purpose:'Classify.'});assert.equal(validateExtensions([consumer],{slots})[0].status,'valid');
 schema.slot.consumers=['application'];assert.equal(validateExtensions([consumer],{slots})[0].reason,'unsupported_consumer');assert.equal(validateExtensions([consumer],{slots,kind:'integration'})[0].status,'valid');
 schema.slot.consumers=['provider'];assert.equal(validateExtensions([consumer],{slots,kind:'integration'})[0].reason,'unsupported_consumer');
 schema.slot.v=2;assert.equal(validateExtensions([consumer],{slots})[0].reason,'unsupported_slot');
 const absent=manifest(),none=new Map([[url,{schema:absent,digest:'pin'}]]);assert.equal(validateExtensions([declaration({options:{extra:1}})],{slots:none})[0].status,'invalid');
});

test('engine harness drives gated slot/declaration Queries and pin Actions over injected providers',async t=>{
 const f=fixture(),hash=await slotDigest(webcrypto,manifest());f.slots=new Map([[url,{schema:manifest(),digest:hash}]]);
 const e=await createTestEngine({providers:{config:{EXTENSIONS_ENABLED:'true'},extensions:createExtensionsProvider(f)}});t.after(()=>e.dispose());
 assert.equal((await e.read(new SlotManifest({input:{schema:manifest()}}))).status,'valid');assert.equal((await e.read(new ExtensionDeclarations({input:{entries:[declaration({digest:hash})]}})))[0].status,'valid');
 const selection=await e.read(new SlotSelection({input:{schema:manifest(),occupants:[occupant('a'),occupant('b')]}}));assert.equal(nextSlotDispatch(selection,{tx:tx(1)}).dispatch.occupant.id,occupant('a').id);
 assert.equal((await e.perform(new PinSlotManifest({input:{url,digest:hash}}))).digest,hash);assert.equal(f.fetches,1);assert.equal(e.audit.entries.at(-1).operation,'extensions.pin');
 const disabled=await createTestEngine({providers:{config:{EXTENSIONS_ENABLED:'false'},extensions:createExtensionsProvider(f)}});t.after(()=>disabled.dispose());
 await assert.rejects(disabled.read(new SlotManifest({input:{schema:manifest()}})),{code:'extensions_disabled'});await assert.rejects(disabled.read(new ExtensionDeclarations({input:{entries:[declaration()]}})),{code:'extensions_disabled'});await assert.rejects(disabled.read(new SlotSelection({input:{schema:manifest(),occupants:[]}})),{code:'extensions_disabled'});await assert.rejects(disabled.perform(new PinSlotManifest({input:{url}})),{code:'extensions_disabled'});assert.equal(f.fetches,1);
});

test('exclusive slots invoke exactly one current approved occupant and represent an empty slot by absence',()=>{
 const schema=manifest('exclusive');let state=createSlotOperation(schema,occupant('a'));const before=structuredClone(state),next=nextSlotDispatch(state,{tx:tx(1)});assert.deepEqual(state,before);assert.equal(next.dispatch.occupant.id,occupant('a').id);
 state=recordSlotOutcome(next.state,{tx:tx(1),ok:true});assert.equal(nextSlotDispatch(state,{tx:tx(2)}).dispatch,null);assert.equal(slotOperationResult(state).status,'succeeded');
 assert.equal(slotOperationResult(createSlotOperation(schema,undefined)).status,'unfilled');assert.throws(()=>createSlotOperation(schema,[]),{code:'invalid_occupants'});
 assert.equal(nextSlotDispatch(createSlotOperation(schema,{...occupant('a'),credentialCurrent:false}),{tx:tx(1)}).dispatch,null);
 assert.equal(slotOperationResult(createSlotOperation(schema,{...occupant('a'),credentialCurrent:false})).status,'unavailable','configured but unavailable differs from an empty role');
});

test('ordered slots snapshot owner order, skip unavailable/stale occupants, and require a fresh tx for every switch',()=>{
 const projected=[{...occupant('a'),status:'unavailable'},{...occupant('b'),credentialCurrent:false},occupant('c'),occupant('d')],state=createSlotOperation(manifest(),projected);projected.reverse();projected[0].status='unavailable';
 let next=nextSlotDispatch(state,{tx:tx(1)});assert.equal(next.dispatch.occupant.id,occupant('c').id);assert.equal(nextSlotDispatch(next.state,{tx:tx(2)}).dispatch,null,'outstanding dispatch blocks switching');
 const failed=recordSlotOutcome(next.state,{tx:tx(1),code:'rate_limited'});assert.throws(()=>nextSlotDispatch(failed,{tx:tx(1)}),{code:'invalid_tx'});next=nextSlotDispatch(failed,{tx:tx(2)});assert.equal(next.dispatch.occupant.id,occupant('d').id);assert.equal(slotOperationResult(recordSlotOutcome(next.state,{tx:tx(2),ok:true})).status,'succeeded');
 assert.throws(()=>recordSlotOutcome(failed,{tx:tx(1),ok:true}),{code:'invalid_outcome'});
});

test('pre-dispatch failover accepts only enumerated no-effect statuses/codes or proof no bytes were sent',()=>{
 for(const outcome of [{bytesSent:false},...[401,403,404,429].map(httpStatus=>({httpStatus})),...['unsupported_contract','unsupported_method','forbidden','not_found','rate_limited','temporarily_unavailable'].map(code=>({code}))]){
  const first=nextSlotDispatch(createSlotOperation(manifest(),[occupant('a'),occupant('b')]),{tx:tx(1)}),state=recordSlotOutcome(first.state,{tx:tx(1),...outcome});assert.equal(nextSlotDispatch(state,{tx:tx(2)}).dispatch.occupant.id,occupant('b').id,JSON.stringify(outcome));
 }
 for(const outcome of [{bytesSent:true},...['timeout','indeterminate','unsupported_future','network_error'].map(code=>({code})),...[400,408,500,503].map(httpStatus=>({httpStatus}))]){
  const first=nextSlotDispatch(createSlotOperation(manifest(),[occupant('a'),occupant('b')]),{tx:tx(1)}),state=recordSlotOutcome(first.state,{tx:tx(1),...outcome});assert.equal(nextSlotDispatch(state,{tx:tx(2)}).dispatch,null);assert.equal(slotOperationResult(state).status,'unknown');
 }
});

test('any-error permits harmless failover but observing removal of an outstanding occupant reports unknown and stops switching',()=>{
 const schema=manifest();schema.slot.failover='any-error';let first=nextSlotDispatch(createSlotOperation(schema,[occupant('a'),occupant('b')],{contracts:contracts()}),{tx:tx(1)});
 const unknown=recordSlotOutcome(first.state,{tx:tx(1),code:'timeout'});assert.equal(nextSlotDispatch(unknown,{tx:tx(2)}).dispatch.occupant.id,occupant('b').id);
 assert.equal(nextSlotDispatch(unknown,{tx:tx(2),removed:[occupant('a').id]}).dispatch,null,'removal after recording ambiguity also blocks switching');
 const removed=nextSlotDispatch(first.state,{tx:tx(2),removed:[occupant('a').id]});assert.equal(removed.dispatch,null);assert.equal(slotOperationResult(removed.state).status,'unknown');
 const pending=createSlotOperation(manifest(),[occupant('a'),occupant('b')]);assert.equal(nextSlotDispatch(pending,{tx:tx(1),removed:[occupant('a').id]}).dispatch.occupant.id,occupant('b').id);
});

test('broadcast dispatches independently, reports every occupant and never calls partial or unknown complete success',()=>{
 let state=createSlotOperation(manifest('broadcast'),[occupant('a'),occupant('b'),occupant('c')]);
 for(let n=1;n<=3;n++)state=nextSlotDispatch(state,{tx:tx(n)}).state;assert.equal(state.attempts.length,3);assert.equal(slotOperationResult(state).status,'pending');
 state=recordSlotOutcome(state,{tx:tx(1),ok:true});state=recordSlotOutcome(state,{tx:tx(2),httpStatus:403});const partial=recordSlotOutcome(state,{tx:tx(3),ok:true});assert.equal(slotOperationResult(partial).status,'partial');assert.deepEqual(slotOperationResult(partial).outcomes.map(o=>o.status),['succeeded','failed','succeeded']);
 assert.equal(slotOperationResult(recordSlotOutcome(state,{tx:tx(3),code:'timeout'})).status,'unknown');
});

test('consumer-choice uses only the projected set and permits multiple invocations only with pinned harmless contracts',()=>{
 const schema=manifest('consumer-choice'),state=createSlotOperation(schema,[occupant('a'),occupant('b')]);assert.equal(nextSlotDispatch(state,{tx:tx(1)}).dispatch,null);assert.throws(()=>nextSlotDispatch(state,{tx:tx(1),choice:occupant('outside').id}),{code:'invalid_choice'});
 const first=nextSlotDispatch(state,{tx:tx(1),choice:occupant('b').id});assert.equal(first.dispatch.occupant.id,occupant('b').id);assert.equal(nextSlotDispatch(recordSlotOutcome(first.state,{tx:tx(1),httpStatus:403}),{tx:tx(2),choice:occupant('a').id}).dispatch,null);
 const harmless=nextSlotDispatch(createSlotOperation(schema,[occupant('a'),occupant('b')],{contracts:contracts()}),{tx:tx(1),choice:occupant('b').id});assert.ok(nextSlotDispatch(recordSlotOutcome(harmless.state,{tx:tx(1),code:'timeout'}),{tx:tx(2),choice:occupant('a').id}).dispatch);
 const done=slotOperationResult(recordSlotOutcome(harmless.state,{tx:tx(1),ok:true}));assert.equal(done.status,'succeeded');assert.deepEqual(done.outcomes.map(value=>value.status),['not_selected','succeeded']);
});

test('provider consumers require live enablement and invalid cardinality/consumer sets do not dispatch',()=>{
 const schema=manifest(),state=createSlotOperation(schema,[occupant('a')],{consumer:'provider'});assert.equal(nextSlotDispatch(state,{tx:tx(1)}).dispatch,null);assert.ok(nextSlotDispatch(state,{tx:tx(1),featureEnabled:true}).dispatch);
 assert.equal(nextSlotDispatch(createSlotOperation(schema,[occupant('a')],{consumer:'provider',featureEnabled:true}),{tx:tx(1),featureEnabled:false}).dispatch,null);
 schema.slot.consumers=['provider'];assert.throws(()=>createSlotOperation(schema,[occupant('a')]),{code:'unsupported_consumer'});schema.slot.consumers=['application'];assert.throws(()=>createSlotOperation(schema,[occupant('a'),occupant('a')]),{code:'invalid_occupants'});assert.equal(slotOperationResult(createSlotOperation(schema,[])).status,'unfilled');
});
