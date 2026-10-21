import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {MemoryMessagingStore} from '../packages/messaging/store.mjs';
import {pinSchema,validateSchema} from '../packages/federation/schema.mjs';
import {validateSlotManifest,slotDigest} from '../packages/federation/extensions.mjs';
import {publicArtifacts} from '../packages/core/public-contracts.mjs';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';
import {EVENT_BUS_CONTRACT,createEventBusesProvider,BusManifest,PinBusManifest} from '../packages/federation/event-buses.mjs';
import {createTestEngine} from './helpers/app-engine.mjs';

const url='https://tasks.example/buses/task-changes/v1';
const manifest=()=>({id:url,title:'Task changes',description:'A record when a task changes.',publisher:'https://tasks.example',fields:{bus:{title:'Task changes bus',type:'resource',cardinality:{min:0,max:1},contracts:[EVENT_BUS_CONTRACT]}},slot:{v:1,crit:['bus'],field:'bus',selection:'exclusive',consumers:['application','provider'],bus:{v:1,types:['created','completed'],payload:{type:'object',additionalProperties:false,required:['task'],properties:{task:{type:'string',maxLength:128}}},max_record_bytes:2048,retention:{min_seconds:3600,max_seconds:604800},publishers:['application'],readers:['application','provider'],effects:{read:{en:'See tasks when they change.'},write:{en:'Add task changes that connected apps see.'}}}}});
const fixture=()=>{let document=manifest(),fetches=0;return {store:new MemoryMessagingStore(),crypto:webcrypto,schemaHosts:['tasks.example'],schemaFetcher:async()=>{fetches++;return structuredClone(document);},set:next=>document=next,get fetches(){return fetches;}};};
async function harness(t,options={}){const f=fixture(),e=await createTestEngine({providers:{config:{EVENT_BUSES_ENABLED:true},eventBuses:createEventBusesProvider(f),...options}});t.after(()=>e.dispose());return {f,e,validate:schema=>e.read(new BusManifest({input:{schema}})),pin:(target=url,digest)=>e.perform(new PinBusManifest({input:{url:target,digest}}))};}
const nesting=depth=>depth===1?{type:'null'}:{type:'object',additionalProperties:false,properties:{child:nesting(depth-1)}};

test('engine Query recognizes one bus occupant without mutating or weakening the ordinary slot validator',async t=>{
 const {validate}=await harness(t),schema=manifest(),before=structuredClone(schema),result=await validate(schema);
 assert.equal(result.status,'valid');assert.deepEqual(result.schema,schema);assert.deepEqual(result.slot,schema.slot);assert.deepEqual(result.bus,schema.slot.bus);assert.equal(result.harmless,false);assert.deepEqual(schema,before);
 assert.equal(validateSlotManifest(schema).status,'unrecognized','a slot-only processor cannot partially recognize a critical bus');
 result.bus.types.push('local-change');assert.deepEqual(schema,before);assert.deepEqual((await validate(schema)).bus.types,before.slot.bus.types);
 const renamed=manifest();renamed.fields.feed=renamed.fields.bus;delete renamed.fields.bus;renamed.slot.field='feed';assert.equal((await validate(renamed)).status,'valid');
});

test('ordinary fragments/slots stay absent; unknown slot versions and other critical members remain unrecognized',async t=>{
 const {validate}=await harness(t);
 for(const mutate of [s=>delete s.slot,s=>{delete s.slot.bus;delete s.slot.crit;}]){const schema=manifest();mutate(schema);assert.equal((await validate(schema)).status,'absent');}
 for(const mutate of [s=>s.slot.v=2,s=>{s.slot.crit.push('future');s.slot.future=true;}]){const schema=manifest();mutate(schema);const result=await validate(schema);assert.equal(result.status,'unrecognized');assert(!Object.hasOwn(result,'bus'));assert(!Object.hasOwn(result,'slot'));}
 const schema=manifest();schema.slot.future={ignored:true};schema.future='retained';schema.slot.crit.push('selection');assert.deepEqual((await validate(schema)).schema,schema);
});

test('engine validation fails atomically for bus/slot shape, purpose, version, retention, modes and declarations',async t=>{
 const {validate}=await harness(t),mutations=[
  s=>delete s.slot.bus,s=>delete s.slot.crit,s=>s.slot.crit=[],s=>s.slot.crit=['bus','bus'],s=>s.slot.bus=null,s=>s.slot.bus={},s=>s.slot.bus.v=2,
  s=>s.slot.selection='ordered',s=>s.fields.bus.cardinality.min=1,s=>s.fields.bus.cardinality.max=2,s=>s.slot.field='missing',s=>s.slot.failover='any-error',s=>s.slot.consumers=[],
  s=>s.fields.extra={title:'Extra',type:'boolean'},s=>s.fields.bus.contracts=['https://contracts.example/lookalike/v1'],s=>s.fields.bus.contracts.push('https://contracts.example/other/v1'),
  s=>s.slot.bus.types=[],s=>s.slot.bus.types=['created','created'],s=>s.slot.bus.types=['Bad'],s=>s.slot.bus.types=['a'.repeat(49)],s=>s.slot.bus.types=Array.from({length:33},(_,n)=>'type-'+n),
  s=>s.slot.bus.max_record_bytes=63,s=>s.slot.bus.max_record_bytes=16385,s=>s.slot.bus.max_record_bytes=64.5,s=>s.slot.bus.retention={},s=>s.slot.bus.retention.min_seconds=-1,s=>s.slot.bus.retention.max_seconds=0,s=>s.slot.bus.retention.max_seconds=2592001,s=>s.slot.bus.retention.min_seconds=604801,s=>s.slot.bus.retention.max_seconds=3600.5,
  s=>s.slot.bus.publishers=[],s=>s.slot.bus.publishers=['robot'],s=>s.slot.bus.readers=['application','application'],s=>s.slot.consumers=['application'],s=>s.slot.bus.history='always',s=>s.slot.bus.categories=['personal-data','personal-data'],
  s=>s.slot.bus.ordering='unordered',s=>s.slot.bus.delivery='push',s=>s.slot.bus.schema_version=2,s=>s.slot.supersedes=url,s=>s.slot.supersedes='https://foreign.example/old',s=>s.padding='é'.repeat(8200),
 ];
 for(const mutate of mutations){const schema=manifest();mutate(schema);assert.doesNotThrow(()=>validateSchema(schema,url));const result=await validate(schema);assert.equal(result.status,'invalid',String(mutate));assert.deepEqual(result.schema,schema);assert(!Object.hasOwn(result,'slot'));assert(!Object.hasOwn(result,'bus'));}
 for(const mutate of [s=>s.description='',s=>s.title='']){const schema=manifest();mutate(schema);await assert.rejects(validate(schema),{code:'invalid_schema'});}
 const insecure=manifest();insecure.publisher='http://tasks.example';await assert.rejects(validate(insecure),{code:'invalid_args'});
});

test('v1 bounds and defaults preserve publisher-attributed purpose and total-order semantics',async t=>{
 const {validate}=await harness(t);
 for(const max_record_bytes of [64,16384])for(const retention of [{min_seconds:0,max_seconds:1},{min_seconds:2592000,max_seconds:2592000}]){
  const schema=manifest();Object.assign(schema.slot.bus,{max_record_bytes,retention,history:'owner-choice',categories:['personal-data','future-category']});schema.slot.bus.types=Array.from({length:32},(_,n)=>'type-'+n);schema.slot.supersedes='https://tasks.example/buses/task-changes/v0';assert.equal((await validate(schema)).status,'valid');
 }
 const result=await validate(manifest());assert(!Object.hasOwn(result.bus,'history'));assert(!Object.hasOwn(result.bus,'ordering'));assert(!Object.hasOwn(result.bus,'delivery'));assert.equal(result.schema.description,'A record when a task changes.');
 const bounded=manifest();bounded.padding='';bounded.padding='x'.repeat(16384-Buffer.byteLength(JSON.stringify(bounded)));assert.equal((await validate(bounded)).status,'valid');bounded.padding+='x';assert.equal((await validate(bounded)).status,'invalid','measure the original document, including its critical bus member');
});

test('effect maps require English, valid distinct BCP 47 tags and bounded plain text counted by code point',async t=>{
 const {validate}=await harness(t);
 for(const effects of [undefined,{},[],{read:{en:'Read'}},{read:{es:'Leer'},write:{en:'Write'}},{read:{en:''},write:{en:'Write'}},{read:{en:'x'.repeat(201)},write:{en:'Write'}},{read:{en:'Read',en_US:'Read'},write:{en:'Write'}},{read:{en:'Read','en-u-abc-u-def':'Read'},write:{en:'Write'}},{read:{en:'Read',EN:'Read'},write:{en:'Write'}},{read:{en:'Read\u0000'},write:{en:'Write'}},{read:{en:'Read',...Object.fromEntries(['es','fr','de','it','pt','nl','ja','zh'].map(tag=>[tag,'Read']))},write:{en:'Write'}}]){
  const schema=manifest();schema.slot.bus.effects=effects;assert.equal((await validate(schema)).status,'invalid',JSON.stringify(effects));
 }
 const schema=manifest();schema.slot.bus.effects.read={en:'😀'.repeat(200),es:'Leer cambios.', 'zh-Hant-TW':'Read', 'x-test':'Read'};assert.equal((await validate(schema)).status,'valid');
});

test('bounded payload subset rejects references, regex, open objects, unbounded collections and unsafe numeric declarations',async t=>{
 const {validate}=await harness(t),invalid=[
  true,{},{$ref:'https://schemas.example/payload'},{type:'string',maxLength:20,pattern:'(a+)+$'},{type:'string',maxLength:20,$defs:{}},
  {type:'object'},{type:'object',additionalProperties:true},{type:'object',additionalProperties:{type:'null'}},{type:'object',additionalProperties:false,required:['missing']},
  {type:'array',items:{type:'null'}},{type:'array',maxItems:256},{type:'array',maxItems:257,items:{type:'null'}},{type:'array',maxItems:-1,items:{type:'null'}},
  {type:'string'},{type:['string','null']},{type:'string',maxLength:4097},{type:'string',maxLength:10,format:'email'},{type:'string',maxLength:10,format:'http'},
  {type:['null','null']},{type:'future'},{type:'number',minimum:2,maximum:1},{type:'number',multipleOf:0},{type:'integer',maximum:9007199254740992},{type:'integer',const:9007199254740992},
  {type:'null',enum:[]},{type:'null',enum:Array.from({length:65},(_,n)=>n)},{type:'null',enum:[null,null]},{type:'object',additionalProperties:false,enum:[{a:1,b:2},{b:2,a:1}]},nesting(7),
  {type:'object',additionalProperties:false,properties:Object.fromEntries(Array.from({length:129},(_,n)=>['p'+n,{type:'null'}]))},
  {type:'object',additionalProperties:false,properties:{nested:{type:'object',additionalProperties:false,properties:Object.fromEntries(Array.from({length:128},(_,n)=>['p'+n,{type:'null'}]))}}},
 ];
 for(const payload of invalid){const schema=manifest();schema.slot.bus.payload=payload;assert.equal((await validate(schema)).status,'invalid',JSON.stringify(payload));}
});

test('payload accepts nullable bounded shapes, all v1 scalar kinds and the inclusive schema budgets',async t=>{
 const {validate}=await harness(t),valid=[nesting(6),{type:'string',maxLength:0},{type:'string',maxLength:4096,format:'uri'},...['date-time','uuid'].map(format=>({type:'string',maxLength:128,format})),{type:['string','null'],maxLength:128},
  {type:'array',maxItems:0,items:{type:'null'}},{type:'array',maxItems:256,items:{type:'integer',minimum:-9007199254740991,maximum:9007199254740991}},
  {type:'number',minimum:-1.5,maximum:2.5,multipleOf:0.5},{type:'boolean',const:true},{type:'integer',enum:Array.from({length:64},(_,n)=>n)},
  {type:'object',additionalProperties:false,properties:Object.fromEntries(Array.from({length:128},(_,n)=>['p'+n,{type:'null'}]))},
 ];
 for(const payload of valid){const schema=manifest();schema.slot.bus.payload=payload;assert.equal((await validate(schema)).status,'valid',JSON.stringify(payload));}
});

test('pin Action shares immutable fragment storage and hashes the complete original manifest',async t=>{
 const {f,e,pin}=await harness(t),schema=manifest(),hash=await slotDigest(webcrypto,schema),before=await pin();assert.equal(before.digest,hash);assert.deepEqual(before.schema,schema);assert.equal((await pinSchema(f,url)).digest,hash.slice(7));assert.equal((await pin(url,hash)).digest,hash);assert.equal(e.audit.entries.at(-1).operation,'events.pin');
 for(const mutate of [s=>s.slot.bus.types.push('reassigned'),s=>s.slot.bus.payload.properties.title={type:'string',maxLength:200},s=>s.slot.bus.retention.max_seconds++,s=>s.slot.bus.history='owner-choice',s=>s.slot.bus.publishers.push('provider'),s=>s.slot.bus.readers=['application'],s=>s.slot.bus.categories=['personal-data'],s=>s.slot.future=true]){
  const changed=manifest();mutate(changed);f.set(changed);await assert.rejects(pin(),{code:'schema_changed'});assert.deepEqual((await f.store.transaction(tx=>tx.get('federation/schema/'+url))).schema,schema);
 }
 f.set(schema);const ordinary=fixture();await pinSchema(ordinary,url);const provider=createEventBusesProvider(ordinary);assert.equal((await provider.pin({url})).digest,hash);
 const next=manifest();next.id=url+'-next';next.slot.supersedes=url;f.set(next);assert.equal((await pin(next.id)).schema.id,next.id);assert.equal((await f.store.transaction(tx=>tx.get('federation/schema/'+url))).digest,hash.slice(7));
});

test('pin rejects digest/host/schema failures before persistence and concurrent changes cannot replace the first pin',async t=>{
 const {f,pin}=await harness(t),wrong=await slotDigest(webcrypto,{different:true});
 await assert.rejects(pin(url,wrong),{code:'digest_mismatch'});assert.equal(await f.store.transaction(tx=>tx.get('federation/schema/'+url)),undefined);
 await assert.rejects(pin(url,'sha256-bad'),{code:'invalid_digest'});const fetches=f.fetches;await assert.rejects(pin('https://untrusted.example/bus/v1'),{code:'untrusted_schema_host'});assert.equal(f.fetches,fetches);
 const invalid=manifest();invalid.slot.bus.v=2;f.set(invalid);await assert.rejects(pin(),{code:'unsupported_fragment'});assert.equal(await f.store.transaction(tx=>tx.get('federation/schema/'+url)),undefined);
 f.schemaFetcher=async()=>{throw Error('publisher unavailable');};await assert.rejects(pin(),/publisher unavailable/);
 let calls=0;f.schemaFetcher=async()=>{const schema=manifest();if(calls++)schema.slot.bus.history='owner-choice';return schema;};const results=await Promise.allSettled([pin(),pin()]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.code,'schema_changed');
});

test('unmounted engine operations are default off, reject before provider access, and never enter account routing',async t=>{
 for(const flag of [undefined,false,'false',1,'1']){
  let calls=0;const {e}=await harness(t,{config:{EVENT_BUSES_ENABLED:flag,EXTENSIONS_ENABLED:true},eventBuses:{validate(){calls++;},pin(){calls++;}}});
  await assert.rejects(e.read(new BusManifest({input:{schema:manifest()}})),{code:'event_buses_disabled'});await assert.rejects(e.perform(new PinBusManifest({input:{url}})),{code:'event_buses_disabled'});assert.equal(calls,0);
 }
 const {validate}=await harness(t,{config:{EVENT_BUSES_ENABLED:'true'}});assert.equal((await validate(manifest())).status,'valid');
 assert(!Object.hasOwn(ACCOUNT_OPERATIONS,BusManifest.operation));assert(!Object.hasOwn(ACCOUNT_OPERATIONS,PinBusManifest.operation));
});

test('event-bus contract source specifies exact methods, write introspection and bounded results without publication',async()=>{
 const contract=JSON.parse(await readFile(new URL('../docs/artefacts/event-bus-v1.json',import.meta.url),'utf8'));
 assert.equal(contract.$id,EVENT_BUS_CONTRACT);assert.equal(contract.$schema,'https://json-schema.org/draft/2020-12/schema');assert.equal(publicArtifacts.some(artifact=>artifact.id===contract.$id),false);assert.deepEqual(Object.keys(contract['x-methods']),['publish','read','subscribe','unsubscribe']);
 for(const [method,metadata] of Object.entries(contract['x-methods'])){const request=contract.$defs[metadata.request.split('/').at(-1)],args=contract.$defs[request.properties.args.$ref.split('/').at(-1)];assert.equal(request.properties.method.const,method);assert.equal(request.additionalProperties,false);assert.equal(args.additionalProperties,false);assert(contract.$defs[metadata.result.split('/').at(-1)]);assert.equal(metadata.effect,method==='read'?'read':'write');}
 assert.equal(contract['x-methods'].publish.introspect,true);assert.deepEqual(Object.keys(contract.$defs.publishResult.properties),['receipt','published_at']);assert.equal(contract.$defs.readArgs.properties.limit.maximum,100);assert.equal(contract.$defs.readArgs.properties.wait.maximum,25);assert.deepEqual(contract.$defs.readArgs.not,{required:['cursor','start']});assert.equal(contract.$defs.hostLimits.properties.txRetentionSeconds.minimum,600);
});
