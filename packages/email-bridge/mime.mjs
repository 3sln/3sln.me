// BRIDGE inbound parsing (public-email-bridge.md "MIME, storage and privacy", "Safe response"; bindlebox.md §9): a
// bounded stream read, one strict pass over RFC 5322 headers and MIME structure, conservative automation hints and
// the transport's authentication results as PROVENANCE only. Nothing here renders, fetches, executes or unpacks; every
// limit is enforced while reading and an over-limit or ambiguous message is refused whole, never truncated.
import {jcs,sha256,base64url} from './wire.mjs';

export const MIME_LIMITS=Object.freeze({rawBytes:1048576,headerBytes:65536,headerFields:256,fieldBytes:8192,lineBytes:4096,depth:4,leaves:32,parts:16,deliveredBytes:1048576,boundary:70,subject:998,senderText:320});
export class BridgeMimeError extends Error{constructor(code){super(code==='too_large'?'The message is too large.':'The message is malformed.');this.name='BridgeMimeError';this.code=code;}}
const bad=(code='malformed')=>{throw new BridgeMimeError(code);};
const latin1=new TextDecoder('latin1'),encoder=new TextEncoder();
const lower=v=>v.toLowerCase();

/** Reads at most `limit` bytes of `stream`; a claimed size is never trusted. Cancels and throws too_large beyond it. */
export async function readBounded(stream,limit=MIME_LIMITS.rawBytes){
 if(!stream||typeof stream.getReader!=='function')bad();const reader=stream.getReader(),chunks=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array))bad();total+=value.byteLength;if(total>limit){try{await reader.cancel();}catch{}bad('too_large');}chunks.push(value);}}
 finally{try{reader.releaseLock();}catch{}}
 const out=new Uint8Array(total);let at=0;for(const c of chunks){out.set(c,at);at+=c.byteLength;}return out;
}

// ---- Addresses (strict: one dot-atom mailbox, optional plain or quoted display name, no comments, no groups) ----
const ATOM=/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/,LABEL=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A normalized mailbox (lower-case domain, local part kept) or null. */
export function mailbox(value){
 if(typeof value!=='string'||value.length>254||/[\u0000- \u007f-￿<>()\[\]\\,;:"]/.test(value))return null;
 const at=value.lastIndexOf('@');if(at<1)return null;const local=value.slice(0,at),domain=lower(value.slice(at+1));
 if(local.length>64||!ATOM.test(local)||domain.length>253||!domain.includes('.')||!domain.split('.').every(l=>LABEL.test(l))||/^\d+(?:\.\d+){3}$/.test(domain))return null;
 return `${local}@${domain}`;
}
/** Header mailbox list with exactly one entry: {address, display} or null (groups, lists, comments, routes). */
export function headerMailbox(value){
 if(typeof value!=='string')return null;const v=value.trim();if(!v||v.length>998||/[()]/.test(v))return null;
 let m=/^<([^<>]+)>$/.exec(v);if(m){const a=mailbox(m[1]);return a?{address:a,display:''}:null;}
 m=/^((?:"(?:[^"\\\r\n]|\\[^\r\n])*")|[^"<>,;:@]*?)\s*<([^<>]+)>$/.exec(v);
 if(m){const a=mailbox(m[2]);if(!a)return null;const d=m[1].startsWith('"')?m[1].slice(1,-1).replace(/\\(.)/g,'$1'):m[1].trim();return /[\u0000-\u001f\u007f]/.test(d)?null:{address:a,display:d};}
 const a=mailbox(v);return a?{address:a,display:''}:null;
}

// ---- Header block ----
const FIELD=/^[!-9;-~]+$/;
function splitHead(bytes){
 const s=latin1.decode(bytes);if(s.includes('\0'))bad();
 // One line-ending convention per message: CRLF, or bare LF throughout; a bare CR is ambiguous.
 const crlf=s.includes('\r\n');if(/\r(?!\n)/.test(s)||crlf&&/(?<!\r)\n/.test(s))bad();const nl=crlf?'\r\n':'\n';
 const end=s.indexOf(nl+nl),head=end<0?s:s.slice(0,end);if(head.length>MIME_LIMITS.headerBytes)bad('too_large');
 return {lines:head.split(nl),body:end<0?'':s.slice(end+2*nl.length),nl};
}
function fields(lines){
 const out=[];for(const line of lines){
  if(line.length>MIME_LIMITS.lineBytes)bad();
  if(/^[ \t]/.test(line)){if(!out.length)bad();const f=out.at(-1);f.value+=line;if(f.value.length>MIME_LIMITS.fieldBytes)bad();continue;}
  const i=line.indexOf(':');if(i<1||!FIELD.test(line.slice(0,i)))bad();out.push({name:lower(line.slice(0,i)),value:line.slice(i+1)});
  if(out.length>MIME_LIMITS.headerFields)bad('too_large');
 }
 for(const f of out)f.value=f.value.replace(/[ \t]+/g,' ').trim();return out;
}
const SINGLE=['from','sender','reply-to','to','subject','date','message-id','in-reply-to','mime-version','content-type','content-transfer-encoding','content-disposition','auto-submitted'];
const index=list=>{const map=new Map();for(const f of list){if(!map.has(f.name))map.set(f.name,[]);map.get(f.name).push(f.value);}return map;};
const only=(map,name)=>{const v=map.get(name);if(v&&v.length>1&&SINGLE.includes(name))bad();return v?.[0];};
/** Header bytes interpreted as UTF-8 when well formed (RFC 6532), else kept as Latin-1; never parsed as markup. */
const utf8Header=v=>{const b=Uint8Array.from(v,c=>c.charCodeAt(0));try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return v;}};

// ---- Content-Type / transfer encodings ----
const TCHAR="[!#$%&'*+.^_`|~0-9A-Za-z-]+",QUOTED='"(?:[^"\\\\]|\\\\.)*"';
function contentType(value,fallback='text/plain'){
 if(value===undefined)return {type:fallback,params:new Map()};
 const m=new RegExp(`^(${TCHAR})/(${TCHAR})((?:\\s*;\\s*${TCHAR}\\s*=\\s*(?:${TCHAR}|${QUOTED}))*)\\s*;?\\s*$`).exec(value);if(!m)bad();
 const params=new Map();for(const [,k,raw] of m[3].matchAll(new RegExp(`;\\s*(${TCHAR})\\s*=\\s*(${TCHAR}|${QUOTED})`,'g'))){const key=lower(k);if(params.has(key))bad();params.set(key,raw.startsWith('"')?raw.slice(1,-1).replace(/\\(.)/g,'$1'):raw);}
 return {type:lower(`${m[1]}/${m[2]}`),params};
}
const B64=/^[A-Za-z0-9+/]*={0,2}$/;
function decode(body,cte){
 const e=lower(cte??'7bit');
 if(['7bit','8bit','binary'].includes(e))return Uint8Array.from(body,c=>c.charCodeAt(0));
 if(e==='base64'){const s=body.replace(/[\r\n \t]/g,'');if(s.length%4||!B64.test(s))bad();try{return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}catch{bad();}}
 if(e==='quoted-printable'){
  const out=[];const lines=body.split(/\r?\n/);
  for(const [n,raw] of lines.entries()){const line=raw.replace(/[ \t]+$/,'');let soft=false;
   for(let i=0;i<line.length;i++){const c=line[i];if(c!=='='){out.push(c.charCodeAt(0));continue;}
    if(i===line.length-1){soft=true;break;}const h=line.slice(i+1,i+3);if(!/^[0-9A-Fa-f]{2}$/.test(h))bad();out.push(parseInt(h,16));i+=2;}
   if(!soft&&n<lines.length-1)out.push(13,10);}
  return Uint8Array.from(out);
 }
 bad();
}
function text(bytes,charset='us-ascii'){
 let decoder;try{decoder=new TextDecoder(lower(charset),{fatal:true});}catch{bad();}
 try{return decoder.decode(bytes);}catch{bad();}
}
const MIME=/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const REPORTS=['multipart/report','message/delivery-status','message/disposition-notification','message/feedback-report','text/rfc822-headers'];

function walk(lines,body,nl,depth,acc,inherited='text/plain'){
 const map=index(fields(lines)),ct=contentType(only(map,'content-type'),inherited),cte=only(map,'content-transfer-encoding'),disposition=lower(only(map,'content-disposition')??'').split(';')[0].trim();
 if(REPORTS.includes(ct.type))acc.reports=true;
 if(ct.type.startsWith('multipart/')){
  if(depth>=MIME_LIMITS.depth)bad('too_large');if(cte&&!['7bit','8bit','binary'].includes(lower(cte)))bad();
  const boundary=ct.params.get('boundary');if(!boundary||boundary.length>MIME_LIMITS.boundary||!/^[0-9A-Za-z'()+_,./:=? -]*[0-9A-Za-z'()+_,./:=?-]$/.test(boundary))bad();
  const dash=`--${boundary}`,rows=body.split(nl);let part=null,closed=false;const parts=[];
  for(const row of rows){const r=row.replace(/[ \t]+$/,'');
   if(r===`${dash}--`){if(part)parts.push(part);part=null;closed=true;break;}
   if(r===dash){if(part)parts.push(part);part=[];continue;}
   if(part)part.push(row);
  }
  if(!closed||!parts.length)bad();
  const child=ct.type==='multipart/digest'?'message/rfc822':'text/plain';
  // A part is headers, a blank line and a body; one starting with the blank line has no headers.
  for(const p of parts){const blank=p.indexOf('');walk(blank<0?p:p.slice(0,blank),blank<0?'':p.slice(blank+1).join(nl),nl,depth+1,acc,child);}
  return map;
 }
 if(++acc.leaves>MIME_LIMITS.leaves)bad('too_large');
 const bytes=decode(body,cte),attachment=disposition==='attachment';
 if(!attachment&&ct.type==='text/plain'&&acc.text===undefined){acc.text=text(bytes,ct.params.get('charset')??'us-ascii');return map;}
 if(!attachment&&ct.type==='text/html'&&acc.html===undefined){acc.html=text(bytes,ct.params.get('charset')??'us-ascii');return map;}
 // Everything else is an opaque attachment: content type is an untrusted label, filenames are dropped.
 acc.attachments.push({mimeType:MIME.test(ct.type)&&ct.type.length<=150&&!ct.type.startsWith('multipart/')?ct.type:'application/octet-stream',bytes});
 return map;
}

// ---- Automation hints (conservative; any hint suppresses every automatic response) ----
const SHAPE=/^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounces?|bounce[-+.=].*|.*[-+.]bounces?|noreply[-+.].*|.*[-+.]noreply|notifications?|daemon|root|listserv|majordomo|owner-.+|.+-owner|.+-request|srs[01][=+-].*|prvs=.*|btv1==.*)$/i;
const CODE=/\b(?:verification|security|one[- ]time|login|log[- ]in|sign[- ]in|confirmation|authentication|access|2fa|otp)\s+(?:code|pin|passcode)\b|\b(?:otp|passcode)\b/i;
export const AUTOMATION_HINTS=Object.freeze(['auto-submitted','list-id','list-unsubscribe','precedence-bulk','auto-response-suppress','delivery-report','null-sender','sender-shape','one-time-code','bridge-loop']);
export function automationHints({map,envelopeFrom,from,subject,text:body='',reports=false}){
 const hints=new Set(),get=n=>map.get(n)??[];
 const auto=get('auto-submitted')[0];if(auto!==undefined&&lower(auto.split(';')[0].trim())!=='no')hints.add('auto-submitted');
 for(const n of ['x-autoreply','x-autorespond','x-auto-reply','x-autoresponder'])if(map.has(n))hints.add('auto-submitted');
 if(map.has('list-id')||[...map.keys()].some(n=>/^list-(?:post|help|owner|subscribe|archive)$/.test(n)))hints.add('list-id');
 if(map.has('list-unsubscribe')||map.has('list-unsubscribe-post'))hints.add('list-unsubscribe');
 for(const p of get('precedence')){const v=lower(p.trim());if(['bulk','list','junk'].includes(v))hints.add('precedence-bulk');if(v==='auto_reply')hints.add('auto-submitted');}
 if(map.has('feedback-id')||map.has('x-campaign')||map.has('x-mailgun-tag'))hints.add('precedence-bulk');
 if(get('x-auto-response-suppress').some(v=>/\b(?:all|autoreply|oof|dr|rn|nrn)\b/i.test(v)))hints.add('auto-response-suppress');
 if(reports)hints.add('delivery-report');
 if(!envelopeFrom)hints.add('null-sender');
 if([envelopeFrom,from].some(a=>a&&SHAPE.test(a.slice(0,a.lastIndexOf('@')))))hints.add('sender-shape');
 if(CODE.test(subject??'')||CODE.test(body.slice(0,4096))&&/\b\d{4,8}\b/.test(body.slice(0,4096)))hints.add('one-time-code');
 if(map.has('x-bindle-bridge'))hints.add('bridge-loop');
 return AUTOMATION_HINTS.filter(h=>hints.has(h));
}

// ---- Authentication results: provenance only, from the configured receiving authserv-id ----
/** RFC 8601 results from the ONE header bearing the configured receiving `authservId`. With no configured id, none or
 * several such headers (a sender-supplied copy beside the receiver's), every result is `unknown`: a caller-provided
 * header is never evidence. Results are recorded as the provider's observations, never as authorship. */
export function authResults(map,authservId){
 const none={spf:'unknown',dkim:'unknown',dmarc:'unknown'};if(typeof authservId!=='string'||!authservId)return none;
 const ours=(map.get('authentication-results')??[]).filter(v=>lower(v.split(';')[0].trim().split(/\s+/)[0])===lower(authservId));if(ours.length!==1)return none;
 const out={...none};for(const clause of ours[0].split(';').slice(1)){const m=/^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(clause);if(m&&out[lower(m[1])]==='unknown'){const r=lower(m[2]);out[lower(m[1])]=['pass','fail','none','neutral','softfail','temperror','permerror','policy'].includes(r)?r:'unknown';}}
 out.dmarc=['pass','fail','none'].includes(out.dmarc)?out.dmarc:'unknown';return out;
}

// ---- One parse ----
// C0/C1 controls, bidi controls and zero-width characters become spaces (review EB-6: display spoofing).
const sanitize=(v,max)=>{const s=String(v??'').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,' ');let out='';for(const ch of s){if(out.length+ch.length>max)break;out+=ch;}return out;};
/** Parses raw bytes into inert parts and assertions. `envelope.from` is the SMTP reverse path ('' when null). */
export async function parseEmail(bytes,{envelopeFrom='',authservId}={}){
 if(!(bytes instanceof Uint8Array))bad();if(bytes.byteLength>MIME_LIMITS.rawBytes)bad('too_large');
 const {lines,body,nl}=splitHead(bytes),acc={leaves:0,attachments:[],reports:false},map=walk(lines,body,nl,0,acc);
 for(const n of SINGLE)only(map,n);
 const fromRaw=only(map,'from');if(fromRaw===undefined)bad();const from=headerMailbox(utf8Header(fromRaw));
 if(!from)bad();// One parseable author mailbox is required; lists, groups and comments are refused whole.
 const replyRaw=only(map,'reply-to'),replyTo=replyRaw===undefined?null:headerMailbox(utf8Header(replyRaw));
 const subject=sanitize(utf8Header(only(map,'subject')??''),MIME_LIMITS.subject),messageIdRaw=only(map,'message-id');
 const messageId=messageIdRaw!==undefined&&/^<[!-;=?-~]{1,250}@[!-;=?-~]{1,250}>$/.test(messageIdRaw.trim())?messageIdRaw.trim():null;
 const parts=[];const head=['From','Subject','Date'].map(n=>[n,only(map,lower(n))]).filter(([,v])=>v!==undefined).map(([n,v])=>`${n}: ${sanitize(utf8Header(v),998)}`).join('\r\n');
 parts.push({mimeType:'text/rfc822-headers',bytes:encoder.encode(head+'\r\n')});
 if(acc.text)parts.push({mimeType:'text/plain',bytes:encoder.encode(acc.text)});
 if(acc.html)parts.push({mimeType:'text/html',bytes:encoder.encode(acc.html)});
 parts.push(...acc.attachments.filter(p=>p.bytes.byteLength));
 if(parts.length>MIME_LIMITS.parts)bad('too_large');if(parts.reduce((n,p)=>n+p.bytes.byteLength,0)>MIME_LIMITS.deliveredBytes)bad('too_large');
 const message={parts:parts.map(p=>({mimeType:p.mimeType,dataBase64url:base64url(p.bytes)}))};
 const hints=automationHints({map,envelopeFrom,from:from.address,subject,text:acc.text??'',reports:acc.reports});
 const headerFrom=from.display?sanitize(`${sanitize(from.display,MIME_LIMITS.senderText-from.address.length-3)} <${from.address}>`,MIME_LIMITS.senderText):from.address;
 return {message,from,replyTo,subject,messageId,hints,auth:authResults(map,authservId),headerFrom,multipleReplyTo:replyRaw!==undefined&&!replyTo};
}

/** Owner-scoped canonical ingress fingerprint (design "Keep deduplication owner-scoped"): envelope sender, normalized
 * Message-ID and the normalized content digest; trace headers and the envelope recipient alias are excluded, so a
 * retry with new Received lines and delivery to two aliases of one owner collapse, while changed content never does. */
export const ingressFingerprint=({owner,envelopeFrom,messageId,digest})=>sha256(jcs(['email-bridge-fp-v1',owner,lower(envelopeFrom??''),messageId??'',digest]));
