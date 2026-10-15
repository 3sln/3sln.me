// Persistent (DPoP-bound) app sessions: one code exchange creates one family that owns its rotating
// refresh tokens, access tokens and any paired embed credential. Lifetimes are provisional (DEVLOG Q1).
import {base64url,digest} from '../messaging/store.mjs';
import {fail,exact} from './schema.mjs';
export const APP_SESSION={absolute:30*86400000,idle:7*86400000,grace:30000,perClient:8,history:64};
const key=(kind,id)=>`federation/${kind}/${id}`;
const text=new TextEncoder();
/** Successors are HMAC derivations of the presented token, so the one-time
 * same-key grace can return the identical successor without storing it. */
async function successor(service,family,previous){const mac=await service.crypto.subtle.importKey('raw',Uint8Array.from(atob(family.rotationKey.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);return `${service.routingKey?service.routingKey+'.':''}${base64url(new Uint8Array(await service.crypto.subtle.sign('HMAC',mac,text.encode(`bindle-refresh-successor-v1\0${previous}`))))}`;}
export const expiresIn=(family,now)=>({refresh_expires_in:Math.floor((family.expiresAt-now)/1000),refresh_idle_expires_in:Math.floor((Math.min(family.idleExpiresAt,family.expiresAt)-now)/1000)});
/** Revokes a family and everything it owns, in the caller's transaction. */
export async function revokeFamily(service,tx,family){
 family.status='revoked';await tx.set(key('family',family.familyId),family);for(const hash of family.history??[])await tx.delete(key('refresh',hash));
 for(const row of await tx.list(key('token','')))if(row.value.familyId===family.familyId)await tx.delete(row.key);
 for(const row of await tx.list(key('embed','')))if(row.value.familyId===family.familyId)await tx.delete(row.key);
 for(const row of await tx.list(key('embed-session','')))if(row.value.familyId===family.familyId)await tx.delete(row.key);
}
export async function createAppSession(service,tx,authority,jkt){
 const now=service.clock();
 // At most eight live sessions per client and owner; the least recently used yields before the per-account bound is counted.
 const siblings=(await tx.list(key('family',''))).map(row=>row.value).filter(f=>f.status==='active'&&f.subject===authority.subject&&f.clientId===authority.clientId).sort((a,b)=>(a.lastUsedAt??0)-(b.lastUsedAt??0));
 for(const family of siblings.slice(0,Math.max(0,siblings.length-APP_SESSION.perClient+1)))await revokeFamily(service,tx,family);
 await service.pruneRefreshFamilies(tx,authority);
 const familyId=service.random(),rotationKey=base64url(service.crypto.getRandomValues(new Uint8Array(32))),refresh_token=service.random(),hash=await digest(service.crypto,`refresh\0${refresh_token}`),expiresAt=now+APP_SESSION.absolute;
 const family={...structuredClone(authority),issuer:service.issuer,audience:service.audience,familyId,expiresAt,idleExpiresAt:now+APP_SESSION.idle,lastUsedAt:now,jkt,rotationKey,status:'active',currentHash:hash,history:[hash]};
 await tx.set(key('family',familyId),family);await tx.set(key('refresh',hash),{familyId,used:false,expiresAt});
 return {family,refresh_token,...expiresIn(family,now)};
}
/** Rotation for a bound family inside the refresh transaction. Returns either a
 * token response or {failure} after committing a revocation. */
export async function rotateBound(service,tx,{record,family,hash,token,proof}){
 const now=service.clock();
 // A valid token without its key neither renews nor revokes the session.
 if(!proof||proof.jkt!==family.jkt)fail('invalid_dpop_proof','A DPoP proof from the session key is required.');
 if(family.idleExpiresAt<=now){await revokeFamily(service,tx,family);return {failure:'invalid_grant'};}
 if(record.used){
  const grace=!record.graceUsed&&now-record.usedAt<=APP_SESSION.grace&&record.nextHash===family.currentHash;
  if(!grace){await revokeFamily(service,tx,family);return {failure:'invalid_grant'};}
  await service.active(family.subject,family.epoch);if(service.connections&&(!family.connection||await service.connections.check(family.connection,family.clientId)!==true))fail('unauthorized');
  record.graceUsed=true;await tx.set(key('refresh',hash),record);
  return {...await service.issueAccess(tx,family),refresh_token:await successor(service,family,token),...expiresIn(family,now)};
 }
 if(family.currentHash!==hash||!Array.isArray(family.history)){await revokeFamily(service,tx,family);return {failure:'invalid_grant'};}
 await service.active(family.subject,family.epoch);if(service.connections&&(!family.connection||await service.connections.check(family.connection,family.clientId)!==true))fail('unauthorized');
 const response=await service.issueAccess(tx,family),refresh_token=await successor(service,family,token),nextHash=await digest(service.crypto,`refresh\0${refresh_token}`);
 Object.assign(record,{used:true,usedAt:now,nextHash});await tx.set(key('refresh',hash),record);
 Object.assign(family,{currentHash:nextHash,lastUsedAt:now,idleExpiresAt:Math.min(now+APP_SESSION.idle,family.expiresAt)});family.history.push(nextHash);
 // A bounded ring of recent hashes keeps reuse detection without ending long-lived sessions; older tokens simply stop existing.
 while(family.history.length>APP_SESSION.history)await tx.delete(key('refresh',family.history.shift()));await tx.set(key('family',family.familyId),family);
 await tx.set(key('refresh',nextHash),{familyId:family.familyId,used:false,expiresAt:family.expiresAt});
 return {...response,refresh_token,...expiresIn(family,now)};
}
/** RFC 7009. Unknown, malformed and foreign tokens are a silent success so the
 * endpoint is no validity oracle; embed credentials use another hash domain. */
export async function revokeToken(service,input){
 // Hints are advisory and unknown ones are ignored (RFC 7009 §2.1), so they cannot reveal routing outcomes.
 exact(input,['token','tokenTypeHint','clientId']);if(!service.clients.has(input.clientId))fail('invalid_client');
 if(!service.opaque(input.token))return {};
 const refresh=await digest(service.crypto,`refresh\0${input.token}`),access=await digest(service.crypto,`token\0${input.token}`);
 return service.store.transaction(async tx=>{
  const record=await tx.get(key('refresh',refresh)),family=record&&await tx.get(key('family',record.familyId));
  // A bound family is revoked only by its current token: an old token from its history, without the key, revokes nothing.
  if(family){if(family.clientId===input.clientId&&(!family.jkt||family.currentHash===refresh))await revokeFamily(service,tx,family);return {};}
  const token=await tx.get(key('token',access));if(token&&token.clientId===input.clientId)await tx.delete(key('token',access));return {};
 });
}
