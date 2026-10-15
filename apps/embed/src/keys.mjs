// Frame key and partitioned island storage (adaptive-app-sign-in §6.1, profile §9.1 key-binding.v1; slice A5).
// Runs only in the island worker, after `ready`. One ECDSA P-256 key per (issuer, client_id), generated with
// extractable:false and kept as a CryptoKey in IndexedDB (partitioned by top-level site). When IndexedDB is
// missing, blocked or ephemeral, everything lives in memory for the page life. The thumbprint never leaves
// the embed origin except inside entry creation and proofs sent to the provider.
const DB='bindle-embed',VERSION=1,STORES=['keys','credentials','meta'];
const text=new TextEncoder();
export const b64url=bytes=>btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const randomId=(crypto=globalThis.crypto,size=18)=>b64url(crypto.getRandomValues(new Uint8Array(size)));
export const sha256=async(value,crypto=globalThis.crypto)=>b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode(value))));
export const scopeKey=(...parts)=>parts.join('\0');

const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
function memoryStore(){
  const data=Object.fromEntries(STORES.map(name=>[name,new Map()]));
  // CryptoKey values are kept by reference for the page life.
  const ops={get:async(store,key)=>data[store].get(key),put:async(store,key,value)=>{data[store].set(key,value);},delete:async(store,key)=>{data[store].delete(key);},list:async(store,prefix='')=>[...data[store]].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value}))};
  return {persistent:false,...ops,transaction:async(_,fn)=>fn(ops),close(){}};
}
function idbStore(db){
  const scoped=tx=>({get:(store,key)=>request(tx.objectStore(store).get(key)),put:(store,key,value)=>request(tx.objectStore(store).put(value,key)),delete:(store,key)=>request(tx.objectStore(store).delete(key)),
    list:async(store,prefix='')=>{const range=IDBKeyRange.bound(prefix,prefix+'￿'),[keys,values]=await Promise.all([request(tx.objectStore(store).getAllKeys(range)),request(tx.objectStore(store).getAll(range))]);return keys.map((key,i)=>({key,value:values[i]}));}});
  // Callbacks may await only requests of this transaction, so it never auto-commits early.
  const transaction=async(names,fn,mode='readwrite')=>{const tx=db.transaction(names,mode),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error??new Error('aborted'));});let result;try{result=await fn(scoped(tx));}catch(error){try{tx.abort();}catch{}throw error;}await done;return result;};
  const one=mode=>(store,...args)=>transaction([store],ops=>ops[mode](store,...args),mode==='get'||mode==='list'?'readonly':'readwrite');
  return {persistent:true,get:one('get'),put:one('put'),delete:one('delete'),list:one('list'),transaction,close:()=>db.close()};
}
/** Opens partitioned storage; falls back to memory when IndexedDB is unavailable or refuses (EI-11). */
export async function openStore({indexedDB=globalThis.indexedDB}={}){
  if(!indexedDB)return memoryStore();
  try{
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open(DB,VERSION);req.onupgradeneeded=()=>{for(const name of STORES)if(!req.result.objectStoreNames.contains(name))req.result.createObjectStore(name);};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('blocked'));});
    return idbStore(db);
  }catch{return memoryStore();}
}

/** RFC 7638 thumbprint over the required EC members in lexicographic order. */
export const thumbprint=(jwk,crypto)=>sha256(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`,crypto);
/** Reads or creates the non-extractable frame key for (issuer, client_id). Concurrent islands converge on one key. */
export async function frameKey(store,{issuer,clientId,crypto=globalThis.crypto,clock=()=>Date.now()}){
  const id=scopeKey(issuer,clientId);let record=await store.get('keys',id);
  if(!record?.privateKey){
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey),fresh={privateKey:pair.privateKey,jwk:{kty,crv,x,y},jkt:await thumbprint({x,y},crypto)};
    record=await store.transaction(['keys'],async ops=>{const existing=await ops.get('keys',id);if(existing?.privateKey)return existing;await ops.put('keys',id,fresh);return fresh;});
  }
  if(record.privateKey.extractable!==false)throw new TypeError('The frame key must be non-extractable.');
  const signer=Object.freeze({jwk:Object.freeze({...record.jwk}),jkt:record.jkt,
    async sign({typ,payload}){const enc=value=>b64url(text.encode(JSON.stringify(value))),head=enc({typ,alg:'ES256',jwk:record.jwk}),body=enc(payload);
      return `${head}.${body}.${b64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},record.privateKey,text.encode(`${head}.${body}`))))}`;}});
  return Object.freeze({...signer,
    /** RFC 9449-shaped proof for the embed API (server nonce, `ath` over the bound value). */
    dpop:async({htm='POST',htu,nonce,ath})=>signer.sign({typ:'dpop+jwt',payload:{jti:randomId(crypto),htm,htu,iat:Math.floor(clock()/1000),nonce,...ath!==undefined?{ath:await sha256(ath,crypto)}:{}}}),
    /** Opener-key handshake proof (profile §9.1): single-use challenge, entry-bound, verification URL. */
    embedProof:({issuer:iss,entry,challenge})=>signer.sign({typ:'bindle-embed+jwt',payload:{jti:randomId(crypto),htm:'POST',htu:`${iss}/oauth/entries/${entry}/embed-verify`,iat:Math.floor(clock()/1000),nonce:challenge,entry}}),
    /** FedCM-in-frame proof (adaptive §11.3, profile §9.1): entry-bound, single-use server nonce, `htu` = the assertion endpoint. */
    fedcmProof:({assertUrl,entry,nonce})=>signer.sign({typ:'bindle-embed+jwt',payload:{jti:randomId(crypto),htm:'POST',htu:assertUrl,iat:Math.floor(clock()/1000),nonce,entry}}),
  });
}

// ---- Component credentials and the generation counter (embed-islands §5.1, EIR-9) -------------------------
const genKey=clientId=>`credentials-gen:${clientId}`;
export const readGeneration=async(store,clientId)=>(await store.get('meta',genKey(clientId)))??0;
export async function listCredentials(store,{issuer,clientId}){return (await store.list('credentials',scopeKey(issuer,clientId,''))).map(row=>row.value);}
/** Writes a credential and bumps the generation in one transaction. */
export async function saveCredential(store,{issuer,clientId},record){
  return store.transaction(['credentials','meta'],async ops=>{await ops.put('credentials',scopeKey(issuer,clientId,record.id),record);const gen=((await ops.get('meta',genKey(clientId)))??0)+1;await ops.put('meta',genKey(clientId),gen);return gen;});
}
/** Deletes matching credentials (all of this client's, or one subject's) and bumps the generation. */
export async function deleteCredentials(store,{issuer,clientId},match=()=>true){
  return store.transaction(['credentials','meta'],async ops=>{const rows=(await ops.list('credentials',scopeKey(issuer,clientId,''))).filter(row=>match(row.value));for(const row of rows)await ops.delete('credentials',row.key);if(rows.length){const gen=((await ops.get('meta',genKey(clientId)))??0)+1;await ops.put('meta',genKey(clientId),gen);}return rows.map(row=>row.value);});
}
export async function updateCredential(store,{issuer,clientId},id,patch){
  return store.transaction(['credentials'],async ops=>{const key=scopeKey(issuer,clientId,id),value=await ops.get('credentials',key);if(value)await ops.put('credentials',key,{...value,...patch});return value?{...value,...patch}:null;});
}
/** Monotonic leadership term, incremented by each new leader while it holds the lock. */
export async function nextTerm(store,clientId){
  return store.transaction(['meta'],async ops=>{const key=`leader-term:${clientId}`,term=((await ops.get('meta',key))??0)+1;await ops.put('meta',key,term);return term;});
}
