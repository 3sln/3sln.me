import test from 'node:test';
import assert from 'node:assert/strict';
import APIProvider,{createAPI} from '../../apps/web/src/providers/api.mjs';
const a='550e8400-e29b-41d4-a716-446655440001',b='550e8400-e29b-41d4-a716-446655440002';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function mockFetch(t,fetcher){const previous=globalThis.fetch;globalThis.fetch=fetcher;t.after(()=>{globalThis.fetch=previous;});}
const install=(api,id,context,csrf)=>api.setContext({account:{id},sessionContext:context,csrfToken:csrf});
test('independent account audit: malformed late JSON cannot report an old 401 into a replacement session',async t=>{
 const api=createAPI(),reading=deferred(),release=deferred();install(api,a,'a1','csrf-a');
 mockFetch(t,async()=>({status:401,ok:false,json:async()=>{reading.resolve();await release.promise;throw new SyntaxError('malformed old response');}}));
 const request=api.get('/api/account');await reading.promise;install(api,b,'b1','csrf-b');release.resolve();
 await assert.rejects(request,error=>error.code==='local_account_changed'&&error.status!==401);assert.equal(api.csrf,'csrf-b');assert.equal(api.account,b);
});
test('independent account audit: a request-local account projection does not replace console CSRF',async t=>{
 const api=createAPI();install(api,a,'a1','csrf-a');const calls=[];
 mockFetch(t,async(path,options)=>{calls.push(options);return new Response(JSON.stringify({csrfToken:'csrf-b',account:{id:b},sessionContext:'b1'}));});
 const result=await api.get('/api/oauth/requests/review',{context:{owner:b,sessionContext:'b1',csrfToken:'csrf-b'}});
 assert.equal(result.account.id,b);assert.equal(calls[0].headers['X-Bindle-Account'],b);assert.equal(api.account,a);assert.equal(api.sessionContext,'a1');assert.equal(api.csrf,'csrf-a');
});
test('independent account audit: disposing the provider invalidates pending responses and all installed context',async t=>{
 const provider=new APIProvider(),api=await provider.obtain(),pending=deferred();install(api,a,'a1','csrf-a');mockFetch(t,()=>pending.promise);
 const request=api.get('/api/account');provider.dispose();pending.resolve(new Response(JSON.stringify({csrfToken:'late-private-csrf'})));
 await assert.rejects(request,error=>error.code==='local_account_changed');assert.equal(api.account,null);assert.equal(api.sessionContext,null);assert.equal(api.csrf,null);
});
