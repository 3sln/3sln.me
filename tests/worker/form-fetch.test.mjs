import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {createHarness} from './harness.mjs';

test('actual Worker form port constructs credential-free POST and returns redirect without another request',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'bindle-form-port-worker-')),out=join(dir,'worker.mjs');t.after(()=>rm(dir,{recursive:true,force:true}));
 await build({stdin:{contents:`import {createWorkerFormFetch} from './apps/worker/form-fetch.mjs';export default {async fetch(request){try{const port=createWorkerFormFetch({allowedOrigins:['https://app.example'],publicRouting:true});const result=await port.send({url:'https://app.example/submit',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':'isolated_worker_operation'},body:new TextEncoder().encode('answer=hello')});return Response.json({...result,bytes:[...result.bytes]});}catch{return Response.json({error:'refused'},{status:502});}}};`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',outfile:out,logLevel:'silent'});
 const calls=[];let privateDNS=false;const mf=new Miniflare(convertV4MiniflareOptions({name:'form-port-audit',modulesRoot:dir,modules:[{type:'ESModule',path:out}],compatibilityDate:'2026-10-11',compatibilityFlags:['global_fetch_strictly_public'],log:new Log(LogLevel.ERROR),outboundService:async request=>{
  const u=new URL(request.url);calls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()});
  if(u.origin==='https://cloudflare-dns.com'){const type=Number(u.searchParams.get('type'));return Response.json({Status:0,Question:[{name:'app.example.',type}],Answer:type===1?[{type,data:privateDNS?'127.0.0.1':'1.1.1.1'}]:[]},{headers:{'Content-Type':'application/dns-json'}});}
  assert.equal(u.href,'https://app.example/submit');return new Response('ignored',{status:303,headers:{Location:'https://other.example/result','Set-Cookie':'must_not_escape=1','Bindle-Target':'_blank'}});
 }}));t.after(()=>mf.dispose());
 const response=await mf.dispatchFetch('https://provider.example/start',{headers:{Cookie:'owner_session=private',Authorization:'Bearer private'}});assert.equal(response.status,200,response.status===200?'':await response.clone().text());const r=await response.json();assert.equal(r.status,303);assert.equal(r.headers.location,'https://other.example/result');assert.equal(r.headers.bindleTarget,'_blank');assert.equal(r.headers['set-cookie'],undefined);assert.deepEqual(r.bytes,[]);assert.equal(calls.length,3);assert.equal(calls[2].method,'POST');assert.equal(calls[2].body,'answer=hello');for(const call of calls){assert.equal(call.headers.cookie,undefined);assert.equal(call.headers.authorization,undefined);assert.equal(call.headers.referer,undefined);}
 calls.length=0;privateDNS=true;assert.equal((await mf.dispatchFetch('https://provider.example/start')).status,502);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});

test('actual AccountObject injects a port only for the explicit registered origin intersection',async t=>{
 const origin='https://app.example',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 for(const approved of [[],[origin],['https://unregistered.example'],['*']]){
  const h=await createHarness({bindings:{FORM_POSTBACK_ORIGINS:JSON.stringify(approved),FEDERATION_CLIENTS:JSON.stringify([{id:origin+'/client',origin,name:'App',redirectUris:[origin+'/callback']}])}});
  try{const account=h.accounts.get(h.accounts.idFromName(owner));const value=await account.postbackAvailability(owner,'fixture',{mimeType:'text/html',appNotification:{}},'fixture-digest');assert.equal(value.enabled,false);await account.invoke({method:'touch',args:[owner]});assert((await account.rows()).some(([key,value])=>key==='owner'&&value===owner));assert.equal(value.reason,approved.includes(origin)?'destination-unavailable':'transport-unavailable');}finally{await h.close();}
 }
});
