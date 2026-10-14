import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

const TOKEN_MIME='application/vnd.bindle.contact-token+jwt';
let h,owner,object,collection,network=1;
test.before(async()=>{
 h=await createHarness();owner=await h.signup('contact_owner');
 object=h.accounts.get(h.accounts.idFromName(owner.result.account.id));
 const snapshot=await h.request('/api/account',{headers:{Cookie:owner.cookie}});assert.equal(snapshot.status,200);collection=(await snapshot.json()).collections[0].id;
});
test.after(async()=>{await h?.close();});
const ownerHeaders=()=>({Origin:h.origin,Cookie:owner.cookie,'X-CSRF-Token':owner.result.csrfToken});
async function contact(extra={}){
 const response=await h.request('/api/contacts',{method:'POST',headers:ownerHeaders(),value:{name:'Untrusted sender',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,maxMessages:10,...extra}});
 assert.equal(response.status,200,await response.clone().text());return response.json();
}
async function mint(url,headers={}){return h.mf.dispatchFetch(url,{headers:{Accept:TOKEN_MIME,'CF-Connecting-IP':`203.0.113.${network++}`,...headers}});}
function form(extra={}){const result=new FormData();for(const [k,v]of Object.entries({collection,mimeType:'text/plain',idempotencyKey:crypto.randomUUID(),subject:'<img src=x onerror=alert(1)>',tags:JSON.stringify([]),...extra}))result.append(k,v);result.append('message',new Blob(['Hello from a sender'],{type:'text/plain'}),'hello.txt');return result;}
// Miniflare/Undici can reuse a socket while workerd cancels an oversized body.
// Close only those deliberate overflow uploads; do not retry application failures.
async function send(url,body=form(),headers={}){const encoded=new Request(url,{method:'POST',body});const bytes=await encoded.arrayBuffer();return h.mf.dispatchFetch(url,{method:'POST',body:bytes,headers:{'Content-Type':encoded.headers.get('Content-Type'),'CF-Connecting-IP':`192.0.2.${network++}`,...(bytes.byteLength>1500000?{Connection:'close'}:{}),...headers}});}
const decode=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url'));

test('recovery documents exclude third-party scripts and allow only WebAssembly compilation',async()=>{
 for(const path of ['/recovery/setup','/recovery/restore','/recovery-kdf-worker.mjs']){
  const response=await h.request(path);assert.equal(response.status,200);
  const csp=response.headers.get('Content-Security-Policy');
  assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.ok(csp.includes("frame-src 'none'"));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.ok(!csp.includes('challenges.cloudflare.com'));
  assert.ok(!csp.includes("'unsafe-eval'"));
 }
});

test('actual Worker signed endpoint serves composer and stateless short-lived bearer without delivery',async()=>{
 const issued=await contact();assert.equal(new URL(issued.url).pathname,`/users/${owner.result.account.handle}/contact/${issued.id}`);assert.equal(new URL(issued.url).hash,'');
 const before=new Map(await object.rows());
 const composer=await h.mf.dispatchFetch(issued.url,{headers:{Accept:'text/html'}});assert.equal(composer.status,200);assert.match(composer.headers.get('Content-Type'),/^text\/html/);assert.equal(composer.headers.get('Referrer-Policy'),'no-referrer');assert.equal(composer.headers.get('Cache-Control'),'no-store');
 const first=await mint(issued.url,{Origin:'https://sender.example'});assert.equal(first.status,200);assert.match(first.headers.get('Content-Type'),/^application\/vnd\.bindle\.contact-token\+jwt/);const token=await first.text();assert.equal(token.split('.').length,3);
 const claims=decode(token);assert.equal(claims.iss,h.origin);assert.equal(claims.sub,owner.result.account.id);assert.equal(claims.aud,h.origin+'/api/messages');assert.equal(claims.parent,issued.id);assert(claims.exp-claims.iat<=300);
 const second=await mint(issued.url);assert.notEqual(await second.text(),token);
 const head=await h.mf.dispatchFetch(issued.url,{method:'HEAD',headers:{Accept:TOKEN_MIME,'CF-Connecting-IP':'198.51.100.11'}});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const preflight=await h.mf.dispatchFetch(issued.url,{method:'OPTIONS',headers:{Origin:'https://sender.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'),null);
 assert.deepEqual(new Map(await object.rows()),before);
 assert.equal(first.headers.get('Set-Cookie'),null);assert.equal(first.headers.get('Access-Control-Allow-Credentials'),null);assert.equal(first.headers.get('Access-Control-Allow-Origin'),'*');
 const ownerResponse=await h.request('/api/account',{headers:{Cookie:owner.cookie,Origin:'https://sender.example'}});assert.equal(ownerResponse.headers.get('Access-Control-Allow-Origin'),null);
});

test('Worker binds signed URL to path, recipient, issuer and unambiguous query',async()=>{
 const issued=await contact();const original=new URL(issued.url);
 const corrupted=new URL(original);const pieces=corrupted.searchParams.get('sig').split('.');pieces[2]='A'.repeat(86);corrupted.searchParams.set('sig',pieces.join('.'));
 for(const url of [issued.url+'&extra=1',issued.url+'&sig=duplicate',issued.url.replace('/'+owner.result.account.handle+'/','/another_owner/'),issued.url.replace(issued.id,crypto.randomUUID()),original.origin+original.pathname,corrupted.href]){
  const response=await mint(url);assert.equal(response.status,401,url);assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
 }
 assert.equal((await mint(issued.url.replace(h.origin,'https://wrong.example'))).status,403);
 const endpointAsBearer=await h.request('/api/messages',{method:'POST',headers:{Authorization:`Bearer ${original.searchParams.get('sig')}`,'CF-Connecting-IP':'198.51.100.10'},value:{collection,mimeType:'text/plain',text:'wrong token type',idempotencyKey:'wrong-type'}});assert.equal(endpointAsBearer.status,401);
});

test('Worker multipart and bare bearer share quotas and idempotency; sender metadata cannot set owner state',async()=>{
 const issued=await contact({maxMessages:2,requiredTags:['contact-source'],optionalTags:['topic']});const token=await (await mint(issued.url)).text();const idem=crypto.randomUUID();
 const forbidden=await send(issued.url,form({tags:JSON.stringify(['owner-looking-tag'])}));assert.equal(forbidden.status,400);assert.equal((await forbidden.json()).error,'forbidden_tags');
 const accepted=await send(issued.url,form({idempotencyKey:idem,tags:JSON.stringify(['topic'])}));assert.equal(accepted.status,202,await accepted.clone().text());const result=await accepted.json();
 const replay=await send(issued.url,form({idempotencyKey:idem,tags:JSON.stringify(['topic'])}));assert.equal(replay.status,202);assert.equal((await replay.json()).id,result.id);
 const bare=await h.request('/api/messages',{method:'POST',headers:{Authorization:`Bearer ${token}`,'CF-Connecting-IP':'198.51.100.1'},value:{collection,mimeType:'text/plain',text:'Bare token message',idempotencyKey:crypto.randomUUID()}});assert.equal(bare.status,202,await bare.clone().text());
 assert.equal((await send(issued.url)).status,429);
 const rows=new Map(await object.rows());const record=rows.get(`message/${owner.result.account.id}/${result.id}/`);assert.deepEqual(record.tags,['contact-source','topic']);assert.deepEqual(record.deliveryTags,['contact-source','topic']);assert.equal(record.classification,'unclassified');assert.equal(record.readAt,null);assert.deepEqual(record.senderMetadata,{subject:'<img src=x onerror=alert(1)>',tags:['topic']});assert.equal(record.bytes,undefined);assert.equal(typeof record.blobRef,'string');
 assert.equal(rows.get(`contact-grant/${issued.id}/`).messagesUsed,2);
});

test('Worker rejects malformed multipart, wrong scope, duplicate fields and bounded streaming body',async()=>{
 const issued=await contact();
 assert.equal((await send(issued.url,form({collection:crypto.randomUUID()}))).status,403);
 const duplicate=form();duplicate.append('collection',collection);assert.equal((await send(issued.url,duplicate)).status,400);
 assert.equal((await send(issued.url,form({subject:'bad\r\nsubject'}))).status,400);
 const extra=form();extra.append('read','true');assert.equal((await send(issued.url,extra)).status,400);
 const huge=form();huge.set('message',new Blob(['x'.repeat(1600000)]),'large.txt');assert.equal((await send(issued.url,huge)).status,413);
 const encoder=new TextEncoder();let remaining=20;const streamed=new ReadableStream({async pull(controller){await new Promise(resolve=>setTimeout(resolve,5));if(remaining--===20)controller.enqueue(encoder.encode('--bounded\r\nContent-Disposition: form-data; name="message"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n'));else if(remaining>=0)controller.enqueue(new Uint8Array(100000).fill(120));else{controller.enqueue(encoder.encode('\r\n--bounded--\r\n'));controller.close();}}});
 const streamedResponse=await h.mf.dispatchFetch(issued.url,{method:'POST',body:streamed,duplex:'half',headers:{'Content-Type':'multipart/form-data; boundary=bounded','CF-Connecting-IP':'198.51.100.9',Connection:'close'}});assert.equal(streamedResponse.status,413);assert.equal((await streamedResponse.json()).error,'body_too_large');
});

test('Worker live quarantine suppresses notifications and revocation rejects mint/delivery/replay',async()=>{
 const issued=await contact();const token=await (await mint(issued.url)).text();const quarantined=await h.request(`/api/contacts/${issued.id}/quarantine`,{method:'POST',headers:ownerHeaders(),value:{quarantined:true}});assert.equal(quarantined.status,200);assert.equal((await quarantined.json()).quarantined,true);
 const response=await send(issued.url);assert.equal(response.status,202);const accepted=await response.json();const rows=new Map(await object.rows());assert.equal(rows.get(`message/${owner.result.account.id}/${accepted.id}/`).quarantined,true);assert.equal(rows.has(`notification-event/${owner.result.account.id}/${accepted.id}/`),false);
 assert.equal((await h.request(`/api/contacts/${issued.id}`,{method:'DELETE',headers:ownerHeaders()})).status,200);
 assert.equal((await mint(issued.url)).status,401);assert.equal((await send(issued.url)).status,401);
 assert.equal((await h.request('/api/messages',{method:'POST',headers:{Authorization:`Bearer ${token}`,'CF-Connecting-IP':'198.51.100.2'},value:{collection,mimeType:'text/plain',text:'revoked',idempotencyKey:'revoked'}})).status,401);
});

test('Worker metadata updates do not read payload R2 objects; cold restore retains payload references',async()=>{
 const issued=await contact();const response=await send(issued.url);assert.equal(response.status,202);const {id}=await response.json();await object.blobReadCounter();
 const update=await h.request(`/api/messages/${id}`,{method:'PATCH',headers:ownerHeaders(),value:{read:true,tags:['owner']}});assert.equal(update.status,200);assert.equal(await object.readCount(),0);
 await object.evictCold();assert.equal(new Map(await object.rows()).has(`message/${owner.result.account.id}/${id}/`),false);
 // Alarm extraction reads the payload once; owner restore itself reads only metadata.
 assert.equal(await object.readCount(),1);await object.blobReadCounter();
 const restored=new Map(await object.restoreCold(owner.result.account.id));assert.equal(typeof restored.get(`message/${owner.result.account.id}/${id}/`).blobRef,'string');assert.equal(await object.readCount(),0);
 const download=await h.request(`/api/messages/${id}/download`,{headers:{Cookie:owner.cookie}});assert.equal(download.status,200);assert.equal(await download.text(),'Hello from a sender');assert.equal(await object.readCount(),1);
});

test('actual Worker device registry uniqueness and approval CAS are atomic',async()=>{
 const namespaces=await h.mf.getDurableObjectNamespace('IDENTITIES');const registry=namespaces.get(namespaces.idFromName('devices-v1'));const code='ABCD-EFGH';
 const first={id:crypto.randomUUID(),userCode:code,revision:0,expiresAt:Date.now()+60000,status:'pending'};const second={...first,id:crypto.randomUUID()};
 const results=await Promise.all([registry.createDevice(first),registry.createDevice(second)]);assert.equal(results.filter(Boolean).length,1);const winner=await registry.findDeviceByCode(code);
 const cas=await Promise.all([registry.compareAndSwapDevice(winner.id,0,{...winner,revision:1,status:'approved'}),registry.compareAndSwapDevice(winner.id,0,{...winner,revision:1,status:'denied'})]);assert.equal(cas.filter(Boolean).length,1);assert.equal(await registry.compareAndSwapDevice(winner.id,0,winner),false);
});

test('Worker expires parent authority and signing-key retirement invalidates existing minted tokens',async()=>{
 const issued=await contact();const bearer=await (await mint(issued.url)).text();const rows=new Map(await object.rows());const path=`contact-grant/${issued.id}/`,grant=rows.get(path);grant.claims.exp=Math.floor(Date.now()/1000)-1;await object.seed(owner.result.account.id,[[path,grant]]);
 assert.equal((await mint(issued.url)).status,401);assert.equal((await send(issued.url)).status,401);
 assert.equal((await h.request('/api/messages',{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'CF-Connecting-IP':'198.51.100.3'},value:{collection,mimeType:'text/plain',text:'expired',idempotencyKey:'expired'}})).status,401);
 const other=await contact();const liveToken=await (await mint(other.url)).text();const fresh=new Map(await object.rows());const keyPath=[...fresh.keys()].find(key=>key.startsWith('contact-key/'));await object.seed(owner.result.account.id,[[keyPath,{...fresh.get(keyPath),active:false}]]);
 assert.equal((await mint(other.url)).status,401);
 assert.equal((await h.request('/api/messages',{method:'POST',headers:{Authorization:`Bearer ${liveToken}`,'CF-Connecting-IP':'198.51.100.4'},value:{collection,mimeType:'text/plain',text:'retired',idempotencyKey:'retired'}})).status,401);
});
