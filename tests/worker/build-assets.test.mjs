import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
const path='/assets/offline-index.'+'a'.repeat(20)+'.html';

test('Worker follows only the exact internal HTML canonicalization and preserves immutable snapshot bytes',async t=>{
 const calls=[],html='<!doctype html><title>3sln.me · public snapshot</title>';
 const h=await createHarness({bindings:{BRAND_NAME:'Other Host'},assets:async request=>{const url=new URL(request.url);calls.push(url.pathname);return url.pathname===path?new Response(null,{status:307,headers:{Location:path.slice(0,-5)}}):new Response(html,{headers:{'Content-Type':'text/html'}});}});t.after(()=>h.close());
 const response=await h.request(path);assert.equal(response.status,200);assert.equal(await response.text(),html);assert.match(response.headers.get('Cache-Control'),/immutable/);assert.deepEqual(calls,[path,path.slice(0,-5)]);
});

test('Worker rejects external, alternate-path, query-bearing, and repeated snapshot redirects',async t=>{
 let location,calls=0,repeat=false;
 const h=await createHarness({assets:async()=>{calls++;return new Response(null,{status:307,headers:{Location:repeat?path.slice(0,-5):location}});}});t.after(()=>h.close());
 for(const target of ['https://other.example'+path.slice(0,-5),'/api/account',path.slice(0,-5)+'?key=anything']){location=target;calls=0;const response=await h.request(path);assert.equal(response.status,502);assert.equal(calls,1);}
 location=path.slice(0,-5);repeat=true;calls=0;assert.equal((await h.request(path)).status,502);assert.equal(calls,2);
});
