// RFC 9449 DPoP for app sessions (auth.md "Token lifetime and client sessions").
// Loaded lazily, only for providers whose capability set has `dpop`. Private
// keys are generated non-extractable; script on the app origin can use them
// but never read them. ES256 (P-256) only.
const encode64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const text=new TextEncoder();

/** RFC 7638 thumbprint over the required EC members in lexicographic order. */
export async function thumbprint({x,y},crypto=globalThis.crypto){return encode64(await crypto.subtle.digest('SHA-256',text.encode(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)));}

export async function createKey(crypto=globalThis.crypto){
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const {x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey);
  // Exactly the RFC 7638 members: providers reject any other JWK member in the proof header.
  const jwk=Object.freeze({kty:'EC',crv:'P-256',x,y});
  return Object.freeze({privateKey:pair.privateKey,jwk,jkt:await thumbprint(jwk,crypto)});
}

/** A compact proof for one request. `htu` loses query and fragment; `ath` binds an access token. */
export async function createProof(key,{htm='POST',htu,nonce,accessToken,crypto=globalThis.crypto,clock=Date.now}){
  const target=new URL(htu);target.search='';target.hash='';
  const header={typ:'dpop+jwt',alg:'ES256',jwk:key.jwk};
  const payload={jti:encode64(crypto.getRandomValues(new Uint8Array(18))),htm,htu:target.href,iat:Math.floor(clock()/1000),...nonce?{nonce}:{},...accessToken?{ath:encode64(await crypto.subtle.digest('SHA-256',text.encode(accessToken)))}:{}};
  const input=`${encode64(text.encode(JSON.stringify(header)))}.${encode64(text.encode(JSON.stringify(payload)))}`;
  // WebCrypto ECDSA signatures are already the raw r||s form JWS requires.
  return `${input}.${encode64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,text.encode(input)))}`;
}

// Holds a non-extractable key across one redirect round trip (structured clone
// keeps it non-extractable). Entries are deleted as soon as the code exchange
// ends; refresh tokens themselves are never persisted by the SDK.
export function indexedDBKeyStore({indexedDB=globalThis.indexedDB,name='bindle-sdk',store='dpop-keys'}={}){
  if(!indexedDB)return null;
  const open=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore(store);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const run=(mode,action)=>open().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),request=action(tx.objectStore(store));tx.oncomplete=()=>{db.close();resolve(request.result);};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};}));
  return {
    put:(id,key)=>run('readwrite',objects=>objects.put({key,storedAt:Date.now()},id)),
    get:id=>run('readonly',objects=>objects.get(id)).then(value=>value?.key??null),
    delete:id=>run('readwrite',objects=>objects.delete(id)),
    // Abandoned round trips (closed tab, Back) leave entries; anything older than a pending transaction goes.
    sweep:(maxAge=600000)=>run('readwrite',objects=>{const request=objects.openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(!(cursor.value?.storedAt>Date.now()-maxAge))cursor.delete();cursor.continue();};return request;}),
  };
}
