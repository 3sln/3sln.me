// Strict I-JSON, RFC 8785 JCS, canonical base64url and exact-shape checks (spec §5.1, links §3.1).
// Adapted from core contact-delivery.mjs (copied per roadmap conflict resolution 13; core originals untouched).
// Pure and deterministic; the only platform API used anywhere in this package is Web Crypto.
import {ERRORS,LIMITS} from './constants.mjs';

export class ProtocolFault extends Error {
 constructor(code,{status=ERRORS[code]??400,...extra}={}){super(code);this.name='ProtocolFault';this.code=code;this.status=status;Object.assign(this,extra);}
}
export const fail=(code,extra)=>{throw new ProtocolFault(code,extra);};
export const malformed=()=>fail('malformed');
export const textEncoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
export const utf8=bytes=>{try{return decoder.decode(bytes);}catch{malformed();}};
export const base64url=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
// Canonical unpadded base64url only: noncanonical trailing bits and padding are refused.
export const fromBase64url=(value,bytes)=>{
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value)||value.length%4===1)malformed();
 let out;try{const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);}catch{malformed();}
 if(base64url(out)!==value||(bytes!==undefined&&out.byteLength!==bytes))malformed();return out;
};
export const sha256=async(crypto,value)=>base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?textEncoder.encode(value):value)));
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));

// RFC 8785 restricted to the I-JSON this profile admits: safe integers only, no -0, well-formed strings,
// keys sorted by UTF-16 code unit. Anything else (undefined, holes, symbols, objects with prototypes) is refused.
export function jcs(value,depth=0){
 if(depth>32)malformed();
 if(value===null||value===true||value===false)return String(value);
 if(typeof value==='string'){if(!value.isWellFormed())malformed();return JSON.stringify(value);}
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))malformed();return String(value);}
 if(Array.isArray(value))return `[${Array.from(value,v=>jcs(v,depth+1)).join(',')}]`;
 if(plain(value))return `{${Object.keys(value).sort().map(k=>`${jcs(k)}:${jcs(value[k],depth+1)}`).join(',')}}`;
 malformed();
}
export const sameValue=(a,b)=>jcs(a)===jcs(b);
// Detached plain copy: getters run once here, never again during validation or signing.
export const detach=value=>{try{return structuredClone(value);}catch{malformed();}};

// I-JSON parser over received bytes: duplicate names at any depth, lone surrogates, BOM, fractions, exponents,
// negative or unsafe numbers and depth abuse are refused before canonicalization. Members are defined, not
// assigned, so `__proto__` stays an ordinary own key that exact-shape checks reject.
export function strictJSON(source,{maxBytes=LIMITS.maxEnvelopeBytes,maxDepth=16}={}){
 let input=source;
 if(source instanceof Uint8Array){if(source.byteLength>maxBytes)fail('too_large');input=utf8(source);}
 else if(typeof input!=='string'||textEncoder.encode(input).byteLength>maxBytes)fail(typeof input==='string'?'too_large':'malformed');
 if(input.startsWith('\ufeff'))malformed();
 let i=0;
 const ws=()=>{while(i<input.length&&' \t\n\r'.includes(input[i]))i++;};
 const token=re=>{re.lastIndex=i;const m=re.exec(input);if(!m)malformed();i=re.lastIndex;return m[0];};
 const string=()=>{const v=JSON.parse(token(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y));if(!v.isWellFormed())malformed();return v;};
 const value=depth=>{
  if(depth>maxDepth)malformed();ws();const c=input[i];
  if(c==='"')return string();
  if(c==='{'){i++;const o={};ws();if(input[i]==='}'){i++;return o;}for(;;){ws();if(input[i]!=='"')malformed();const k=string();if(Object.hasOwn(o,k))malformed();ws();if(input[i++]!==':')malformed();Object.defineProperty(o,k,{value:value(depth+1),enumerable:true,writable:true,configurable:true});ws();const n=input[i++];if(n==='}')return o;if(n!==',')malformed();}}
  if(c==='['){i++;const a=[];ws();if(input[i]===']'){i++;return a;}for(;;){a.push(value(depth+1));ws();const n=input[i++];if(n===']')return a;if(n!==',')malformed();}}
  const literal=token(/true|false|null|(?:0|[1-9][0-9]{0,15})(?![0-9.eE+-])/y);
  if(literal==='true')return true;if(literal==='false')return false;if(literal==='null')return null;
  const n=Number(literal);if(!Number.isSafeInteger(n))malformed();return n;
 };
 const result=value(0);ws();if(i!==input.length)malformed();return result;
}

// Shapes. Display strings carry no Cc, line/paragraph separators or bidi controls; no normalization (S6).
const controls=/[\p{Cc}\p{Bidi_Control}\u2028\u2029\u200b\ufeff]/u;
export const text=(v,max,min=0)=>{if(typeof v!=='string'||!v.isWellFormed()||controls.test(v))return false;let n=0;for(const _ of v)if(++n>max)return false;return n>=min;};
export const time=v=>Number.isSafeInteger(v)&&v>=0;
export const positive=(v,max)=>Number.isSafeInteger(v)&&v>0&&v<=max;
export const exact=(v,required,optional=[])=>{if(!plain(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))malformed();return v;};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const isUUID=v=>typeof v==='string'&&UUID.test(v);
export const uuid=v=>{if(!isUUID(v))malformed();return v;};
// SHA-256 digests and event IDs: canonical 43-character base64url of 32 bytes.
export const digestValue=v=>{fromBase64url(v,32);if(v.length!==43)malformed();return v;};
// Opaque protocol identifiers (incarnations, cnx): visible ASCII only, so the pair-token input is unambiguous.
export const opaque=(v,max=64)=>{if(typeof v!=='string'||!new RegExp(`^[\\x21-\\x7e]{1,${max}}$`).test(v))malformed();return v;};
export const keyIdValue=v=>{if(!text(v,200,1))malformed();return v;};
export const mimeValid=v=>typeof v==='string'&&v.length<=150&&/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v);
const COMPACT=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const compactValue=(v,max=LIMITS.maxCompactChars)=>{if(typeof v!=='string'||v.length>max||!COMPACT.test(v))malformed();return v;};

// Exact canonical URLs: no userinfo or fragment and no parser-normalized spelling. `http://localhost`
// only when a development host opts in with allowLoopback; production callers never set it.
const scheme=(u,local)=>u.protocol==='https:'||(local===true&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));
// Production hosts are DNS names: no trailing dot (a second spelling of one host), IP literals or loopback names.
const hostOK=(u,local)=>local===true&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)||(!u.hostname.endsWith('.')&&!u.hostname.startsWith('[')&&!/^[0-9.]+$/.test(u.hostname)&&!/(^|\.)localhost$/.test(u.hostname)&&u.hostname.includes('.'));
const parseURL=(v,local)=>{if(typeof v!=='string'||v.length>2048)malformed();let u;try{u=new URL(v);}catch{malformed();}if(!scheme(u,local)||!hostOK(u,local)||u.username||u.password||u.hash||v.includes('#')||u.href!==v)malformed();return u;};
export const urlValue=(v,local)=>parseURL(v,local);
// Delivery URLs (ingress, multicast, return control): additionally no query.
export const endpointValue=(v,local)=>{const u=parseURL(v,local);if(u.search||v.includes('?'))malformed();return u;};
export const originValue=(v,local)=>{const u=parseURL(`${v}/`,local);if(u.origin!==v||u.pathname!=='/'||u.search)malformed();return v;};
// Published identifiers (profiles, purposes): absolute HTTPS, at most 256 characters, never loopback.
export const uriValue=v=>{if(typeof v!=='string'||v.length>256)malformed();parseURL(v,false);return v;};
// Unicode scalar order for signed tag lists (code points, not UTF-16 units).
export const scalarCompare=(a,b)=>{const x=[...a],y=[...b];for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i].codePointAt(0)-y[i].codePointAt(0);return x.length-y.length;};
// Fixed-length digest comparison without early exit (both operands are public-length strings).
export const equalDigest=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
