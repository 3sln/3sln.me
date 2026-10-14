import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createNodeFormFetch} from '../packages/apps/node-form-fetch.mjs';
import {createWorkerFormFetch} from '../apps/worker/form-fetch.mjs';
import {publicAddress} from '../packages/apps/form-fetch-policy.mjs';
const origin='https://app.example';
const input=(extra={})=>({url:origin+'/submit?mode=one',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':'audit_operation_123456'},body:new TextEncoder().encode('answer=hello'),...extra});
function nodeHarness({records=[{address:'93.184.216.34',family:4}],status=200,headers={'content-type':'text/html'},body='<p>Done</p>',lookup,stall=false}={}){
 const calls=[];let resolverCalls=0;const port=createNodeFormFetch({allowedOrigins:[origin],timeoutMs:100,lookup:lookup??(async()=>{resolverCalls++;return records;}),request:(options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=bytes=>{calls.push({options,bytes:new Uint8Array(bytes)});if(stall)return;queueMicrotask(()=>{const res=new PassThrough();Object.assign(res,{statusCode:status,headers});callback(res);res.end(body);});};return req;}});return {port,calls,get resolverCalls(){return resolverCalls;}};
}
function workerHarness({addresses=['93.184.216.34'],ipv6=['2606:4700:4700::1111'],status=200,headers={'Content-Type':'text/html'},body='<p>Done</p>',dnsOverride,stall=false,timeoutMs=100}={}){
 const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});const u=new URL(url);if(u.origin==='https://cloudflare-dns.com'){const type=Number(u.searchParams.get('type'));return Response.json(dnsOverride??{Status:0,Question:[{name:'app.example.',type}],Answer:(type===1?addresses:ipv6).map(data=>({type,data}))},{headers:{'Content-Type':'application/dns-json'}});}if(stall)return new Promise(()=>{});return new Response(body,{status,headers});};return {calls,port:createWorkerFormFetch({allowedOrigins:[origin],publicRouting:true,fetcher,timeoutMs})};
}
test('form transport addresses reject private, special, translated and documentation ranges',()=>{
 for(const value of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.1.1','172.16.0.1','192.168.0.1','192.0.2.1','198.18.0.1','203.0.113.5','224.0.0.1','012.2.3.4','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:a00:1::1','3fff::1','invalid'])assert.equal(publicAddress(value),false,value);
 for(const value of ['93.184.216.34','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(value),true,value);
});
test('both transports require explicit exact HTTPS origins and fixed credential-free request shape',async()=>{
 for(const create of [opts=>createNodeFormFetch(opts),opts=>createWorkerFormFetch({...opts,publicRouting:true})])for(const allowedOrigins of [[],['http://app.example'],['https://app.example:444'],['https://127.0.0.1'],['https://localhost'],['https://app.example/path']])assert.throws(()=>create({allowedOrigins}));
 assert.throws(()=>createWorkerFormFetch({allowedOrigins:[origin]}));
 for(const {port,calls}of [nodeHarness(),workerHarness()]){for(const extra of [{url:'https://other.example/post'},{url:'https://app.example:444/post'},{url:'https://user:pass@app.example/post'},{url:origin+'/#secret'},{method:'GET'},{body:new Uint8Array(16385)},{headers:{Cookie:'secret'}},{headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':'audit_operation_123456',Authorization:'secret'}},{cf:{resolveOverride:'private.example'}}])await assert.rejects(port.send(input(extra)));assert.equal(calls.length,0);}
});
test('Node pins validated public A result to TLS connection and constructs headers/body without cookie authority',async()=>{
 const h=nodeHarness(),r=await h.port.send(input());assert.equal(r.status,200);assert.equal(new TextDecoder().decode(r.bytes),'<p>Done</p>');assert.equal(h.resolverCalls,1);const [{options,bytes}]=h.calls;assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'app.example');assert.equal(options.path,'/submit?mode=one');assert.equal(options.method,'POST');assert.deepEqual(bytes,input().body);assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);
 const selected=await new Promise((resolve,reject)=>options.lookup('ignored',{all:true},(e,r)=>e?reject(e):resolve(r)));assert.deepEqual(selected,[{address:'93.184.216.34',family:4}]);
});
test('Node rejects mixed/private DNS, unknown outcome timeout, oversized/encoded response and never follows redirect',async()=>{
 for(const records of [[],[{address:'10.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],[{address:'2606:4700::1',family:6}]]){const h=nodeHarness({records});await assert.rejects(h.port.send(input()));assert.equal(h.calls.length,0);}
 for(const opts of [{body:'x'.repeat(131073)},{headers:{'content-encoding':'gzip'}},{stall:true},{lookup:()=>new Promise(()=>{})}])await assert.rejects(nodeHarness(opts).port.send(input()),{code:'form_transport_unavailable'});
 const h=nodeHarness({status:307,headers:{location:'https://other.example/done','set-cookie':'secret=1'},body:'ignored'}),r=await h.port.send(input());assert.equal(h.calls.length,1);assert.equal(r.status,307);assert.deepEqual(r.headers,{location:'https://other.example/done'});assert.equal(r.bytes.length,0);
});
test('Worker screens A and AAAA before exact reviewed native fetch with no ambient credentials or redirect follow',async()=>{
 const h=workerHarness({headers:{'Content-Type':'text/html','Set-Cookie':'secret=1'}}),r=await h.port.send(input());assert.equal(h.calls.length,3);assert.equal(r.status,200);assert.deepEqual(r.headers,{contentType:'text/html'});const {url,options}=h.calls[2];assert.equal(url,input().url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);assert.equal(options.cf,undefined);
});
test('Worker DNS screening rejects mixed/private/empty/malformed records before POST; redirects stay manual',async()=>{
 for(const opts of [{addresses:['10.0.0.1']},{ipv6:['fd00::1']},{addresses:['1.1.1.1','127.0.0.1']},{addresses:[],ipv6:[]},{dnsOverride:{Status:0,Question:[{name:'wrong.example.',type:1}],Answer:[]}},{dnsOverride:{Status:3}}]){const h=workerHarness(opts);await assert.rejects(h.port.send(input()));assert(h.calls.every(c=>c.options.method==='GET'));}
 const h=workerHarness({status:303,headers:{Location:'https://other.example/next','Set-Cookie':'secret=1'},body:'ignored'}),r=await h.port.send(input());assert.equal(h.calls.length,3);assert.equal(r.status,303);assert.deepEqual(r.headers,{location:'https://other.example/next',contentType:'text/plain;charset=UTF-8'});assert.equal(r.bytes.length,0);
});
test('Worker response bytes/deadline and caller abort remain bounded without replay',async()=>{
 for(const opts of [{body:'x'.repeat(131073)},{headers:{'Content-Encoding':'gzip'}},{stall:true,timeoutMs:5}]){const h=workerHarness(opts);await assert.rejects(h.port.send(input()),{code:'form_transport_unavailable'});assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);}
 const controller=new AbortController();controller.abort();const h=workerHarness();await assert.rejects(h.port.send(input({signal:controller.signal})));assert.equal(h.calls.length,0);
});

test('Worker cancels an oversized streaming body and rejects concurrency before DNS work',async()=>{
 let canceled=0,posts=0;const responses=[];const fetcher=async(url,options)=>{if(options.method==='GET'){const type=Number(new URL(url).searchParams.get('type'));return Response.json({Status:0,Question:[{name:'app.example',type}],Answer:type===1?[{type,data:'1.1.1.1'}]:[]},{headers:{'Content-Type':'application/dns-json'}});}posts++;if(posts===1)return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(131073));},cancel(){canceled++;}}));return new Promise(resolve=>responses.push(resolve));};
 const port=createWorkerFormFetch({allowedOrigins:[origin],publicRouting:true,fetcher,maxConcurrent:1,timeoutMs:100});await assert.rejects(port.send(input()));assert.equal(canceled,1);
 const pending=port.send(input());await new Promise(resolve=>setTimeout(resolve,0));await assert.rejects(port.send(input()));assert.equal(posts,2);responses[0](new Response('Done'));assert.equal((await pending).status,200);
 await assert.rejects(port.send(input({signal:{}})));assert.equal(posts,2);
});

test('Node late DNS after total deadline cannot initiate a POST',async()=>{
 let resolveDNS;const h=nodeHarness({lookup:()=>new Promise(resolve=>resolveDNS=resolve)});await assert.rejects(h.port.send(input()));resolveDNS([{address:'1.1.1.1',family:4}]);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(h.calls.length,0);
});
