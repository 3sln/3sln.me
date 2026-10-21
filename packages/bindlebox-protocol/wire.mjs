// Transport framing (spec §7.1, §7.3, §2.2, §9): strict multipart/form-data for single and multicast delivery, and the
// mailbox/public-intake RPC requests. Adapted from core contact-delivery-wire.mjs (copied, not imported). Parsers
// never consult credentials; the edge checks those first. Each parser yields one semantic operation or a ProtocolFault.
import {LIMITS,MAILBOX_CONTRACT,INTAKE_CONTRACT,JWS_TYPES} from './constants.mjs';
import {fail,malformed,textEncoder,strictJSON,utf8,exact,plain,text,time,uuid,isUUID,mimeValid,fromBase64url,base64url,sha256,jcs,urlValue,originValue,compactValue,digestValue,sameValue} from './encoding.mjs';
import {validateEnvelope,validateContent,validatePrincipal,clampLimits,payloadDigest,eventId,recordShape} from './envelope.mjs';
import {credentialScheme,parseCredential} from './conversation.mjs';
import {parseCompact,verifyES256} from './certificate.mjs';

const indexOf=(bytes,needle,from)=>{const first=needle[0];outer:for(let i=bytes.indexOf(first,from);i>=0&&i<=bytes.length-needle.length;i=bytes.indexOf(first,i+1)){for(let j=1;j<needle.length;j++)if(bytes[i+j]!==needle[j])continue outer;return i;}return -1;};
const startsAt=(bytes,needle,at)=>at+needle.length<=bytes.length&&needle.every((b,i)=>bytes[at+i]===b);
const tchar="[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quoted='"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"';
const PARAMS=new RegExp(`;\\s*(${tchar})=(${tchar}|${quoted})`,'g');
const parameters=(value,head)=>{
 const m=new RegExp(`^${head}((?:\\s*;\\s*${tchar}=(?:${tchar}|${quoted}))*)\\s*$`,'i').exec(value);if(!m)malformed();
 const out=new Map();for(const [,name,raw] of m[1].matchAll(PARAMS)){const k=name.toLowerCase();if(out.has(k))malformed();out.set(k,raw.startsWith('"')?raw.slice(1,-1).replace(/\\(.)/g,'$1'):raw);}
 return out;
};
const BOUNDARY=/^[0-9A-Za-z'()+_,./:=?-]{1,70}$/;
export function multipartBoundary(contentType){
 if(typeof contentType!=='string'||contentType.length>256)malformed();
 const params=parameters(contentType,'multipart/form-data'),boundary=params.get('boundary');
 if(params.size!==1||!boundary||!BOUNDARY.test(boundary))malformed();return boundary;
}
// Only Content-Disposition (form-data; name; optional inert filename) and Content-Type; visible ASCII; no duplicates.
const partHeaders=block=>{
 if(block.byteLength>1024||block.some(b=>b>0x7e||(b<0x20&&b!==0x0d&&b!==0x0a)))malformed();
 const headers=new Map();for(const line of utf8(block).split('\r\n')){const m=/^([A-Za-z0-9-]+):[ \t]*(.*?)[ \t]*$/.exec(line);if(!m||/[\r\n]/.test(m[2]))malformed();const k=m[1].toLowerCase();if(headers.has(k)||!['content-disposition','content-type'].includes(k))malformed();headers.set(k,m[2]);}
 const disposition=parameters(headers.get('content-disposition')??'','form-data');
 if([...disposition.keys()].some(k=>!['name','filename'].includes(k))||!disposition.has('name'))malformed();
 return {name:disposition.get('name'),type:headers.get('content-type')};
};
// No preamble, epilogue (beyond one CRLF), transfer encoding, nested multipart, extra or duplicate parts.
function parseParts(contentType,bytes,{names,maxBytes}){
 if(!(bytes instanceof Uint8Array))malformed();if(bytes.byteLength>maxBytes)fail('too_large');
 const boundary=multipartBoundary(contentType),dash=textEncoder.encode(`--${boundary}`),delimiter=textEncoder.encode(`\r\n--${boundary}`),crlf=[13,10],blank=textEncoder.encode('\r\n\r\n');
 if(!startsAt(bytes,[...dash,...crlf],0))malformed();
 const parts=new Map();let at=dash.length+2;
 for(;;){
  if(parts.size>=names.length)malformed();
  const headEnd=indexOf(bytes,blank,at);if(headEnd<0||headEnd-at>1024)malformed();
  const head=partHeaders(bytes.subarray(at,headEnd)),start=headEnd+4,end=indexOf(bytes,delimiter,start);if(end<0)malformed();
  if(!names.includes(head.name)||parts.has(head.name))malformed();
  parts.set(head.name,{type:head.type,bytes:bytes.subarray(start,end)});
  at=end+delimiter.length;
  if(startsAt(bytes,[45,45],at)){at+=2;if(at!==bytes.length&&!(at+2===bytes.length&&startsAt(bytes,crlf,at)))malformed();break;}
  if(!startsAt(bytes,crlf,at))malformed();at+=2;
 }
 return parts;
}
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i;
const checkBody=async(content,body,crypto)=>{if(body.byteLength!==content.byteLength||await sha256(crypto,body)!==content.sha256)malformed();return content.sha256;};

// §7.1 single delivery: `envelope` (JSON), `message` exactly when content is non-null (Content-Type = content.mimeType),
// and `secret` (32 octets) exactly for rotate and secret-share. An Idempotency-Key, when sent, must equal operationId.
// Options: limits (host-advertised), maxParticipants, idempotencyKey, allowLoopback (development), crypto.
export async function parseDelivery(contentType,bytes,options={}){
 const crypto=options.crypto??globalThis.crypto,limits=clampLimits(options.limits);
 const parts=parseParts(contentType,bytes,{names:['envelope','message','secret'],maxBytes:limits.maxRequestBytes});
 const env=parts.get('envelope');if(!env||!JSON_TYPE.test(env.type??''))malformed();
 if(env.bytes.byteLength>limits.maxEnvelopeBytes)fail('too_large');
 const envelope=await validateEnvelope(strictJSON(env.bytes,{maxBytes:limits.maxEnvelopeBytes}),options),p=envelope.payload;
 if(options.idempotencyKey!==undefined&&options.idempotencyKey!==null&&options.idempotencyKey!==p.operationId)malformed();
 const message=parts.get('message');let body=null,bodyDigest=null;
 if((p.content===null)!==(message===undefined))malformed();
 if(message){if(message.type!==p.content.mimeType)malformed();if(message.bytes.byteLength>limits.maxBodyBytes)fail('too_large');body=message.bytes.slice();bodyDigest=await checkBody(p.content,body,crypto);}
 const secretPart=parts.get('secret'),wantsSecret=p.kind==='conversation-record'&&recordShape(p.record.type).secret===true;let secret=null;
 if(wantsSecret!==(secretPart!==undefined))malformed();
 if(secretPart){if(secretPart.type!=='application/octet-stream'||secretPart.bytes.byteLength!==32)malformed();secret=secretPart.bytes.slice();if(await sha256(crypto,secret)!==p.record.data.secretDigest)malformed();}
 return {envelope,body,bodyDigest,secret,credentialScheme:credentialScheme(envelope),payloadDigest:await payloadDigest(envelope,crypto),...p.kind==='conversation-record'?{eventId:await eventId(envelope,crypto)}:{}};
}
const part=(boundary,name,type,bytes)=>[textEncoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: ${type}\r\n\r\n`),bytes,textEncoder.encode('\r\n')];
const join=chunks=>{const out=new Uint8Array(chunks.reduce((n,c)=>n+c.byteLength,0));let at=0;for(const c of chunks){out.set(c,at);at+=c.byteLength;}return out;};
function encodeParts(parts,boundary){
 if(!BOUNDARY.test(boundary))malformed();const delimiter=textEncoder.encode(`\r\n--${boundary}`);
 for(const [, ,bytes] of parts)if(indexOf(join([textEncoder.encode('\r\n'),bytes,textEncoder.encode('\r\n')]),delimiter,0)>=0)malformed();
 return {contentType:`multipart/form-data; boundary=${boundary}`,bytes:join([...parts.flatMap(([name,type,bytes])=>part(boundary,name,type,bytes)),textEncoder.encode(`--${boundary}--\r\n`)])};
}
// Sender encoders for already signed envelopes. The boundary must not occur in any part.
export function encodeDelivery(envelope,{body=null,secret=null,boundary}={}){
 const p=envelope?.payload;if(!plain(p)||(p.content===null)!==(body===null))malformed();
 return encodeParts([['envelope','application/json',textEncoder.encode(jcs(envelope))],...body?[['message',p.content.mimeType,body]]:[],...secret?[['secret','application/octet-stream',secret]]:[]],boundary??`bindlebox-${base64url(globalThis.crypto.getRandomValues(new Uint8Array(18)))}`);
}

// §7.3 multicast. Batch framing and shape errors fail the whole request; an error confined to one context only marks
// that context rejected. Returns {batchId, content, body, contexts:[{index, credential, envelope, payloadDigest, eventId?} |
// {index, error}]}. The caller charges every context before dispatching any, then runs the edge credential check.
export async function parseMulticast(contentType,bytes,options={}){
 const crypto=options.crypto??globalThis.crypto,limits=clampLimits(options.limits),max=Math.min(limits.maxBatchContexts,LIMITS.maxBatchContexts);
 const parts=parseParts(contentType,bytes,{names:['batch','message'],maxBytes:limits.maxRequestBytes}),batchPart=parts.get('batch'),message=parts.get('message');
 if(!batchPart||!message||!JSON_TYPE.test(batchPart.type??''))malformed();if(batchPart.bytes.byteLength>LIMITS.maxBatchBytes)fail('too_large');
 const batch=strictJSON(batchPart.bytes,{maxBytes:LIMITS.maxBatchBytes,maxDepth:20});
 exact(batch,['version','batchId','content','contexts']);if(batch.version!==1)malformed();uuid(batch.batchId);validateContent(batch.content,limits);
 if(!Array.isArray(batch.contexts)||!batch.contexts.length)malformed();if(batch.contexts.length>max)fail('too_large');
 if(message.type!==batch.content.mimeType)malformed();if(message.bytes.byteLength>limits.maxBodyBytes)fail('too_large');
 const body=message.bytes.slice(),bodyDigest=await checkBody(batch.content,body,crypto),seen=new Set(),contexts=[];
 for(const [index,ctx] of batch.contexts.entries()){
  try{
   exact(ctx,['credential','envelope']);exact(ctx.credential,['scheme','value']);
   if(!['BindleLink','BindleConversation'].includes(ctx.credential.scheme)||typeof ctx.credential.value!=='string')malformed();
   const credential=parseCredential(`${ctx.credential.scheme} ${ctx.credential.value}`);
   if(textEncoder.encode(jcs(ctx.envelope)).byteLength>limits.maxEnvelopeBytes)fail('too_large');
   const envelope=await validateEnvelope(ctx.envelope,options);
   if(!sameValue(envelope.payload.content,batch.content)||credentialScheme(envelope)!==credential.scheme)malformed();
   const digest=await payloadDigest(envelope,crypto);if(seen.has(digest))malformed();seen.add(digest);
   contexts.push({index,credential,envelope,payloadDigest:digest,...envelope.payload.kind==='conversation-record'?{eventId:await eventId(envelope,crypto)}:{}});
  }catch(error){if(!error?.code||!error.status)throw error;contexts.push({index,error:error.code,status:error.status});}
 }
 return {batchId:batch.batchId,content:batch.content,body,bodyDigest,contexts};
}
export function encodeMulticast({batchId,contexts},body,{boundary}={}){
 if(!Array.isArray(contexts)||!contexts.length||contexts.length>LIMITS.maxBatchContexts)malformed();
 const content=contexts[0].envelope.payload.content,batch={version:1,batchId:uuid(batchId),content,contexts:contexts.map(({credential,envelope})=>({credential:{scheme:credential.scheme,value:credential.value},envelope}))};
 const json=textEncoder.encode(jcs(batch));if(json.byteLength>LIMITS.maxBatchBytes)fail('too_large');
 return encodeParts([['batch','application/json',json],['message',content.mimeType,body]],boundary??`bindlebox-${base64url(globalThis.crypto.getRandomValues(new Uint8Array(18)))}`);
}

// Resource RPC (protocol §5) for the mailbox contract (§2.2) and public intake (§9), parsed from raw bytes so duplicate
// members are refused before canonicalization. Envelope errors are malformed (HTTP 400); contract/method/argument
// errors carry `rpc: true` and belong in the 200 error envelope.
const rpcFault=code=>fail(code,{status:200,rpc:true});
export function parseRPC(bytes,{resource,allowLoopback=false}={}){
 const r=strictJSON(bytes,{maxBytes:LIMITS.maxRequestBytes,maxDepth:12});
 exact(r,['version','tx','resource','contract','method','args']);if(r.version!=='0'||!isUUID(r.tx)||typeof r.contract!=='string'||typeof r.method!=='string'||!plain(r.args))malformed();
 urlValue(r.resource,allowLoopback);if(resource!==undefined&&r.resource!==resource)malformed();
 if(r.contract===MAILBOX_CONTRACT){
  if(r.method==='describe'){if(Object.keys(r.args).length)rpcFault('invalid_args');}
  else if(r.method==='linkRevoked'){try{exact(r.args,['jti']);if(!text(r.args.jti,128,1))malformed();}catch{rpcFault('invalid_args');}}
  else rpcFault('unsupported_method');
 }else if(r.contract===INTAKE_CONTRACT){
  if(r.method!=='deliver')rpcFault('unsupported_method');
  try{validateIntakeArgs(r.args,{allowLoopback});}catch(error){if(error?.code==='too_large')throw error;rpcFault('invalid_args');}
 }else rpcFault('unsupported_contract');
 return {tx:r.tx,resource:r.resource,contract:r.contract,method:r.method,args:r.args};
}
export const rpcRequest=({tx,resource,contract,method,args})=>({version:'0',tx:uuid(tx),resource,contract,method,args});

// Public intake `deliver({message, provenance})` (§9). Parts decode to at most 1 MiB in total.
function validateIntakeArgs(args,{allowLoopback}){
 exact(args,['message','provenance']);exact(args.message,['parts']);const parts=args.message.parts;
 if(!Array.isArray(parts)||!parts.length||parts.length>LIMITS.maxIntakeParts)malformed();let total=0;
 for(const x of parts){exact(x,['mimeType','dataBase64url']);if(!mimeValid(x.mimeType)||typeof x.dataBase64url!=='string'||x.dataBase64url.length>1398102)malformed();total+=fromBase64url(x.dataBase64url).byteLength;if(total>LIMITS.maxBodyBytes)fail('too_large');}
 parseProvenance(args.provenance,{allowLoopback});return args;
}
// normalizedDigest is SHA-256 over JCS of the delivered `message` object (provisional reading of "canonical parts", review B1).
export const intakeDigest=(message,crypto=globalThis.crypto)=>sha256(crypto,jcs(message));
export function parseProvenance(compact,{allowLoopback=false}={}){
 const jws=parseCompact(compactValue(compact),JWS_TYPES.provenance),c=jws.claims;
 exact(c,['bindle','v','iss','channel','recipient','receivedAt','sender','dmarc','automation','ingressFingerprint','normalizedDigest','jti']);
 if(c.bindle!=='intake-provenance'||c.v!==1||!text(c.channel,64,1)||!time(c.receivedAt)||!['pass','fail','none','unknown'].includes(c.dmarc))malformed();
 originValue(c.iss,allowLoopback);validatePrincipal(c.recipient,{local:allowLoopback});
 exact(c.sender,['envelopeFrom','headerFrom'],['replyTo']);for(const k of Object.keys(c.sender))if(!text(c.sender[k],320))malformed();
 if(!Array.isArray(c.automation)||c.automation.length>16||c.automation.some(x=>!text(x,64,1)))malformed();
 if(!text(c.ingressFingerprint,128,1)||!text(c.jti,128,1))malformed();digestValue(c.normalizedDigest);return jws;
}
// Occupant checks (§9, S-6) 1–3 and 5; deduplication on jti and tx (4) is the caller's. The result is assertions only:
// the item is channel-origin with an unverified sender and is never signed as authored by anyone.
export async function verifyProvenance(args,{consumerKey,consumer,recipient,now,allowLoopback=false,crypto=globalThis.crypto}){
 const jws=parseProvenance(args.provenance,{allowLoopback}),c=jws.claims;
 if(!consumerKey||jws.header.kid!==consumerKey.keyId||!await verifyES256(consumerKey.publicJwk,jws.signature,jws.signingInput,crypto))fail('not_authorized');
 if(c.iss!==consumer||c.recipient.issuer!==recipient.issuer||c.recipient.subject!==recipient.subject)fail('not_authorized');
 if(await intakeDigest(args.message,crypto)!==c.normalizedDigest)malformed();
 if(!Number.isSafeInteger(now)||c.receivedAt>now+LIMITS.clockSkewMs||c.receivedAt<now-LIMITS.recordWindowMs)fail('envelope_expired');
 return {jti:c.jti,channel:c.channel,receivedAt:c.receivedAt,asserted:{sender:c.sender,dmarc:c.dmarc,automation:c.automation},verifiedSender:false};
}
