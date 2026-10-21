// Test-only Bindle Messaging parties: identity keys, delegate keys, certificates and in-memory directory/status ports.
// Reserved .example hosts only. These fixtures are not a provider, directory or delegation service.
import {encodeDelegation,thumbprint,PURPOSES,PROFILE,contentDescriptor,signGenesis,signEnvelope,signInvitationResponse,signReceipt,receiptPayload,genesisDigest,secretDigest,base64url,fromBase64url} from '../../../packages/bindlebox-protocol/index.mjs';

export const NOW=Date.UTC(2026,9,20,12);
export const NAMES=['alice','bob','carol'];
export const SUBJECTS={alice:'a11ce000-0000-4000-8000-000000000001',bob:'b0b00000-0000-4000-8000-000000000002',carol:'ca401000-0000-4000-8000-000000000003'};
export const INGRESS={alice:'https://alice.box.example/ingress',bob:'https://hub.box.example/ingress',carol:'https://hub.box.example/ingress'};
export const MULTICAST='https://hub.box.example/multicast';
const ES={name:'ECDSA',namedCurve:'P-256'};
export const encoder=new TextEncoder();

export async function generateKeys(crypto=globalThis.crypto){
 const pair=async()=>{const k=await crypto.subtle.generateKey(ES,true,['sign','verify']);return crypto.subtle.exportKey('jwk',k.privateKey);};
 const out={};for(const name of NAMES)out[name]={identity:await pair(),delegate:await pair(),renewedDelegate:await pair()};return out;
}
const importPrivate=(jwk,crypto)=>crypto.subtle.importKey('jwk',jwk,ES,false,['sign']);
const pub=({kty,crv,x,y})=>({kty,crv,x,y});

export function principalOf(name){const issuer=`https://${name}.provider.example`,subject=SUBJECTS[name];return {issuer,subject,identityURI:`${issuer}/identity/${subject}`};}
// Certificate claims for a party; override any member to build a negative case.
export function claimsFor(name,delegateJwk,jkt,{now=NOW,purposes=[PURPOSES.author,PURPOSES.receipt].sort(),iat=Math.floor(now/1000)-3600,lifetime=86400,since=iat-3*86400,ingress=INGRESS[name],jti=`cert-${name}-${jkt.slice(0,8)}`,...extra}={}){
 const p=principalOf(name);
 return {bindle:'key-delegation',v:1,iss:p.issuer,sub:p.subject,delegate:pub(delegateJwk),jkt,purposes,client:{client_id:`https://${name}.box.example/client.json`,origin:`https://${name}.box.example`,...ingress==null?{}:{ingress}},cnx:`cnx-${name}`,since,jti,iat,exp:iat+lifetime,...extra};
}

// One party: author descriptor, signers and certificate(s). `keys` are the JWK sets from generateKeys().
export async function party(name,keys,{now=NOW,crypto=globalThis.crypto,claims={}}={}){
 const k=keys[name],principal=principalOf(name),keyId=`${principal.identityURI}#k1`,identityPrivate=await importPrivate(k.identity,crypto);
 const delegateJkt=await thumbprint(pub(k.delegate),crypto),renewedJkt=await thumbprint(pub(k.renewedDelegate),crypto);
 const issue=(jwk,jkt,over={})=>encodeDelegation(claimsFor(name,jwk,jkt,{now,...claims,...over}),{privateKey:identityPrivate,keyId},crypto);
 const delegation=await issue(k.delegate,delegateJkt);
 return {name,principal,keyId,ingress:INGRESS[name],identity:{keyId,publicJwk:pub(k.identity),privateKey:identityPrivate},
  author:{principal,identityDocument:`${principal.identityURI}/identity.json`,keyId,delegate:`jkt:${delegateJkt}`},
  signer:{privateKey:await importPrivate(k.delegate,crypto),delegation,kid:`jkt:${delegateJkt}`},
  renewed:{privateKey:await importPrivate(k.renewedDelegate,crypto),delegation:await issue(k.renewedDelegate,renewedJkt),kid:`jkt:${renewedJkt}`,jkt:renewedJkt},
  jkt:delegateJkt,issue:(over={},jwk=k.delegate,jkt=delegateJkt)=>issue(jwk,jkt,over),identityPrivate};
}
// In-memory directory and status ports with revocation and outage switches.
export function world(parties){
 const revoked=new Map(),down=new Set(),calls={resolve:0,status:0};
 const byIssuer=Object.fromEntries(Object.values(parties).map(p=>[p.principal.issuer,p]));
 return {calls,revoke(jkt,hour){revoked.set(jkt,hour);},outage(kind){down.add(kind);},restore(kind){down.delete(kind);},
  resolveKey:async({issuer,subject,keyId})=>{calls.resolve++;if(down.has('directory'))throw new Error('directory down');const p=byIssuer[issuer];return p&&p.principal.subject===subject&&p.keyId===keyId?{keyId,publicJwk:p.identity.publicJwk,identityURI:p.principal.identityURI}:null;},
  status:async({jkt})=>{calls.status++;if(down.has('status'))throw new Error('status down');return revoked.has(jkt)?{status:'revoked',revokedHour:revoked.get(jkt)}:{status:'active'};}};
}

export const CONVERSATION='c0c0c0c0-0000-4000-8000-00000000c0c0';
export const EPOCH='e0e0e0e0-0000-4000-8000-00000000e0e0';
export const EPOCH2='e0e0e0e0-0000-4000-8000-00000000e0e2';
export const SECRET=Uint8Array.from({length:32},(_,i)=>i+1);
export const SECRET2=Uint8Array.from({length:32},(_,i)=>64+i);
export const NONCE=base64url(Uint8Array.from({length:16},(_,i)=>200-i));
export const linkRecipient=(to,contactId='jti-contact-1',resource='parent-1')=>({issuer:to.principal.issuer,owner:to.principal.subject,contactId,resource});
export const recordRecipient=(to,incarnation='inc-for-alice')=>({issuer:to.principal.issuer,owner:to.principal.subject,conversationId:CONVERSATION,incarnation});
export const binding=(p,incarnation=`inc-from-${p.name}`)=>({ingress:p.ingress,incarnation,profiles:[PROFILE],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536,maxBatchContexts:32},...p.ingress.startsWith('https://hub.')?{multicast:MULTICAST}:{}});
export const uuidOf=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

export async function linkPayload(from,to,{kind='one-off',body=encoder.encode('Hello from the vectors.'),mimeType='text/plain',operationId=uuidOf(1),createdAt=NOW-60000,subject='Hello',optionalTags=[],recipient=linkRecipient(to),...extra}={},crypto=globalThis.crypto){
 return {version:1,profile:PROFILE,kind,noReply:kind==='one-off',operationId,createdAt,recipient,content:await contentDescriptor(mimeType,body,crypto),subject,optionalTags,author:from.author,...extra};
}
export async function genesisFor(creator,participants,{body=encoder.encode('Let us talk.'),createdAt=NOW-120000,subject='Planning'}={},crypto=globalThis.crypto){
 return signGenesis({version:1,profile:PROFILE,conversationId:CONVERSATION,createdAt,creator:creator.author,participants:participants.map(p=>({principal:p.principal,keyId:p.keyId})),secretEpoch:EPOCH,secretDigest:await secretDigest(SECRET,crypto),subject,content:await contentDescriptor('text/plain',body,crypto)},creator.signer,{crypto});
}
export async function initEnvelope(creator,invitee,participants,{body=encoder.encode('Let us talk.'),createdAt=NOW-60000}={},crypto=globalThis.crypto){
 const genesis=await genesisFor(creator,participants,{body},crypto);
 const payload=await linkPayload(creator,invitee,{kind:'conversation-init',body,createdAt,operationId:uuidOf(2),subject:'Planning',conversation:{genesis,sharedSecret:base64url(SECRET),returnControl:{resource:`${new URL(creator.ingress).origin}/return/invite-1`,nonce:NONCE,expiresAt:createdAt+86400000,maxResponseBytes:8192},creatorBinding:binding(creator,`inc-for-${invitee.name}`)}},crypto);
 return signEnvelope(payload,creator.signer,{crypto});
}
export async function recordPayload(from,to,type,{counter=1,previous=null,parents=[],target,data,body,incarnation=`inc-for-${from.name}`,createdAt=NOW-30000,operationId=uuidOf(100+counter),epoch=EPOCH,stream=from.author.delegate,...extra}={},crypto=globalThis.crypto){
 return {version:1,profile:PROFILE,kind:'conversation-record',noReply:false,operationId,createdAt,recipient:recordRecipient(to,type==='peer-hello'?'hello':incarnation),content:body?await contentDescriptor('text/plain',body,crypto):null,subject:'',optionalTags:[],author:from.author,
  record:{type,conversationId:CONVERSATION,epoch,stream,counter,previous,parents,...target?{target}:{},...data?{data}:{}},...extra};
}
export async function invitationResponse(responder,genesis,{decision='accept',acceptListed=true,createdAt=NOW-30000}={},crypto=globalThis.crypto){
 return signInvitationResponse({version:1,profile:PROFILE,conversationId:CONVERSATION,genesisDigest:await genesisDigest(genesis,crypto),nonce:NONCE,decision,acceptListed,responder:responder.author,...decision==='accept'?{binding:binding(responder)}:{},createdAt},responder.signer,{crypto});
}
export async function receiptFor(recipient,envelope,{receivedAt=NOW-10000,ingress=recipient.ingress}={},crypto=globalThis.crypto){
 return signReceipt(await receiptPayload(envelope,{recipient:recipient.principal,ingress,receivedAt},crypto),recipient.signer,{crypto});
}
export {fromBase64url,base64url};
