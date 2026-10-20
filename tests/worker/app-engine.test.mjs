import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
// Actual workerd + SQLite Durable Object: the engine-first Views and Tags routes dispatch ngin Actions inside the
// account object's blockConcurrencyWhile gate (a dispatch runs on a later macrotask, which the gate must allow).
async function read(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
test('Worker adapter: Views, incoming and tag rule routes dispatch account engine operations end to end',async t=>{
 const h=await createHarness();t.after(()=>h.close());const {result:owner,cookie}=await h.signup(),headers={Origin:h.origin,Cookie:cookie,'X-CSRF-Token':owner.csrfToken};
 const call=(path,method='GET',value)=>h.request(path,{method,headers:method==='GET'?{Cookie:cookie}:headers,...value!==undefined?{value}:{}});
 assert.deepEqual((await read(await call('/api/views'))).views.map(v=>v.id),['all','unread','conversations']);
 const operationId=crypto.randomUUID(),input={name:'Work',filter:{version:1,tagsAll:['work']},operationId};
 const view=await read(await call('/api/views','POST',input));assert.deepEqual(await read(await call('/api/views','POST',input)),view,'a retried operation ID returns the original View');
 assert.equal((await read(await call('/api/views/'+view.id,'PUT',{name:'Renamed',filter:{version:1},expectedRevision:1}))).revision,2);
 assert.equal((await read(await call('/api/views/'+view.id,'PUT',{name:'Stale',filter:{version:1},expectedRevision:1}),409)).error,'view_conflict');
 const page=await read(await call(`/api/incoming?view=${view.id}&viewRevision=2&limit=10`));assert.deepEqual(page.items,[]);
 assert.equal((await read(await call('/api/incoming','PATCH',{id:'conversation:none',expectedRevision:1,tags:['x']}),404)).error,'not_found');
 assert.deepEqual(await read(await call('/api/views/'+view.id,'DELETE',{expectedRevision:2})),{deleted:true});
 const rules=await read(await call('/api/rules'));assert.ok(rules.some(r=>r.id==='default:promote.spam'));
 const remaining=await read(await call('/api/rules/default:promote.social','DELETE',{}));assert.equal(remaining.some(r=>r.id==='default:promote.social'),false);
 assert.equal((await read(await call(`/api/rules/${encodeURIComponent('default:promote.social')}/restore`,'POST',{}))).id,'default:promote.social');
 assert.equal((await read(await call('/api/rules','PUT',{}),400)).error,'invalid_rules');
 const label=await read(await call('/api/tags/labels','PUT',{label:'Clients'}));assert.equal((await read(await call('/api/tags/labels'))).labels[label.id],'Clients');
 const snapshot=await read(await call('/api/account'));assert.equal(snapshot.tagLabels.labels[label.id],'Clients');assert.ok(snapshot.rules.some(r=>r.id==='default:promote.social'));assert.equal(snapshot.views.length,3);
 assert.equal((await h.request('/api/views',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},value:input})).status,403);
});
