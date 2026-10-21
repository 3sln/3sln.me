// BB-B6 portable archive writer (spec §10; architecture §8, §16). Pure helpers with no mailbox store access:
//  - the export classification of mailbox rows (allowlist; unknown keys are never exported or imported) and the
//    sanitizers that keep secrets, link metas, pair/return capabilities and delegate keys out of every archive;
//  - a faithful value codec (bytes and byte arrays as base64) and JSON-lines records {t,k,v} / deletions {t,k,d:1};
//  - per-object sealing to the owner's identity encryption key (ECDH-ES P-256 ephemeral, HKDF-SHA-256 bound to
//    kid/name/owner/epk, a random AES-256-GCM content key wrapped under it, the header as content AAD). The writer
//    needs only the public key; opening needs `unwrap(header, proof)` from the key holder (provider custody, or the
//    recovery file offline), which runs the archive HKDF itself and returns only that object's content key, never a
//    raw ECDH output (review BB6-S1), and only to a fresh proof of possession of the occupant's archive-purpose delegate
//    key (BB6-S2). Not end-to-end encryption: the provider holds the private key today;
//  - the manifest: a compact JWS (`typ` bindlebox-archive+jwt) signed by the occupant's delegate key under the archive
//    purpose, embedding its certificate, verified against the owner's identity key, purpose, lifetime and revocation;
//  - an object-storage/v1 client (get/put/delete with absent/version conditions, 1 MiB objects, no listing).
// Provisional profile and deviations: docs/release/bindlebox-archive-review.md.
import * as P from '../../bindlebox-protocol/index.mjs';
import {signES256,verifyES256} from '../../bindlebox-protocol/certificate.mjs';
import {equalDigest} from '../../bindlebox-protocol/encoding.mjs';
import {fault,MailboxFault} from '../faults.mjs';

export const ARCHIVE_PREFIX='bindlebox/v1/',MANIFEST_KEY=`${ARCHIVE_PREFIX}manifest.json`,MANIFEST_TYP='bindlebox-archive+jwt',SEAL_ALG='ECDH-ES+A256GCM';
export const ARCHIVE_LIMITS=Object.freeze({objectBytes:1048576,segmentBytes:786432,segments:2048,deltasBeforeCompaction:32,leaseMs:24*3600000,lockMs:600000,gcGraceMs:24*3600000,checkpointMs:15*60000,batchRows:256,retired:4096});
const te=new TextEncoder(),td=new TextDecoder('utf-8',{fatal:true}),MAGIC=te.encode('BBX1'),ECDH={name:'ECDH',namedCurve:'P-256'};
const NAME=/^bindlebox\/v1\/(segments|blobs)\/[A-Za-z0-9_-]{16,128}$/;
export const objectName=(kind,random=globalThis.crypto)=>`${ARCHIVE_PREFIX}${kind==='blob'?'blobs':'segments'}/${P.base64url(random.getRandomValues(new Uint8Array(24)))}`;

// Standard base64 for the object-storage dataBase64 member; canonical form only.
export const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
export const unb64=s=>{let raw;try{raw=atob(s);}catch{fault('archive_corrupt','The archive is damaged.',422);}const out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);if(b64(out)!==s)fault('archive_corrupt','The archive is damaged.',422);return out;};
export const digest=async bytes=>P.sha256(globalThis.crypto,bytes);
const corrupt=()=>fault('archive_corrupt','The archive is damaged or was changed outside BindleBox.',422);

// ---- Value codec. Mailbox values are structured-clone data: plain objects, arrays, strings, safe numbers, booleans,
// null and Uint8Array. Byte arrays (Array of 0–255 integers, as conv/body rows hold) are packed; a literal `$` member
// is escaped. Anything else (Map, Date, functions) refuses to export rather than silently changing shape.
const isPlain=v=>v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const byteArray=v=>v.length>=32&&v.every(n=>Number.isInteger(n)&&n>=0&&n<256);
export function encodeValue(v,depth=0){
 if(depth>64)fault('archive_unsupported','A mailbox value is too deeply nested to archive.',500);
 if(v===null||typeof v==='string'||typeof v==='boolean')return v;
 if(typeof v==='number'){if(!Number.isFinite(v))fault('archive_unsupported','A mailbox value cannot be archived.',500);return v;}
 if(v instanceof Uint8Array)return {$:'u8',d:b64(v)};
 if(Array.isArray(v))return byteArray(v)?{$:'a8',d:b64(Uint8Array.from(v))}:v.map(x=>x===undefined?null:encodeValue(x,depth+1));
 if(isPlain(v)){const o={};for(const k of Object.keys(v))if(v[k]!==undefined)o[k]=encodeValue(v[k],depth+1);return Object.hasOwn(v,'$')?{$:'o',v:o}:o;}
 fault('archive_unsupported','A mailbox value cannot be archived.',500);
}
export function decodeValue(v,depth=0){
 if(depth>64)corrupt();
 if(v===null||typeof v!=='object')return v;
 if(Array.isArray(v))return v.map(x=>decodeValue(x,depth+1));
 if(typeof v.$==='string'){
  const keys=Object.keys(v).sort().join(',');
  if(v.$==='u8'&&keys==='$,d'&&typeof v.d==='string')return unb64(v.d);
  if(v.$==='a8'&&keys==='$,d'&&typeof v.d==='string')return Array.from(unb64(v.d));
  if(v.$==='o'&&keys==='$,v'&&isPlain(v.v)){const o={};for(const k of Object.keys(v.v))o[k]=decodeValue(v.v[k],depth+1);return o;}
  corrupt();
 }
 const o={};for(const k of Object.keys(v))o[k]=decodeValue(v[k],depth+1);return o;
}

// ---- Classification (spec §10 record types; phases are the import order: control, peers, outbox, items). First match
// wins. Excluded by omission: owner, config, shell:*, edge outboxes, conv/secret, conv/route, conv/work, conv/response,
// bb:send body/queue/breaker/events, cursors, hot usage (recomputed on import) and archive/* itself.
const R=(prefix,type,phase,exact=false)=>Object.freeze({prefix,type,phase,exact});
export const ARCHIVE_CLASSES=Object.freeze([
 R('block/','block',0),R('revoked/','revocation',0),R('conv/frontier/','frontier',0),R('conv/mutations/','pending-mutation',0),
 R('conv/replay/','replay',0),R('replay/','replay',0),R('conv/evidence/','evidence',0),R('intake/jti/','replay',0),R('intake/tx/','replay',0),
 R('bridge/fp/','replay',0),R('edge-seq','counter',0,true),R('conv-edge-seq','counter',0,true),
 R('conv/settings','overlay',1,true),R('conv/room/','conversation',1),R('conv/peer/','peer',1),R('conv/stream/','stream-head',1),
 R('conv/intro/','peer',1),R('conv/invite/','peer',1),R('conv/rotation/','peer',1),R('conv/allowance','quota',1,true),R('conv/placeholder/','gap',1),
 R('bb:send:message/','outbox',2),R('bb:send:task/','outbox',2),R('conv/op/','outbox',2),
 R('conv/event/','item',3),R('conv/body/','body-ref',3),R('conv/by-jkt/','item',3),R('conv/decided/','overlay',3),
 R('item/','item',3),R('body/','body-ref',3),R('pending/','item',3),R('rejected/','item',3),R('by-jkt/','item',3),R('seen-jkt/','item',3),
 R('parent/','link-parent',3),R('contact/','contact',3),R('contact-link/','contact',3),R('known/','contact',3),R('allow/','rule',3),
 R('settings/','overlay',3),R('budget/','quota',3),R('bridge/settings','overlay',3,true),R('storage-gc/','gc',3),
 R('bb:views/','view',3),R('bb:view-operations/','view',3),R('bb:rules','rule',3,true),R('bb:classify:settings','rule',3,true),R('bb:tag-labels','tag-label',3,true),
 R('bb:incoming:row/','overlay',3),R('bb:incoming:organization/','overlay',3),R('bb:incoming:revision','counter',3,true),
]);
export const classify=key=>typeof key==='string'?ARCHIVE_CLASSES.find(c=>c.exact?key===c.prefix:key.startsWith(c.prefix))??null:null;
export const COUNTERS=new Set(['edge-seq','conv-edge-seq','bb:incoming:revision']);
const FINAL=new Set(['delivered','rejected','expired','cancelled']);
export const manualEnd=t=>(t.createdAt??0)+(t.kind==='conversation-record'?7*86400000:86400000)-3600000;
const TASK_FIELDS=['id','messageId','principal','peer','state','revision','attempts','nextAttemptAt','deadline','reason','class','createdAt','kind','manualUsed','generation','conversation','host','ingress','deliveredBeforeCancel','control','budgetEnd','notBefore','repaired','obligation','receipt','resend'];
// Final send obligations as summaries: no envelope (a conversation-init embeds the secret), credential or secret part.
export const compactTask=t=>({...Object.fromEntries(TASK_FIELDS.filter(k=>t[k]!==undefined).map(k=>[k,structuredClone(t[k])])),envelope:null,credential:null,secret:null,lease:null,compact:true});
export const compactMessage=m=>({fingerprint:m.fingerprint??null,bodyKeys:[],hasBody:false,tasks:[...m.tasks??[]],revision:m.revision??0,compact:true});
// Sanitizers run on export and again on import, so even a hostile archive cannot plant a secret-bearing row.
export function sanitize(key,value,{phase='export'}={}){
 const v=structuredClone(value);
 if(key.startsWith('conv/event/')&&v.envelope&&!['message','edit','retract'].includes(v.type))delete v.envelope;
 if(key.startsWith('conv/rotation/')){if(v?.state==='pending')return undefined;return {...v,secret:null};}
 if(key.startsWith('conv/invite/'))return {...v,nonce:null,route:null};
 if(key.startsWith('conv/op/')){const unsent=!v.submitted;return {operationId:v.operationId,cid:v.cid,eventId:v.eventId,type:v.type,kid:v.kid,createdAt:v.createdAt,knownRotation:Boolean(v.knownRotation),recipients:unsent?[]:(v.recipients??[]).map(r=>({principal:r.principal})),prepared:null,secret:null,payload:null,hasBody:false,submitted:true,abandoned:Boolean(v.abandoned),...unsent?{unsent:true}:{}};}
 if(key.startsWith('bb:send:task/')){const t=compactTask(v);if(phase==='import'&&!FINAL.has(t.state))Object.assign(t,{state:'expired',reason:'moved',resend:true,manualUsed:true});return t;}
 if(key.startsWith('bb:send:message/'))return compactMessage(v);
 if(key.startsWith('parent/'))return {...v,link:null};
 // Invitations lose the secret and the creator's return capability; an undecided one needs a fresh invitation (BB6-S9).
 if(key.startsWith('item/')&&v?.envelope?.payload?.conversation){const c=v.envelope.payload.conversation;if(Object.hasOwn(c,'sharedSecret')||Object.hasOwn(c,'returnControl')||Object.hasOwn(c,'creatorBinding')){delete c.sharedSecret;delete c.returnControl;delete c.creatorBinding;v.secretRedacted=true;v.needsReinvite=true;}}
 return v;
}
export const recordType=(c,value)=>c.prefix==='conv/event/'&&value?.type==='retract'?'tombstone':c.type;
// One archive line. Deletions carry no value; types come from the classification, never from the archive alone.
export function lineOf(key,value){
 const c=classify(key);if(!c)return null;
 if(value===undefined)return JSON.stringify({t:c.type,k:key,d:1});
 const v=sanitize(key,value);if(v===undefined)return null;
 return JSON.stringify({t:recordType(c,v),k:key,v:encodeValue(v)});
}
// Parses and validates one logical line: the key must be exportable, its declared type must match, and its value is
// re-sanitized for import.
export function parseLine(line){
 let r;try{r=P.strictJSON(line,{maxBytes:64*1048576,maxDepth:72});}catch{corrupt();}
 if(!isPlain(r)||typeof r.t!=='string'||typeof r.k!=='string'||r.k.length>2048)corrupt();
 const c=classify(r.k);if(!c)fault('archive_invalid','The archive contains data BindleBox does not import.',422);
 if(r.d===1){if(Object.keys(r).sort().join(',')!=='d,k,t'||r.t!==c.type)corrupt();return {key:r.k,type:c.type,phase:c.phase,deleted:true};}
 if(Object.keys(r).sort().join(',')!=='k,t,v')corrupt();
 const value=sanitize(r.k,decodeValue(r.v),{phase:'import'});if(value===undefined)return {key:r.k,type:c.type,phase:c.phase,deleted:true};
 if(r.t!==recordType(c,value))corrupt();
 return {key:r.k,type:r.t,phase:c.phase,value};
}

// ---- Sealing. Object layout: "BBX1" | u32 header length | header JSON | AES-256-GCM ciphertext (AAD = header bytes).
const hkdfKey=async(z,{kid,name,owner,epk},usages)=>{
 const base=await crypto.subtle.importKey('raw',z,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:te.encode(`bindlebox-archive-v1\n${P.jcs({kid,name,owner,epk})}`)},base,{name:'AES-GCM',length:256},false,usages);
};
const ownerOf=p=>({issuer:p.issuer,subject:p.subject});
const pubJwk=({kty,crv,x,y})=>({kty,crv,x,y});
export async function sealObject(plain,{key,name,owner,kind}){
 if(!key||typeof key.kid!=='string'||!key.kid||key.kid.length>200)fault('archive_keys_unavailable','Your encryption key is unavailable.',503);
 let recipient;try{recipient=await crypto.subtle.importKey('jwk',{...pubJwk(key.publicJwk),ext:true},ECDH,false,[]);}catch{fault('archive_keys_unavailable','Your encryption key is unavailable.',503);}
 const eph=await crypto.subtle.generateKey(ECDH,true,['deriveBits']),epk=pubJwk(await crypto.subtle.exportKey('jwk',eph.publicKey));
 const z=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:recipient},eph.privateKey,256)),o=ownerOf(owner);
 const kek=await hkdfKey(z,{kid:key.kid,name,owner:o,epk},['encrypt']);z.fill(0);
 const dek=crypto.getRandomValues(new Uint8Array(32)),wiv=crypto.getRandomValues(new Uint8Array(12)),iv=crypto.getRandomValues(new Uint8Array(12));
 const wct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:wiv,additionalData:te.encode('bindlebox-archive-wrap-v1')},kek,dek));
 const header=te.encode(JSON.stringify({v:1,alg:SEAL_ALG,kid:key.kid,epk,wiv:P.base64url(wiv),wct:P.base64url(wct),iv:P.base64url(iv),name,owner:o,kind}));
 const content=await crypto.subtle.importKey('raw',dek,{name:'AES-GCM'},false,['encrypt']);dek.fill(0);
 const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:header},content,plain));
 const out=new Uint8Array(8+header.length+ct.length);out.set(MAGIC,0);new DataView(out.buffer).setUint32(4,header.length);out.set(header,8);out.set(ct,8+header.length);
 if(out.length>ARCHIVE_LIMITS.objectBytes)fault('archive_too_large','An archive object exceeds the storage limit.',500);
 return out;
}
// Opens one object fetched under `name` for `owner`. A header naming another object, owner or algorithm, a wrong key
// or any modified byte fails as archive_corrupt; an unavailable key holder fails as archive_keys_unavailable.
export async function openObject(bytes,{name,owner,kind,unwrap}){
 if(!(bytes instanceof Uint8Array)||bytes.length<8||!MAGIC.every((b,i)=>bytes[i]===b))corrupt();
 const n=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4);if(n<16||n>4096||8+n+16>bytes.length)corrupt();
 const hb=bytes.subarray(8,8+n);let h;try{h=P.strictJSON(td.decode(hb),{maxBytes:4096,maxDepth:4});}catch{corrupt();}
 const o=ownerOf(owner);
 if(!isPlain(h)||Object.keys(h).sort().join(',')!=='alg,epk,iv,kid,kind,name,owner,v,wct,wiv'||h.v!==1||h.alg!==SEAL_ALG||h.name!==name||h.kind!==kind||!isPlain(h.owner)||h.owner.issuer!==o.issuer||h.owner.subject!==o.subject||typeof h.kid!=='string')corrupt();
 let dek;try{dek=await unwrap({kid:h.kid,epk:pubJwk(h.epk),name,owner:o,wiv:h.wiv,wct:h.wct});}catch(error){if(error instanceof MailboxFault)throw error;fault('archive_keys_unavailable','Your encryption key is unavailable.',503);}
 if(!(dek instanceof Uint8Array)||dek.length!==32)fault('archive_keys_unavailable','Your encryption key is unavailable.',503);
 try{
  const content=await crypto.subtle.importKey('raw',dek,{name:'AES-GCM'},false,['decrypt']);dek.fill(0);
  return {kid:h.kid,plain:new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:P.fromBase64url(h.iv,12),additionalData:hb},content,bytes.subarray(8+n)))};
 }catch{corrupt();}
}
// Key-holder side of `unwrap`: ECDH with the owner's private encryption key, the archive HKDF bound to this object's
// kid/name/owner/epk, and the wrapped content key. Returns only the 32-byte content key of that one object; a wrong
// key, name or owner fails. The holder MUST first check `verifyUnwrapProof` (and should log the object name).
export async function localUnwrap(privateKey,{kid,epk,name,owner,wiv,wct}){
 const pub=await crypto.subtle.importKey('jwk',{...pubJwk(epk),ext:true},ECDH,false,[]);
 const z=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:pub},privateKey,256));
 const kek=await hkdfKey(z,{kid,name,owner:ownerOf(owner),epk:pubJwk(epk)},['decrypt']);z.fill(0);
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:P.fromBase64url(wiv,12),additionalData:te.encode('bindlebox-archive-wrap-v1')},kek,P.fromBase64url(wct)));
}
// Proof of possession for one unwrap: the delegate key signs the object, its key ID and the current time. The
// certificate alone is public (it is in the manifest and every envelope), so it never authorizes an unwrap.
const proofInput=({name,kid,at,jkt})=>te.encode(`bindlebox-archive-unwrap-v1\n${P.jcs({name,kid,at,jkt})}`);
export async function unwrapProof(signer,{name,kid,at}){return {at,signature:await signES256(signer.privateKey,proofInput({name,kid,at,jkt:signer.jkt}))};}
// Key-holder check: archive purpose for this owner, the certificate's key signed this request within 60 s. The holder
// separately checks that the certificate's key is the current occupant's and that the certificate verifies.
export async function verifyUnwrapProof({delegation,proof,name,kid,owner,now}){
 let jws;try{jws=P.parseDelegation(delegation);}catch{return false;}
 const c=jws.claims;if(!c.purposes.includes(P.PURPOSES.archive)||c.iss!==owner.issuer||c.sub!==owner.subject||!isPlain(proof)||!Number.isSafeInteger(proof.at)||Math.abs(now-proof.at)>P.LIMITS.clockSkewMs||typeof proof.signature!=='string')return false;
 let signature;try{signature=P.fromBase64url(proof.signature,64);}catch{return false;}
 return verifyES256(c.delegate,signature,proofInput({name,kid,at:proof.at,jkt:c.jkt}));
}

// ---- Manifest (spec §10): compact JWS over the received bytes; the payload embeds the signing certificate.
const enc=v=>P.base64url(te.encode(JSON.stringify(v)));
export async function signManifest(payload,signer){const head=`${enc({alg:'ES256',kid:signer.kid,typ:MANIFEST_TYP})}.${enc(payload)}`;return `${head}.${await signES256(signer.privateKey,te.encode(head))}`;}
// Key ranges stay in the sealed objects and the writer's local journal, never in the plaintext manifest (BB6-S6).
const SEGMENT_KEYS='bytes,count,keyId,kind,name,sha256';
function payloadShape(p,owner){
 const ok=isPlain(p)&&p.version===1&&p.profile===P.PROFILE&&isPlain(p.owner)&&p.owner.issuer===owner.issuer&&p.owner.subject===owner.subject
  &&Number.isSafeInteger(p.generation)&&p.generation>0&&Number.isSafeInteger(p.base)&&p.base>0&&p.base<=p.generation&&Number.isSafeInteger(p.writtenAt)&&Number.isSafeInteger(p.leaseUntil)&&Number.isSafeInteger(p.controlGeneration)
  &&isPlain(p.writer)&&typeof p.writer.client_id==='string'&&typeof p.writer.cnx==='string'&&typeof p.writer.jkt==='string'&&(p.previous===null||typeof p.previous==='string')&&typeof p.handoff==='boolean'
  &&(p.plan===null||typeof p.plan==='string')&&(p.takeover===null||isPlain(p.takeover))&&typeof p.delegation==='string'&&Array.isArray(p.segments)&&p.segments.length<=ARCHIVE_LIMITS.segments
  &&Array.isArray(p.retired)&&p.retired.length<=ARCHIVE_LIMITS.retired;
 if(!ok)corrupt();
 const names=new Set();
 for(const s of p.segments){if(!isPlain(s)||Object.keys(s).sort().join(',')!==SEGMENT_KEYS||!NAME.test(s.name)||!s.name.includes('/segments/')||names.has(s.name)||typeof s.sha256!=='string'||s.sha256.length!==43||!Number.isSafeInteger(s.bytes)||!Number.isSafeInteger(s.count)||!['snapshot','delta'].includes(s.kind)||typeof s.keyId!=='string')corrupt();names.add(s.name);}
 // Retired objects are never live segments.
 for(const r of p.retired)if(!isPlain(r)||Object.keys(r).sort().join(',')!=='after,name'||!NAME.test(r.name)||names.has(r.name)||!Number.isSafeInteger(r.after))corrupt();
 // The base snapshot's segments come first; every later entry is a delta.
 let seenDelta=false;for(const s of p.segments){if(s.kind==='delta')seenDelta=true;else if(seenDelta)corrupt();}
}
// Verifies signature, owner, certificate (owner identity key, archive purpose, lifetime at writtenAt) and revocation.
// A manifest written at or after a revoked key's quarantine hour is trusted only when its digest is in `trusted` (the
// exact handoff anchor, or a manifest this mailbox itself recorded writing).
export async function verifyManifest(compact,{owner,directory,now,trusted=[]}){
 if(typeof compact!=='string'||compact.length>ARCHIVE_LIMITS.objectBytes)corrupt();
 const parts=compact.split('.');if(parts.length!==3)corrupt();
 let header,payload;try{header=P.strictJSON(td.decode(P.fromBase64url(parts[0])),{maxBytes:1024,maxDepth:4});payload=P.strictJSON(td.decode(P.fromBase64url(parts[1])),{maxBytes:ARCHIVE_LIMITS.objectBytes,maxDepth:8});}catch{corrupt();}
 if(!isPlain(header)||Object.keys(header).sort().join(',')!=='alg,kid,typ'||header.alg!=='ES256'||header.typ!==MANIFEST_TYP)corrupt();
 payloadShape(payload,owner);
 const untrusted=()=>fault('archive_untrusted','This archive was not written by your messaging app.',403);
 let jkt,cert;try{jkt=P.jktOf(header.kid);cert=P.parseDelegation(payload.delegation);}catch{untrusted();}
 let identityKey;try{identityKey=await directory.resolveKey({issuer:owner.issuer,subject:owner.subject,identityURI:owner.identityURI,keyId:cert.header.kid});}catch{fault('archive_unavailable','Your identity could not be checked. Try again.',503);}
 if(!isPlain(identityKey)||(owner.identityURI&&identityKey.identityURI!==owner.identityURI))untrusted();
 let verified;try{verified=await P.verifyDelegation(payload.delegation,{identityKey,principal:owner,keyId:cert.header.kid,jkt,purpose:P.PURPOSES.archive,now:payload.writtenAt,at:payload.writtenAt});}catch{untrusted();}
 const c=verified.claims;
 if(payload.writer.jkt!==jkt||payload.writer.cnx!==c.cnx||payload.writer.client_id!==c.client.client_id||payload.writtenAt>now+P.LIMITS.clockSkewMs)untrusted();
 if(!verified.delegateKey||!await verifyES256(verified.delegateKey,P.fromBase64url(parts[2],64),te.encode(`${parts[0]}.${parts[1]}`)))untrusted();
 const manifestDigest=await digest(te.encode(compact));
 let status;try{status=await directory.status({issuer:owner.issuer,subject:owner.subject,identityURI:owner.identityURI,jkt});}catch{status=undefined;}
 if(isPlain(status)&&status.status==='revoked'){if(P.quarantined(payload.writtenAt,status.revokedHour)&&!trusted.some(d=>equalDigest(String(d),manifestDigest)))untrusted();}
 else if(!isPlain(status)||status.status!=='active')fault('archive_unavailable','Your messaging key status could not be checked. Try again.',503);
 return {payload,digest:manifestDigest,jkt,certificate:c,active:status.status==='active'};
}

// ---- object-storage/v1 client. `port.call(method, args)` returns the contract result or throws {code}.
const STORAGE_DOWN=()=>fault('archive_storage_unavailable','Your storage is unavailable. Try again later.',503);
export function storageClient(port){
 if(!port||typeof port.call!=='function')STORAGE_DOWN();
 const call=async(method,args)=>{try{return await port.call(method,args);}catch(error){if(['not_found','conflict','unsupported_method','forbidden','quota_exceeded','body_too_large'].includes(error?.code))throw new MailboxFault(error.code,error.code,error.status);STORAGE_DOWN();}};
 return Object.freeze({
  async get(key){let r;try{r=await call('get',{key});}catch(error){if(error.code==='not_found')return null;if(error.code==='forbidden')STORAGE_DOWN();throw error;}if(!isPlain(r)||typeof r.dataBase64!=='string'||!isPlain(r.object)||typeof r.object.version!=='string')corrupt();return {bytes:unb64(r.dataBase64),version:r.object.version};},
  async put(key,bytes,condition){if(bytes.length>ARCHIVE_LIMITS.objectBytes)fault('archive_too_large','An archive object exceeds the storage limit.',500);let r;try{r=await call('put',{key,dataBase64:b64(bytes),condition,contentType:'application/octet-stream'});}catch(error){if(['quota_exceeded','body_too_large'].includes(error.code))fault('archive_storage_full','Your storage is full.',507);if(error.code==='forbidden')STORAGE_DOWN();throw error;}if(!isPlain(r?.object)||typeof r.object.version!=='string')STORAGE_DOWN();return r.object.version;},
  // Deletion: true when removed or already gone; 'unsupported' where the backend has no conditional delete.
  async delete(key,version){try{const r=await call('delete',{key,version});return r?.physicalRetention?'retained':true;}catch(error){if(error.code==='not_found')return true;if(['unsupported_method','forbidden'].includes(error.code))return 'unsupported';throw error;}},
 });
}

// ---- Segment planning. Entries are sorted by key; a segment covers the keys after its predecessor's `last` up to
// its own `last`, and its `digest` covers its logical lines, so an interrupted plan can be resumed segment by segment
// when the same range still has exactly the same lines.
export async function plan(entries,{segmentBytes=ARCHIVE_LIMITS.segmentBytes}={}){
 const out=[];let current=null;
 const close=async()=>{if(current){current.digest=await digest(te.encode(current.lines.join('\n')));out.push(current);current=null;}};
 for(const e of entries){
  const size=te.encode(e.line).length+1;
  if(current&&current.bytes+size>segmentBytes)await close();
  current??={lines:[],first:e.key,last:e.key,bytes:0,control:false};
  current.lines.push(e.line);current.last=e.key;current.bytes+=size;if(e.phase===0)current.control=true;
 }
 await close();return out;
}
// Splits an oversized logical line into blob parts; the segment line keeps only their names and ciphertext digests.
export const blobParts=(line,{segmentBytes=ARCHIVE_LIMITS.segmentBytes}={})=>{const bytes=te.encode(line),parts=[];for(let at=0;at<bytes.length;at+=segmentBytes)parts.push(bytes.subarray(at,at+segmentBytes));return parts;};
export const utf8=bytes=>{try{return td.decode(bytes);}catch{corrupt();}};
export {te as encoder};
