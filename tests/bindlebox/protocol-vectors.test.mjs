// Fixed Bindle Messaging vectors (spec §13): every signed object verifies, digests are stable, and tampering, signature
// substitution and cross-domain reuse fail. Regenerate only with tests/bindlebox/vectors/generate.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as B from '../../packages/bindlebox-protocol/index.mjs';

const V=JSON.parse(await readFile(new URL('./vectors/vectors.json',import.meta.url),'utf8'));
const parties=Object.values(V.parties);
const calls={resolve:0,status:0};
const resolveKey=async({issuer,subject,keyId})=>{calls.resolve++;const p=parties.find(p=>p.principal.issuer===issuer);return p&&p.principal.subject===subject&&p.keyId===keyId?{keyId,publicJwk:p.identityPublicJwk,identityURI:p.principal.identityURI}:null;};
const status=async()=>{calls.status++;return {status:'active'};};
const ports={resolveKey,status,now:V.now};
const get=name=>{const o=V.objects.find(o=>o.name===name);assert.ok(o,name);return structuredClone(o);};
const bytes=v=>B.fromBase64url(v);
const genesis=()=>get('conversation-init').signed.payload.conversation.genesis;
const invitation=async()=>{const g=genesis();return {conversationId:g.payload.conversationId,genesisDigest:await B.genesisDigest(g),nonce:get('conversation-init').signed.payload.conversation.returnControl.nonce,participants:g.payload.participants,expiresAt:get('conversation-init').signed.payload.conversation.returnControl.expiresAt};};
const obligationFor=async(envelope,to)=>({principal:to.principal,ingress:to.ingress,operationId:envelope.payload.operationId,kind:envelope.payload.kind,payloadDigest:await B.payloadDigest(envelope),bodyDigest:envelope.payload.content?.sha256??null,...envelope.payload.kind==='conversation-record'?{eventId:await B.eventId(envelope)}:{}});
const RECEIPTS={'receipt-one-off':'one-off','receipt-record':'record-message','receipt-control-record':'record-retract'};
async function verifyObject(o,overrides={}){
 const p={...ports,...overrides};
 switch(o.type){
  case 'envelope':return B.verifyEnvelope(o.signed,p);
  case 'genesis':{const g=B.validateGenesis(o.signed);return B.authenticate(g,{...p,domain:B.DOMAINS.genesis,principal:g.payload.creator.principal,keyId:g.payload.creator.keyId,purpose:B.PURPOSES.author,at:g.payload.createdAt,required:false});}
  case 'invitation-response':return B.verifyInvitationResponse(o.signed,{...p,invitation:await invitation()});
  case 'receipt':{const r=await B.verifyReceipt(o.signed,{...p,obligation:await obligationFor(get(RECEIPTS[o.name]).signed,V.parties.bob)});if(r.state!=='delivered')throw Object.assign(new Error(r.reason),{code:'author_unverifiable',reason:r.reason});return r;}
 }
}
const rejects=(promise,code='author_unverifiable')=>assert.rejects(promise,error=>error.code===code||(code==='author_unverifiable'&&error.reason!==undefined));

test('vector inventory covers every signed object type and every record type',()=>{
 const types=new Set(V.objects.map(o=>o.type));for(const t of ['envelope','genesis','invitation-response','receipt'])assert.ok(types.has(t),t);
 const records=new Set(V.objects.filter(o=>o.type==='envelope'&&o.signed.payload.kind==='conversation-record').map(o=>o.signed.payload.record.type));
 assert.deepEqual([...records].sort(),[...B.RECORD_TYPES].sort());
 assert.deepEqual([...new Set(V.objects.filter(o=>o.type==='envelope').map(o=>o.signed.payload.kind))].sort(),[...B.KINDS].sort());
 assert.equal(V.profile,B.PROFILE);for(const p of parties)assert.ok(p.principal.issuer.endsWith('.example'));
});

test('digests, event IDs and signing inputs recompute exactly',async()=>{
 for(const o of V.objects){
  assert.equal(await B.sha256(crypto,B.signingInput(o.domain,o.signed)),o.signingInputSha256,o.name);
  assert.equal(await B.payloadDigest(o.signed),o.payloadDigest,o.name);
  if(o.eventId)assert.equal(await B.eventId(o.signed),o.eventId,o.name);
  if(o.genesisDigest)assert.equal(await B.genesisDigest(o.signed),o.genesisDigest,o.name);
  if(o.bodyBase64url)assert.equal(await B.sha256(crypto,bytes(o.bodyBase64url)),o.signed.payload.content.sha256,o.name);
 }
 assert.equal(get('genesis').genesisDigest,await B.genesisDigest(genesis()));
});

test('every positive vector verifies against the directory key and delegate certificate',async()=>{
 for(const o of V.objects){const r=await verifyObject(o);assert.ok(r,o.name);if(o.type==='envelope'){assert.equal(r.payloadDigest,o.payloadDigest);assert.equal(r.author.jkt,B.jktOf(o.signed.proof.kid));}}
 for(const [name,p] of Object.entries(V.parties)){const c=B.parseDelegation(p.certificate).claims;assert.equal(c.jkt,p.jkt,name);assert.equal(await B.thumbprint(c.delegate),p.jkt);assert.equal(c.client.ingress,p.ingress);assert.ok(c.exp-c.iat<=86400);}
});

test('a renewed certificate for the same key keeps identity; a certificate for another key does not verify',async()=>{
 const a=get('one-off'),b=get('one-off-renewed-certificate');
 assert.notEqual(a.signed.proof.delegation,b.signed.proof.delegation);assert.equal(a.payloadDigest,b.payloadDigest);
 assert.equal(B.parseDelegation(b.signed.proof.delegation).claims.since,B.parseDelegation(a.signed.proof.delegation).claims.since);
 await verifyObject(b);
 a.signed.proof.delegation=V.parties.alice.renewedCertificate;await rejects(verifyObject(a));
});

test('tampering with any signed member, the signature or the certificate fails',async()=>{
 const edits=[
  p=>{p.createdAt+=1;},p=>{p.version=p.version;p.subject=(p.subject??'')+'x';},
  p=>{if(p.operationId)p.operationId=p.operationId.replace(/.$/,c=>c==='0'?'1':'0');else if(p.nonce)p.nonce=p.nonce.replace(/^./,c=>c==='A'?'B':'A');else p.conversationId=p.conversationId.replace(/.$/,c=>c==='0'?'1':'0');},
 ];
 for(const o of V.objects){
  for(const [i,edit] of edits.entries()){
   const t=structuredClone(o);if(i===1&&!Object.hasOwn(t.signed.payload,'subject'))continue;edit(t.signed.payload);
   await rejects(verifyObject(t).catch(error=>{if(error.code==='malformed'||error.code==='not_authorized')throw Object.assign(error,{code:'author_unverifiable'});throw error;}),'author_unverifiable');
  }
  const s=structuredClone(o),sig=bytes(s.signed.proof.signature);sig[10]^=1;s.signed.proof.signature=B.base64url(sig);await rejects(verifyObject(s));
  const c=structuredClone(o),parts=c.signed.proof.delegation.split('.'),cs=bytes(parts[2]);cs[0]^=1;parts[2]=B.base64url(cs);c.signed.proof.delegation=parts.join('.');await rejects(verifyObject(c));
 }
});

test('signature substitution between principals, keys and objects fails',async()=>{
 const alice=get('one-off'),carol=get('record-peer-hello'),receipt=get('receipt-one-off');
 // Another principal's certificate and signature on Alice's payload.
 await rejects(verifyObject({...alice,signed:{payload:alice.signed.payload,proof:carol.signed.proof}}).catch(e=>{throw Object.assign(e,{code:e.code==='malformed'?'author_unverifiable':e.code});}));
 await rejects(verifyObject({...alice,signed:{payload:alice.signed.payload,proof:{...alice.signed.proof,delegation:V.parties.carol.certificate}}}));
 // A receipt signature is not an envelope signature and vice versa, even by the same key.
 const bobEnvelope=get('record-peer-hello');bobEnvelope.signed.proof.signature=receipt.signed.proof.signature;await rejects(verifyObject(bobEnvelope));
 // Changing kid (and author.delegate) to the renewed key, keeping the old signature, fails.
 const k=get('one-off');k.signed.payload.author.delegate=`jkt:${V.parties.alice.renewedJkt}`;k.signed.proof.kid=k.signed.payload.author.delegate;k.signed.proof.delegation=V.parties.alice.renewedCertificate;await rejects(verifyObject(k));
});

test('each signature verifies only under its own domain prefix; contact-delivery v1 never verifies',async()=>{
 const keyOf=async o=>B.importVerifyKey(B.parseDelegation(o.signed.proof.delegation).claims.delegate);
 for(const o of V.objects){
  const key=await keyOf(o),sig=bytes(o.signed.proof.signature);
  for(const domain of Object.values(B.DOMAINS)){
   const ok=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,sig,B.signingInput(domain,o.signed));
   assert.equal(ok,domain===o.domain,`${o.name} under ${JSON.stringify(domain)}`);
  }
 }
 const legacy=get('one-off');const legacyOk=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},await keyOf(legacy),bytes(V.contactDeliveryV1.signature),new TextEncoder().encode('bindle-contact-delivery-v1\n'+B.jcs({alg:'ES256',kid:legacy.signed.proof.kid,payload:legacy.signed.payload})));
 assert.equal(legacyOk,true,'the legacy-domain signature is genuine');
 legacy.signed.proof.signature=V.contactDeliveryV1.signature;await rejects(verifyObject(legacy));
 assert.throws(()=>B.signingInput('bindle-contact-delivery-v1\n',legacy.signed),{code:'malformed'});
 const prefixes=Object.values(B.DOMAINS);for(const a of prefixes)for(const b of prefixes)if(a!==b)assert.equal(b.startsWith(a),false);
});

test('status checks are required exactly where §3.4 says, and revocation is refused',async()=>{
 const down=async()=>{throw new Error('status down');},revoked=async()=>({status:'revoked',revokedHour:Math.floor(V.now/3600000)});
 for(const name of ['record-message','one-off'])await verifyObject(get(name),{status:down});
 for(const name of ['conversation-init','record-edit','record-retract','record-peer-proposal','record-peer-response','record-peer-hello','record-rotate','record-secret-share','record-leave','record-ingress','record-rejoin','invitation-response-accept']){
  await assert.rejects(verifyObject(get(name),{status:down}),{code:'author_unverifiable',status:503},name);
  await assert.rejects(verifyObject(get(name),{status:revoked}),{code:'author_unverifiable',status:401,revoked:true},name);
 }
 for(const name of Object.keys(RECEIPTS)){const o=get(name);assert.deepEqual(await B.verifyReceipt(o.signed,{...ports,status:revoked,obligation:await obligationFor(get(RECEIPTS[name]).signed,V.parties.bob)}),{state:'unknown',reason:'revoked'});}
});

test('pair token, edge key and transport vectors',async()=>{
 const t=V.pairToken,secret=bytes(t.secretBase64url);
 assert.equal(await B.pairToken(secret,t.input),t.token);assert.equal(await B.tokenDigest(t.token),t.tokenDigest);
 assert.equal(await B.edgeKey({conversationId:t.input.conversationId,author:t.input.author,owner:t.input.recipient}),t.edgeKey);
 assert.notEqual(t.helloToken,t.token);
 const m=await B.parseDelivery(V.multipart.contentType,bytes(V.multipart.bytesBase64url));
 assert.deepEqual(m.envelope,get(V.multipart.name).signed);assert.equal(B.base64url(m.secret),get(V.multipart.name).secretBase64url);assert.equal(m.credentialScheme,'BindleConversation');
 const b=await B.parseMulticast(V.multicast.contentType,bytes(V.multicast.bytesBase64url));
 assert.deepEqual(b.contexts.map(c=>c.payloadDigest),V.multicast.payloadDigests);assert.equal(b.contexts.every(c=>!c.error),true);
 assert.equal(await B.eventId(get('record-peer-hello').signed),V.helloEventId);
});

test('unknown principals are refused without status fetches',async()=>{
 const before={...calls},o=get('record-retract');
 await assert.rejects(B.verifyEnvelope(o.signed,{...ports,resolveKey:async()=>null}),{code:'author_unverifiable',status:401});
 assert.equal(calls.status,before.status);
});
