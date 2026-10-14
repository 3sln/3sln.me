import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryMessagingStore,ContactTokenService,ContactEndpointService,MessagingService,signContactToken} from '../packages/messaging/index.mjs';
import {contactTagPolicy,contactDeliveryTags} from '../packages/messaging/tag-policy.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://space.example';
async function fixture(){
 const store=new MemoryMessagingStore(),tokens=new ContactTokenService({store,issuer:origin});const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);await tokens.registerKey(owner,{kid:'one',alg:'ES256',publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey)});const endpoints=new ContactEndpointService({tokens,signer:()=>pair.privateKey}),messages=new MessagingService({store,tokens:endpoints});const collection=await messages.createCollection(owner,'All messages'),priority=await messages.createCollection(owner,'Legacy priority destination');
 const issue=(policy={requiredTags:['priority:paid'],optionalTags:['bug','feature']})=>endpoints.create(owner,{kid:'one',handle:'n.abc',collections:[collection.id],mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,...policy});
 return {store,tokens,endpoints,messages,collection,priority,pair,issue};
}
test('tag policies are bounded, disjoint, copied, and legacy annotations remain unendorsed',()=>{
 const source={requiredTags:['priority:paid'],optionalTags:['bug']},policy=contactTagPolicy(source);source.requiredTags.push('later');assert.deepEqual(policy.requiredTags,['priority:paid']);assert.deepEqual(contactDeliveryTags(policy,['bug']),['priority:paid','bug']);assert.deepEqual(contactDeliveryTags({},['priority:ultra']),[]);
 for(const value of [{requiredTags:['a','a']},{requiredTags:['a'],optionalTags:['a']},{optionalTags:['x'.repeat(65)]},{requiredTags:Array.from({length:33},(_,i)=>String(i))}])assert.throws(()=>contactTagPolicy(value),{code:'invalid_contact_tags'});
 assert.throws(()=>contactDeliveryTags(policy,['priority:ultra']),{code:'forbidden_tags'});
});
test('required and selected optional tags are inherited by minted tokens and applied before rules without cascades',async()=>{
 const f=await fixture(),link=await f.issue(),minted=await f.endpoints.mint(link.url),claims=(await f.endpoints.verify(minted.token)).claims;assert.deepEqual(claims.requiredTags,['priority:paid']);assert.deepEqual(claims.optionalTags,['bug','feature']);
 await f.messages.setRules(owner,[{id:'paid',enabled:true,match:{tagsAll:['priority:paid','bug']},actions:{collection:f.priority.id,tags:['reviewed']}},{id:'no-cascade',enabled:true,match:{tagsAll:['reviewed']},actions:{classification:'spam'}}]);
 const request={collection:f.collection.id,mimeType:'text/plain',bytes:new TextEncoder().encode('Report'),idempotencyKey:'same',senderMetadata:{subject:'Bug',tags:['bug']}},result=await f.messages.receive(minted.token,request),message=await f.messages.read(owner,result.id);
 assert.deepEqual(message.deliveryTags,['priority:paid','bug']);assert.deepEqual(message.tags,['reviewed']);assert.equal(message.classification,'unclassified');assert.equal(message.collection,f.priority.id);assert.deepEqual(await f.messages.receive(minted.token,request),result);
 await assert.rejects(f.messages.receive(minted.token,{...request,senderMetadata:{tags:['feature']}}),{code:'idempotency_conflict'});
 await assert.rejects(f.messages.receive(minted.token,{...request,idempotencyKey:'outside',senderMetadata:{tags:['priority:ultra']}}),{code:'forbidden_tags'});
 await assert.rejects(f.messages.receive(minted.token,{...request,idempotencyKey:'wrong-scope',collection:f.priority.id}),{code:'forbidden'});
});
test('tag policy cannot be removed or expanded from a child token, even if signed with the fixture key',async()=>{
 const f=await fixture(),link=await f.issue(),minted=await f.endpoints.mint(link.url),verified=await f.endpoints.verify(minted.token);
 for(const policy of [{requiredTags:[]},{optionalTags:['priority:ultra']},{requiredTags:undefined,optionalTags:undefined}]){const claims={...verified.claims,...policy};if(claims.requiredTags===undefined)delete claims.requiredTags;if(claims.optionalTags===undefined)delete claims.optionalTags;await assert.rejects(f.endpoints.verify(await signContactToken({header:verified.header,claims,privateKey:f.pair.privateKey})),{code:'unauthorized'});}
});
test('new links with empty optional policy reject arbitrary sender tags, but always apply mandatory tags',async()=>{
 const f=await fixture(),link=await f.issue({requiredTags:['contact:developer'],optionalTags:[]}),minted=await f.endpoints.mint(link.url),request={collection:f.collection.id,mimeType:'text/plain',bytes:new TextEncoder().encode('Hello'),idempotencyKey:'mandatory'};
 const result=await f.messages.receive(minted.token,request);assert.deepEqual((await f.messages.read(owner,result.id)).tags,['contact:developer']);await assert.rejects(f.messages.receive(minted.token,{...request,idempotencyKey:'bad',senderMetadata:{tags:['work']}}),{code:'forbidden_tags'});
 for(const match of [{tagsAll:[]},{tagsAll:['a','a']},{tagsAll:'a'}])await assert.rejects(f.messages.setRules(owner,[{id:'invalid',enabled:true,match,actions:{classification:'work'}}]),{code:'invalid_rules'});
});
test('actual portable account rejects disallowed tags before writing blobs or charging receipt admission',async t=>{
 const metadata=new SqliteMetadata(':memory:');t.after(()=>metadata.close());let writes=0;const blobs={put:async()=>{writes++;},get:async()=>null,delete:async()=>{}},controller=new AccountController({metadata,gate:new SerialGate(),blobs,archives:blobs,config:{APP_ORIGIN:origin,KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),WORK_LIMITS_ENABLED:'false',STORAGE_WRITE_ENABLED:'false'}});
 await controller.warm(owner);const collection=(await controller.collections(owner))[0],link=await controller.createContact(owner,'n.abc',{name:'Tag scope',collections:[collection.id],mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,requiredTags:['priority:paid'],optionalTags:['bug']}),minted=await controller.mintContact(owner,link.url);
 await assert.rejects(controller.receive(owner,minted.token,{collection:collection.id,mimeType:'text/plain',bytes:[72,105],idempotencyKey:'bad',senderMetadata:{tags:['priority:ultra']}}),{code:'forbidden_tags'});assert.equal(writes,0);assert.equal(await metadata.get('message-receipt-budget/v1'),undefined);
});
