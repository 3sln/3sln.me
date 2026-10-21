import {localUnwrap,verifyUnwrapProof,MANIFEST_KEY} from '../../../packages/bindlebox-engine/store/archive-writer.mjs';
import {parseDelegation} from '../../../packages/bindlebox-protocol/index.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
// Disposable local development only. Keys exist for this process and must never be selected by production composition.
export async function createLocalTestKeyHolder({store,clock={now:()=>Date.now()}}){
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),{kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey),kid=crypto.randomUUID();
 const allowed=async({delegation,proof,name,kid})=>{
  const config=await store.get('config'),grant=await store.get('shell:authorization'),key=await store.get('shell:delegate');let claims;try{claims=parseDelegation(delegation).claims;}catch{return false;}
  return grant?.active===true&&claims.cnx===grant.connection&&claims.jkt===key?.jkt&&await verifyUnwrapProof({delegation,proof,name,kid,owner:config?.principal,now:clock.now()});
 };
 return {current:async()=>({kid,publicJwk:{kty,crv,x,y}}),async unwrap({delegation,proof,...header}){if(header.kid!==kid||!await allowed({delegation,proof,...header}))fault('forbidden','Archive key access refused.',403);return localUnwrap(pair.privateKey,header);},attest:input=>allowed({...input,name:MANIFEST_KEY,kid:'takeover'})};
}
