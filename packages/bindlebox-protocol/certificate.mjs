// Delegation certificates (spec §3.2, core feature key-delegation.v1, assumed) and compact JWS parsing (links §3.1).
// Signing input is the received `segment1.segment2`; nothing is re-serialized before verification.
import {LIMITS,JWS_TYPES,PURPOSES} from './constants.mjs';
import {fail,malformed,fromBase64url,base64url,textEncoder,strictJSON,exact,text,time,uuid,opaque,keyIdValue,compactValue,originValue,endpointValue,uriValue,plain,sha256,utf8} from './encoding.mjs';

const ES256={name:'ECDSA',hash:'SHA-256'};
const FORBIDDEN_HEADERS=['jku','jwk','x5u','x5c','crit','b64','zip','cty'];
// One compact JWS: canonical segments, strict UTF-8 I-JSON (depth 8), header exactly {alg,kid,typ}, 64-byte signature.
export function parseCompact(compact,typ){
 compactValue(compact);const [h,p,s]=compact.split('.');
 const header=strictJSON(utf8(fromBase64url(h)),{maxBytes:1024,maxDepth:8}),claims=strictJSON(utf8(fromBase64url(p)),{maxBytes:LIMITS.maxCompactChars,maxDepth:8}),signature=fromBase64url(s,64);
 if(plain(header)&&FORBIDDEN_HEADERS.some(k=>Object.hasOwn(header,k)))malformed();
 exact(header,['alg','kid','typ']);if(header.alg!=='ES256'||header.typ!==typ)malformed();keyIdValue(header.kid);if(!plain(claims))malformed();
 return {header,claims,signature,signingInput:textEncoder.encode(`${h}.${p}`)};
}

// RFC 7638 thumbprint of a P-256 public JWK: required members in lexicographic order, SHA-256, base64url.
export const publicJwk=jwk=>{exact(jwk,['kty','crv','x','y']);if(jwk.kty!=='EC'||jwk.crv!=='P-256')malformed();fromBase64url(jwk.x,32);fromBase64url(jwk.y,32);return {kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y};};
export const thumbprint=async(jwk,crypto=globalThis.crypto)=>{const k=publicJwk(jwk);return sha256(crypto,`{"crv":"P-256","kty":"EC","x":"${k.x}","y":"${k.y}"}`);};
export const jktOf=delegate=>{if(typeof delegate!=='string'||!/^jkt:[A-Za-z0-9_-]{43}$/.test(delegate))malformed();fromBase64url(delegate.slice(4),32);return delegate.slice(4);};
// Imports public verification keys only. Private members, other curves and off-curve points yield null.
export async function importVerifyKey(jwk,crypto=globalThis.crypto){
 let k;try{k=publicJwk(jwk);}catch{return null;}
 try{return await crypto.subtle.importKey('jwk',{...k,ext:true},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{return null;}
};
export async function verifyES256(jwkOrKey,signature,input,crypto=globalThis.crypto){
 const key=typeof CryptoKey==='function'&&jwkOrKey instanceof CryptoKey?(jwkOrKey.type==='public'&&jwkOrKey.algorithm.name==='ECDSA'&&jwkOrKey.algorithm.namedCurve==='P-256'?jwkOrKey:null):await importVerifyKey(jwkOrKey,crypto);if(!key)return false;
 try{return await crypto.subtle.verify(ES256,key,signature,input);}catch{return false;}
}
export const signES256=async(privateKey,input,crypto=globalThis.crypto)=>base64url(new Uint8Array(await crypto.subtle.sign(ES256,privateKey,input)));

const BINDLEBOX_PURPOSES=Object.values(PURPOSES);
// Structural certificate validation. Signature, key resolution and time are checked by verifyDelegation.
export function parseDelegation(compact,{allowLoopback=false}={}){
 const jws=parseCompact(compact,JWS_TYPES.delegation),c=jws.claims;
 exact(c,['bindle','v','iss','sub','delegate','jkt','purposes','client','cnx','since','jti','iat','exp']);
 if(c.bindle!=='key-delegation'||c.v!==1)malformed();originValue(c.iss,allowLoopback);uuid(c.sub);
 const delegate=exact(c.delegate,['kty','crv','x','y']);
 if(delegate.kty!=='EC'||delegate.crv!=='P-256')malformed();fromBase64url(delegate.x,32);fromBase64url(delegate.y,32);fromBase64url(c.jkt,32);
 if(!Array.isArray(c.purposes)||!c.purposes.length||c.purposes.length>16)malformed();
 for(let i=0;i<c.purposes.length;i++){uriValue(c.purposes[i]);if(i&&!(c.purposes[i-1]<c.purposes[i]))malformed();}
 exact(c.client,['client_id','origin'],['ingress']);if(!text(c.client.client_id,2048,1))malformed();originValue(c.client.origin,allowLoopback);
 if(Object.hasOwn(c.client,'ingress'))endpointValue(c.client.ingress,allowLoopback);
 // The provider MUST set client.ingress whenever it certifies a Bindle Messaging purpose (§3.2, review S-4).
 else if(c.purposes.some(p=>BINDLEBOX_PURPOSES.includes(p)))malformed();
 opaque(c.cnx);if(!text(c.jti,128,1))malformed();
 if(!time(c.since)||!time(c.iat)||!time(c.exp)||!(c.iat<c.exp)||c.exp>c.iat+LIMITS.maxCertificateSeconds||c.since>c.iat)malformed();
 return jws;
}

// §3.3 steps 1–4 for one certificate. `identityKey` is the principal's identity key resolved through the
// directory with pinned continuity by the caller; an embedded key is never a trust anchor.
// Checks: typ/bindle, signature, iss/sub, jkt equality and thumbprint, purpose, lifetime ±60 s, and `at ≥ since − 60 s`.
export async function verifyDelegation(compact,{identityKey,principal,keyId,jkt,purpose,now,at,allowLoopback=false,crypto=globalThis.crypto}){
 const unverifiable=()=>fail('author_unverifiable');
 let jws;try{jws=parseDelegation(compact,{allowLoopback});}catch{unverifiable();}
 const c=jws.claims;
 if((keyId!==undefined&&jws.header.kid!==keyId)||c.iss!==principal.issuer||c.sub!==principal.subject||c.jkt!==jkt||!c.purposes.includes(purpose))unverifiable();
 if(!Number.isSafeInteger(now)||now<c.iat*1000-LIMITS.clockSkewMs||now>c.exp*1000+LIMITS.clockSkewMs)unverifiable();
 if(at!==undefined&&(!Number.isSafeInteger(at)||at<(c.since*1000)-LIMITS.clockSkewMs))unverifiable();
 if(await thumbprint(c.delegate,crypto)!==jkt)unverifiable();
 if(!identityKey||identityKey.keyId!==jws.header.kid||!await verifyES256(identityKey.publicJwk,jws.signature,jws.signingInput,crypto))unverifiable();
 return {header:jws.header,claims:c,delegateKey:await importVerifyKey(c.delegate,crypto)};
}

// Encodes a certificate for tests, simulators and provider fixtures. Not used by an occupant at runtime.
export async function encodeDelegation(claims,{privateKey,keyId},crypto=globalThis.crypto){
 const enc=v=>base64url(textEncoder.encode(JSON.stringify(v))),head=`${enc({alg:'ES256',kid:keyId,typ:JWS_TYPES.delegation})}.${enc(claims)}`;
 const compact=`${head}.${await signES256(privateKey,textEncoder.encode(head),crypto)}`;parseDelegation(compact,{allowLoopback:true});return compact;
}
