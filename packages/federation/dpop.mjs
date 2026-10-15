// RFC 9449 DPoP proofs, RFC 7638 thumbprints and stateless single-use server nonces. ES256 (P-256) only.
// Proof signatures are verified outside storage transactions; consumeProof() records nonce and jti inside one.
import {base64url,digest} from '../messaging/store.mjs';
import {fail} from './schema.mjs';
export const DPOP_TYP='dpop+jwt',EMBED_PROOF_TYP='bindle-embed+jwt';
const text=new TextEncoder();
const bytes=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value))fail('invalid_dpop_proof');const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));const out=Uint8Array.from(raw,c=>c.charCodeAt(0));if(base64url(out)!==value)fail('invalid_dpop_proof');return out;};
const part=value=>{let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes(value)));}catch(error){if(error.code)throw error;fail('invalid_dpop_proof');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('invalid_dpop_proof');return parsed;};
const keyed=(value,keys)=>Object.keys(value).every(k=>keys.includes(k));
const bare=value=>{const url=new URL(value);url.search='';url.hash='';return url.href;};
/** RFC 7638 thumbprint over the required EC members in lexicographic order. */
export async function thumbprint(crypto,jwk){if(!jwk||typeof jwk!=='object'||!keyed(jwk,['kty','crv','x','y'])||jwk.kty!=='EC'||jwk.crv!=='P-256'||!/^[A-Za-z0-9_-]{43}$/.test(jwk.x??'')||!/^[A-Za-z0-9_-]{43}$/.test(jwk.y??''))fail('invalid_dpop_proof');return digest(crypto,`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`);}
export const jktPattern=/^[A-Za-z0-9_-]{43}$/;
/** Verifies one compact proof. `nonce` is a function returning the validated
 * nonce record (or failing), `ath` the bound credential, `claims` extra members. */
export async function verifyProof(crypto,proof,{typ=DPOP_TYP,htm,htu,now,window=60,nonce,ath,claims={}}){
 if(typeof proof!=='string'||proof.length>4096)fail('invalid_dpop_proof');const parts=proof.split('.');if(parts.length!==3)fail('invalid_dpop_proof');
 const header=part(parts[0]),payload=part(parts[1]),signature=bytes(parts[2]);
 if(!keyed(header,['typ','alg','jwk'])||header.typ!==typ||header.alg!=='ES256'||signature.length!==64)fail('invalid_dpop_proof');
 const jkt=await thumbprint(crypto,header.jwk);
 if(!keyed(payload,['jti','htm','htu','iat','nonce','ath',...Object.keys(claims)])||typeof payload.jti!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti)||payload.htm!==htm||typeof payload.htu!=='string'||payload.htu.length>2048)fail('invalid_dpop_proof');
 let target;try{target=bare(payload.htu);}catch{fail('invalid_dpop_proof');}if(target!==bare(htu))fail('invalid_dpop_proof');
 if(!Number.isSafeInteger(payload.iat)||Math.abs(payload.iat-Math.floor(now/1000))>window)fail('invalid_dpop_proof');
 for(const [name,value]of Object.entries(claims))if(payload[name]!==value)fail('invalid_dpop_proof');
 if(ath===undefined?payload.ath!==undefined:payload.ath!==await digest(crypto,ath))fail('invalid_dpop_proof');
 let key;try{key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:header.jwk.x,y:header.jwk.y,ext:true},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{fail('invalid_dpop_proof');}
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,signature,text.encode(`${parts[0]}.${parts[1]}`)))fail('invalid_dpop_proof');
 // Nonce checks run last so a forged proof never learns nonce state.
 const fresh=nonce?await nonce(payload.nonce):null;if(!nonce&&payload.nonce!==undefined)fail('invalid_dpop_proof');
 return {jkt,jti:payload.jti,iat:payload.iat,nonceHash:fresh?.hash??null,expiresAt:Math.max(fresh?.expiresAt??0,(payload.iat+window)*1000)};
}
/** Stateless HMAC nonces: `exp.random.mac`, purpose-separated, ≤ ttl. Single
 * use is enforced where the proof is consumed (consumeProof). */
export function dpopNonces({secret,crypto=globalThis.crypto,clock=()=>Date.now(),ttl=120000}){
 if(typeof secret!=='string'||secret.length<16)throw new TypeError('A DPoP nonce secret is required.');
 const key=crypto.subtle.importKey('raw',text.encode(`bindle-dpop-nonce-v1\0${secret}`),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const mac=async(purpose,exp,random)=>base64url(new Uint8Array(await crypto.subtle.sign('HMAC',await key,text.encode(`${purpose}\0${exp}\0${random}`))));
 return {ttl,
  async issue(purpose){const exp=(clock()+ttl).toString(36),random=base64url(crypto.getRandomValues(new Uint8Array(16)));return `${exp}.${random}.${await mac(purpose,exp,random)}`;},
  async check(purpose,value){const match=typeof value==='string'&&/^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);if(!match)fail('use_dpop_nonce','A fresh DPoP nonce is required.');const exp=parseInt(match[1],36),now=clock();
   if(!(exp>now&&exp<=now+ttl)||!await crypto.subtle.verify('HMAC',await key,bytes(match[3]),text.encode(`${purpose}\0${match[1]}\0${match[2]}`)))fail('use_dpop_nonce','A fresh DPoP nonce is required.');return {hash:await digest(crypto,`dpop-nonce\0${value}`),expiresAt:exp};}};
}
/** Records nonce and jti once each, keyed by domain-separated hashes. */
export async function consumeProof(tx,prefix,proof,crypto,clock,max=1024){
 const now=clock(),rows=await tx.list(prefix);let live=0;for(const row of rows){if(row.value.expiresAt<=now)await tx.delete(row.key);else live++;}
 if(live+2>max)fail('rate_limited','Too many recent proofs. Try again shortly.');
 const keys=[`${prefix}jti/${await digest(crypto,`dpop-jti\0${proof.jkt}\0${proof.jti}`)}`,...proof.nonceHash?[`${prefix}nonce/${proof.nonceHash}`]:[]];
 for(const name of keys)if(await tx.get(name))fail(name.includes('/nonce/')?'use_dpop_nonce':'invalid_dpop_proof','This proof was already used.');
 for(const name of keys)await tx.set(name,{expiresAt:Math.max(proof.expiresAt,now+1000)});
}
