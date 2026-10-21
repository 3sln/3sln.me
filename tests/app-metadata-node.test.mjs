import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createNodeMetadataFetch} from '../packages/apps/node-metadata-fetch.mjs';
const origin='https://app.example';
function fixture({records=[{address:'8.8.8.8',family:4}],status=200,headers={'content-type':'application/json'},chunks=['{}'],stall=false}={}){
 let lookups=0,calls=0,dial;const lookup=async(host,options)=>{lookups++;assert.equal(host,'app.example');assert.equal(options.all,true);assert.equal(options.family,4);return records;};
 const request=(options,callback)=>{calls++;dial=options;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{if(stall)return;const res=new EventEmitter();res.statusCode=status;res.headers=headers;res.destroy=()=>{};callback(res);for(const chunk of chunks)res.emit('data',Buffer.from(chunk));res.emit('end');});return req;};
 const fetch=createNodeMetadataFetch({allowedOrigins:[origin],lookup,request});return {fetch,stats:()=>({lookups,calls,dial}),lookup,request};
}
test('validates every DNS answer and pins actual dial without another resolution',async()=>{
 const f=fixture();assert.equal(await (await f.fetch(origin+'/manifest',{headers:{Accept:'text/html',Authorization:'secret',Cookie:'private'}})).text(),'{}');
 const {dial,lookups}=f.stats();assert.equal(lookups,1);assert.equal(dial.servername,'app.example');assert.equal(dial.agent,false);assert.equal(dial.rejectUnauthorized,true);assert.deepEqual(dial.headers,{Host:'app.example',Accept:'text/html','Accept-Encoding':'identity'});
 dial.lookup('app.example',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
 dial.lookup('app.example',{all:true},(error,addresses)=>assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]));assert.equal(f.stats().lookups,1);
});
test('rejects mixed public/private and noncompliant IPv6 resolver answers before any dial',async()=>{
 for(const address of ['127.0.0.1','10.0.0.2','100.64.0.1','169.254.169.254','172.31.0.1','192.168.0.1','192.0.0.9','192.88.99.1','198.18.0.1','198.51.100.4','203.0.113.1','224.1.1.1','255.255.255.255','::1','::ffff:8.8.8.8','2606:4700:4700::1111']){const f=fixture({records:[{address:'8.8.8.8',family:4},{address,family:address.includes(':')?6:4}]});await assert.rejects(f.fetch(origin+'/manifest'),/globally routable/);assert.equal(f.stats().calls,0);}
});
test('rejects unregistered origins, credentials, query, fragment, port and HTTP',async()=>{
 const f=fixture();for(const url of ['https://other.example/a','http://app.example/a','https://user:pass@app.example/a',origin+'/a?secret=x',origin+'/a#secret','https://app.example:8443/a'])await assert.rejects(f.fetch(url));assert.equal(f.stats().lookups,0);
});
test('never follows redirects or accepts compression or oversized streamed bodies',async()=>{
 for(const options of [{status:302,headers:{location:'http://127.0.0.1/'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'131073'}},{chunks:['x'.repeat(65536),'x'.repeat(65537)]}]){const f=fixture(options);await assert.rejects(f.fetch(origin+'/a'));assert.equal(f.stats().calls,1);}
});
test('bounds DNS timeout, concurrency and request rate',async()=>{
 const never=new Promise(()=>{});let calls=0;const slow=createNodeMetadataFetch({allowedOrigins:[origin],lookup:()=>never,request:()=>{calls++;},timeoutMs:20,maxConcurrent:1});const first=slow(origin+'/a');await assert.rejects(slow(origin+'/b'),/budget/);await assert.rejects(first,/timed out/);assert.equal(calls,0);
 const f=fixture();const limited=createNodeMetadataFetch({allowedOrigins:[origin],lookup:f.lookup,request:f.request,maxRequestsPerMinute:1});await limited(origin+'/a');await assert.rejects(limited(origin+'/b'),/budget/);
});
test('honors abort and prevents a late DNS response starting network work',async()=>{
 let finishDNS,calls=0;const controller=new AbortController();const fetch=createNodeMetadataFetch({allowedOrigins:[origin],lookup:()=>new Promise(resolve=>{finishDNS=resolve;}),request:()=>{calls++;}});const pending=fetch(origin+'/a',{signal:controller.signal});await Promise.resolve();controller.abort();await assert.rejects(pending,/aborted/);finishDNS([{address:'8.8.8.8',family:4}]);await Promise.resolve();assert.equal(calls,0);
});

test('daily process budget persists after minute rate window and defaults reject insecure configuration',async()=>{
 let now=100000;const f=fixture();const fetch=createNodeMetadataFetch({allowedOrigins:[origin],lookup:f.lookup,request:f.request,clock:()=>now,maxRequestsPerDay:1});await fetch(origin+'/a');now+=61000;await assert.rejects(fetch(origin+'/b'),/budget/);
 for(const allowedOrigins of [[],['http://app.example'],['https://app.example:8443'],['https://app.example/path']])assert.throws(()=>createNodeMetadataFetch({allowedOrigins}));
});

test('client metadata Node egress preserves removal statuses and cache policy without following redirects',async()=>{
 const {createNodeClientMetadataFetch}=await import('../packages/federation/node-client-metadata-fetch.mjs');
 for(const status of [200,404,410]){
  const f=fixture({status,headers:{'content-type':'application/json','cache-control':'max-age=73'},chunks:['{"removed":true}']}),fetch=createNodeClientMetadataFetch({lookup:f.lookup,request:f.request});
  const response=await fetch(origin+'/client.json');assert.equal(response.status,status);assert.equal(response.headers.get('Cache-Control'),'max-age=73');assert.deepEqual(await response.json(),{removed:true});assert.equal(f.stats().calls,1);
 }
 for(const status of [301,302,307,308,500]){const f=fixture({status,headers:{location:origin+'/elsewhere'}});await assert.rejects(createNodeClientMetadataFetch({lookup:f.lookup,request:f.request})(origin+'/client.json'));assert.equal(f.stats().calls,1);}
 for(const status of [404,410])for(const headers of [{'content-encoding':'gzip'},{'content-length':'131073'}]){const f=fixture({status,headers});await assert.rejects(f.fetch(origin+'/client.json'));}
});

test('Node egress drives metadata and integration key cache expiry and definitive removal',async()=>{
 const {createNodeClientMetadataFetch}=await import('../packages/federation/node-client-metadata-fetch.mjs'),{ClientDirectory}=await import('../packages/federation/client-metadata.mjs');
 const clientId=origin+'/bindle/client.json',jwksUri=origin+'/bindle/jwks.json',pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
 const document={client_id:clientId,client_name:'Node integration',redirect_uris:[origin+'/bindle/callback'],token_endpoint_auth_method:'private_key_jwt',jwks_uri:jwksUri,grant_types:['authorization_code','refresh_token'],response_types:['code'],bindle_integration:{v:1,setup:{fragments:[{fragment:'https://schema.example/settings/v1',required:true,purpose:'Settings',fields:['value']}]}}};
 let now=100000,removal=0;const calls=[];
 const lookup=fixture().lookup,request=(options,callback)=>{calls.push(options.path);const key=options.path.endsWith('jwks.json'),f=fixture({status:key&&removal?removal:200,headers:{'content-type':'application/json','cache-control':'max-age=600'},chunks:[JSON.stringify(key?{keys:[publicJwk]}:document)]});return f.request(options,callback);};
 const directory=new ClientDirectory({enabled:true,integrations:true,clock:()=>now,fetch:createNodeClientMetadataFetch({lookup,request})});
 const client=await directory.resolve(clientId);assert.equal(client.integration.status,'valid');assert.ok((await directory.resolveKeys(client)).keys.length);const first=calls.length;
 now+=599999;await directory.resolve(clientId);await directory.resolveKeys(client);assert.equal(calls.length,first);
 now++;await directory.resolve(clientId);await directory.resolveKeys(client);assert.equal(calls.length,first+2,'both caches honor the Node max-age');
 for(const status of [404,410]){now+=600000;removal=status;assert.equal(await directory.resolveKeys(client),null,'removed keys never reuse the stale valid set');}
});
