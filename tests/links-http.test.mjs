import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';
import { authored } from './link-helpers.mjs';
import { rpcDeliveryRequest } from '../packages/messaging/contact-delivery-wire.mjs';
import { base64url,digest } from '../packages/messaging/store.mjs';

// Real Node adapter: links routing (links §2, §6–§8), authored delivery and the D10 cutover.
const origin='http://localhost:8791',INTAKE='application/vnd.bindle.contact-intake+json',DELIVERY='application/vnd.bindle.contact-token+jwt; profile="contact-delivery-v1"';
let app,directory,alice,bob;
let lane=0;const fetchURL=(url,init={})=>{const request=new Request(new URL(url,origin),init);if(!request.headers.has('CF-Connecting-IP'))request.headers.set('CF-Connecting-IP',`203.0.113.${++lane%250}`);return app.fetch(request);};
let network=1;
async function account(){
 const ip=`198.51.100.${network++}`,post=(path,value,headers={})=>fetchURL(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':ip,...headers},body:JSON.stringify(value)});
 const signup=await post('/api/auth/signup',{method:'password',password:'Private links account password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}),pending=await signup.json(),setup={Cookie:signup.headers.get('Set-Cookie').split(';')[0]};
 const recovery=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken},setup)).json();
 const activated=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true},setup);assert.equal(activated.status,200,await activated.clone().text());
 const session=await activated.json(),headers={Cookie:activated.headers.getSetCookie().find(c=>c.startsWith('bindle_session=')).split(';')[0],'X-CSRF-Token':session.csrfToken};
 const owner=(path,value,method='POST')=>fetchURL(path,{method,headers:{Origin:origin,...headers,...value===undefined?{}:{'Content-Type':'application/json'}},...value===undefined?{}:{body:JSON.stringify(value)}});
 return {session,headers,owner,id:session.account.id,handle:session.account.handle,sign:async input=>{const r=await owner('/api/links/envelope',input);assert.equal(r.status,200,await r.clone().text());return r.json();}};
}
const send=(url,message,headers={})=>fetchURL(url,{method:'POST',headers:{'Content-Type':message.contentType,...headers},body:message.bytes});
test.before(async()=>{directory=await mkdtemp(join(tmpdir(),'bindle-links-http-'));app=await createNodeServer({directory,config:{APP_ORIGIN:origin}});alice=await account();bob=await account();});
test.after(async()=>{await app?.close();if(directory)await rm(directory,{recursive:true,force:true});});

test('new-form link: owner issuance, side-effect-free intake metadata, JSON inspection and cross-account authored delivery',async()=>{
 const created=await alice.owner('/api/contact-links',{name:'Project inbox',mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,maxMessages:3,maxMessageBytes:4096,autoTags:['inbox:project'],optionalTags:['topic:bug'],labels:{'topic:bug':{en:'Bug report',es:'Error'}}});
 assert.equal(created.status,200,await created.clone().text());const link=await created.json();assert.equal(link.form,'link');assert.equal(link.conditional,false);assert.deepEqual(link.intake.autoTags,['inbox:project']);assert.match(link.url,/\?bindle_meta=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
 const controller=app.resources.accounts.get(alice.id),before=JSON.stringify([...await controller.metadata.list()]);
 const metadata=await fetchURL(link.url+'&utm_source=chat',{headers:{Accept:INTAKE,'Accept-Language':'es-MX, en;q=0.5'}});assert.equal(metadata.status,200);assert.equal(metadata.headers.get('Content-Type'),INTAKE);assert.equal(metadata.headers.get('Cache-Control'),'no-store');assert.equal(metadata.headers.get('Access-Control-Allow-Origin'),'*');
 const body=await metadata.json();assert.deepEqual(body.optionalTags,[{id:'topic:bug',label:'Error'}]);assert.equal(body.form,'link');assert.equal(body.quotaScope,'parent');assert.equal(JSON.stringify(body).includes('inbox:project'),false);
 const inspection=await (await fetchURL(link.url,{headers:{Accept:'application/json'}})).json();assert.deepEqual(inspection.kinds,['one-off']);assert.equal(inspection.conditional,false);assert.equal(Object.hasOwn(inspection,'requiredTags'),false);assert.equal(Object.hasOwn(inspection,'collections'),false);
 assert.equal(JSON.stringify([...await controller.metadata.list()]),before,'GET representations write nothing');
 const message=await authored(bob.sign,link.url,{text:'Hi Alice',subject:'Hello',optionalTags:['topic:bug']}),accepted=await send(link.url,message,{'Idempotency-Key':message.envelope.payload.operationId});
 assert.equal(accepted.status,202,await accepted.clone().text());const {receipt}=await accepted.json();assert.equal(receipt.payload.authorship,'identity');assert.equal(receipt.payload.recipient.owner,alice.id);
 const stored=await controller.messages.read(alice.id,receipt.payload.messageId);assert.deepEqual(stored.deliveryTags,['inbox:project','topic:bug']);assert.equal(stored.delivery.author.principal.subject,bob.id);
 const replay=await send(link.url,message);assert.equal(replay.status,202);assert.deepEqual((await replay.json()).receipt,receipt);
 // Intake edits apply to the next delivery without reissuing the link.
 const intake=await (await alice.owner(`/api/contacts/${link.id}/intake`,undefined,'GET')).json();
 const edited=await alice.owner(`/api/contacts/${link.id}/intake`,{revision:intake.revision,autoTags:['inbox:renamed'],optionalTags:[],labels:{}},'PUT');assert.equal(edited.status,200);
 assert.equal((await alice.owner(`/api/contacts/${link.id}/intake`,{revision:intake.revision,autoTags:[],optionalTags:[],labels:{}},'PUT')).status,409);
 assert.equal((await alice.owner(`/api/contacts/${link.id}/url`,undefined,'GET').then(r=>r.json())).url,link.url);
 const refused=await send(link.url,await authored(bob.sign,link.url,{optionalTags:['topic:bug']}));assert.equal(refused.status,400);assert.equal((await refused.json()).error,'forbidden_tags');
 const renamed=await send(link.url,await authored(bob.sign,link.url,{text:'second'}));assert.equal(renamed.status,202);assert.deepEqual((await controller.messages.read(alice.id,(await renamed.json()).receipt.payload.messageId)).deliveryTags,['inbox:renamed']);
 assert.equal((await send(link.url,await authored(bob.sign,link.url,{text:'third'}))).status,202);assert.equal((await send(link.url,await authored(bob.sign,link.url,{text:'fourth'}))).status,429);
});

test('edge routing uses the shared raw-query parser; data is refused outside the JSON inspection GET',async()=>{
 const link=await (await alice.owner('/api/contact-links',{name:'Edge',mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,maxMessages:5,maxMessageBytes:4096})).json(),meta=new URL(link.url).searchParams.get('bindle_meta'),base=link.url.split('?')[0];
 for(const url of [`${link.url}&%73ig=x`,`${link.url}&bindle_meta=${meta}`,`${link.url}&Bindle_meta=x`,`${base}?bindle_meta=${meta}%2E`,`${link.url}&bindle_x=1`])assert.equal((await fetchURL(url,{headers:{Accept:INTAKE}})).status,400,url);
 for(const url of [`${base.replace(link.id,crypto.randomUUID())}?bindle_meta=${meta}`,`${base.replace('/'+alice.handle+'/','/'+bob.handle+'/')}?bindle_meta=${meta}`]){const r=await fetchURL(url,{headers:{Accept:INTAKE}});assert.equal(r.status,401,url);assert.equal((await r.json()).error,'link_invalid');}
 const data=`${link.url}&bindle_data=a.b.c`;
 for(const [method,accept] of [['GET','text/html'],['HEAD',INTAKE],['GET',INTAKE],['GET','application/vnd.bindle.contact-profile+json'],['GET',DELIVERY]])assert.equal((await fetchURL(data,{method,headers:{Accept:accept}})).status,400,`${method} ${accept}`);
 assert.equal((await send(data,await authored(bob.sign,link.url))).status,400);
 const unconditional=await fetchURL(data,{headers:{Accept:'application/json'}});assert.equal(unconditional.status,400);assert.equal((await unconditional.json()).error,'link_malformed');
 const html=await fetchURL(link.url,{headers:{Accept:'text/html'}});assert.equal(html.status,200);assert.equal(html.headers.get('Referrer-Policy'),'no-referrer');
});

test('D10 cutover: legacy links keep GET behavior but accept only authored delivery; anonymous paths are refused clearly',async()=>{
 const account=await (await alice.owner('/api/account',undefined,'GET')).json(),collection=account.collections[0].id;
 const legacy=await (await alice.owner('/api/contacts',{name:'Old link',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,requiredTags:['legacy:auto'],optionalTags:['topic']})).json();assert.equal(legacy.form,'legacy');assert.match(legacy.url,/\?sig=/);
 const form=new FormData();form.set('collection',collection);form.set('mimeType','text/plain');form.set('idempotencyKey',crypto.randomUUID());form.set('message',new Blob(['anonymous'],{type:'text/plain'}),'m.txt');
 const anonymous=await fetchURL(legacy.url,{method:'POST',body:form});assert.equal(anonymous.status,403);const refusal=await anonymous.json();assert.equal(refusal.error,'author_required');assert.match(refusal.message,/identity-authored/);
 assert.equal((await fetchURL(legacy.url,{headers:{Accept:'application/vnd.bindle.contact-token+jwt'}})).status,406);
 const bearer=await fetchURL('/api/messages',{method:'POST',headers:{Authorization:'Bearer a.b.c','Content-Type':'application/json'},body:JSON.stringify({collection,mimeType:'text/plain',text:'x',idempotencyKey:'x'})});assert.equal(bearer.status,403);assert.equal((await bearer.json()).error,'author_required');
 const inspection=await (await fetchURL(legacy.url,{headers:{Accept:'application/json'}})).json();assert.equal(Object.hasOwn(inspection,'requiredTags'),false);assert.deepEqual(inspection.optionalTags,['topic']);assert.deepEqual(inspection.authorship,['identity']);
 const metadata=await (await fetchURL(legacy.url,{headers:{Accept:INTAKE}})).json();assert.equal(metadata.form,'legacy');assert.deepEqual(metadata.kinds,['one-off']);
 const authoredLegacy=await send(legacy.url,await authored(bob.sign,legacy.url,{optionalTags:['topic']}));assert.equal(authoredLegacy.status,202,await authoredLegacy.clone().text());
 const stored=await app.resources.accounts.get(alice.id).messages.read(alice.id,(await authoredLegacy.json()).receipt.payload.messageId);assert.deepEqual(stored.deliveryTags,['legacy:auto','topic']);
 const dual=await send(legacy.url,await authored(bob.sign,legacy.url),{Authorization:'Bearer a.b.c'});assert.equal(dual.status,400);assert.equal((await dual.json()).error,'ambiguous_credentials');
});

test('contact-delivery bearer: profile negotiation, RPC admission through the disjoint dispatcher, shared receipt namespace',async()=>{
 const link=await (await alice.owner('/api/contact-links',{name:'RPC',mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,maxMessages:5,maxMessageBytes:4096})).json();
 const minted=await fetchURL(link.url,{headers:{Accept:DELIVERY}});assert.equal(minted.status,200);assert.match(minted.headers.get('Content-Type'),/profile="contact-delivery-v1"/);const token=await minted.text(),claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
 assert.deepEqual(claims.authorship,['identity']);assert.deepEqual(claims.methods,['deliver']);assert.equal(claims.aud,origin+'/bindle/rpc');assert.equal(claims.parent,link.id);assert(claims.exp-claims.iat<=300);
 const message=await authored(bob.sign,link.url,{text:'via rpc'}),request=rpcDeliveryRequest(message.envelope,base64url(message.body));
 const rpc=await fetchURL('/bindle/rpc',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(request)});assert.equal(rpc.status,200,await rpc.clone().text());const result=await rpc.json();assert.equal(result.tx,message.envelope.payload.operationId);assert.equal(result.result.payload.authorship,'identity');
 const viaURL=await send(link.url,message);assert.equal(viaURL.status,202);assert.deepEqual((await viaURL.json()).receipt,result.result);
 const tampered=token.slice(0,-4)+(token.endsWith('AAAA')?'BBBB':'AAAA');assert.equal((await fetchURL('/bindle/rpc',{method:'POST',headers:{Authorization:'Bearer '+tampered,'Content-Type':'application/json'},body:JSON.stringify(request)})).status,401);
 await alice.owner(`/api/contacts/${link.id}`,undefined,'DELETE');assert.equal((await fetchURL('/bindle/rpc',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(rpcDeliveryRequest((await authored(bob.sign,link.url)).envelope,base64url(new TextEncoder().encode('Hello'))))})).status,401);
});

test('opener operations are owner-authenticated, CSRF-checked and same-host only; tags and default rules are routed',async()=>{
 const link=await (await alice.owner('/api/contact-links',{name:'Opener',mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,maxMessages:5,maxMessageBytes:4096})).json();
 assert.equal((await fetchURL('/api/links/envelope',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetchURL('/api/links/envelope',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:bob.headers.Cookie,'X-CSRF-Token':'wrong'},body:'{}'})).status,403);
 assert.equal((await bob.owner('/api/links/envelope',{link:'https://foreign.example/users/abc/contact/'+crypto.randomUUID()+'?bindle_meta=a.b.c',mimeType:'text/plain',byteLength:1,sha256:'A'.repeat(43),operationId:crypto.randomUUID()})).status,401);
 assert.equal((await bob.owner('/api/links/respond',{link:link.url})).status,401,'providers sign responses only for conditional links (links §9)');
 assert.equal((await bob.owner('/api/links/respond',{link:link.url+'&utm=1'})).status,401);
 const labels=await (await alice.owner('/api/tags/labels',undefined,'GET')).json();assert.deepEqual(labels,{revision:0,labels:{}});
 const named=await (await alice.owner('/api/tags/labels',{label:'Clients'},'PUT')).json();assert.match(named.id,/^t\./);
 const snapshot=await (await alice.owner('/api/account',undefined,'GET')).json();assert.equal(snapshot.tagLabels.labels[named.id],'Clients');
 const rules=snapshot.rules,target=rules.find(rule=>rule.id.startsWith('default:'));await alice.owner('/api/rules',{rules:rules.filter(rule=>rule.id!==target.id)},'PUT');
 const restored=await alice.owner(`/api/rules/${encodeURIComponent(target.id)}/restore`,{});assert.equal(restored.status,200);assert.equal((await restored.json()).id,target.id);
});

test('signing out forgets this device push subscription for that account only',async()=>{
 const carol=await account(),endpoint='https://fcm.googleapis.com/fcm/send/'+crypto.randomUUID(),subscription={endpoint,keys:{p256dh:base64url(new Uint8Array(65).fill(4)),auth:base64url(new Uint8Array(16).fill(1))}};
 for(const who of [carol,bob])assert.equal((await who.owner('/api/notifications/subscribe',{subscription,label:'This device'})).status,200);
 const id=await digest(crypto,endpoint),rows=async who=>[...await app.resources.accounts.get(who.id).metadata.list({prefix:`push-subscription/${who.id}/`})].length;
 assert.equal(await rows(carol),1);assert.equal((await carol.owner('/api/auth/logout',{pushSubscription:id})).status,200);
 assert.equal(await rows(carol),0);assert.equal(await rows(bob),1);assert.equal((await carol.owner('/api/account',undefined,'GET')).status,401);
});
