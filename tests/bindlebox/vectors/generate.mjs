#!/usr/bin/env node
// Regenerates tests/bindlebox/vectors/vectors.json. ECDSA signatures are randomized, so the committed file is the fixed
// vector set; rerun only when the wire format changes, and review the diff. Keys are test-only and published here.
// node tests/bindlebox/vectors/generate.mjs [--new-keys]
import {readFile,writeFile} from 'node:fs/promises';
import {DOMAINS,PROFILE,signEnvelope,payloadDigest,eventId,genesisDigest,signingInput,sha256,base64url,jcs,pairToken,edgeKey,tokenDigest,encodeDelivery,encodeMulticast,secretDigest} from '../../../packages/bindlebox-protocol/index.mjs';
import {NOW,NAMES,generateKeys,party,encoder,initEnvelope,recordPayload,linkPayload,invitationResponse,receiptFor,genesisFor,binding,linkRecipient,SECRET,SECRET2,CONVERSATION,EPOCH,EPOCH2,uuidOf} from './fixtures.mjs';

const file=new URL('./vectors.json',import.meta.url);
let keys;try{if(!process.argv.includes('--new-keys'))keys=JSON.parse(await readFile(file,'utf8')).keys;}catch{}
keys??=await generateKeys();
const P={};for(const name of NAMES)P[name]=await party(name,keys);
const {alice,bob,carol}=P,objects=[];
async function add(name,type,signed,{domain,body,secret}={}){
 const entry={name,type,domain,signed,signingInputSha256:await sha256(crypto,signingInput(domain,signed)),payloadDigest:await payloadDigest(signed)};
 if(type==='envelope'&&signed.payload.kind==='conversation-record')entry.eventId=await eventId(signed);
 if(type==='genesis')entry.genesisDigest=await genesisDigest(signed);
 if(body)entry.bodyBase64url=base64url(body);if(secret)entry.secretBase64url=base64url(secret);
 objects.push(entry);return signed;
}
const E=DOMAINS.envelope,body=encoder.encode('Hello from the vectors.');
const oneOff=await add('one-off','envelope',await signEnvelope(await linkPayload(alice,bob,{optionalTags:['billing','urgent']}),alice.signer),{domain:E,body});
// Same signed payload carried with a renewed certificate for the same jkt: identity must not change (§5.4).
await add('one-off-renewed-certificate','envelope',{payload:oneOff.payload,proof:{...oneOff.proof,delegation:await alice.issue({iat:Math.floor(NOW/1000)-60,since:Math.floor(NOW/1000)-3600-3*86400,jti:'cert-alice-renewed'})}},{domain:E,body});
const genesis=await add('genesis','genesis',await genesisFor(alice,[alice,bob,carol]),{domain:DOMAINS.genesis});
const init=await add('conversation-init','envelope',await initEnvelope(alice,bob,[alice,bob,carol]),{domain:E,body:encoder.encode('Let us talk.')});
await add('invitation-response-accept','invitation-response',await invitationResponse(bob,init.payload.conversation.genesis),{domain:DOMAINS.invitationResponse});
const carolResponse=await add('invitation-response-carol','invitation-response',await invitationResponse(carol,init.payload.conversation.genesis),{domain:DOMAINS.invitationResponse});
await add('invitation-response-decline','invitation-response',await invitationResponse(bob,init.payload.conversation.genesis,{decision:'decline',acceptListed:false}),{domain:DOMAINS.invitationResponse});
const rec=async(name,type,options={},extra={})=>add(name,'envelope',await signEnvelope(await recordPayload(alice,bob,type,options),alice.signer),{domain:E,...extra});
const msgBody=encoder.encode('First message.'),message=await rec('record-message','message',{counter:1,body:msgBody},{body:msgBody});
const messageId=await eventId(message),editBody=encoder.encode('First message, edited.');
const edit=await rec('record-edit','edit',{counter:2,previous:messageId,parents:[messageId],target:messageId,body:editBody},{body:editBody});
const retract=await rec('record-retract','retract',{counter:3,previous:await eventId(edit),parents:[await eventId(edit)],target:messageId});
const proposal=await rec('record-peer-proposal','peer-proposal',{counter:4,previous:await eventId(retract),data:{principal:carol.principal,keyId:carol.keyId,introduction:carolResponse}});
await rec('record-peer-response','peer-response',{counter:5,previous:await eventId(proposal),data:{proposal:await eventId(proposal),decision:'accept'}});
await rec('record-rotate','rotate',{counter:6,previous:messageId,data:{newEpoch:EPOCH2,secretDigest:await secretDigest(SECRET2)}},{secret:SECRET2});
await rec('record-secret-share','secret-share',{counter:7,previous:messageId,data:{epoch:EPOCH,secretDigest:await secretDigest(SECRET)}},{secret:SECRET});
await rec('record-leave','leave',{counter:8,previous:messageId});
await rec('record-ingress','ingress',{counter:9,previous:messageId,data:{binding:binding(alice,'inc-for-bob-2')}});
await rec('record-rejoin','rejoin',{counter:10,previous:messageId,data:{binding:binding(alice,'inc-for-bob-3')}});
const hello=await add('record-peer-hello','envelope',await signEnvelope(await recordPayload(carol,bob,'peer-hello',{counter:1,data:{binding:binding(carol,'inc-carol-for-bob'),startCounter:1}}),carol.signer),{domain:E});
await add('receipt-one-off','receipt',await receiptFor(bob,oneOff),{domain:DOMAINS.receipt});
await add('receipt-record','receipt',await receiptFor(bob,message),{domain:DOMAINS.receipt});
await add('receipt-control-record','receipt',await receiptFor(bob,retract),{domain:DOMAINS.receipt});
// Multicast: one identical body to bob and carol on the same instance.
const toCarol=await signEnvelope(await linkPayload(alice,carol,{operationId:uuidOf(3),recipient:linkRecipient(carol,'jti-contact-carol','parent-carol')}),alice.signer);
const multicast=encodeMulticast({batchId:uuidOf(9),contexts:[{credential:{scheme:'BindleLink',value:'eyJhbGciOiJFUzI1NiJ9.eyJiaW5kbGUiOiJsaW5rLW1ldGEifQ.AAAA'},envelope:oneOff},{credential:{scheme:'BindleLink',value:'eyJhbGciOiJFUzI1NiJ9.eyJiaW5kbGUiOiJsaW5rLW1ldGEifQ.BBBB'},envelope:toCarol}]},body,{boundary:'bindlebox-vector-batch'});
const delivery=encodeDelivery(objects.find(o=>o.name==='record-rotate').signed,{secret:SECRET2,boundary:'bindlebox-vector-1'});
const tokenInput={conversationId:CONVERSATION,author:{issuer:alice.principal.issuer,subject:alice.principal.subject},recipient:{issuer:bob.principal.issuer,subject:bob.principal.subject},incarnation:'inc-for-alice'};
const token=await pairToken(SECRET,tokenInput),helloToken=await pairToken(SECRET,{...tokenInput,author:{issuer:carol.principal.issuer,subject:carol.principal.subject},incarnation:'hello'});
// A contact-delivery v1 style signature over the same payload: must never verify as Bindle Messaging (§5.2).
const legacyInput=encoder.encode('bindle-contact-delivery-v1\n'+jcs({alg:'ES256',kid:oneOff.proof.kid,payload:oneOff.payload}));
const legacySignature=base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},alice.signer.privateKey,legacyInput)));
const out={description:'Bindle Messaging interop v1 draft vectors (docs/spec/bindlebox.md §13). Test-only keys; placeholder .example identifiers; not a conformance claim.',profile:PROFILE,now:NOW,keys,
 parties:Object.fromEntries(NAMES.map(n=>[n,{principal:P[n].principal,keyId:P[n].keyId,identityPublicJwk:P[n].identity.publicJwk,jkt:P[n].jkt,certificate:P[n].signer.delegation,renewedJkt:P[n].renewed.jkt,renewedCertificate:P[n].renewed.delegation,ingress:P[n].ingress}])),
 objects,
 pairToken:{secretBase64url:base64url(SECRET),input:tokenInput,token,tokenDigest:await tokenDigest(token),edgeKey:await edgeKey({conversationId:CONVERSATION,author:tokenInput.author,owner:tokenInput.recipient}),helloToken},
 multipart:{name:'record-rotate',contentType:delivery.contentType,bytesBase64url:base64url(delivery.bytes)},
 multicast:{contentType:multicast.contentType,bytesBase64url:base64url(multicast.bytes),payloadDigests:[await payloadDigest(oneOff),await payloadDigest(toCarol)]},
 contactDeliveryV1:{name:'one-off',signature:legacySignature},
 helloEventId:await eventId(hello)};
await writeFile(file,JSON.stringify(out,null,1)+'\n');
console.log(`wrote ${objects.length} signed objects to ${file.pathname}`);
