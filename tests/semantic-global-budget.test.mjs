import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {GlobalSemanticBudget} from '../packages/runtime/semantic-budget.mjs';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('global semantic reservations serialize across owners and survive restart without caller price authority',async()=>{
 const metadata=new SqliteMetadata(':memory:');try{
 const config={SEMANTIC_GLOBAL_MONTHLY_MICRO_USD:'22',SEMANTIC_GLOBAL_DAILY_MICRO_USD:'22'};const budget=new GlobalSemanticBudget({metadata,config});
 const results=await Promise.allSettled(Array.from({length:20},()=>budget.reserve({operation:'embed',units:512,costMicroUSD:0,owner})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal((await metadata.get('semantic/month')).microUSD,22);
 await assert.rejects(new GlobalSemanticBudget({metadata,config}).reserve({operation:'query',units:384,owner}),{code:'semantic_global_budget'});
 }finally{metadata.close();}
});
test('global namespace and upsert lifetime caps do not reset with the billing month or deletions',async()=>{
 const metadata=new SqliteMetadata(':memory:');let now=Date.UTC(2026,9,12);try{
 const config={SEMANTIC_GLOBAL_MAX_OWNERS:'1',SEMANTIC_GLOBAL_MAX_UPSERTS:'1'};const budget=new GlobalSemanticBudget({metadata,config,clock:()=>now});
 await budget.reserve({operation:'upsert',units:384,owner,newVector:true});now=Date.UTC(2026,10,12);
 await assert.rejects(budget.reserve({operation:'upsert',units:384,owner,newVector:false}),{code:'semantic_global_budget'});
 await assert.rejects(budget.reserve({operation:'query',units:384,owner:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),{code:'semantic_global_budget'});
 await budget.reserve({operation:'query',units:384,owner});assert.deepEqual(await metadata.get('semantic/stock'),{owners:1,upserts:1});
 }finally{metadata.close();}
});
test('daily pause resets safely while monthly aggregate capacity remains charged',async()=>{
 const metadata=new SqliteMetadata(':memory:');let now=Date.UTC(2026,9,12);try{
 const budget=new GlobalSemanticBudget({metadata,clock:()=>now,config:{SEMANTIC_GLOBAL_DAILY_MICRO_USD:'11',SEMANTIC_GLOBAL_MONTHLY_MICRO_USD:'22'}});
 await budget.reserve({operation:'embed',units:512,owner});await assert.rejects(budget.reserve({operation:'query',units:384,owner}),{code:'semantic_global_budget'});
 now+=86400000;await budget.reserve({operation:'embed',units:512,owner});now+=86400000;await assert.rejects(budget.reserve({operation:'embed',units:512,owner}),{code:'semantic_global_budget'});
 }finally{metadata.close();}
});
