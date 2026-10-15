import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MemoryMessagingStore} from '../packages/messaging/index.mjs';
import {fail,key,canonical,digest,base64url} from '../packages/messaging/store.mjs';
import {strictJSON,validateEnvelope,payloadDigest,signingInput,verifyProof,verifyAuthor,localAuthorResolver,localIdentityDescriptor,createAuthoredEnvelope,semanticEnvelope,DELIVERY_DOMAIN,GENESIS_DOMAIN,ADMISSION_DOMAIN,CONVERSATION_V2_CONTRACT} from '../packages/messaging/contact-delivery.mjs';
import {parseMultipartDelivery,parseRPCDelivery,multipartDeliveryBody,rpcDeliveryRequest} from '../packages/messaging/contact-delivery-wire.mjs';
import {ContactDeliveryService,CONTACT_DELIVERY_STATUS} from '../packages/messaging/contact-delivery-service.mjs';

const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const vector=JSON.parse(read('../docs/architecture/artefacts/contact-delivery-v1.vectors.json'));
const issuer='https://3sln.example',owner='22222222-2222-4222-8222-222222222222',sender='44444444-4444-4444-8444-444444444444',grantId='33333333-3333-4333-8333-333333333333',resource=`${issuer}/entities/${owner}/contacts/${grantId}`;
const recipient={issuer,owner,contactId:grantId,resource},enc=new TextEncoder(),ES={name:'ECDSA',hash:'SHA-256'};
const pair=()=>crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const jwk=async k=>{const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',k.publicKey);return {kty,crv,x,y};};
const sign=async(domain,signed,privateKey)=>({...signed,proof:{...signed.proof,signature:base64url(new Uint8Array(await crypto.subtle.sign(ES,privateKey,signingInput(domain,signed))))}});
const resign=(envelope,privateKey)=>sign(DELIVERY_DOMAIN,{payload:envelope.payload,proof:{alg:'ES256',kid:envelope.payload.author.keyId}},privateKey);

async function fixture({kinds=['one-off'],intakeTags={autoTags:['contact:developer'],optionalTags:['bug','feature']},maxMessages=10,conditional}={}){
 const store=new MemoryMessagingStore(),senderKey=await pair(),admission=await pair(),kid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',keys=new Map([[sender+kid,{alg:'ES256',publicJwk:await jwk(senderKey),active:true,purpose:'signing',accountActive:true}]]);
 const author=localIdentityDescriptor(issuer,sender,kid),state={revision:1,...intakeTags},collection='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 await store.transaction(async tx=>{await tx.set(key('collection',owner,collection),{id:collection,owner,active:true});await tx.set(key('contact-grant',grantId),{id:grantId,owner,active:true,messagesUsed:0,bytesUsed:0,claims:{collections:[collection],mimeTypes:['text/plain','text/html'],maxMessages,maxBytes:65536,maxMessageBytes:16384},delivery:{resource,kinds,collection,...conditional?{conditional:true}:{}}});});
 const calls=[],hooks={},parents={verify:async credential=>{calls.push('verify');if(credential!==grantId)fail('unauthorized');return {parent:credential};},live:async(tx,verified)=>{calls.push('live');await hooks.live?.();const grant=await tx.get(key('contact-grant',verified.parent));if(!grant?.active)fail('unauthorized');return grant;}};
 const service=new ContactDeliveryService({store,issuer,parents,intake:async id=>{if(hooks.intake)return hooks.intake();return id===grantId?structuredClone(state):null;},resolve:localAuthorResolver({issuer,lookup:async(subject,id)=>{calls.push('resolve');return structuredClone(keys.get(subject+id));}}),admissionKey:async()=>({kid:'provider-1',privateKey:admission.privateKey})});
 const envelope=(over={})=>createAuthoredEnvelope({author,privateKey:senderKey.privateKey,recipient,mimeType:'text/plain',body:enc.encode('Hello'),subject:'Hello',optionalTags:['feature','bug'],...over});
 return {store,service,senderKey,admission,author,keys,kid,state,envelope,calls,hooks};
}

test('fixed vector: implementation reproduces canonical bytes, digests and both ES256 proofs; other domains fail',async()=>{
 const envelope=await validateEnvelope(strictJSON(JSON.stringify(vector.envelope)));
 assert.equal(canonical({alg:'ES256',kid:envelope.proof.kid,payload:envelope.payload}),vector.signedCanonical);
 assert.equal(await digest(crypto,signingInput(DELIVERY_DOMAIN,envelope)),vector.signedBytesSha256);
 assert.equal(canonical(semanticEnvelope(envelope)),vector.semanticCanonical);
 assert.equal(await payloadDigest(envelope),vector.payloadDigest);
 const record={alg:'ES256',publicJwk:vector.publicJwk};
 assert.equal(await verifyProof(DELIVERY_DOMAIN,envelope,record),true);
 const other=structuredClone(envelope);other.proof.signature=vector.resignedSignature;
 assert.equal(await verifyProof(DELIVERY_DOMAIN,other,record),true);assert.equal(await payloadDigest(other),vector.payloadDigest);
 for(const domain of [GENESIS_DOMAIN,ADMISSION_DOMAIN,''])assert.equal(await verifyProof(domain,envelope,record),false);
 for(const mutate of [p=>p.subject+='!',p=>p.recipient.resource+='x',p=>p.createdAt++,p=>p.author.identityDocument+='x']){const changed=structuredClone(envelope);mutate(changed.payload);assert.equal(await verifyProof(DELIVERY_DOMAIN,changed,record),false);}
 // The vector author is foreign to every host except sender.example: refused without lookup.
 let looked=false;await assert.rejects(verifyAuthor(envelope,{issuer:'https://recipient.example',resolve:()=>{looked=true;}}),{code:'author_unverifiable'});assert.equal(looked,false);
});

test('published RPC example parses strictly and is identity-authored',async()=>{
 const md=read('../docs/spec/contact-delivery.md'),raw=md.match(/```json\n([\s\S]*?)\n```/)[1];
 const parsed=await parseRPCDelivery(enc.encode(raw));assert.equal(new TextDecoder().decode(parsed.body),'Hello');assert.ok(parsed.envelope.payload.author);
});

test('strict JSON rejects duplicates, unsafe numbers, lone surrogates and prototype tricks',()=>{
 for(const j of ['{"a":1,"a":2}','{"a":{"b":1,"b":1}}','{"a":1.5}','{"a":1e3}','{"a":-1}','{"a":9007199254740992}','{"a":"\\ud800"}','{"a":01}','[1,]','{"a":1} x','{"a":NaN}'])assert.throws(()=>strictJSON(j),{code:'invalid_envelope'},j);
 assert.equal(Object.getPrototypeOf(strictJSON('{"__proto__":{"x":1}}')),Object.prototype);
 assert.throws(()=>strictJSON('['.repeat(40)+']'.repeat(40)),{code:'invalid_envelope'});
});

test('envelope shape: authorship required, kind/noReply pairing, sorted tags, kid binding',async()=>{
 const f=await fixture(),{envelope}=await f.envelope();assert.deepEqual(envelope.payload.optionalTags,['bug','feature']);
 const bad=async(mutate,code='invalid_envelope')=>{const e=structuredClone(envelope);mutate(e);await assert.rejects(validateEnvelope(e),{code});};
 await bad(e=>{e.payload.author=null;delete e.proof;},'author_required');await bad(e=>{delete e.payload.author;},'author_required');await bad(e=>{delete e.proof;},'author_required');
 await bad(e=>{e.payload.noReply=false;});await bad(e=>{e.payload.kind='conversation-init';});await bad(e=>{e.payload.conversation={};});
 await bad(e=>{e.payload.optionalTags=['feature','bug'];});await bad(e=>{e.payload.optionalTags=['bug','bug'];});await bad(e=>{e.payload.optionalTags=['  '];});
 await bad(e=>{e.proof.kid='other';});await bad(e=>{e.payload.extra=1;});await bad(e=>{e.payload.recipient.issuer+='/';});await bad(e=>{e.payload.subject='a\nb';});await bad(e=>{e.payload.operationId=e.payload.operationId.toUpperCase();});
 await bad(e=>{e.proof.signature=e.proof.signature.slice(0,85)+'B';});
 await assert.rejects(createAuthoredEnvelope({author:f.author,privateKey:f.senderKey.privateKey,recipient,mimeType:'text/plain',body:enc.encode('x'),kind:'conversation-init'}),{code:'kind_unsupported'});
});

test('service admits an authored one-off with intake tags and a provider-signed receipt; RPC and multipart share replay',async()=>{
 const f=await fixture(),{envelope,body}=await f.envelope(),form=multipartDeliveryBody(envelope,body);
 const parsed=await parseMultipartDelivery(form.contentType,form.bytes),first=await f.service.deliver(grantId,{...parsed,idempotencyKey:envelope.payload.operationId});
 assert.equal(first.replayed,false);const r=first.receipt;
 assert.deepEqual(Object.keys(r.payload).sort(),['authorship','bodyDigest','issuer','kind','messageId','noReply','operationId','payloadDigest','purpose','receivedAt','recipient','state','version']);
 assert.equal(r.payload.authorship,'identity');assert.equal(r.payload.payloadDigest,await payloadDigest(envelope));
 const provider={alg:'ES256',publicJwk:await jwk(f.admission)};assert.equal(await verifyProof(ADMISSION_DOMAIN,r,provider),true);assert.equal(await verifyProof(DELIVERY_DOMAIN,r,provider),false);
 const message=await f.store.transaction(tx=>tx.get(key('message',owner,r.payload.messageId)));
 assert.deepEqual(message.deliveryTags,['contact:developer','bug','feature']);assert.equal(message.delivery.intakeRevision,1);assert.deepEqual(message.delivery.author,f.author);assert.equal(new TextDecoder().decode(message.bytes),'Hello');
 // Same operation over RPC, re-signed (new ECDSA bytes), after an intake edit: replays the receipt.
 f.state.revision=2;const again=await resign(envelope,f.senderKey.privateKey);assert.notEqual(again.proof.signature,envelope.proof.signature);
 const rpc=await parseRPCDelivery(enc.encode(JSON.stringify(rpcDeliveryRequest(again,base64url(body)))));
 assert.deepEqual(await f.service.deliver(grantId,rpc),{receipt:r,replayed:true});
 const grant=await f.store.transaction(tx=>tx.get(key('contact-grant',grantId)));assert.equal(grant.messagesUsed,1);
 // Standard FormData encoding (filename="blob") is accepted.
 const fd=new FormData();fd.append('envelope',new Blob([JSON.stringify(envelope)],{type:'application/json'}));fd.append('message',new Blob([body],{type:'text/plain'}));const request=new Request('https://3sln.example/x',{method:'POST',body:fd});
 assert.equal((await parseMultipartDelivery(request.headers.get('content-type'),new Uint8Array(await request.arrayBuffer()))).envelope.payload.operationId,envelope.payload.operationId);
});

test('duplicate operation IDs with different payloads conflict; idempotency header must match',async()=>{
 const f=await fixture(),{envelope,body}=await f.envelope();await f.service.deliver(grantId,{envelope,body});
 const changed=await f.envelope({operationId:envelope.payload.operationId,createdAt:envelope.payload.createdAt,subject:'Different'});
 await assert.rejects(f.service.deliver(grantId,changed),{code:'operation_conflict'});
 const later=await f.envelope({operationId:envelope.payload.operationId,createdAt:envelope.payload.createdAt+1});await assert.rejects(f.service.deliver(grantId,later),{code:'operation_conflict'});
 const other=await f.envelope();await assert.rejects(f.service.deliver(grantId,{...other,idempotencyKey:envelope.payload.operationId}),{code:'idempotency_mismatch'});
 assert.equal(CONTACT_DELIVERY_STATUS.operation_conflict,409);
});

test('author verification: foreign, unknown, revoked, wrong key and descriptor substitution are refused',async()=>{
 const f=await fixture(),{envelope,body}=await f.envelope();
 const foreign=structuredClone(envelope);foreign.payload.author=localIdentityDescriptor('https://elsewhere.example',sender,f.kid);foreign.proof.kid=foreign.payload.author.keyId;
 await assert.rejects(f.service.deliver(grantId,{envelope:await resign(foreign,f.senderKey.privateKey),body}),{code:'author_unverifiable'});
 const stranger=await pair(),forged=await resign(envelope,stranger.privateKey);await assert.rejects(f.service.deliver(grantId,{envelope:forged,body}),{code:'author_unverifiable'});
 const doc=structuredClone(envelope);doc.payload.author.identityDocument=`${issuer}/somewhere-else.json`;await assert.rejects(f.service.deliver(grantId,{envelope:await resign(doc,f.senderKey.privateKey),body}),{code:'author_unverifiable'});
 const unknown=structuredClone(envelope);unknown.payload.author=localIdentityDescriptor(issuer,'55555555-5555-4555-8555-555555555555',f.kid);unknown.proof.kid=unknown.payload.author.keyId;await assert.rejects(f.service.deliver(grantId,{envelope:await resign(unknown,f.senderKey.privateKey),body}),{code:'author_unverifiable'});
 const tampered=structuredClone(envelope);tampered.payload.subject='Changed';await assert.rejects(f.service.deliver(grantId,{envelope:tampered,body}),{code:'author_unverifiable'});
 await f.service.deliver(grantId,{envelope,body});f.keys.get(sender+f.kid).active=false;
 // Revocation is rechecked before private receipt replay.
 await assert.rejects(f.service.deliver(grantId,{envelope,body}),{code:'author_unverifiable'});
});

test('scope: recipient binding, kind, MIME, tags, size, time window, quotas and live parent',async()=>{
 const f=await fixture({maxMessages:1}),{envelope,body}=await f.envelope();
 const swap=async(mutate,code)=>{const e=structuredClone(envelope);mutate(e.payload);await assert.rejects(f.service.deliver(grantId,{envelope:await resign(e,f.senderKey.privateKey),body}),{code});};
 await swap(p=>p.recipient.contactId='55555555-5555-4555-8555-555555555555','recipient_mismatch');await swap(p=>p.recipient.resource+='/x','recipient_mismatch');await swap(p=>p.recipient.owner=sender,'recipient_mismatch');
 await assert.rejects(f.service.deliver(grantId,await f.envelope({optionalTags:['priority:paid']})),{code:'forbidden_tags'});
 await assert.rejects(f.service.deliver(grantId,await f.envelope({mimeType:'application/pdf'})),{code:'unsupported_media'});
 await assert.rejects(f.service.deliver(grantId,await f.envelope({body:new Uint8Array(16385)})),{code:'too_large'});
 await assert.rejects(f.service.deliver(grantId,await f.envelope({createdAt:Date.now()-86400001})),{code:'operation_expired'});
 await assert.rejects(f.service.deliver(grantId,await f.envelope({createdAt:Date.now()+61000})),{code:'operation_expired'});
 await assert.rejects(f.service.deliver(grantId,await f.envelope({body:new Uint8Array([0xff])})),{code:'invalid_utf8'});
 await assert.rejects(f.service.deliver(grantId,{envelope,body:enc.encode('Hellx')}),{code:'body_mismatch'});
 await assert.rejects(f.service.deliver('unknown',{envelope,body}),{code:'unauthorized'});
 await f.service.deliver(grantId,{envelope,body});await assert.rejects(f.service.deliver(grantId,await f.envelope()),{code:'quota_exceeded'});
});

test('multipart framing: exact two parts, no duplicates/extras/encodings, bounded sizes',async()=>{
 const f=await fixture(),{envelope,body}=await f.envelope(),json=JSON.stringify(envelope),b='XyZ';
 const part=(name,type,content,extra='')=>`--${b}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n${type?`Content-Type: ${type}\r\n`:''}${extra.startsWith('\r\n')?'':''}\r\n${content}\r\n`;
 const frame=(...parts)=>enc.encode(parts.join('')+`--${b}--\r\n`),ct=`multipart/form-data; boundary=${b}`;
 const ok=frame(part('envelope','application/json',json),part('message','text/plain','Hello'));assert.ok(await parseMultipartDelivery(ct,ok));
 const reject=async(bytes,code='invalid_multipart',type=ct)=>assert.rejects(parseMultipartDelivery(type,bytes),{code});
 await reject(frame(part('envelope','application/json',json),part('message','text/plain','Hello'),part('message','text/plain','Hello')));
 await reject(frame(part('envelope','application/json',json),part('envelope','application/json',json),part('message','text/plain','Hello')));
 await reject(frame(part('envelope','application/json',json),part('message','text/plain','Hello'),part('subject','text/plain','x')));
 await reject(frame(part('envelope','application/json',json)));
 await reject(frame(part('envelope','application/json',json),part('collection','text/plain','x')));
 await reject(frame(part('envelope','text/plain',json),part('message','text/plain','Hello')));
 await reject(frame(part('envelope','application/json',json,'; name="message"'),part('message','text/plain','Hello')));
 await reject(enc.encode(`--${b}\r\nContent-Disposition: form-data; name="envelope"\r\nContent-Type: application/json\r\nContent-Transfer-Encoding: base64\r\n\r\n${json}\r\n`+part('message','text/plain','Hello')+`--${b}--\r\n`));
 await reject(enc.encode('preamble\r\n'+new TextDecoder().decode(ok)));await reject(enc.encode(new TextDecoder().decode(ok)+'epilogue'));await reject(ok.slice(0,-4));
 await reject(ok,'invalid_multipart',`${ct}; boundary=other`);await reject(ok,'invalid_multipart','multipart/mixed; boundary=XyZ');
 await reject(frame(part('envelope','application/json',json),part('message','text/html','Hello')),'unsupported_media');
 await reject(frame(part('envelope','application/json',json.replace('"version":1','"version":1,"version":1')),part('message','text/plain','Hello')),'invalid_envelope');
 await reject(frame(part('envelope','application/json',json+' '.repeat(65536)),part('message','text/plain','Hello')),'too_large');
 await reject(frame(part('envelope','application/json',json),part('message','text/plain','x'.repeat(1048577))),'too_large');
 await reject(new Uint8Array(1500001),'too_large');
});

test('RPC framing: exact members, tx/resource binding, canonical base64url body',async()=>{
 const f=await fixture(),{envelope,body}=await f.envelope(),base=rpcDeliveryRequest(envelope,base64url(body));
 const reject=(value,code='invalid_envelope')=>assert.rejects(parseRPCDelivery(enc.encode(typeof value==='string'?value:JSON.stringify(value))),{code});
 await reject({...base,tx:'11111111-1111-4111-8111-111111111111'});await reject({...base,resource:base.resource+'x'});await reject({...base,method:'receive'});await reject({...base,extra:1});
 await reject({...base,args:{...base.args,collection:'x'}});await reject({...base,args:{...base.args,bodyBase64url:base64url(body)+'='}});await reject({...base,args:{...base.args,bodyBase64url:'SGVsbG9'}});
 await reject({...base,args:{...base.args,bodyBase64url:'SGVsbG8x'}},'body_mismatch');
 await reject(JSON.stringify(base).replace('"version":"0"','"version":"0","version":"0"'));
});

test('conversation-init: bootstrap bindings validated and signed, then refused until conversation v2 runtime exists',async()=>{
 const f=await fixture({kinds:['one-off','conversation-init']}),body=enc.encode('Hi'),secret=crypto.getRandomValues(new Uint8Array(32)),createdAt=Date.now();
 const content={mimeType:'text/plain',byteLength:2,sha256:await digest(crypto,body)},peer=localIdentityDescriptor(issuer,owner,'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),creatorResource=`${issuer}/entities/${sender}/conversations/x`;
 const genesis=await sign(GENESIS_DOMAIN,{payload:{version:2,contract:CONVERSATION_V2_CONTRACT,conversationId:'66666666-6666-4666-8666-666666666666',createdAt,creator:f.author,creatorResource,participants:[{identity:f.author,resource:creatorResource},{identity:peer,resource:`${issuer}/entities/${owner}/conversations/x`}],secretEpoch:'77777777-7777-4777-8777-777777777777',secretDigest:await digest(crypto,secret),initialContent:content,initialSubject:'Hi'},proof:{alg:'ES256',kid:f.author.keyId}},f.senderKey.privateKey);
 const conversation={genesis,sharedSecret:base64url(secret),returnControl:{resource:creatorResource+'/respond',recipient:peer.principal,genesisDigest:await digest(crypto,canonical(semanticEnvelope(genesis))),nonce:'88888888-8888-4888-8888-888888888888',expiresAt:createdAt+86400000,method:'respondInvitation',maxBytes:8192,capability:'cap'}};
 const payload={version:1,kind:'conversation-init',noReply:false,operationId:crypto.randomUUID(),createdAt,recipient,content,subject:'Hi',optionalTags:[],author:f.author,conversation};
 const envelope=await sign(DELIVERY_DOMAIN,{payload,proof:{alg:'ES256',kid:f.author.keyId}},f.senderKey.privateKey);
 await validateEnvelope(structuredClone(envelope));
 await assert.rejects(f.service.deliver(grantId,{envelope,body}),{code:'kind_unsupported'});
 for(const mutate of [c=>c.returnControl.expiresAt=createdAt+8*86400000,c=>c.sharedSecret=base64url(new Uint8Array(32)),c=>c.returnControl.genesisDigest='A'.repeat(43),c=>c.genesis.payload.participants.pop(),c=>c.genesis.payload.initialSubject='Other',c=>c.returnControl.recipient=f.author.principal,c=>c.genesis.payload.participants.push(structuredClone(c.genesis.payload.participants[1]))]){const e=structuredClone(envelope);mutate(e.payload.conversation);await assert.rejects(validateEnvelope(e),{code:'invalid_envelope'});}
 // A genesis re-signed under the outer delivery domain is not a genesis proof.
 const crossed=structuredClone(envelope);crossed.payload.conversation.genesis=await sign(DELIVERY_DOMAIN,{payload:genesis.payload,proof:genesis.proof},f.senderKey.privateKey);crossed.payload.conversation.returnControl.genesisDigest=await digest(crypto,canonical(semanticEnvelope(crossed.payload.conversation.genesis)));
 await assert.rejects(f.service.deliver(grantId,{envelope:await resign(crossed,f.senderKey.privateKey),body}),{code:'author_unverifiable'});
});

test('review fixes: credential first, revocation fence, account status, conditional parents, tag cap, rules, controls, BOM, nested re-signature',async()=>{
 const f=await fixture(),{envelope,body}=await f.envelope();
 // Unauthenticated callers get a uniform 401 before hashing or identity lookup, even with a forged author.
 const forged=await resign(envelope,(await pair()).privateKey);f.calls.length=0;
 for(const e of [envelope,forged])await assert.rejects(f.service.deliver('nope',{envelope:e,body}),{code:'unauthorized'});assert.deepEqual(f.calls,['verify','verify']);
 // Revoked between verification and commit: refused inside the transaction.
 f.hooks.live=()=>{f.keys.get(sender+f.kid).active=false;};await assert.rejects(f.service.deliver(grantId,{envelope,body}),{code:'author_unverifiable'});
 f.hooks.live=null;f.keys.get(sender+f.kid).active=true;f.keys.get(sender+f.kid).accountActive=false;await assert.rejects(f.service.deliver(grantId,{envelope,body}),{code:'author_unverifiable'});
 f.keys.get(sender+f.kid).accountActive=true;f.keys.get(sender+f.kid).purpose='encryption';await assert.rejects(f.service.deliver(grantId,{envelope,body}),{code:'author_unverifiable'});f.keys.get(sender+f.kid).purpose='signing';
 f.hooks.intake=()=>{throw new Error('down');};await assert.rejects(f.service.deliver(grantId,{envelope,body}),{code:'admission_unavailable'});f.hooks.intake=null;
 // Owner rules use the shared tag model: addTags adds, intake auto tags keep provenance.
 await f.store.transaction(tx=>tx.set(key('rules',owner),[{id:'r1',enabled:true,match:{tagsAll:['contact:developer']},actions:{addTags:['important']}}]));
 const {receipt}=await f.service.deliver(grantId,{envelope,body}),message=await f.store.transaction(tx=>tx.get(key('message',owner,receipt.payload.messageId)));
 assert.ok(message.tags.includes('important')&&message.tags.includes('contact:developer'));assert.equal(message.tagProvenance['contact:developer'].source,'intake');assert.equal(message.tagProvenance['contact:developer'].intakeRevision,1);assert.equal(message.addTags,undefined);
 const c=await fixture({conditional:true});await assert.rejects(c.service.deliver(grantId,await c.envelope()),{code:'audience_unavailable'});
 const many=Array.from({length:32},(_,i)=>'auto'+i),t=await fixture({intakeTags:{autoTags:many,optionalTags:['bug']}});await assert.rejects(t.service.deliver(grantId,await t.envelope({optionalTags:['bug']})),{code:'forbidden_tags'});
 for(const subject of ['a‮b','a\u0085b','a b'])await assert.rejects(f.envelope({subject}),{code:'invalid_envelope'});
 const nullProof=structuredClone(envelope);nullProof.proof=null;await assert.rejects(validateEnvelope(nullProof),{code:'author_required'});
 assert.throws(()=>strictJSON(new Uint8Array([0xef,0xbb,0xbf,0x7b,0x7d])),{code:'invalid_envelope'});
 // Re-signing a nested genesis does not change operation identity.
 const g={payload:{x:1},proof:{alg:'ES256',kid:'k',signature:'A'.repeat(86)}},a={payload:{conversation:{genesis:g}},proof:{alg:'ES256',kid:'k',signature:'A'.repeat(86)}},b=structuredClone(a);b.payload.conversation.genesis.proof.signature='Q'.repeat(86);
 assert.equal(await payloadDigest(a),await payloadDigest(b));
});

test('replay namespace includes the author principal: another author cannot squat or probe an operation ID',async()=>{
 const f=await fixture(),other=await pair(),otherSubject='99999999-9999-4999-8999-999999999999',otherKid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 f.keys.set(otherSubject+otherKid,{alg:'ES256',publicJwk:await jwk(other),active:true,purpose:'signing',accountActive:true});
 const victim=await f.envelope(),squat=await createAuthoredEnvelope({author:localIdentityDescriptor(issuer,otherSubject,otherKid),privateKey:other.privateKey,recipient,mimeType:'text/plain',body:enc.encode('Squat'),operationId:victim.envelope.payload.operationId});
 const first=await f.service.deliver(grantId,squat),second=await f.service.deliver(grantId,victim);
 assert.equal(first.replayed,false);assert.equal(second.replayed,false);assert.notEqual(first.receipt.payload.messageId,second.receipt.payload.messageId);
 assert.deepEqual(await f.service.deliver(grantId,victim),{receipt:second.receipt,replayed:true});
});
