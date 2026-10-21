// App-custodied keys, sealed per mailbox. `certify` uses the ordinary consented provider delegation contract;
// this adapter never imports provider internals or exports a private key to a browser/service.
import * as B from '../../../packages/bindlebox-protocol/index.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
const encoder=new TextEncoder(),ES={name:'ECDSA',namedCurve:'P-256'},publicOnly=({kty,crv,x,y})=>({kty,crv,x,y});
const unavailable=()=>fault('recipient_unavailable','Delegation service unavailable.',503);
export function sealedDelegateKeys({store,secret,clientId,certify,directory,clock={now:()=>Date.now()}}){
 let tail=Promise.resolve();
 async function context(){const owner=await store.get('owner'),config=await store.get('config'),grant=await store.get('shell:authorization');if(!owner||config?.principal?.subject!==owner||!grant?.active||!secret||!clientId)unavailable();return {owner,config,revision:grant.revision};}
 async function key(owner){let bytes;try{bytes=B.fromBase64url(secret,32);}catch{unavailable();}const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('bindlebox-shell-v1'),info:encoder.encode(owner)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
 async function open(row,owner){try{const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:B.fromBase64url(row.iv,12),additionalData:encoder.encode(`${owner}\n${row.jkt}`)},await key(owner),B.fromBase64url(row.sealed));return crypto.subtle.importKey('jwk',JSON.parse(new TextDecoder().decode(raw)),ES,false,['sign']);}catch{unavailable();}}
 async function snapshot(row,owner){return {kid:`jkt:${row.jkt}`,delegation:row.delegation,privateKey:await open(row,owner)};}
 return {
  async current(){const {owner}=await context(),row=await store.get('shell:delegate');if(!row?.delegation)unavailable();return snapshot(row,owner);},
  renew(){const result=tail.then(async()=>{
   const {owner,config,revision}=await context();let row=await store.get('shell:delegate');
   if(!row){
    const pair=await crypto.subtle.generateKey(ES,true,['sign','verify']),publicJwk=publicOnly(await crypto.subtle.exportKey('jwk',pair.publicKey)),jkt=await B.thumbprint(publicJwk),iv=crypto.getRandomValues(new Uint8Array(12));
    const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`${owner}\n${jkt}`)},await key(owner),encoder.encode(JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey))));
    row={jkt,publicJwk,iv:B.base64url(iv),sealed:B.base64url(new Uint8Array(sealed)),delegation:null};
    await store.transaction(async tx=>{const prior=await tx.get('shell:delegate');if(prior)row=prior;else await tx.put('shell:delegate',row);});
   }
   const privateKey=await open(row,owner),iat=Math.floor(clock.now()/1000),input=encoder.encode('bindle-key-delegation-pop-v1\n'+JSON.stringify({aud:config.principal.issuer,client_id:clientId,iat,jkt:row.jkt,sub:owner}));
   if(typeof certify!=='function')unavailable();
   const result=await certify({owner,renew:row.delegation!==null,input:{delegate:row.publicJwk,purposes:Object.values(B.PURPOSES).sort(),proof:{iat,signature:B.base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,input)))}}});
   const certificate=result?.certificate,jws=B.parseDelegation(certificate),identityKey=await directory?.resolveKey({issuer:config.principal.issuer,subject:owner,keyId:jws.header.kid});
   const {claims}=await B.verifyDelegation(certificate,{identityKey,principal:config.principal,jkt:row.jkt,purpose:B.PURPOSES.receipt,now:clock.now()});
   if(claims.client.client_id!==clientId||claims.client.origin!==new URL(clientId).origin||claims.client.ingress!==config.ingress||!Object.values(B.PURPOSES).every(p=>claims.purposes.includes(p)))unavailable();
   const at=(claims.iat+(claims.exp-claims.iat)/2)*1000;if(at<=clock.now())unavailable();
   await store.transaction(async tx=>{const grant=await tx.get('shell:authorization'),current=await tx.get('shell:delegate');if(!grant?.active||grant.revision!==revision||current?.jkt!==row.jkt)fault('not_authorized','Connection changed during renewal.',403);await tx.put('shell:delegate',{...row,delegation:certificate});await tx.put('shell:renewal',{at});});
   return {jkt:row.jkt,expiresAt:claims.exp*1000};
  });tail=result.catch(()=>{});return result;}
 };
}
