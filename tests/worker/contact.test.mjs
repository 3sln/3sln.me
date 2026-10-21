import test from 'node:test';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {CoreHeaders} from 'miniflare';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { authored } from '../link-helpers.mjs';
import { multipartDeliveryBody, rpcDeliveryRequest } from '../../packages/messaging/contact-delivery-wire.mjs';
import { base64url } from '../../packages/messaging/store.mjs';

// Actual Worker adapter: identity-authored delivery on legacy and new-form links (links §6.1, §10).
const DELIVERY='application/vnd.bindle.contact-token+jwt; profile="contact-delivery-v1"',INTAKE='application/vnd.bindle.contact-intake+json';
let h,owner,sender,object,collection,network=1;
test.before(async()=>{
 h=await createHarness();owner=await h.signup('contact_owner');await new Promise(resolve=>setTimeout(resolve,1100));sender=await h.signup('contact_sender');
 object=h.accounts.get(h.accounts.idFromName(owner.result.account.id));
 const snapshot=await h.request('/api/account',{headers:{Cookie:owner.cookie}});assert.equal(snapshot.status,200);collection=(await snapshot.json()).collections[0].id;
});
test.after(async()=>{await h?.close();});
const ownerHeaders=()=>({Origin:h.origin,Cookie:owner.cookie,'X-CSRF-Token':owner.result.csrfToken}),senderHeaders=()=>({Origin:h.origin,Cookie:sender.cookie,'X-CSRF-Token':sender.result.csrfToken});
async function contact(extra={}){
 const response=await h.request('/api/contacts',{method:'POST',headers:ownerHeaders(),value:{name:'Untrusted sender',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,maxMessages:10,...extra}});
 assert.equal(response.status,200,await response.clone().text());return response.json();
}
async function mint(url,headers={}){return h.mf.dispatchFetch(url,{headers:{Accept:DELIVERY,'CF-Connecting-IP':`203.0.113.${network++}`,...headers}});}
// The sender's own provider signs; the browser-equivalent POSTs credentialless multipart.
const sign=async input=>{const response=await h.request('/api/links/envelope',{method:'POST',headers:{...senderHeaders(),'CF-Connecting-IP':`192.0.2.${network++%250}`},value:input});assert.equal(response.status,200,await response.clone().text());return response.json();};
const message=(url,options)=>authored(sign,url,{text:'Hello from a sender',subject:'<img src=x onerror=alert(1)>',...options});
// Undici rejects a valid early 413 if a concurrent upload write gets EPIPE. Use an HTTP
// client that stops uploading on response; still require the complete status and error body.
async function oversizedUpload(url,{body,headers}){
 const runtime=await h.mf.ready,target=new URL(url),source=body instanceof ReadableStream?Readable.fromWeb(body):Readable.from([body]);
 return new Promise((resolve,reject)=>{
  let responding=false;const request=httpRequest(new URL(target.pathname+target.search,runtime),{method:'POST',agent:false,headers:{...headers,[CoreHeaders.ORIGINAL_URL]:url}},response=>{
   responding=true;source.unpipe(request);source.destroy();request.end();const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
  });
  request.on('error',error=>{if(!responding||error.code!=='EPIPE')reject(error);});source.on('error',reject);source.pipe(request);
 });
}
async function send(url,body,headers={}){body??=await message(url);const init={method:'POST',body:body.bytes,headers:{'Content-Type':body.contentType,'CF-Connecting-IP':`192.0.2.${network++%250}`,...headers}};return body.bytes.byteLength>1500000?oversizedUpload(url,init):h.mf.dispatchFetch(url,init);}

const rpc=(token,body)=>h.request('/bindle/rpc',{method:'POST',headers:{Authorization:'Bearer '+token,'CF-Connecting-IP':`198.51.100.${network++%250}`},value:rpcDeliveryRequest(body.envelope,base64url(body.body))});
const decode=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
const anonymous=()=>{const result=new FormData();for(const [k,v]of Object.entries({collection,mimeType:'text/plain',idempotencyKey:crypto.randomUUID()}))result.append(k,v);result.append('message',new Blob(['anonymous'],{type:'text/plain'}),'hello.txt');return result;};
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


test('actual Worker signed endpoint serves composer, intake metadata and a stateless delivery bearer without delivery',async()=>{
 const issued=await contact();assert.equal(new URL(issued.url).pathname,`/users/${owner.result.account.handle}/contact/${issued.id}`);assert.equal(new URL(issued.url).hash,'');
 const before=new Map(await object.rows());
 const composer=await h.mf.dispatchFetch(issued.url,{headers:{Accept:'text/html'}});assert.equal(composer.status,200);assert.match(composer.headers.get('Content-Type'),/^text\/html/);assert.equal(composer.headers.get('Referrer-Policy'),'no-referrer');assert.equal(composer.headers.get('Cache-Control'),'no-store');
 const first=await mint(issued.url,{Origin:'https://sender.example'});assert.equal(first.status,200);assert.match(first.headers.get('Content-Type'),/profile="contact-delivery-v1"/);const token=await first.text();assert.equal(token.split('.').length,3);
 const claims=decode(token);assert.equal(claims.iss,h.origin);assert.equal(claims.sub,owner.result.account.id);assert.equal(claims.aud,h.origin+'/bindle/rpc');assert.equal(claims.parent,issued.id);assert.deepEqual(claims.authorship,['identity']);assert(claims.exp-claims.iat<=300);
 const second=await mint(issued.url);assert.notEqual(await second.text(),token);
 assert.equal((await mint(issued.url,{Accept:'application/vnd.bindle.contact-token+jwt'})).status,406);
 const intake=await h.mf.dispatchFetch(issued.url,{headers:{Accept:INTAKE,'CF-Connecting-IP':'198.51.100.30'}});assert.equal(intake.status,200);assert.equal((await intake.json()).form,'legacy');
 const head=await h.mf.dispatchFetch(issued.url,{method:'HEAD',headers:{Accept:DELIVERY,'CF-Connecting-IP':'198.51.100.11'}});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const preflight=await h.mf.dispatchFetch(issued.url,{method:'OPTIONS',headers:{Origin:'https://sender.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'),null);
 assert.deepEqual(new Map(await object.rows()),before);
 assert.equal(first.headers.get('Set-Cookie'),null);assert.equal(first.headers.get('Access-Control-Allow-Credentials'),null);assert.equal(first.headers.get('Access-Control-Allow-Origin'),'*');
 const ownerResponse=await h.request('/api/account',{headers:{Cookie:owner.cookie,Origin:'https://sender.example'}});assert.equal(ownerResponse.headers.get('Access-Control-Allow-Origin'),null);
});

test('Worker binds signed URL to path, recipient, issuer and unambiguous query; raw-query edge routing',async()=>{
 const issued=await contact();const original=new URL(issued.url);
 const corrupted=new URL(original);const pieces=corrupted.searchParams.get('sig').split('.');pieces[2]='A'.repeat(86);corrupted.searchParams.set('sig',pieces.join('.'));
 for(const url of [issued.url+'&extra=1',issued.url+'&sig=duplicate',issued.url.replace('/'+owner.result.account.handle+'/','/another_owner/'),issued.url.replace(issued.id,crypto.randomUUID()),original.origin+original.pathname,corrupted.href]){
  const response=await mint(url);assert.equal(response.status,401,url);assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
 }
 assert.equal((await mint(issued.url.replace(h.origin,'https://wrong.example'))).status,403);
 assert.equal((await mint(issued.url+'&bindle_meta=a.b.c')).status,400);assert.equal((await mint(issued.url.replace('?sig=','?%73ig=')+'&bindle_meta=a.b.c')).status,400);
 const endpointAsBearer=await h.request('/api/messages',{method:'POST',headers:{Authorization:`Bearer ${original.searchParams.get('sig')}`,'CF-Connecting-IP':'198.51.100.10'},value:{collection,mimeType:'text/plain',text:'wrong token type',idempotencyKey:'wrong-type'}});assert.equal(endpointAsBearer.status,403);assert.equal((await endpointAsBearer.json()).error,'author_required');
});

test('Worker authored multipart and RPC share quotas and receipts; anonymous multipart is refused; sender metadata cannot set owner state',async()=>{
 const issued=await contact({maxMessages:2,requiredTags:['contact-source'],optionalTags:['topic']});const token=await (await mint(issued.url)).text();
 const refused=await send(issued.url,{bytes:new Uint8Array(await new Request(issued.url,{method:'POST',body:anonymous()}).arrayBuffer()),contentType:new Request(issued.url,{method:'POST',body:anonymous()}).headers.get('Content-Type')});
 const old=anonymous(),encoded=new Request(issued.url,{method:'POST',body:old}),legacy=await h.mf.dispatchFetch(issued.url,{method:'POST',body:await encoded.arrayBuffer(),headers:{'Content-Type':encoded.headers.get('Content-Type'),'CF-Connecting-IP':'198.51.100.21'}});assert.equal(legacy.status,403);assert.equal((await legacy.json()).error,'author_required');assert.equal(refused.status,403);
 const forbidden=await send(issued.url,await message(issued.url,{optionalTags:['owner-looking-tag']}));assert.equal(forbidden.status,400);assert.equal((await forbidden.json()).error,'forbidden_tags');
 const body=await message(issued.url,{optionalTags:['topic']}),accepted=await send(issued.url,body);assert.equal(accepted.status,202,await accepted.clone().text());const {receipt}=await accepted.json();
 const replay=await rpc(token,body);assert.equal(replay.status,200,await replay.clone().text());assert.deepEqual((await replay.json()).result,receipt);
 const viaRPC=await rpc(token,await message(issued.url,{text:'Bare RPC message'}));assert.equal(viaRPC.status,200,await viaRPC.clone().text());
 assert.equal((await send(issued.url)).status,429);
 const rows=new Map(await object.rows());const record=rows.get(`message/${owner.result.account.id}/${receipt.payload.messageId}/`);assert.deepEqual(record.tags,['contact-source','topic']);assert.deepEqual(record.deliveryTags,['contact-source','topic']);assert.equal(record.classification,'unclassified');assert.equal(record.readAt,null);assert.deepEqual(record.senderMetadata,{subject:'<img src=x onerror=alert(1)>',tags:['topic']});assert.equal(record.bytes,undefined);assert.equal(typeof record.blobRef,'string');assert.equal(record.delivery.author.principal.subject,sender.result.account.id);
 assert.equal(rows.get(`contact-grant/${issued.id}/`).messagesUsed,2);
});

test('Worker rejects malformed multipart, ambiguous credentials, wrong media and bounded streaming body',async()=>{
 const issued=await contact(),body=await message(issued.url);
 const text=new TextDecoder().decode(body.bytes),boundary=body.contentType.split('boundary=')[1];
 const duplicate=text.replace(`--${boundary}--`,`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\nContent-Type: text/plain\r\n\r\nagain\r\n--${boundary}--`);assert.equal((await send(issued.url,{bytes:new TextEncoder().encode(duplicate),contentType:body.contentType})).status,400);
 assert.equal((await send(issued.url,body,{Authorization:'Bearer a.b.c'})).status,400);
 assert.equal((await send(issued.url,body,{'Idempotency-Key':crypto.randomUUID()})).status,400);
 const wrongType=text.replace('Content-Type: text/plain\r\n\r\nHello','Content-Type: text/html\r\n\r\nHello');assert.equal((await send(issued.url,{bytes:new TextEncoder().encode(wrongType),contentType:body.contentType})).status,415);
 const huge={contentType:body.contentType,bytes:new Uint8Array(1600000).fill(120)},hugeResponse=await send(issued.url,huge);assert.equal(hugeResponse.status,413);assert.equal((await hugeResponse.json()).error,'too_large');
 const encoder=new TextEncoder();let remaining=20;const streamed=new ReadableStream({async pull(controller){await new Promise(resolve=>setTimeout(resolve,5));if(remaining--===20)controller.enqueue(encoder.encode('--bounded\r\nContent-Disposition: form-data; name="message"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n'));else if(remaining>=0)controller.enqueue(new Uint8Array(100000).fill(120));else{controller.enqueue(encoder.encode('\r\n--bounded--\r\n'));controller.close();}}});
 const streamedResponse=await oversizedUpload(issued.url,{method:'POST',body:streamed,duplex:'half',headers:{'Content-Type':'multipart/form-data; boundary=bounded','CF-Connecting-IP':'198.51.100.9'}});assert.equal(streamedResponse.status,413);assert.equal((await streamedResponse.json()).error,'too_large');
});

test('Worker live quarantine suppresses notifications and revocation rejects mint, delivery and RPC',async()=>{
 const issued=await contact();const token=await (await mint(issued.url)).text();const quarantined=await h.request(`/api/contacts/${issued.id}/quarantine`,{method:'POST',headers:ownerHeaders(),value:{quarantined:true}});assert.equal(quarantined.status,200);assert.equal((await quarantined.json()).quarantined,true);
 const response=await send(issued.url);assert.equal(response.status,202);const accepted=(await response.json()).receipt.payload.messageId;const rows=new Map(await object.rows());assert.equal(rows.get(`message/${owner.result.account.id}/${accepted}/`).quarantined,true);assert.equal(rows.has(`notification-event/${owner.result.account.id}/${accepted}/`),false);
 assert.equal((await h.request(`/api/contacts/${issued.id}`,{method:'DELETE',headers:ownerHeaders()})).status,200);
 assert.equal((await mint(issued.url)).status,401);assert.equal((await send(issued.url)).status,401);assert.equal((await rpc(token,await message(issued.url))).status,401);
});

test('Worker metadata updates do not read payload R2 objects; cold restore retains payload references',async()=>{
 const issued=await contact();const response=await send(issued.url);assert.equal(response.status,202);const id=(await response.json()).receipt.payload.messageId;await object.blobReadCounter();
 const update=await h.request(`/api/messages/${id}`,{method:'PATCH',headers:ownerHeaders(),value:{read:true,tags:['owner']}});assert.equal(update.status,200);assert.equal(await object.readCount(),0);
 await object.evictCold();assert.equal(new Map(await object.rows()).has(`message/${owner.result.account.id}/${id}/`),false);
 // Alarm extraction reads the payload once; owner restore itself reads only metadata.
 assert.equal(await object.readCount(),1);await object.blobReadCounter();
 const restored=new Map(await object.restoreCold(owner.result.account.id));assert.equal(typeof restored.get(`message/${owner.result.account.id}/${id}/`).blobRef,'string');assert.equal(await object.readCount(),0);
 const download=await h.request(`/api/messages/${id}/download`,{headers:{Cookie:owner.cookie}});assert.equal(download.status,200);assert.equal(await download.text(),'Hello from a sender');assert.equal(await object.readCount(),1);
});

test('actual Worker device registry uniqueness and approval CAS are atomic',async()=>{
 const namespaces=await h.mf.getDurableObjectNamespace('IDENTITIES');const registry=namespaces.get(namespaces.idFromName('devices-v1'));const code='ABCD-EFGH';
 const first={id:crypto.randomUUID(),userCodeHash:code,revision:0,expiresAt:Date.now()+60000,status:'pending'};const second={...first,id:crypto.randomUUID()};
 const results=await Promise.all([registry.createDevice(first),registry.createDevice(second)]);assert.equal(results.filter(Boolean).length,1);const winner=await registry.findDeviceByCode(code);
 const cas=await Promise.all([registry.compareAndSwapDevice(winner.id,0,{...winner,revision:1,status:'approved'}),registry.compareAndSwapDevice(winner.id,0,{...winner,revision:1,status:'denied'})]);assert.equal(cas.filter(Boolean).length,1);assert.equal(await registry.compareAndSwapDevice(winner.id,0,winner),false);
});


test('Worker new-form links: owner issuance, conditional evaluation consumed once, rotation and intake edits without reissue',async()=>{
 const created=await h.request('/api/contact-links',{method:'POST',headers:ownerHeaders(),value:{name:'Project',mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,maxMessages:5,maxMessageBytes:4096,autoTags:['inbox:project'],optionalTags:['topic:bug'],labels:{'topic:bug':{en:'Bug'}}}});assert.equal(created.status,200,await created.clone().text());const link=await created.json();
 const accepted=await send(link.url,await message(link.url,{optionalTags:['topic:bug']}));assert.equal(accepted.status,202,await accepted.clone().text());
 const intake=await (await h.request(`/api/contacts/${link.id}/intake`,{headers:ownerHeaders()})).json();assert.equal((await h.request(`/api/contacts/${link.id}/intake`,{method:'PUT',headers:ownerHeaders(),value:{revision:intake.revision,autoTags:['inbox:edited'],optionalTags:[],labels:{}}})).status,200);
 const refused=await send(link.url,await message(link.url,{optionalTags:['topic:bug']}));assert.equal(refused.status,400);const edited=await send(link.url,await message(link.url));assert.equal(edited.status,202);
 assert.deepEqual(new Map(await object.rows()).get(`message/${owner.result.account.id}/${(await edited.json()).receipt.payload.messageId}/`).deliveryTags,['inbox:edited']);
 // A conditional parent issued by the trusted system path (the developer-contact link).
 const developer=await object.developerContactLink(owner.result.account.id,owner.result.account.handle);assert.equal(developer.available,true);
 const respond=await h.request('/api/links/respond',{method:'POST',headers:senderHeaders(),value:{link:developer.url}});assert.equal(respond.status,200,await respond.clone().text());const {data}=await respond.json();
 const inspect=url=>h.mf.dispatchFetch(url,{headers:{Accept:'application/json','CF-Connecting-IP':`198.51.100.${network++%250}`}});
 const first=await (await inspect(`${developer.url}&bindle_data=${data}`)).json();assert.ok(['eligible','ineligible','unavailable'].includes(first.audience.state),JSON.stringify(first));
 assert.deepEqual((await (await inspect(`${developer.url}&bindle_data=${data}`)).json()).audience,{state:'stale'});
 assert.equal((await h.mf.dispatchFetch(`${developer.url}&bindle_data=${data}`,{headers:{Accept:'text/html'}})).status,400);
 const rotated=await h.request(`/api/contacts/${developer.grantId}/rotate`,{method:'POST',headers:ownerHeaders(),value:{}});assert.equal(rotated.status,200);const {url}=await rotated.json();assert.notEqual(url,developer.url);
 assert.equal((await inspect(developer.url)).status,401);assert.deepEqual((await (await inspect(url)).json()).audience,{state:'required'});
});

test('Worker expires parent authority and signing-key retirement invalidates existing delivery bearers',async()=>{
 const issued=await contact();const bearer=await (await mint(issued.url)).text();const pending=await message(issued.url);const rows=new Map(await object.rows());const path=`contact-grant/${issued.id}/`,grant=rows.get(path);grant.claims.exp=Math.floor(Date.now()/1000)-1;await object.seed(owner.result.account.id,[[path,grant]]);
 assert.equal((await mint(issued.url)).status,401);assert.equal((await send(issued.url,pending)).status,401);assert.equal((await rpc(bearer,pending)).status,401);
 const other=await contact();const liveToken=await (await mint(other.url)).text();const live=await message(other.url);const fresh=new Map(await object.rows());const keyPath=[...fresh.keys()].find(key=>key.startsWith('contact-key/'));await object.seed(owner.result.account.id,[[keyPath,{...fresh.get(keyPath),active:false}]]);
 assert.equal((await mint(other.url)).status,401);assert.equal((await rpc(liveToken,live)).status,401);
});
