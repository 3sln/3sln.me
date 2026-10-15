import {encode,decode,secureEqual} from './crypto.mjs';
// A deploy-time boot token. Configuration holds only its SHA-256 digest, so the
// token itself never sits in server environment, logs or the durable store.
export const BOOT_TOKEN_WINDOW_MS=1800000,BOOT_TOKEN_SKEW_MS=120000,BOOT_COMPLETE_MS=600000;
const utf8=new TextEncoder(),bad=()=>{throw Object.assign(new Error('This boot token is invalid, expired or already used.'),{code:'invalid_boot_token',status:403});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
export const bootTokenDigest=async token=>hex(await crypto.subtle.digest('SHA-256',utf8.encode(token)));
export function bootConfigured(config){return typeof config?.BOOTSTRAP_TOKEN_SHA256==='string'&&/^[a-f0-9]{64}$/.test(config.BOOTSTRAP_TOKEN_SHA256.trim().toLowerCase());}
export function bootWindowMs(config){const raw=config?.BOOT_ACCESS_HOURS??'24',hours=Number(raw);if(!/^\d+$/.test(String(raw))||hours<1||hours>72)throw Object.assign(new Error('Boot access window must be 1–72 hours.'),{code:'boot_unavailable',status:503});return hours*3600000;}
function origin(value){let url;try{url=new URL(value);}catch{}return Boolean(url&&url.origin===value&&(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='localhost'));}
export function mintBootToken(issuer,{now=Date.now()}={}){if(!origin(issuer))throw new TypeError('An exact HTTPS origin is required.');const claims={v:1,iss:issuer,purpose:'boot',ts:now,nonce:encode(crypto.getRandomValues(new Uint8Array(16))),secret:encode(crypto.getRandomValues(new Uint8Array(32)))};return 'boot1.'+encode(utf8.encode(JSON.stringify(claims)));}
/** Constant-time digest match first, then exact typed claims. `fresh:false`
 * skips only the mint window, for completing an already reserved use. */
export async function verifyBootToken(token,config,{now=Date.now(),fresh=true,compare=secureEqual}={}){
 if(!bootConfigured(config))throw Object.assign(new Error('Boot setup is not configured.'),{code:'boot_unavailable',status:503});
 if(typeof token!=='string'||token.length>512||!/^boot1\.[A-Za-z0-9_-]{40,480}$/.test(token))bad();
 const digest=await bootTokenDigest(token);if(!compare(digest,config.BOOTSTRAP_TOKEN_SHA256.trim().toLowerCase()))bad();
 let claims;try{claims=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(token.slice(6))));}catch{bad();}
 if(!exact(claims,['v','iss','purpose','ts','nonce','secret'])||claims.v!==1||claims.purpose!=='boot'||claims.iss!==config.APP_ORIGIN||!Number.isSafeInteger(claims.ts)||typeof claims.nonce!=='string'||! /^[A-Za-z0-9_-]{22,86}$/.test(claims.nonce)||typeof claims.secret!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(claims.secret)||decode(claims.secret).length!==32)bad();
 if(claims.ts-now>BOOT_TOKEN_SKEW_MS||fresh&&now-claims.ts>BOOT_TOKEN_WINDOW_MS)bad();
 return {digest,claims:{v:1,iss:claims.iss,purpose:'boot',ts:claims.ts,nonce:claims.nonce}};
}
