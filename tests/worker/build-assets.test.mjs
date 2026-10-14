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

test('Worker resolves console and Spanish landing HTML canonicalization internally without changing public routes',async t=>{
 const calls=[];
 const h=await createHarness({assets:async request=>{const url=new URL(request.url);calls.push(url.pathname+url.search);if(['/console.html','/index.es.html'].includes(url.pathname))return new Response(null,{status:307,headers:{Location:url.pathname.slice(0,-5)}});return new Response('<!doctype html><title>'+url.pathname+'</title>',{headers:{'Content-Type':'text/html'}});}});t.after(()=>h.close());
 for(const [publicPath,asset]of [['/console?signin','/console'],['/device','/console'],['/recovery/restore','/console'],['/?lang=es','/index.es']]){calls.length=0;const response=await h.request(publicPath);assert.equal(response.status,200);assert.equal(response.headers.get('Location'),null);assert.match(await response.text(),new RegExp('<title>'+asset+'</title>'));assert.deepEqual(calls,[asset+'.html',asset]);}
 calls.length=0;const legacy=await h.mf.dispatchFetch(h.origin+'/?signin&return_to=%2Fpreferences',{redirect:'manual'});assert.equal(legacy.status,307);assert.equal(legacy.headers.get('Location'),'/console?signin&return_to=%2Fpreferences');assert.deepEqual(calls,[]);
});

test('Worker console asset redirects reject external or alternate destinations',async t=>{
 let location='https://other.example/console';
 const h=await createHarness({assets:async()=>new Response(null,{status:307,headers:{Location:location}})});t.after(()=>h.close());
 for(const target of ['https://other.example/console','/api/account','/console?signin','/console#private']){location=target;assert.equal((await h.request('/console')).status,502);}
});

test('Worker resolves only the known generated offline console and landing snapshot names',async t=>{
 const calls=[];const h=await createHarness({assets:async request=>{const url=new URL(request.url);calls.push(url.pathname);return url.pathname.endsWith('.html')?new Response(null,{status:307,headers:{Location:url.pathname.slice(0,-5)}}):new Response('<!doctype html><title>offline</title>',{headers:{'Content-Type':'text/html'}});}});t.after(()=>h.close());
 for(const name of ['console','landing-en','landing-es']){calls.length=0;const path='/assets/offline-'+name+'.'+'b'.repeat(20)+'.html';const response=await h.request(path);assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/immutable/);assert.deepEqual(calls,[path,path.slice(0,-5)]);}
});
