import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';

test('owner step-up routes enforce Origin, CSRF, session and account binding without issuing another session',async t=>{
 const h=await createHarness();t.after(()=>h.close());const {result,cookie}=await h.signup(),headers={Cookie:cookie,Origin:h.origin,'X-CSRF-Token':result.csrfToken},password='isolated test account password';
 const post=(path,value={},extra=headers)=>h.request(path,{method:'POST',value,headers:extra});
 for(const path of ['/api/auth/step-up/begin','/api/auth/step-up']){
  const input=path.endsWith('/begin')?{}:{method:'password',password};
  for(const forbidden of [{...headers,Origin:'https://outside.example'},{...headers,'X-CSRF-Token':'wrong'},{...headers,'X-CSRF-Token':''}])assert.equal((await post(path,input,forbidden)).status,403);
  assert.equal((await post(path,input,{Origin:h.origin})).status,401);
  assert.equal((await post(path,input,{...headers,'X-Bindle-Account':crypto.randomUUID(),'X-Bindle-Session-Context':result.sessionContext})).status,409);
  assert.equal((await h.request(path,{headers})).status,405);
 }
 const begin=await post('/api/auth/step-up/begin');assert.equal(begin.status,200);assert.deepEqual(await begin.json(),{password:true,passkey:false});
 const wrong=await post('/api/auth/step-up',{method:'password',password:'a wrong but long password'});assert.equal(wrong.status,401);assert.equal(wrong.headers.get('Set-Cookie'),null);
 assert.equal((await post('/api/auth/step-up',{method:'passkey',response:{id:'unregistered'}})).status,401);
 const confirmed=await post('/api/auth/step-up',{method:'password',password});assert.equal(confirmed.status,200);assert(Number.isSafeInteger((await confirmed.json()).stepUpUntil));assert.equal(confirmed.headers.get('Set-Cookie'),null);
 const session=await (await h.request('/api/session',{headers})).json();assert.equal(session.account.id,result.account.id);assert.equal(session.sessionContext,result.sessionContext);assert.equal(session.csrfToken,result.csrfToken);
});
