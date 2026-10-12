import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata, SerialGate } from '../apps/node/resources.mjs';
import { AccountController } from '../packages/runtime/accounts.mjs';
import { key } from '../packages/messaging/store.mjs';
import { enqueueSearchEvent } from '../packages/search/index.mjs';
import { semanticShard } from '../packages/runtime/semantic-routing.mjs';

const owner = '12345678-1234-4234-8234-123456789abc';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const create = async (config = {}) => {
  const metadata = new SqliteMetadata(':memory:'), bytes = new TextEncoder().encode('Violet project private text');
  const blobs = { get: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) }), delete: async () => {} };
  const controller = new AccountController({ metadata, sql: metadata.sql, gate: new SerialGate(), blobs, archives: { get: async () => null }, config: { APP_ORIGIN: 'https://app.example', LOCAL_DEVELOPMENT: 'true', BILLING_ENABLED: 'false', ...config } });
  const message = { id, owner, collection: 'inbox', mimeType: 'text/plain', receivedAt: Date.now(), readAt: null, size: bytes.length, tags: ['work'], classification: 'work', quarantined: false, blobRef: 'body', revision: 1 };
  await metadata.put(key('message', owner, id), message); controller.itemIndex.upsert(message);
  await metadata.put('owner', owner); await metadata.put('lastOwnerActiveAt', Date.now());
  return { metadata, controller, message };
};

test('runtime search never treats a stale item catalog as source authority after source deletion', async () => {
  const { metadata, controller } = await create();
  try {
    await controller.search.ingest({ owner, id: `message:${id}`, revision: 1, operation: 'upsert' });
    assert.equal((await controller.search.search(owner, { text: 'Violet' })).items.length, 1);
    await metadata.delete(key('message', owner, id));
    assert.ok(controller.itemIndex.get(id)); // Deliberately stale derived projection.
    assert.deepEqual((await controller.search.search(owner, { text: 'Violet' })).items, []);
    // A new service/controller must still refuse the old indexed content.
    const restarted = new AccountController({ metadata, sql: metadata.sql, gate: new SerialGate(), blobs: { get: async () => null }, archives: { get: async () => null }, config: { APP_ORIGIN: 'https://app.example', LOCAL_DEVELOPMENT: 'true', BILLING_ENABLED: 'false' } });
    assert.deepEqual((await restarted.search.search(owner, { text: 'Violet' })).items, []);
  } finally { metadata.close(); }
});

test('shelved authority does not convert queued upserts into deletion tombstones', async () => {
  const { metadata, controller } = await create();
  try {
    await metadata.transaction(tx => enqueueSearchEvent(tx, { owner, id: `message:${id}`, source: { kind: 'message', id }, revision: 1 }));
    await metadata.delete(key('message', owner, id)); await metadata.put('shelved', true);
    await controller.alarm();
    const pending = await controller.searchOutbox.peek(owner, 10);
    assert.equal(pending.length, 1); assert.equal(pending[0].operation, 'upsert');
    assert.equal(metadata.db.prepare('SELECT count(*) AS count FROM search_revisions').get().count, 0);
  } finally { metadata.close(); }
});

test('existing source messages are queued during bounded migration and become searchable', async () => {
  const { metadata, controller } = await create();
  try {
    await controller.warm(owner);
    const pending = await controller.searchOutbox.peek(owner, 10);
    assert.equal(pending.length, 1);
    await controller.searchDrain(owner, { limit: 10 });
    const result = await controller.omniSearch(owner, { text: 'Violet' });
    assert.equal(result.items.length, 1); assert.equal(result.indexing.pending, 0);
  } finally { metadata.close(); }
});

test('a full search backfill queue does not block authoritative inbox catalog migration', async () => {
  const { metadata, controller } = await create();
  try {
    // Exhausted durable capacity is independent of owner read permission.
    await metadata.put(key('search-queue-usage', owner), { count: 5000 });
    await controller.warm(owner);
    assert.equal(await metadata.get('item-index-ready'), true);
    assert.equal(controller.itemIndex.page(owner, { limit: 1 }).items.length, 1);
    assert.equal((await metadata.get(key('search-queue-usage', owner))).count, 5000);
  } finally { metadata.close(); }
});

test('large legacy catalogs and search backfill advance on bounded alarms without owner retries', async () => {
  const { metadata, controller, message } = await create();
  try {
    await metadata.transaction(async tx => {
      for(let index=0;index<450;index++){
        const messageId=`bbbbbbbb-bbbb-4bbb-8bbb-${index.toString(16).padStart(12,'0')}`;
        await tx.put(key('message',owner,messageId),{...message,id:messageId});
      }
    });
    await controller.warm(owner);
    assert.notEqual(await metadata.get('item-index-ready'),true);
    assert.notEqual(await metadata.get('search-backfill-ready'),true);
    assert.ok((await metadata.get(key('search-queue-usage',owner))).count<=200);
    await controller.alarm(); await controller.alarm();
    assert.equal(await metadata.get('item-index-ready'),true);
    assert.equal(await metadata.get('search-backfill-ready'),true);
    assert.equal(metadata.db.prepare('SELECT count(*) AS count FROM inbox_catalog WHERE owner=?').get(owner).count,451);
    assert.equal((await controller.messagePage(owner,{limit:100})).items.length,100);
    assert.ok((await metadata.get(key('search-queue-usage',owner))).count<=900);
    assert.equal(metadata.db.prepare('SELECT count(*) AS count FROM search_documents WHERE owner=?').get(owner).count,20);
    assert.ok(!await metadata.get('shelved'));
  } finally { metadata.close(); }
});

test('legacy backfill reserves plan queue capacity for new source mutations', async () => {
  const { metadata, controller } = await create();
  try {
    await metadata.put(key('search-queue-usage',owner),{count:899});
    await controller.warm(owner);
    assert.equal((await metadata.get(key('search-queue-usage',owner))).count,900);
    await controller.warm(owner);
    assert.equal((await metadata.get('search-backfill-blocked')).reason,'queue_capacity');
    assert.equal(await metadata.get('item-index-ready'),true);
    assert.ok((await metadata.getAlarm())<Date.now()+120000);
  } finally { metadata.close(); }
});

const semanticConfig = counters => ({ SEMANTIC_SEARCH_ENABLED: 'true', AI: { run: async (model,input) => { counters.embeds++; assert.equal(model,'@cf/baai/bge-small-en-v1.5'); assert.ok(new TextEncoder().encode(input.text[0]).length<=480); return { data: [Array(384).fill(0.1)] }; } }, SEARCH_VECTORS: { upsert: async () => { counters.upserts++; }, deleteByIds: async () => { counters.deletes++; }, query: async () => { counters.queries++; return { matches: [] }; } }, SEMANTIC_SPEND: { reserve: async request => { counters.admissions.push(request); return true; } } });

test('real semantic runtime requires consent, rebuilds existing data and purges on revoke without nested account deadlocks', async () => {
  const counters={embeds:0,upserts:0,queries:0,deletes:0,admissions:[]};const {metadata,controller}=await create(semanticConfig(counters));
  try {
    await controller.search.ingest({owner,id:`message:${id}`,revision:1,operation:'upsert'});
    assert.equal(counters.embeds,0);
    const opted=await controller.invoke({method:'updateSearchPreferences',args:[owner,{enabled:true}]});assert.equal(opted.available,true);
    await controller.alarm();assert.equal(counters.embeds,1);assert.equal(counters.upserts,1);
    await controller.search.ingest({owner,id:`message:${id}`,revision:1,operation:'upsert'});assert.equal(counters.embeds,1);
    await controller.invoke({method:'omniSearch',args:[owner,{text:'violet',mode:'semantic'}]});assert.equal(counters.queries,1);
    assert.equal(counters.admissions.filter(row=>row.operation==='embed').length,2);
    await controller.invoke({method:'updateSearchPreferences',args:[owner,{enabled:false}]});
    assert.equal((await controller.searchPreferences(owner)).available,false);await controller.alarm();assert.equal(counters.deletes,1);
    const refusal=await controller.invoke({method:'omniSearch',args:[owner,{text:'violet',mode:'semantic'}]});assert.equal(refusal.$fault.code,'semantic_search_unavailable');
    await controller.invoke({method:'updateSearchPreferences',args:[owner,{enabled:true}]});await controller.alarm();assert.equal(counters.upserts,2);
  }finally{metadata.close();}
});

test('semantic limits survive restart and lexical outbox progress survives exhausted semantic spend', async()=>{
  const counters={embeds:0,upserts:0,queries:0,deletes:0,admissions:[]};const {metadata,controller}=await create(semanticConfig(counters));
  try{
    await controller.updateSearchPreferences(owner,{enabled:true});
    controller.semanticBudget.limits.documents=0;
    await controller.searchDrain(owner,{limit:10});assert.equal(counters.embeds,0);assert.equal((await controller.searchOutbox.peek(owner,10)).length,0);
    assert.equal((await controller.omniSearch(owner,{text:'violet',mode:'lexical'})).items.length,1);
    assert.equal((await controller.searchPreferences(owner)).error,'semantic_account_budget');
    controller.semanticBudget.limits.documents=1000;
    await controller.omniSearch(owner,{text:'violet',mode:'semantic'});
    const restarted=new AccountController({metadata,sql:metadata.sql,gate:new SerialGate(),blobs:controller.blobs,archives:controller.archives,config:controller.config});
    assert.equal((await restarted.searchPreferences(owner)).usage.queries,1);
    assert.equal((await restarted.searchPreferences(owner)).enabled,true);
  }finally{metadata.close();}
});

test('account runtime uses a fixed owner vector shard and refuses changed durable routing', async () => {
  const counters={embeds:0,upserts:0,queries:0,deletes:0,admissions:[]},config=semanticConfig(counters),writes=[0,0,0,0];delete config.SEARCH_VECTORS;
  for(let shard=0;shard<4;shard++)config[`SEARCH_VECTORS_${shard}`]={query:async()=>({matches:[]}),deleteByIds:async()=>{},upsert:async()=>{writes[shard]++;}};
  const {metadata,controller}=await create(config);
  try{
    await controller.updateSearchPreferences(owner,{enabled:true});await controller.alarm();
    const shard=await semanticShard(owner,4);assert.equal(writes[shard],1);assert.equal(writes.reduce((sum,value)=>sum+value,0),1);
    assert.deepEqual(await metadata.get('search-vector-route'),{layoutVersion:1,shard});
    await metadata.put('search-vector-route',{layoutVersion:1,shard:(shard+1)%4});
    const restarted=new AccountController({metadata,sql:metadata.sql,gate:new SerialGate(),blobs:controller.blobs,archives:controller.archives,config:controller.config});
    const result=await restarted.invoke({method:'omniSearch',args:[owner,{text:'violet',mode:'semantic'}]});assert.equal(result.$fault.code,'semantic_routing_mismatch');assert.equal(counters.embeds,1);
  }finally{metadata.close();}
});
