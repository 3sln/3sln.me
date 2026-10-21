import {base64url,fromBase64url,LIMITS} from '../../bindlebox-protocol/index.mjs';
import {fault} from '../faults.mjs';
const chunkBytes=786432,te=new TextEncoder();
// A fresh per-body key lives only in the mailbox metadata (and the sealed archive), never in user storage.
export async function stageBody(storage,key,body){
 if(!(body instanceof Uint8Array)||body.length>LIMITS.maxBodyBytes)fault('too_large','Body exceeds its limit.',413);
 const raw=crypto.getRandomValues(new Uint8Array(32)),secret=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']),parts=[];
 try{for(let at=0;at<body.length;at+=chunkBytes){const name=key+'/'+parts.length,iv=crypto.getRandomValues(new Uint8Array(12)),bytes=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:te.encode(name)},secret,body.subarray(at,at+chunkBytes)));await storage.put(name,bytes);parts.push({key:name,iv:base64url(iv)});}return {storage:'user',key,seal:{alg:'A256GCM',key:base64url(raw),parts}};}
 catch(error){for(const p of parts)await storage.delete?.(p.key).catch(()=>{});throw error;}finally{raw.fill(0);}
}
export async function readBody(storage,ref){
 if(ref?.seal?.alg!=='A256GCM'||!Array.isArray(ref.seal.parts)||ref.seal.parts.length>Math.ceil(LIMITS.maxBodyBytes/chunkBytes)||ref.seal.parts.some((p,i)=>p?.key!==ref.key+'/'+i))fault('body_unavailable','Encrypted body is unavailable.',503);
 const secret=await crypto.subtle.importKey('raw',fromBase64url(ref.seal.key,32),'AES-GCM',false,['decrypt']),parts=[];
 let total=0;for(const p of ref.seal.parts){const result=await storage.get(p.key),bytes=result?.bytes??result;try{if(!(bytes instanceof Uint8Array)||bytes.length>chunkBytes+16||bytes.length<16)throw new Error();const part=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64url(p.iv,12),additionalData:te.encode(p.key)},secret,bytes));total+=part.length;if(total>LIMITS.maxBodyBytes)throw new Error();parts.push(part);}catch{fault('body_unavailable','Encrypted body cannot be verified.',503);}}
 const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;
}
export const bodyObjects=ref=>ref?.seal?.parts?.map(p=>p.key)??(ref?.key?[ref.key]:[]);
