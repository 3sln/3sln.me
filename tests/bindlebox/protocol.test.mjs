// Bindle Messaging protocol library: encoding, certificates, envelope schema, author verification, conversations,
// replay, outcomes and wire parsers. Live-signed fixtures; fixed vectors are in protocol-vectors.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
import {NOW,NAMES,generateKeys,party,world,encoder,linkPayload,initEnvelope,recordPayload,invitationResponse,receiptFor,binding,claimsFor,SECRET,CONVERSATION,EPOCH,EPOCH2,NONCE,uuidOf,linkRecipient,MULTICAST} from './vectors/fixtures.mjs';

const keys=await generateKeys(),P={};for(const name of NAMES)P[name]=await party(name,keys);
const {alice,bob,carol}=P;
const fresh=()=>world(P);
const opts=w=>({resolveKey:w.resolveKey,status:w.status,now:NOW});
const oneOff=async(over={})=>B.signEnvelope(await linkPayload(alice,bob,over),alice.signer);
const record=async(type,over={},from=alice,to=bob)=>B.signEnvelope(await recordPayload(from,to,type,over),from.signer);
const code=c=>error=>{assert.equal(error.code,c,`expected ${c}, got ${error.code}: ${error.stack}`);return true;};
// Re-signs a mutated payload as Alice, so the schema (not the signature) is what fails.
const resign=async(envelope,edit)=>{const payload=structuredClone(envelope.payload);edit(payload);return B.signEnvelope(payload,alice.signer);};

test('strict I-JSON and JCS: duplicates, BOM, surrogates, unsafe numbers and ordering',()=>{
 for(const bad of ['{"a":1,"a":2}','\ufeff{}','{"a":"\\ud800"}','{"a":1.0}','{"a":-1}','{"a":1e3}','{"a":9007199254740993}','[1,]','{"a":1}x','{"__proto__":1,"__proto__":2}',`${'['.repeat(20)}${']'.repeat(20)}`])assert.throws(()=>B.strictJSON(bad),{code:'malformed'},bad);
 const parsed=B.strictJSON('{"__proto__":{"x":1},"b":[true,null,"\\u00e9"]}');assert.equal(Object.getPrototypeOf(parsed),Object.prototype);assert.ok(Object.hasOwn(parsed,'__proto__'));
 assert.throws(()=>B.strictJSON(new Uint8Array([0x22,0xff,0x22])),{code:'malformed'});assert.throws(()=>B.strictJSON('"'+'a'.repeat(70000)+'"'),{code:'too_large'});
 // RFC 8785 §3.2.3 key order is by UTF-16 code unit.
 assert.equal(B.jcs({'\u20ac':1,'\r':2,'\ufb33':3,'1':4,'\u{1f600}':5,'\u0080':6,'\u00f6':7}),'{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\u{1f600}":5,"\ufb33":3}');
 for(const bad of [{a:undefined},[1,,2],{a:-0},{a:1.5},{a:'\ud800'},new Date(0),{a:()=>1}])assert.throws(()=>B.jcs(bad),{code:'malformed'});
 assert.throws(()=>B.fromBase64url('AB=='),{code:'malformed'});assert.throws(()=>B.fromBase64url('AB'),{code:'malformed'},'noncanonical trailing bits');assert.deepEqual([...B.fromBase64url('AA')],[0]);
});

test('certificate validation: lifetime, purpose, ingress, header and key binding',async()=>{
 const w=fresh(),payload=await linkPayload(alice,bob),reissue=async over=>B.signEnvelope(payload,{...alice.signer,delegation:await alice.issue(over)});
 await B.verifyEnvelope(await reissue({}),opts(w));
 await assert.rejects(alice.issue({lifetime:86401}),code('malformed'));
 await assert.rejects(alice.issue({ingress:null}),code('malformed'),'Bindle Messaging purposes require client.ingress');
 await assert.rejects(alice.issue({purposes:[B.PURPOSES.receipt,B.PURPOSES.author]}),code('malformed'),'purposes must ascend');
 await assert.rejects(alice.issue({since:Math.floor(NOW/1000)}),code('malformed'),'since after iat');
 const iat=Math.floor(NOW/1000);
 for(const over of [{purposes:[B.PURPOSES.receipt]},{iat:iat-86400*2},{iat:iat+120},{since:iat-3600,iat:iat-3600},{iss:'https://mallory.provider.example'},{sub:bob.principal.subject}]){
  const delegation=over.iss||over.sub?await B.encodeDelegation({...claimsFor('alice',keys.alice.delegate,alice.jkt),...over},{privateKey:alice.identityPrivate,keyId:alice.keyId}):await alice.issue(over);
  const e=over.since?await B.signEnvelope({...payload,createdAt:(iat-3600-120)*1000},{...alice.signer,delegation}):await B.signEnvelope(payload,{...alice.signer,delegation});
  await assert.rejects(B.verifyEnvelope(e,opts(w)),code('author_unverifiable'),JSON.stringify(over));
 }
 // A certificate signed by another identity key, or presented under another kid, fails.
 const forged=await B.encodeDelegation(claimsFor('alice',keys.alice.delegate,alice.jkt),{privateKey:bob.identityPrivate,keyId:alice.keyId});
 await assert.rejects(B.verifyEnvelope(await B.signEnvelope(payload,{...alice.signer,delegation:forged}),opts(w)),code('author_unverifiable'));
 const otherKid=await B.encodeDelegation(claimsFor('alice',keys.alice.delegate,alice.jkt),{privateKey:alice.identityPrivate,keyId:`${alice.principal.identityURI}#k2`});
 await assert.rejects(B.verifyEnvelope(await B.signEnvelope(payload,{...alice.signer,delegation:otherKid}),opts(w)),code('author_unverifiable'));
 // Header members: typ, forbidden members, embedded keys.
 const [h,p,s]=alice.signer.delegation.split('.'),enc=v=>B.base64url(encoder.encode(JSON.stringify(v)));
 for(const header of [{alg:'ES256',kid:alice.keyId,typ:'bindle-link-meta+jwt'},{alg:'ES256',kid:alice.keyId,typ:'bindle-key-delegation+jwt',jku:'https://x.example'},{alg:'HS256',kid:alice.keyId,typ:'bindle-key-delegation+jwt'},{alg:'ES256',kid:alice.keyId,typ:'bindle-key-delegation+jwt',jwk:keys.alice.identity}])assert.throws(()=>B.parseDelegation(`${enc(header)}.${p}.${s}`),code('malformed'));
 assert.ok(h);
 // Delegate private members never import as verification keys.
 assert.equal(await B.importVerifyKey(keys.alice.delegate),null);
 // A signer cannot sign with a certificate for another jkt.
 await assert.rejects(B.signEnvelope(payload,{...alice.signer,delegation:alice.renewed.delegation}),code('malformed'));
});

test('envelope schema: exact members, kinds, display strings, tags, sizes and profiles',async()=>{
 const e=await oneOff({optionalTags:['a','b']});await B.validateEnvelope(e);
 const cases=[
  [p=>{p.extra=1;},'malformed'],[p=>{p.noReply=false;},'malformed'],[p=>{p.subject='a\u202eb';},'malformed'],[p=>{p.subject='line\u2028break';},'malformed'],
  [p=>{p.subject='x'.repeat(201);},'malformed'],[p=>{p.optionalTags=['b','a'];},'malformed'],[p=>{p.optionalTags=['a','a'];},'malformed'],[p=>{p.optionalTags=[' a'];},'malformed'],
  [p=>{p.operationId='0000000A-0000-4000-8000-000000000001';},'malformed'],[p=>{p.profile='https://spec.bindle.example/bindlebox/v2';},'unsupported_profile'],[p=>{p.version=2;},'malformed'],
  [p=>{p.recipient.resource='x'.repeat(129);},'malformed'],[p=>{p.content.byteLength=1048577;},'too_large'],[p=>{p.resendOf='not-a-uuid';},'malformed'],
  [p=>{p.author.identityDocument='https://evil.example/doc';},'malformed'],[p=>{p.author.delegate='jkt:short';},'malformed'],[p=>{p.recipient.issuer='https://bob.provider.example/';},'malformed'],
  [p=>{p.kind='conversation-record';p.noReply=false;},'malformed'],[p=>{p.record={};},'malformed'],
 ];
 for(const [edit,c] of cases){const t=structuredClone(e);edit(t.payload);if(t.payload.author.delegate!==e.payload.author.delegate)t.proof.kid=t.payload.author.delegate;await assert.rejects(B.validateEnvelope(t),code(c),edit.toString());}
 await assert.rejects(B.validateEnvelope({payload:{...e.payload,author:null},proof:e.proof}),code('author_required'));
 await assert.rejects(B.validateEnvelope({payload:e.payload}),code('author_required'));
 await assert.rejects(B.validateEnvelope({...e,proof:{...e.proof,kid:alice.renewed.kid}}),code('malformed'));
 await assert.rejects(B.validateEnvelope(e,{limits:{maxBodyBytes:4}}),code('too_large'),'host limits shrink the maxima');
 assert.equal(B.clampLimits({maxBodyBytes:1e12}).maxBodyBytes,B.LIMITS.maxBodyBytes,'host limits never raise the maxima');
 const big=structuredClone(e);big.payload.author.keyId='k'.repeat(200);big.payload.optionalTags=Array.from({length:32},(_,i)=>`t${String(i).padStart(2,'0')}${'x'.repeat(58)}`);await B.validateEnvelope(big);
 const huge=structuredClone(e);huge.proof.delegation=`${'A'.repeat(4000)}.${'A'.repeat(4000)}.${'A'.repeat(100)}`;await B.validateEnvelope(huge);
 // Getters run once on detach; the validated copy is detached from the caller.
 let reads=0;const tricky={get payload(){reads++;return structuredClone(e.payload);},proof:e.proof};const v=await B.validateEnvelope(tricky);assert.equal(reads,1);v.payload.subject='changed';assert.notEqual(e.payload.subject,'changed');
});

test('records: shapes, streams, counters, parents, bodies and reserved incarnations',async()=>{
 const m=await record('message',{body:encoder.encode('x')});await B.validateEnvelope(m);
 const id=await B.eventId(m);
 await assert.rejects(record('message',{}),code('malformed'),'message needs a body');
 await assert.rejects(record('retract',{target:id,body:encoder.encode('x')}),code('malformed'),'control records carry no body');
 await assert.rejects(record('edit',{body:encoder.encode('x')}),code('malformed'),'edit needs a target');
 await assert.rejects(record('message',{counter:2,body:encoder.encode('x')}),code('malformed'),'counter > 1 needs previous');
 await B.validateEnvelope(await record('message',{counter:1,previous:id,body:encoder.encode('x')}));
 await assert.rejects(record('message',{parents:Array.from({length:9},(_,i)=>B.base64url(new Uint8Array(32).fill(i))),counter:1,body:encoder.encode('x')}),code('malformed'));
 await assert.rejects(record('message',{parents:[id,id],body:encoder.encode('x')}),code('malformed'));
 await assert.rejects(record('message',{stream:alice.renewed.kid,body:encoder.encode('x')}),code('malformed'),'stream is the signing jkt');
 await assert.rejects(resign(m,p=>{p.record.type='reaction';}),code('record_unsupported'));
 await assert.rejects(resign(m,p=>{p.record.conversationId=uuidOf(77);}),code('malformed'));
 await assert.rejects(resign(m,p=>{p.optionalTags=['a'];}),code('malformed'));
 await assert.rejects(record('ingress',{data:{binding:binding(alice,'hello')}}),code('malformed'),'hello is reserved');
 await assert.rejects(record('message',{incarnation:'hello',body:encoder.encode('x')}),code('malformed'));
 await assert.rejects(record('peer-hello',{data:{binding:binding(carol),startCounter:1}},carol,bob).then(e=>resign(e,p=>{p.recipient.incarnation='inc';})),code('malformed'));
 await assert.rejects(record('rotate',{data:{newEpoch:EPOCH,secretDigest:await B.secretDigest(SECRET)}}),code('malformed'),'rotation must change epoch');
 await assert.rejects(record('leave',{data:{}}),code('malformed'));
 await assert.rejects(record('peer-response',{data:{proposal:id,decision:'maybe'}}),code('malformed'));
 const bad=binding(alice);bad.multicast='https://elsewhere.example/multicast';await assert.rejects(record('ingress',{data:{binding:bad}}),code('malformed'),'multicast shares the ingress origin');
 const q=binding(alice);q.ingress+='?user=1';await assert.rejects(record('ingress',{data:{binding:q}}),code('malformed'),'no query on ingress');
});

test('conversation-init: genesis bindings, secret digest, participants and return control',async()=>{
 const w=fresh(),init=await initEnvelope(alice,bob,[alice,bob,carol]);const v=await B.verifyEnvelope(init,opts(w));assert.equal(v.author.client.ingress,alice.ingress);
 await assert.rejects(B.validateEnvelope(init,{maxParticipants:2}),code('participants_exceeded'));
 const edit=async(fn)=>{const p=structuredClone(init.payload);fn(p);return B.signEnvelope(p,alice.signer);};
 await assert.rejects(edit(p=>{p.conversation.sharedSecret=B.base64url(new Uint8Array(32));}),code('malformed'));
 await assert.rejects(edit(p=>{p.conversation.returnControl.expiresAt=p.createdAt+604800001;}),code('malformed'));
 await assert.rejects(edit(p=>{p.conversation.returnControl.maxResponseBytes=9000;}),code('malformed'));
 await assert.rejects(edit(p=>{p.subject='Other';}),code('malformed'));
 await assert.rejects(edit(p=>{p.recipient=linkRecipient(carol);}).then(e=>initEnvelope(alice,bob,[alice,carol])),code('malformed'),'the approached recipient must be listed');
 // The creator binding and the return control must sit on the creator's certified ingress (S-4, S-11).
 const moved=await edit(p=>{p.conversation.creatorBinding.ingress='https://alice.box.example/other';});await assert.rejects(B.verifyEnvelope(moved,opts(w)),code('author_unverifiable'));
 const rc=await edit(p=>{p.conversation.returnControl.resource='https://evil.example/return';});await assert.rejects(B.verifyEnvelope(rc,opts(w)),code('author_unverifiable'));
 // A genesis signed under the envelope domain is not a genesis.
 const g=structuredClone(init.payload.conversation.genesis);g.proof.signature=(await B.signEnvelope(await linkPayload(alice,bob),alice.signer)).proof.signature;
 await assert.rejects(edit(p=>{p.conversation.genesis=g;}).then(e=>B.verifyEnvelope(e,opts(w))),code('author_unverifiable'));
});

test('invitation responses: checks before crypto, expiry, single use and certified binding',async()=>{
 const w=fresh(),init=await initEnvelope(alice,bob,[alice,bob,carol]),c=init.payload.conversation,g=c.genesis;
 const invitation={conversationId:CONVERSATION,genesisDigest:await B.genesisDigest(g),nonce:NONCE,participants:g.payload.participants,expiresAt:c.returnControl.expiresAt};
 const r=await invitationResponse(bob,g),ok=await B.verifyInvitationResponse(r,{...opts(w),invitation});assert.equal(ok.decision,'accept');assert.equal(ok.acceptListed,true);
 const before={...w.calls};
 await assert.rejects(B.verifyInvitationResponse(r,{...opts(w),invitation:{...invitation,nonce:B.base64url(new Uint8Array(16))}}),code('not_authorized'));
 await assert.rejects(B.verifyInvitationResponse(r,{...opts(w),invitation:{...invitation,participants:g.payload.participants.filter(x=>x.principal.subject!==bob.principal.subject)}}),code('not_authorized'));
 await assert.rejects(B.verifyInvitationResponse(r,{...opts(w),now:invitation.expiresAt+1,invitation}),code('invitation_expired'));
 assert.deepEqual(w.calls,before,'no directory or status work before the nonce, membership and expiry checks');
 assert.equal(B.invitationDecision(undefined,ok.digest),'new');assert.equal(B.invitationDecision({responseDigest:ok.digest},ok.digest),'replay');
 assert.throws(()=>B.invitationDecision({responseDigest:ok.digest},B.base64url(new Uint8Array(32))),code('invitation_used'));
 const wrong=binding(bob);wrong.ingress='https://hub.box.example/someone-else';
 const forged=await B.signInvitationResponse({...structuredClone(r.payload),binding:wrong},bob.signer);await assert.rejects(B.verifyInvitationResponse(forged,{...opts(w),invitation}),code('author_unverifiable'));
 await assert.rejects(B.signInvitationResponse({...structuredClone(r.payload),decision:'decline'},bob.signer),code('malformed'),'decline carries no binding');
});

test('records: ingress bindings, introductions and quarantine',async()=>{
 const w=fresh();
 await B.verifyEnvelope(await record('ingress',{data:{binding:binding(alice)}}),opts(w));
 const elsewhere=binding(alice);elsewhere.ingress='https://alice.box.example/hijack';
 for(const type of ['ingress','rejoin'])await assert.rejects(B.verifyEnvelope(await record(type,{data:{binding:elsewhere}}),opts(w)),code('author_unverifiable'),type);
 const g=(await initEnvelope(alice,bob,[alice,bob,carol])).payload.conversation.genesis,carolResponse=await invitationResponse(carol,g);
 const proposal=await record('peer-proposal',{data:{principal:carol.principal,keyId:carol.keyId,introduction:carolResponse}});
 const v=await B.verifyEnvelope(proposal,opts(w));assert.equal(v.introduction.kind,'invitation-response');assert.equal(v.introduction.binding.ingress,carol.ingress);
 const hello=await record('peer-hello',{data:{binding:binding(carol),startCounter:1}},carol,bob);
 assert.equal((await B.verifyEnvelope(await record('peer-proposal',{data:{principal:carol.principal,keyId:carol.keyId,introduction:hello}}),opts(w))).introduction.kind,'peer-hello');
 // A proposal cannot attribute someone else's introduction, nor nest proposals.
 await assert.rejects(record('peer-proposal',{data:{principal:bob.principal,keyId:bob.keyId,introduction:carolResponse}}),code('malformed'));
 const nested=await record('peer-proposal',{data:{principal:carol.principal,keyId:carol.keyId}});
 await assert.rejects(record('peer-proposal',{data:{principal:alice.principal,keyId:alice.keyId,introduction:nested}}),code('malformed'));
 // A revoked introducer key is refused even inside a valid proposal.
 w.revoke(carol.jkt,Math.floor(NOW/3600000));await assert.rejects(B.verifyEnvelope(proposal,opts(w)),code('author_unverifiable'));
 const hour=Math.floor(NOW/3600000);assert.equal(B.quarantined(NOW-30*60000,hour),true);assert.equal(B.quarantined((hour-1)*3600000-1,hour),false);
 // Directory outage is retryable; status is not consulted for plain messages.
 const w2=fresh();w2.outage('directory');await assert.rejects(B.verifyEnvelope(await oneOff(),opts(w2)),e=>e.code==='author_unverifiable'&&e.status===503&&e.retryAfter>0);
 const w3=fresh();w3.outage('status');await B.verifyEnvelope(await oneOff(),opts(w3));assert.equal(w3.calls.status,0);
});

test('receipts: honest unknown on every failed §8.1 check',async()=>{
 const w=fresh(),e=await oneOff(),obligation={principal:bob.principal,ingress:bob.ingress,operationId:e.payload.operationId,kind:e.payload.kind,payloadDigest:await B.payloadDigest(e),bodyDigest:e.payload.content.sha256};
 const r=await receiptFor(bob,e);assert.equal((await B.verifyReceipt(r,{...opts(w),obligation})).state,'delivered');
 const check=async(receipt,reason,o=obligation,ports=opts(w))=>assert.deepEqual(await B.verifyReceipt(receipt,{...ports,obligation:o}),{state:'unknown',reason});
 await check(r,'ingress',{...obligation,ingress:'https://hub.box.example/other'});
 await check(r,'digest',{...obligation,payloadDigest:B.base64url(new Uint8Array(32))});
 await check(r,'digest',{...obligation,bodyDigest:null});
 await check(r,'recipient',{...obligation,principal:carol.principal});
 await check(await receiptFor(bob,e,{receivedAt:NOW+120000}),'received_at');
 await check(await receiptFor(bob,e,{ingress:'https://hub.box.example/other'}),'ingress',{...obligation,ingress:'https://hub.box.example/other'});
 await check({...r,proof:{...r.proof,signature:e.proof.signature}},'certificate');
 await check({payload:r.payload,proof:e.proof},'certificate');
 const authorOnly=await bob.issue({purposes:[B.PURPOSES.author]});await check(await B.signReceipt(r.payload,{...bob.signer,delegation:authorOnly}),'certificate');
 const w2=fresh();w2.outage('status');await check(r,'status_unavailable',obligation,opts(w2));
 await check({...r,extra:1},'malformed');
 const rec=await record('message',{body:encoder.encode('x')}),rr=await receiptFor(bob,rec);
 assert.equal((await B.verifyReceipt(rr,{...opts(w),obligation:{principal:bob.principal,ingress:bob.ingress,operationId:rec.payload.operationId,kind:rec.payload.kind,payloadDigest:await B.payloadDigest(rec),bodyDigest:rec.payload.content.sha256,eventId:await B.eventId(rec)}})).state,'delivered');
 await check(rr,'digest',{principal:bob.principal,ingress:bob.ingress,operationId:rec.payload.operationId,kind:rec.payload.kind,payloadDigest:await B.payloadDigest(rec),bodyDigest:rec.payload.content.sha256});
});

test('event identity is recipient independent; payload digest is per delivery context',async()=>{
 const toBob=await record('message',{body:encoder.encode('same'),incarnation:'inc-1'}),toCarol=await record('message',{body:encoder.encode('same'),incarnation:'inc-2'},alice,carol);
 assert.equal(await B.eventId(toBob),await B.eventId(toCarol));assert.notEqual(await B.payloadDigest(toBob),await B.payloadDigest(toCarol));
 const again=await record('message',{body:encoder.encode('same'),incarnation:'inc-1'});assert.notEqual(again.proof.signature,toBob.proof.signature);assert.equal(await B.payloadDigest(again),await B.payloadDigest(toBob));
 assert.throws(()=>B.eventId(again.payload.kind?{payload:{kind:'one-off'}}:again),code('malformed'));
});

test('pair tokens, credential grammar and the pre-authentication gate',async()=>{
 const base={conversationId:CONVERSATION,author:alice.principal,recipient:bob.principal,incarnation:'inc-for-alice'},t=await B.pairToken(SECRET,base);
 for(const over of [{author:carol.principal},{recipient:carol.principal},{incarnation:'inc-2'},{conversationId:uuidOf(5)}])assert.notEqual(await B.pairToken(SECRET,{...base,...over}),t);
 assert.notEqual(await B.pairToken(new Uint8Array(32),base),t);
 await assert.rejects(B.pairToken(SECRET,{...base,incarnation:'a b'}),code('malformed'));
 assert.deepEqual(B.parseCredential(null),{scheme:null});
 for(const bad of ['Bearer x','bindlelink a.b.c','BindleLink  a.b.c','BindleLink a.b.c ','BindleConversation x'])assert.throws(()=>B.parseCredential(bad),e=>['malformed','link_malformed','not_authorized'].includes(e.code),bad);
 assert.throws(()=>B.parseCredential('BindleLink a.b'),code('link_malformed'));
 const credential=B.parseCredential(`BindleConversation ${EPOCH}.${t}`);assert.equal(credential.token,t);assert.equal(B.formatCredential(credential),`BindleConversation ${EPOCH}.${t}`);
 const m=await record('message',{body:encoder.encode('x')}),entry={tokenDigests:{[EPOCH]:await B.tokenDigest(t)},incarnation:'inc-for-alice'};
 assert.equal(await B.checkPairGate(credential,m,entry),true);assert.equal(B.checkCredentialKind(m,credential),'BindleConversation');
 await assert.rejects(B.checkPairGate(B.parseCredential(`BindleConversation ${EPOCH}.${await B.pairToken(SECRET,{...base,author:carol.principal})}`),m,entry),code('not_authorized'));
 await assert.rejects(B.checkPairGate(B.parseCredential(`BindleConversation ${EPOCH2}.${t}`),m,{...entry,tokenDigests:{...entry.tokenDigests,[EPOCH2]:entry.tokenDigests[EPOCH]}}),code('not_authorized'),'epoch must match the record');
 await assert.rejects(B.checkPairGate(credential,m,{...entry,incarnation:'inc-new'}),code('incarnation_stale'));
 assert.throws(()=>B.checkCredentialKind(m,{scheme:'BindleLink',value:'a.b.c'}),code('not_authorized'));
 const link=await oneOff(),rejoin=await record('rejoin',{data:{binding:binding(alice)}});
 assert.throws(()=>B.checkCredentialKind(link,{scheme:null}),code('link_invalid'));
 assert.equal(B.checkCredentialKind(rejoin,{scheme:null}),null);
 assert.throws(()=>B.checkCredentialKind(rejoin,credential),code('not_authorized'));
 assert.throws(()=>B.checkLinkRecipient(link,{issuer:bob.principal.issuer,owner:bob.principal.subject,jti:'other',resource:'parent-1'}),code('link_invalid'));
 const k1=await B.edgeKey({conversationId:CONVERSATION,author:alice.principal,owner:bob.principal}),k2=await B.edgeKey({conversationId:CONVERSATION,author:bob.principal,owner:alice.principal});assert.notEqual(k1,k2);
});

test('counter frontiers: gaps, duplicates, bounds, expiry and equivocation',()=>{
 let s=B.streamState();const step=(c,now=NOW)=>{const r=B.admitCounter(s,c,{now});s=r.state;return r.status;};
 assert.equal(step(1),'new');assert.equal(step(1),'duplicate');assert.equal(step(4),'new');assert.equal(B.frontier(s),1);assert.equal(step(3),'new');assert.equal(step(2),'new');assert.equal(B.frontier(s),4);
 assert.throws(()=>B.admitCounter(s,4+1025,{now:NOW}),code('counter_gap'));assert.equal(step(4+1024),'new');assert.equal(s.gaps.length,256);
 assert.equal(step(4+1024-300),'duplicate','abandoned gaps read as duplicates');assert.equal(step(4+1023),'new');
 assert.equal(B.admitCounter(s,4+1000,{now:NOW+B.LIMITS.recordWindowMs+1}).state.gaps.length,0,'gaps expire with the window');
 assert.equal(B.equivocates(undefined,'a'),false);assert.equal(B.equivocates('a','a'),false);assert.equal(B.equivocates('a','b'),true);
 const ids=Array.from({length:8},(_,i)=>B.base64url(new Uint8Array(32).fill(i)));
 assert.deepEqual(B.placeholderPlan(ids,new Set(ids.slice(0,2)),60),{placeholders:ids.slice(2,6),collapsed:true});
 let pending=[];for(let i=0;i<70;i++)pending=B.queueMutation(pending,{target:ids[i%8],author:alice.principal,eventId:`e${i}`}).pending;assert.equal(pending.length,64);assert.equal(pending[0].eventId,'e6');
 assert.throws(()=>B.checkMutationAuthor({author:alice.principal},carol.principal),code('record_forbidden'));
});

test('frozen audiences are order independent and mutation audiences intersect',async()=>{
 const peers=[{...bob.principal,incarnation:'i1'},{...carol.principal,incarnation:'i2'}];
 const a=await B.freezeAudience(peers),b=await B.freezeAudience([...peers].reverse());assert.equal(a.digest,b.digest);assert.ok(Object.isFrozen(a.members));
 assert.notEqual((await B.freezeAudience([{...bob.principal,incarnation:'i9'},peers[1]])).digest,a.digest);
 await assert.rejects(B.freezeAudience([peers[0],peers[0]]),code('malformed'));
 assert.deepEqual(B.mutationAudience(a,[carol.principal]).map(m=>m.subject),[carol.principal.subject]);
});

test('replay namespaces, windows and decisions',async()=>{
 const e=await oneOff(),other=await B.signEnvelope({...(await linkPayload(carol,bob)),operationId:e.payload.operationId},carol.signer);
 assert.notEqual(B.replayKey(e),B.replayKey(other),'operation IDs are namespaced by author principal');
 assert.notEqual(B.operationKey(alice.principal,e.payload.operationId),B.operationKey(carol.principal,e.payload.operationId));
 const r1=await record('message',{body:encoder.encode('x')}),r2=await record('message',{body:encoder.encode('y')});assert.equal(B.replayKey(r1),B.replayKey(r2));
 assert.equal(B.checkWindow(e,NOW),true);assert.throws(()=>B.checkWindow(e,e.payload.createdAt+86400001),code('envelope_expired'));
 assert.throws(()=>B.checkWindow(e,e.payload.createdAt-60001),e=>e.code==='clock_skew'&&e.serverTime===e.serverTime);
 assert.equal(B.checkWindow(r1,r1.payload.createdAt+6*86400000),true);
 const d1=await B.payloadDigest(r1),d2=await B.payloadDigest(r2);
 assert.equal(B.replayDecision(null,{payloadDigest:d1}),'new');assert.equal(B.replayDecision({payloadDigest:d1},{payloadDigest:d1}),'replay');
 assert.throws(()=>B.replayDecision({payloadDigest:d1},{payloadDigest:d2}),code('operation_conflict'));
 assert.equal(B.replayDecision({payloadDigest:d1,eventId:'a'},{payloadDigest:d2,eventId:'b'}),'equivocation');
 assert.equal(B.replayDecision({payloadDigest:d1,eventId:'a'},{payloadDigest:d2,eventId:'a'}),'duplicate-event');
 assert.equal(B.retainUntil(e,NOW),e.payload.createdAt+86400000+B.LIMITS.retentionMs);
 assert.equal(B.admissibleAfterRestore(e,{checkpointAt:NOW}),false);assert.equal(B.admissibleAfterRestore(e,{checkpointAt:NOW,imported:true}),true);
});

test('failure classification and receipt application are honest',()=>{
 const c=B.classifyFailure;
 assert.deepEqual(c({transport:'timeout'}),{action:'retry',state:'unknown',reason:'unreachable'});
 assert.equal(c({status:503,error:'recipient_unavailable',retryAfter:'120'}).notBefore,120000);
 assert.equal(c({status:503,error:'recipient_storage_unavailable'}).reason,'storage');assert.equal(c({status:429,retryAfter:'soon'}).notBefore,60000);
 assert.deepEqual(c({status:403,error:'not_authorized'}),{action:'repair',reason:'authorization'});
 assert.deepEqual(c({status:403,error:'not_authorized',repaired:true}),{action:'terminal',state:'rejected',class:'not_authorized'});
 assert.equal(c({status:403,error:'not_authorized',record:true,knownRotation:true}).reason,'epoch');
 assert.equal(c({status:410,error:'ingress_moved',record:true}).reason,'moved');assert.equal(c({status:404}).action,'repair');
 assert.equal(c({status:302}).action,'retry','redirects are never followed');assert.equal(c({status:500}).state,'unknown');
 for(const [status,error,cls] of [[400,'malformed','invalid'],[409,'operation_conflict','invalid'],[413,'too_large','too_large'],[415,'record_unsupported','invalid'],[403,'participants_exceeded','participants_exceeded']])assert.deepEqual(c({status,error,repaired:status===403}),{action:'terminal',state:'rejected',class:cls});
 assert.deepEqual(B.applyReceipt('expired'),{state:'delivered'});assert.deepEqual(B.applyReceipt('cancelled'),{state:'cancelled',deliveredBeforeCancel:true});
 assert.deepEqual(B.aggregate(['delivered','unknown','expired','cancelled','queued']),{delivered:1,pending:2,failed:1,cancelled:1});
});

test('multicast results are validated per context and never inferred',async()=>{
 const r=await receiptFor(bob,await oneOff());
 const results=B.parseMulticastResults({results:[{index:0,state:'delivered',receipt:r},{index:1,state:'accepted-host'},{index:2,state:'rejected',error:'recipient_unavailable'},{index:3,state:'unknown'}]},4);
 assert.deepEqual(results.map(x=>B.multicastOutcome(x).action),['verify-receipt','retry','retry','retry']);
 assert.equal(B.multicastOutcome(results[1]).reconcile,true);
 for(const bad of [{results:[]},{results:[{index:1,state:'unknown'}]},{results:[{index:0,state:'delivered'}]},{results:[{index:0,state:'unknown',receipt:r}]},{results:[{index:0,state:'done'}]},{results:[{index:0,state:'unknown'}],extra:1}])assert.throws(()=>B.parseMulticastResults(bad,1),code('malformed'));
 assert.throws(()=>B.parseMulticastResults({results:[{index:0,state:'unknown'}]},2),code('malformed'));
});

test('single delivery multipart: round trip and strict framing',async()=>{
 const e=await oneOff(),body=encoder.encode('Hello from the vectors.'),{contentType,bytes}=B.encodeDelivery(e,{body,boundary:'b0'});
 const parsed=await B.parseDelivery(contentType,bytes,{idempotencyKey:e.payload.operationId});assert.deepEqual(parsed.envelope,e);assert.deepEqual(parsed.body,body);assert.equal(parsed.credentialScheme,'BindleLink');
 await assert.rejects(B.parseDelivery(contentType,bytes,{idempotencyKey:uuidOf(9)}),code('malformed'));
 const text=new TextDecoder().decode(bytes),enc=s=>encoder.encode(s);
 for(const bad of ['preamble\r\n'+text,text.replace('name="message"','name="message"; size=1'),text.replace('Content-Type: text/plain','Content-Type: text/html'),text.replace('--b0--','--b0\r\nContent-Disposition: form-data; name="extra"\r\n\r\nx\r\n--b0--'),text.replace('Content-Disposition','Content-Transfer-Encoding: base64\r\nContent-Disposition'),text.replace('from the vectors','from the vectorz'),text+'trailing'])await assert.rejects(B.parseDelivery(contentType,enc(bad)),code('malformed'),bad.slice(0,60));
 await assert.rejects(B.parseDelivery('multipart/form-data; boundary=b0; boundary=b0',bytes),code('malformed'));
 await assert.rejects(B.parseDelivery('multipart/mixed; boundary=b0',bytes),code('malformed'));
 await assert.rejects(B.parseDelivery(contentType,new Uint8Array(1500001)),code('too_large'));
 const control=await record('retract',{target:B.base64url(new Uint8Array(32))}),c=B.encodeDelivery(control,{boundary:'b1'});assert.equal((await B.parseDelivery(c.contentType,c.bytes)).body,null);
 await assert.rejects(B.parseDelivery(c.contentType,B.encodeDelivery(e,{body,boundary:'b1'}).bytes.slice(0,10)),code('malformed'));
 const rotate=await record('rotate',{data:{newEpoch:EPOCH2,secretDigest:await B.secretDigest(SECRET)}}),withSecret=B.encodeDelivery(rotate,{secret:SECRET,boundary:'b2'});
 assert.deepEqual((await B.parseDelivery(withSecret.contentType,withSecret.bytes)).secret,SECRET);
 await assert.rejects(B.parseDelivery(withSecret.contentType,B.encodeDelivery(rotate,{secret:new Uint8Array(32),boundary:'b2'}).bytes),code('malformed'),'secret must match its digest');
 await assert.rejects(B.parseDelivery(withSecret.contentType,B.encodeDelivery(rotate,{boundary:'b2'}).bytes),code('malformed'),'rotate requires the secret part');
 await assert.rejects(B.parseDelivery(c.contentType,B.encodeDelivery(control,{secret:SECRET,boundary:'b1'}).bytes),code('malformed'),'secret only for rotate and secret-share');
 assert.throws(()=>B.encodeDelivery(e,{body:enc('x\r\n--b0 y'),boundary:'b0'}),code('malformed'));
});

test('multicast parsing: whole-request failures versus confined context errors',async()=>{
 const body=encoder.encode('Hello from the vectors.'),toBob=await oneOff(),toCarol=await B.signEnvelope(await linkPayload(alice,carol,{operationId:uuidOf(3),recipient:linkRecipient(carol,'jti-c','parent-c')}),alice.signer);
 const cred=v=>({scheme:'BindleLink',value:`a.b.${v}`}),other=await oneOff({body:encoder.encode('different'),operationId:uuidOf(4)}),m=await record('message',{body});
 const broken=structuredClone(toCarol);broken.payload.extra=1;
 const batch=B.encodeMulticast({batchId:uuidOf(8),contexts:[{credential:cred('a'),envelope:toBob},{credential:cred('b'),envelope:other},{credential:cred('c'),envelope:toBob},{credential:{scheme:'BindleLink',value:'a.b.d'},envelope:m},{credential:cred('e'),envelope:broken},{credential:cred('f'),envelope:toCarol}]},body,{boundary:'mb'});
 const parsed=await B.parseMulticast(batch.contentType,batch.bytes);
 assert.deepEqual(parsed.contexts.map(c=>c.error??'ok'),['ok','malformed','malformed','malformed','malformed','ok']);
 const many=B.encodeMulticast({batchId:uuidOf(8),contexts:Array.from({length:32},()=>({credential:cred('a'),envelope:toBob}))},body,{boundary:'mb'});
 const bytes=new TextDecoder().decode(many.bytes).replace('"contexts":[',`"contexts":[{"credential":{"scheme":"BindleLink","value":"a.b.c"},"envelope":{}},`);
 await assert.rejects(B.parseMulticast(many.contentType,encoder.encode(bytes)),code('too_large'),'33 contexts');
 await assert.rejects(B.parseMulticast(batch.contentType,batch.bytes,{limits:{maxBatchContexts:4}}),code('too_large'),'descriptor limit');
 await assert.rejects(B.parseMulticast(batch.contentType,encoder.encode(new TextDecoder().decode(batch.bytes).replace('from the vectors','from the vectorz'))),code('malformed'),'one body for all');
 assert.equal(MULTICAST.startsWith(new URL(bob.ingress).origin),true);
});

test('mailbox and intake RPC: strict envelope, methods and provenance',async()=>{
 const resource='https://hub.box.example/mailboxes/m1',req=(contract,method,args,extra={})=>encoder.encode(JSON.stringify({version:'0',tx:uuidOf(1),resource,contract,method,args,...extra}));
 assert.equal(B.parseRPC(req(B.MAILBOX_CONTRACT,'describe',{})).method,'describe');
 assert.equal(B.parseRPC(req(B.MAILBOX_CONTRACT,'linkRevoked',{jti:'j1'}),{resource}).args.jti,'j1');
 assert.throws(()=>B.parseRPC(req(B.MAILBOX_CONTRACT,'describe',{x:1})),e=>e.code==='invalid_args'&&e.rpc===true);
 assert.throws(()=>B.parseRPC(req(B.MAILBOX_CONTRACT,'deliver',{})),code('unsupported_method'));
 assert.throws(()=>B.parseRPC(req('https://x.example/c','describe',{})),code('unsupported_contract'));
 assert.throws(()=>B.parseRPC(req(B.MAILBOX_CONTRACT,'describe',{},{extra:1})),code('malformed'));
 assert.throws(()=>B.parseRPC(encoder.encode(`{"version":"0","version":"0","tx":"${uuidOf(1)}","resource":"${resource}","contract":"${B.MAILBOX_CONTRACT}","method":"describe","args":{}}`)),code('malformed'));
 assert.throws(()=>B.parseRPC(req(B.MAILBOX_CONTRACT,'describe',{}),{resource:'https://hub.box.example/mailboxes/m2'}),code('malformed'));
 // Public intake with a consumer-signed provenance JWS.
 const consumer=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),consumerJwk=await crypto.subtle.exportKey('jwk',consumer.publicKey);
 const message={parts:[{mimeType:'text/plain',dataBase64url:B.base64url(encoder.encode('Hi from email'))}]};
 const claims={bindle:'intake-provenance',v:1,iss:'https://bob.provider.example',channel:'email',recipient:bob.principal,receivedAt:NOW-1000,sender:{envelopeFrom:'a@sender.example',headerFrom:'A <a@sender.example>'},dmarc:'pass',automation:[],ingressFingerprint:'fp-1',normalizedDigest:await B.intakeDigest(message),jti:'prov-1'};
 const enc=v=>B.base64url(encoder.encode(JSON.stringify(v))),head=`${enc({alg:'ES256',kid:'bridge-1',typ:'bindle-intake-provenance+jwt'})}.${enc(claims)}`;
 const provenance=`${head}.${B.base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},consumer.privateKey,encoder.encode(head))))}`;
 const parsed=B.parseRPC(req(B.INTAKE_CONTRACT,'deliver',{message,provenance}));
 const key={keyId:'bridge-1',publicJwk:{kty:'EC',crv:'P-256',x:consumerJwk.x,y:consumerJwk.y}},ctx={consumerKey:key,consumer:'https://bob.provider.example',recipient:bob.principal,now:NOW};
 const v=await B.verifyProvenance(parsed.args,ctx);assert.equal(v.verifiedSender,false);assert.equal(v.asserted.dmarc,'pass');
 await assert.rejects(B.verifyProvenance(parsed.args,{...ctx,recipient:carol.principal}),code('not_authorized'));
 await assert.rejects(B.verifyProvenance(parsed.args,{...ctx,consumer:'https://evil.example'}),code('not_authorized'));
 await assert.rejects(B.verifyProvenance({...parsed.args,message:{parts:[{mimeType:'text/plain',dataBase64url:'AA'}]}},ctx),code('malformed'));
 await assert.rejects(B.verifyProvenance(parsed.args,{...ctx,now:NOW+8*86400000}),code('envelope_expired'));
 await assert.rejects(B.verifyProvenance(parsed.args,{...ctx,consumerKey:{...key,keyId:'other'}}),code('not_authorized'));
 assert.throws(()=>B.parseRPC(req(B.INTAKE_CONTRACT,'deliver',{message,provenance:alice.signer.delegation})),code('invalid_args'),'a delegation is not a provenance');
});

test('descriptors: limits, profiles, multicast origin and expiry',()=>{
 const d={version:1,profiles:[B.PROFILE],ingress:bob.ingress,multicast:MULTICAST,verifies:['https://bob.provider.example'],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536,maxBatchContexts:32},kinds:['conversation-init','one-off'],expiresAt:NOW+3600000};
 B.validateDescriptor(d,{now:NOW});const {expiresAt,...describe}=d;B.validateDescriptor(describe,{describe:true});
 for(const [edit,c] of [[x=>{x.expiresAt=NOW+3600001;},'malformed'],[x=>{x.expiresAt=NOW;},'malformed'],[x=>{x.profiles=['https://other.example/p'];},'unsupported_profile'],[x=>{x.multicast='https://other.example/m';},'malformed'],[x=>{x.limits.maxParticipants=33;},'malformed'],[x=>{x.kinds=['one-off','conversation-init'];},'malformed'],[x=>{x.ingress='http://hub.box.example/ingress';},'malformed']])
  {const t=structuredClone(d);edit(t);assert.throws(()=>B.validateDescriptor(t,{now:NOW}),code(c));}
 assert.ok(B.validateDescriptor({...structuredClone(d),ingress:'http://localhost:8787/ingress',multicast:'http://localhost:8787/m'},{now:NOW,allowLoopback:true}));
});

test('security review regressions (docs/release/bindlebox-protocol-review.md BR-1–BR-10)',async()=>{
 const w=fresh();
 // BR-1: identityURI is pinned by the directory; a signer-chosen identityURI (or one with a query) never reaches the ports.
 const swapped=await resign(await oneOff(),p=>{p.author.principal.identityURI=`${alice.principal.issuer}/identity/${bob.principal.subject}`;});
 await assert.rejects(B.verifyEnvelope(swapped,opts(w)),code('author_unverifiable'));
 await assert.rejects(resign(await oneOff(),p=>{p.author.principal.identityURI+='?x=';}),code('malformed'));
 const e=await oneOff(),r=await receiptFor(bob,e),obligation={principal:{issuer:bob.principal.issuer,subject:bob.principal.subject},ingress:bob.ingress,operationId:e.payload.operationId,kind:e.payload.kind,payloadDigest:await B.payloadDigest(e),bodyDigest:e.payload.content.sha256};
 const echo=await B.signReceipt({...structuredClone(r.payload),recipient:{...bob.principal,identityURI:`${bob.principal.issuer}/echo`}},bob.signer);
 assert.equal((await B.verifyReceipt(echo,{...opts(w),obligation})).state,'unknown');
 // BR-2: only explicit permanent refusals are terminal.
 for(const status of [200,201,204,100,0,408,425,418])assert.equal(B.classifyFailure({status}).state,'unknown',String(status));
 // BR-3: multicast rejections keep rotation context and never make author_unverifiable terminal.
 assert.equal(B.multicastOutcome({state:'rejected',error:'author_unverifiable'},{repaired:true}).state,'unknown');
 assert.equal(B.multicastOutcome({state:'rejected',error:'not_authorized'},{record:true,knownRotation:true,repaired:true}).reason,'epoch');
 // BR-4: an ordinary pair token never admits a peer-hello, and a hello token never admits ordinary records.
 const base={conversationId:CONVERSATION,author:carol.principal,recipient:bob.principal},normal=await B.pairToken(SECRET,{...base,incarnation:'inc-for-carol'}),helloToken=await B.pairToken(SECRET,{...base,incarnation:'hello'});
 const hello=await record('peer-hello',{data:{binding:binding(carol),startCounter:1}},carol,bob),msg=await record('message',{body:encoder.encode('x'),incarnation:'inc-for-carol'},carol,bob);
 const entry={tokenDigests:{[EPOCH]:await B.tokenDigest(normal)},helloDigests:{[EPOCH]:await B.tokenDigest(helloToken)},incarnation:'inc-for-carol'},cred=t=>B.parseCredential(`BindleConversation ${EPOCH}.${t}`);
 assert.equal(await B.checkPairGate(cred(helloToken),hello,entry),true);assert.equal(await B.checkPairGate(cred(normal),msg,entry),true);
 await assert.rejects(B.checkPairGate(cred(normal),hello,entry),code('not_authorized'));await assert.rejects(B.checkPairGate(cred(helloToken),msg,entry),code('not_authorized'));
 // BR-5: a missing invitation expiry fails closed.
 const g=(await initEnvelope(alice,bob,[alice,bob,carol])).payload.conversation.genesis,resp=await invitationResponse(bob,g);
 assert.throws(()=>B.precheckInvitationResponse(resp,{conversationId:CONVERSATION,genesisDigest:resp.payload.genesisDigest,nonce:NONCE,participants:g.payload.participants,now:NOW}),code('not_authorized'));
 // BR-6: every Bidi_Control, zero-width space and BOM is refused in display strings.
 for(const cp of [0x061c,0x200e,0x200f,0x200b,0xfeff,0x2066,0x202e])await assert.rejects(resign(await oneOff(),p=>{p.subject=`a${String.fromCodePoint(cp)}b`;}),code('malformed'),cp.toString(16));
 // BR-7: no trailing-dot hosts, IP literals or loopback names outside development.
 for(const issuer of ['https://alice.provider.example.','https://127.0.0.1','https://[::1]','https://localhost','https://box.localhost'])assert.throws(()=>B.validatePrincipal({issuer,subject:alice.principal.subject,identityURI:`${issuer}/identity/x`}),code('malformed'),issuer);
 assert.ok(B.validatePrincipal({issuer:'http://localhost:8787',subject:alice.principal.subject,identityURI:'http://localhost:8787/identity/x'},{local:true}));
 // BR-8: startCounter is the first expected counter.
 assert.equal(B.admitCounter(B.streamState(1),1,{now:NOW}).status,'new');assert.equal(B.admitCounter(B.streamState(5),4,{now:NOW}).status,'duplicate');
 // BR-9: the genesis delegation must certify the creator's key.
 const p=structuredClone((await initEnvelope(alice,bob,[alice,bob,carol])).payload);p.conversation.genesis.proof.delegation=bob.signer.delegation;
 await assert.rejects(B.verifyEnvelope(await B.signEnvelope(p,alice.signer),opts(w)),code('author_unverifiable'));
 // BR-10: a receipt verifies by its receivedAt, so later reconciliation is possible; status is still required.
 assert.equal((await B.verifyReceipt(r,{...opts(w),now:NOW+3*86400000,obligation})).state,'delivered');
 // Ordering: a binding mismatch on a status-required record costs no status fetch.
 const elsewhere=binding(alice);elsewhere.ingress='https://alice.box.example/hijack';const before=w.calls.status;
 await assert.rejects(B.verifyEnvelope(await record('ingress',{data:{binding:elsewhere}}),opts(w)),code('author_unverifiable'));assert.equal(w.calls.status,before);
});
