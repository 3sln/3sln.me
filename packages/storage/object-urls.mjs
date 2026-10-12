const encoder=new TextEncoder();
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const pathPattern=new RegExp(`^/bindle/objects/(${UUID})/([A-Za-z0-9_-]{43})$`);
const opaque=/^[A-Za-z0-9_-]{43}$/;
const failure=()=>{throw Object.assign(new Error('This object URL is invalid or no longer active.'),{code:'unauthorized',status:401});};
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const decode=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));

/** A provider-only signing domain. No user credential or resource bearer is
 * encoded into a URL; private delegation state lives in its account shard. */
export function objectURLAuthority({issuer,secret,crypto=globalThis.crypto,clock=()=>Date.now()}){
 const origin=new URL(issuer).origin;
 let keyPromise;
 const key=()=>keyPromise??=(async()=>{let bytes;try{bytes=decode(secret);}catch{failure();}if(bytes.byteLength!==32)failure();const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(origin),info:encoder.encode('bindle/object-url/provider-signing/v1')},material,{name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);})();
 const message=({owner,id,operation,expiresAt})=>encoder.encode(`bindle-object-url-v1\n${origin}\n${owner}\n${id}\n${operation}\n${expiresAt}`);
 const validate=claims=>{if(!new RegExp(`^${UUID}$`).test(claims.owner)||!opaque.test(claims.id)||!['read','write'].includes(claims.operation)||!Number.isSafeInteger(claims.expiresAt)||claims.expiresAt<=clock()||claims.expiresAt>clock()+300000)failure();};
 return {
  async sign(claims){validate(claims);const signature=encode(new Uint8Array(await crypto.subtle.sign('HMAC',await key(),message(claims))));return `${origin}/bindle/objects/${claims.owner}/${claims.id}?expires=${claims.expiresAt}&sig=${signature}`;},
  async verify(value,operation){let url;try{if(typeof value!=='string'||value.length>512)failure();url=new URL(value);}catch{failure();}const match=pathPattern.exec(url.pathname);if(url.origin!==origin||url.username||url.password||url.hash||!match||url.searchParams.size!==2||url.searchParams.getAll('expires').length!==1||url.searchParams.getAll('sig').length!==1)failure();const raw=url.searchParams.get('expires'),signature=url.searchParams.get('sig');if(!/^\d{13}$/.test(raw??'')||!opaque.test(signature??''))failure();const claims={owner:match[1],id:match[2],operation,expiresAt:Number(raw)};validate(claims);if(value!==url.href||encode(decode(signature))!==signature||url.href!==`${origin}${url.pathname}?expires=${raw}&sig=${signature}`)failure();if(!await crypto.subtle.verify('HMAC',await key(),decode(signature),message(claims)))failure();return {...claims,signature};}
 };
}
