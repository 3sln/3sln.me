// Provider brokering key set (integrations §5.3, §7 item 7) and RFC 9068 brokered access tokens. ES256 (P-256) only.
// Keys are purpose-separated (one kid per purpose), sealed at rest with an HKDF-derived AES-GCM key whose AAD binds
// issuer, kid, purpose and public point, published before use and retained after retirement until every token they
// signed has expired. Consumer-facing minting routes and SET minting are later slices (EXT-X8, EXT-X6).
import {FederationFault} from './schema.mjs';
export const ACCESS_TOKEN_TYP='at+jwt',BROKERING_ALG='ES256',BROKERING_JWKS_PATH='/oauth/brokering/jwks',BROKERING_PURPOSES=Object.freeze(['invoke','describe','discover','event']);
/** exp − iat bounds in seconds (integrations §5.3); the verifier leeway bound is §5.5 step 5. */
export const ACCESS_LIFETIMES=Object.freeze({invoke:300,describe:60,discover:60}),MAX_ACCESS_LIFETIME=300,MAX_LEEWAY=30;
/** JWKS response max-age. Lead time ≥ verifier cache (≤ 1 h, §5.5 step 2) + this; overlap ≥ lifetime + leeway. */
/** Overlap covers the SET acceptance window (600 s + 30 s, §6.1), which exceeds lifetime + leeway + clock error (360 s, §7.2). */
export const JWKS_MAX_AGE=300,MIN_OVERLAP=(600+MAX_LEEWAY)*1000,DEFAULT_LEAD=(3600+JWKS_MAX_AGE+60)*1000;
const TYPES=Object.freeze({invoke:'at+jwt',describe:'at+jwt',discover:'at+jwt',event:'secevent+jwt'});
/** P-256 order; signatures are normalized to low-s and high-s is refused, so a token has one byte encoding. */
const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,HALF=N>>1n;
const big=bytes=>BigInt('0x'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''));
const lowS=sig=>{const s=big(sig.slice(32));if(s<=HALF)return sig;const out=new Uint8Array(sig);out.set(Uint8Array.from((N-s).toString(16).padStart(64,'0').match(/../g),h=>parseInt(h,16)),32);return out;};
export const brokeringEnabled=config=>config?.BROKERING_ENABLED==='true';
/** Provisional manifest member. AMD-C6: `brokered-resources.v1` (whose `jwks_uri` this becomes) is declared only once
 * EXT-X8 mounts preferences/v2 and minting; until then the flag publishes the key set without claiming the feature. */
export const brokeringManifest=issuer=>({brokering_jwks_uri:`${issuer}${BROKERING_JWKS_PATH}`});
const text=new TextEncoder(),ECDSA={name:'ECDSA',namedCurve:'P-256'},SIG={name:'ECDSA',hash:'SHA-256'},RECORD='brokering/keyset',TOMBSTONES=64;
const unavailable=()=>{throw Object.assign(new FederationFault('brokering_unavailable','Brokering keys are unavailable.'),{status:503});};
const invalid=reason=>{throw Object.assign(new FederationFault('invalid_token','The brokered access token is invalid.'),{status:401,reason});};
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const b64u=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
/** Strict base64url: alphabet only, no padding, canonical trailing bits. */
const unb64u=(value,reason)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value)||value.length%4===1)invalid(reason);const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),out=Uint8Array.from(raw,c=>c.charCodeAt(0));if(b64u(out)!==value)invalid(reason);return out;};
/** Canonical JSON segment: rejects duplicate members, non-objects and any encoding the minter does not emit. */
const segment=(value,reason)=>{let raw,parsed;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(unb64u(value,reason));parsed=JSON.parse(raw);}catch(e){if(e.code)throw e;invalid(reason);}if(!plain(parsed)||JSON.stringify(parsed)!==raw)invalid(reason);return parsed;};
const exactKeys=(value,keys)=>Object.keys(value).every(k=>keys.includes(k));
const safe=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const httpsURL=(value,max=2048)=>{if(!safe(value,max))return null;try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===value?u:null;}catch{return null;}};
const KID=/^(invoke|describe|discover|event)\.[A-Za-z0-9_-]{22}$/,JTI=/^[A-Za-z0-9_-]{22,128}$/,CONNECTION=/^[A-Za-z0-9._~-]{1,128}$/,GRANT=/^[A-Za-z0-9._~-]{1,128}$/,METHOD=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Public members only; anything private, foreign or ambiguous is refused rather than filtered. */
function publicJwk(jwk){
 if(!plain(jwk)||!exactKeys(jwk,['kty','crv','x','y','kid','alg','use'])||jwk.kty!=='EC'||jwk.crv!=='P-256'||jwk.alg!==undefined&&jwk.alg!==BROKERING_ALG||jwk.use!==undefined&&jwk.use!=='sig'||!KID.test(jwk.kid??'')||![jwk.x,jwk.y].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)))return null;
 return {kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,kid:jwk.kid,alg:BROKERING_ALG,use:'sig'};
}
function methodsValid(methods,describe){
 if(!plain(methods))return false;const entries=Object.entries(methods);if(!entries.length||entries.length>16||describe&&entries.length!==1)return false;
 return entries.every(([contract,list])=>httpsURL(contract,512)&&Array.isArray(list)&&list.length>0&&list.length<=64&&new Set(list).size===list.length&&list.every(m=>typeof m==='string'&&METHOD.test(m))&&(!describe||list.length===1&&list[0]==='describe'));
}
/** Claim rules shared by minting and verification, so the minter cannot emit what the verifier refuses. */
function claimsValid(c,issuer){
 const b=c.bindle,aud=httpsURL(c.aud),lifetime=ACCESS_LIFETIMES[b?.purpose];
 if(!exactKeys(c,['iss','sub','aud','client_id','iat','exp','jti','bindle','cnf'])||c.iss!==issuer||!safe(c.sub,512)||!aud||aud.origin===new URL(issuer).origin||!safe(c.client_id,2048)||!Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp)||!lifetime||c.exp<=c.iat||c.exp-c.iat>lifetime||typeof c.jti!=='string'||!JTI.test(c.jti))return false;
 if(!plain(b)||!exactKeys(b,['v','purpose','connection','generation','resource','grant','methods','scope','feature'])||b.v!==1||!CONNECTION.test(b.connection??'')||!Number.isSafeInteger(b.generation)||b.generation<0)return false;
 if(b.feature!==undefined&&(!safe(b.feature,128)||c.client_id!==issuer))return false;
 if(b.purpose==='discover'){if(c.client_id!==issuer||['resource','grant','methods','scope'].some(k=>b[k]!==undefined))return false;}
 else{const resource=httpsURL(b.resource,512);if(!resource||resource.origin!==aud.origin||!GRANT.test(b.grant??'')||!methodsValid(b.methods,b.purpose==='describe')||b.purpose==='describe'&&c.client_id!==issuer)return false;
  if(b.scope!==null&&(!plain(b.scope)||JSON.stringify(b.scope).length>4096))return false;}
 if(c.cnf!==undefined&&(!plain(c.cnf)||!exactKeys(c.cnf,['jkt'])||!/^[A-Za-z0-9_-]{43}$/.test(c.cnf.jkt??'')))return false;
 return true;
}
/** HKDF-separated AES-GCM sealing key; `secret` is the base64 32-byte KEY_ENCRYPTION_KEY used for other provider keys. */
async function sealingKey(crypto,secret,issuer){
 let raw;try{raw=Uint8Array.from(atob(secret),c=>c.charCodeAt(0));}catch{unavailable();}if(typeof secret!=='string'||raw.length!==32)unavailable();
 const material=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:text.encode(issuer),info:text.encode('bindle-brokering-keys-v1')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const aad=(issuer,k)=>text.encode(JSON.stringify(['bindle-brokering-key-v1',issuer,k.kid,k.purpose,k.x,k.y]));
/** The provider's brokering key set over transactional federation metadata (`transaction(tx=>…)`, tx.get/set). The
 * transaction must serialize with severance commits (one Durable Object or SerialGate). Lifecycle per purpose:
 * next (published standby, not signing) → active (signs) → retiring (published until removeAt) → removed; revoked keys are
 * tombstoned, unpublished and never resurrected. `lead`, `overlap` and `rotateAfter` are milliseconds. */
export function brokeringKeys({issuer,secret,metadata,crypto=globalThis.crypto,clock=()=>Date.now(),lead=DEFAULT_LEAD,overlap=3600000,rotateAfter=90*86400000,cacheMs=5000}){
 if(!httpsURL(`${issuer}/`)&&!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(issuer??''))throw new TypeError('A provider issuer origin is required.');
 if(typeof metadata?.transaction!=='function')throw new TypeError('Transactional federation metadata is required.');
 if(!Number.isSafeInteger(lead)||lead<DEFAULT_LEAD||!Number.isSafeInteger(overlap)||overlap<MIN_OVERLAP||!Number.isSafeInteger(rotateAfter)||rotateAfter<=lead+overlap)throw new TypeError('Brokering rotation needs lead ≥ verifier cache plus JWKS max-age, overlap ≥ the SET window plus leeway, and a longer rotation period.');
 let sealing;const seal=()=>sealing??=sealingKey(crypto,secret,issuer).catch(e=>{sealing=undefined;throw e;});
 const imported=new Map();let memo;const forget=()=>{memo=undefined;};
 async function generate(purpose,now,state){
  const pair=await crypto.subtle.generateKey(ECDSA,true,['sign','verify']),jwk=await crypto.subtle.exportKey('jwk',pair.privateKey),kid=`${purpose}.${b64u(crypto.getRandomValues(new Uint8Array(16)))}`;
  const key={kid,purpose,state,createdAt:now,activatesAt:state==='active'?now:now+lead,...state==='active'?{activatedAt:now}:{},x:jwk.x,y:jwk.y},iv=crypto.getRandomValues(new Uint8Array(12));
  key.sealed={v:1,iv:b64u(iv),ciphertext:b64u(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(issuer,key),tagLength:128},await seal(),text.encode(JSON.stringify({d:jwk.d})))))};return key;
 }
 /** Applies due transitions; returns true when the record changed. Never activates a revoked key. */
 async function advance(set,now){
  let changed=false;
  for(const purpose of BROKERING_PURPOSES){
   let active=set.keys.find(k=>k.purpose===purpose&&k.state==='active');
   // Every purpose keeps a published standby. It activates at its scheduled time, or at once when compromise left the
   // purpose without an active key, so a replacement is normally already in verifiers' cached key sets.
   let next=set.keys.find(k=>k.purpose===purpose&&k.state==='next');
   if(next&&(next.activatesAt<=now||!active)){if(active)Object.assign(active,{state:'retiring',retiredAt:now,removeAt:now+overlap});Object.assign(next,{state:'active',activatedAt:now});active=next;next=undefined;changed=true;}
   if(!active){active=await generate(purpose,now,'active');set.keys.push(active);changed=true;}
   if(!next){const k=await generate(purpose,now,'next');k.activatesAt=Math.max(now+lead,active.activatedAt+rotateAfter);set.keys.push(k);changed=true;}
  }
  const before=set.keys.length;set.keys=set.keys.filter(k=>k.state!=='retiring'||k.removeAt>now);const dead=set.keys.filter(k=>k.state==='revoked');
  if(dead.length>TOMBSTONES){const drop=new Set(dead.sort((a,b)=>a.revokedAt-b.revokedAt).slice(0,dead.length-TOMBSTONES).map(k=>k.kid));set.keys=set.keys.filter(k=>!drop.has(k.kid));}
  return changed||set.keys.length!==before;
 }
 const load=async tx=>{const set=await tx.get(RECORD);if(set===undefined||set===null)return {v:1,keys:[]};if(!plain(set)||set.v!==1||!Array.isArray(set.keys))unavailable();return structuredClone(set);};
 const current=()=>metadata.transaction(async tx=>{const set=await load(tx),now=clock();if(await advance(set,now))await tx.set(RECORD,set);forget();return set;});
 async function signingKey(k){
  const cached=imported.get(k.kid);if(cached?.ciphertext===k.sealed.ciphertext)return cached.key;
  let key;try{const clear=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64u(k.sealed.iv),additionalData:aad(issuer,k),tagLength:128},await seal(),unb64u(k.sealed.ciphertext))));
   if(!plain(clear)||!exactKeys(clear,['d'])||!/^[A-Za-z0-9_-]{43}$/.test(clear.d??''))throw 0;
   key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:k.x,y:k.y,d:clear.d,ext:false},ECDSA,false,['sign']);
   const probe=text.encode('bindle-brokering-key-check-v1'),verify=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:k.x,y:k.y},ECDSA,false,['verify']);
   if(!await crypto.subtle.verify(SIG,verify,await crypto.subtle.sign(SIG,key,probe),probe))throw 0;}catch(e){if(e?.code)throw e;unavailable();}
  imported.set(k.kid,{ciphertext:k.sealed.ciphertext,key});return key;
 }
 const published=(set,now=clock())=>({keys:set.keys.filter(k=>['next','active'].includes(k.state)||k.state==='retiring'&&k.removeAt>now).sort((a,b)=>a.createdAt-b.createdAt||(a.kid<b.kid?-1:1)).map(k=>({kty:'EC',crv:'P-256',x:k.x,y:k.y,kid:k.kid,alg:BROKERING_ALG,use:'sig'}))});
 return {issuer,
  /** The public key set (standby, active and retiring keys) for the public JWKS route: a read-only snapshot memoized
   * per instance for `cacheMs`, so unauthenticated traffic never writes or contends with severance commits. Due
   * transitions run on signing, rotation, revocation or maintain(). */
  async jwks(){const now=clock();if(memo&&memo.until>now)return memo.value;let set=await metadata.transaction(load);
   if(BROKERING_PURPOSES.some(p=>!set.keys.some(k=>k.purpose===p&&k.state==='active')))set=await current();
   const value=published(set,now);memo={value,until:now+cacheMs};return value;},
  /** Scheduled maintenance: applies due promotions, standby staging and removals. */
  async maintain(){await current();},
  /** Compact JWS over a canonical header and payload with the purpose's active key. */
  async sign(purpose,payload){
   if(!BROKERING_PURPOSES.includes(purpose))throw new TypeError('Unknown brokering purpose.');
   const set=await current(),k=set.keys.find(x=>x.purpose===purpose&&x.state==='active');if(!k)unavailable();
   const input=`${b64u(text.encode(JSON.stringify({alg:BROKERING_ALG,typ:TYPES[purpose],kid:k.kid})))}.${b64u(text.encode(JSON.stringify(payload)))}`;
   return {kid:k.kid,token:`${input}.${b64u(lowS(new Uint8Array(await crypto.subtle.sign(SIG,await signingKey(k),text.encode(input)))))}`};
  },
  /** Planned rotation: brings the published standby forward to the earliest time it has been published for `lead`. */
  rotate(purposes=BROKERING_PURPOSES){return metadata.transaction(async tx=>{const set=await load(tx),now=clock();await advance(set,now);const staged=[];
   for(const purpose of[].concat(purposes)){if(!BROKERING_PURPOSES.includes(purpose))throw new TypeError('Unknown brokering purpose.');const k=set.keys.find(x=>x.purpose===purpose&&x.state==='next');k.activatesAt=Math.min(k.activatesAt,Math.max(now,k.createdAt+lead));staged.push({kid:k.kid,purpose,activatesAt:k.activatesAt});}
   await tx.set(RECORD,set);forget();return staged;});},
  /** Key compromise: erase the private key, unpublish it at once and, if it was active, replace it immediately. The
   * caller then increments every connection generation and emits the §7 events (EXT-X6/X8). */
  revoke(kid){return metadata.transaction(async tx=>{const set=await load(tx),now=clock(),k=set.keys.find(x=>x.kid===kid&&x.state!=='revoked');if(!k)throw new FederationFault('not_found','No such brokering key.');
   const wasActive=k.state==='active';for(const field of Object.keys(k))if(!['kid','purpose','createdAt'].includes(field))delete k[field];Object.assign(k,{state:'revoked',revokedAt:now});imported.delete(kid);
   await advance(set,now);await tx.set(RECORD,set);forget();return {kid,purpose:k.purpose,replacement:wasActive?set.keys.find(x=>x.purpose===k.purpose&&x.state==='active').kid:null};});},
  /** Operator view: lifecycle metadata only, never key material. */
  async status(){return (await current()).keys.map(({kid,purpose,state,createdAt,activatesAt,activatedAt,retiredAt,removeAt,revokedAt})=>({kid,purpose,state,createdAt,activatesAt,activatedAt,retiredAt,removeAt,revokedAt}));},
  /** Provider-side verification (e.g. a later introspection endpoint): the published set, plus the signing key must
   * have been active when the token was issued, so a retired or staged key cannot vouch for a new token. */
  async verify(token,options){const set=await current();return verifyAccessToken(token,{...options,issuer,keys:published(set),signedWhile:kid=>{const k=set.keys.find(x=>x.kid===kid);return k&&k.activatedAt!==undefined?{from:k.activatedAt,until:k.retiredAt}:null;}});}
 };
}
/** Mints one RFC 9068 brokered access token (integrations §5.3). Live minting checks (account epoch, connection
 * status and generation, grant, assignment, record, consumer session) are the caller's, inside the severance domain. */
export async function mintAccessToken(keys,{subject,audience,clientId,purpose='invoke',connection,generation,resource,grant,methods,scope=null,feature,jkt,lifetime=ACCESS_LIFETIMES[purpose]},{clock=()=>Date.now(),crypto=globalThis.crypto}={}){
 const iat=Math.floor(clock()/1000);if(!Number.isSafeInteger(lifetime)||lifetime<1||lifetime>(ACCESS_LIFETIMES[purpose]??0))throw new FederationFault('invalid_request','Brokered token lifetime exceeds the purpose bound.');
 const bindle={v:1,purpose,connection,generation,...purpose==='discover'?{}:{resource,grant,methods,scope},...feature===undefined?{}:{feature}};
 const claims={iss:keys.issuer,sub:subject,aud:audience,client_id:clientId,iat,exp:iat+lifetime,jti:b64u(crypto.getRandomValues(new Uint8Array(16))),bindle,...jkt===undefined?{}:{cnf:{jkt}}};
 if(!claimsValid(structuredClone(claims),keys.issuer))throw new FederationFault('invalid_request','Brokered token claims are invalid.');
 const {kid,token}=await keys.sign(purpose,claims);
 return {token,tokenType:jkt===undefined?'Bearer':'DPoP',expiresAt:claims.exp*1000,jti:claims.jti,kid};
}
/** Unverified structural parse (§5.5 step 1): lets a resource server find (`iss`, `bindle.connection`) before any key
 * lookup or network fetch. Nothing returned here is trustworthy until verifyAccessToken succeeds. */
export function peekAccessToken(token){
 if(typeof token!=='string'||token.length>8192)invalid('malformed');const parts=token.split('.');if(parts.length!==3)invalid('malformed');
 const header=segment(parts[0],'header'),claims=segment(parts[1],'claims');
 if(!exactKeys(header,['alg','typ','kid'])||Object.keys(header).length!==3)invalid('header');if(header.alg!==BROKERING_ALG)invalid('alg');if(header.typ!==ACCESS_TOKEN_TYP)invalid('typ');if(!KID.test(header.kid)||header.kid.startsWith('event.'))invalid('kid');
 return {header,claims,iss:claims.iss,connection:plain(claims.bindle)?claims.bindle.connection:undefined,parts};
}
/** Verifies a brokered access token in the integrations §5.5 order. `keys` is the issuer's brokering JWKS (object) or
 * `async kid => jwks` (the caller enforces the ≤ 1 h cache and ≤ 1/min unknown-kid refetch); `connection(peek)` may
 * reject an unknown (`iss`, connection) before any key is consulted. Generation floors, revoked grants, envelope
 * matching and DPoP proofs (steps 6–8) remain the resource server's. Failures throw `invalid_token` with a `reason`. */
export async function verifyAccessToken(token,{keys,issuer,audience,purposes=['invoke'],now=Date.now(),leeway=MAX_LEEWAY,connection,signedWhile,crypto=globalThis.crypto}){
 if(!Number.isSafeInteger(leeway)||leeway<0||leeway>MAX_LEEWAY||!httpsURL(audience))throw new TypeError('Verifier needs an exact HTTPS audience and leeway ≤ 30 s.');
 const peek=peekAccessToken(token),{header,claims,parts}=peek;
 if(claims.iss!==issuer)invalid('iss');if(connection&&!await connection(peek))invalid('connection');
 const set=typeof keys==='function'?await keys(header.kid):keys;if(!plain(set)||!Array.isArray(set.keys)||set.keys.length>64)invalid('jwks');
 const matches=set.keys.filter(k=>k?.kid===header.kid);if(matches.length!==1)invalid('kid');const jwk=publicJwk(matches[0]);if(!jwk)invalid('jwks');
 const signature=unb64u(parts[2],'signature');if(signature.length!==64||big(signature.slice(32))>HALF)invalid('signature');
 let key;try{key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},ECDSA,false,['verify']);}catch{invalid('jwks');}
 if(!await crypto.subtle.verify(SIG,key,signature,text.encode(`${parts[0]}.${parts[1]}`)))invalid('signature');
 if(!claimsValid(claims,issuer))invalid('claims');
 if(claims.aud!==audience)invalid('aud');if(!purposes.includes(claims.bindle.purpose)||!header.kid.startsWith(`${claims.bindle.purpose}.`))invalid('purpose');
 const seconds=Math.floor(now/1000);if(claims.iat>seconds+leeway||claims.exp<=seconds-leeway)invalid('time');
 if(signedWhile){const window=signedWhile(header.kid);if(!window||claims.iat*1000<window.from-leeway*1000||window.until!==undefined&&claims.iat*1000>window.until+leeway*1000)invalid('key_state');}
 return {header,claims};
}
