// One explicitly configured bridge key. Publication always projects public coordinates; never serialize the secret.
import {bridgeConfig} from './engine.mjs';
export async function bridgeKey(config){
 if(!bridgeConfig(config).enabled)return null;
 try{
  const {kid,privateJWK:k}=JSON.parse(config.EMAIL_BRIDGE_SIGNING_JWK);
  if(typeof kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(kid)||k?.kty!=='EC'||k.crv!=='P-256'||typeof k.d!=='string')return null;
  const publicJwk={kty:'EC',crv:'P-256',x:k.x,y:k.y},privateKey=await crypto.subtle.importKey('jwk',k,{name:'ECDSA',namedCurve:'P-256'},false,['sign']),publicKey=await crypto.subtle.importKey('jwk',publicJwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const probe=new TextEncoder().encode('email-bridge-key-check-v1'),proof=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,probe);if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,proof,probe))return null;
  const keyId=`${bridgeConfig(config).origin}/keys/email-bridge/${kid}`;return {keyId,privateKey,publicJwk:{...publicJwk,kid:keyId,alg:'ES256',use:'sig',key_ops:['verify']}};
 }catch{return null;}
}
