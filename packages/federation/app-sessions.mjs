// Persistent (DPoP-bound) app sessions: one approval (authorization code or device grant) creates one family that owns
// its rotating refresh tokens, access tokens and any paired embed credential. Lifetime (user decisions, DEVLOG
// 2026-10-20, superseding 30 d absolute / 7 d idle): no absolute lifetime unless the user chose a shorter one at device
// approval; a sliding refresh idle limit (180 d, host-configurable); every refresh rotates with reuse detection and a
// one-time 30 s same-key grace; every refresh re-checks the live grant, account, connection and approval lineage.
// Access tokens: 15 min Bearer, 60 min DPoP-bound (host-configurable, never longer than those ceilings).
import {base64url,digest} from '../messaging/store.mjs';
import {fail,exact} from './schema.mjs';
const MINUTE=60000,DAY=86400000;
/** `idle` is the paired embed-credential idle limit (embed-bindings.mjs). Refresh and access defaults sit beside it. */
export const APP_SESSION=Object.freeze({idle:7*DAY,refreshIdle:180*DAY,maxRefreshIdle:365*DAY,bearerAccess:15*MINUTE,dpopAccess:60*MINUTE,grace:30000,perClient:8,history:64});
/** Absolute expiry of a family without one: finite and JSON-safe (the largest Date), so every `expiresAt <= now`
 * reader, including refresh-record equality and cleanup, treats it as never reached. */
export const NO_EXPIRY=8640000000000000;
const whole=(raw,min,max,name,unit)=>{if(raw===undefined||raw==='')return undefined;const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max||String(value)!==String(raw).trim())throw new TypeError(`${name} must be a whole number of ${unit} from ${min} to ${max}.`);return value;};
/** Host policy from configuration: APP_REFRESH_IDLE_DAYS (1–365, default 180), APP_ACCESS_TOKEN_MINUTES (Bearer,
 * 1–15, default 15) and APP_DPOP_ACCESS_TOKEN_MINUTES (DPoP-bound, 1–60, default 60). Invalid values fail loudly. */
export function appSessionPolicy(config={}){
 const days=whole(config.APP_REFRESH_IDLE_DAYS,1,365,'APP_REFRESH_IDLE_DAYS','days'),bearer=whole(config.APP_ACCESS_TOKEN_MINUTES,1,15,'APP_ACCESS_TOKEN_MINUTES','minutes'),bound=whole(config.APP_DPOP_ACCESS_TOKEN_MINUTES,1,60,'APP_DPOP_ACCESS_TOKEN_MINUTES','minutes');
 return Object.freeze({idleMs:days===undefined?APP_SESSION.refreshIdle:days*DAY,bearerAccessMs:bearer===undefined?APP_SESSION.bearerAccess:bearer*MINUTE,dpopAccessMs:bound===undefined?APP_SESSION.dpopAccess:bound*MINUTE});
}
const within=(value,min,max,fallback)=>Number.isSafeInteger(value)&&value>=min&&value<=max?value:fallback;
// The adapter attaches `service.appSessions = {idleMs, bearerAccessMs, dpopAccessMs, lineage:{live, revoke}}`
// (device-authorization.mjs `attachAppSessions`); absent or out-of-range values use the defaults above.
export const appRefreshIdleMs=service=>within(service.appSessions?.idleMs,DAY,APP_SESSION.maxRefreshIdle,APP_SESSION.refreshIdle);
export const appAccessMs=(service,family)=>family?.access==='dpop'?within(service.appSessions?.dpopAccessMs,MINUTE,APP_SESSION.dpopAccess,APP_SESSION.dpopAccess):within(service.appSessions?.bearerAccessMs,MINUTE,APP_SESSION.bearerAccess,APP_SESSION.bearerAccess);
const key=(kind,id)=>`federation/${kind}/${id}`;
const text=new TextEncoder();
/** Storage ID of a DPoP-bound access token. Its `dpop/` prefix keeps it out of the Bearer lookup, whose digest never
 * contains a slash, so a bound token presented as Bearer is unknown. */
export const boundTokenId=async(service,token)=>`dpop/${await digest(service.crypto,`dpop-token\0${token}`)}`;
/** Successors are HMAC derivations of the presented token, so the one-time
 * same-key grace can return the identical successor without storing it. */
async function successor(service,family,previous){const mac=await service.crypto.subtle.importKey('raw',Uint8Array.from(atob(family.rotationKey.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);return `${service.routingKey?service.routingKey+'.':''}${base64url(new Uint8Array(await service.crypto.subtle.sign('HMAC',mac,text.encode(`bindle-refresh-successor-v1\0${previous}`))))}`;}
/** `refresh_expires_in` is the lifetime of the issued refresh token: without an absolute expiry it equals the idle
 * window, and each rotation renews it. */
export const expiresIn=(family,now)=>{const idle=Math.floor((Math.min(family.idleExpiresAt,family.expiresAt)-now)/1000);return {refresh_expires_in:family.expiresAt>=NO_EXPIRY?idle:Math.floor((family.expiresAt-now)/1000),refresh_idle_expires_in:idle};};
/** Revokes a family and everything it owns, in the caller's transaction. The record stays (status revoked) until
 * cleanup removes it, which its expiry now allows. */
export async function revokeFamily(service,tx,family){
 family.status='revoked';family.expiresAt=Math.min(family.expiresAt,service.clock());await tx.set(key('family',family.familyId),family);for(const hash of family.history??[])await tx.delete(key('refresh',hash));
 for(const row of await tx.list(key('token','')))if(row.value.familyId===family.familyId)await tx.delete(row.key);
 for(const row of await tx.list(key('embed','')))if(row.value.familyId===family.familyId)await tx.delete(row.key);
 for(const row of await tx.list(key('embed-session','')))if(row.value.familyId===family.familyId)await tx.delete(row.key);
}
/** Ends the approval lineage of families that ended here (frees the account's lineage slot). Best effort: the family
 * is already unusable, and a lineage that stays behind only fails its own refresh check. */
export async function endLineage(service,families){
 const revoke=service.appSessions?.lineage?.revoke;if(typeof revoke!=='function')return;
 for(const family of families)if(family?.lineage)try{await revoke({owner:family.lineage.owner,lineageId:family.lineage.lineageId});}catch{}
}
/** Live approval lineage of a device-grant family (LinkedLineageQuery): true, false (revoke), or a refusal without
 * state change when the port is missing or failing. Families without lineage pass. */
export async function lineageLive(service,family){
 if(!family.lineage)return true;const live=service.appSessions?.lineage?.live;if(typeof live!=='function')fail('temporarily_unavailable','Application sessions are temporarily unavailable.');
 let result;try{result=await live({owner:family.lineage.owner,lineageId:family.lineage.lineageId,familyId:family.familyId});}catch{fail('temporarily_unavailable','Application sessions are temporarily unavailable.');}
 return result===true;
}
/** Access token for a family: Bearer (≤ 15 min) or DPoP-bound (≤ 60 min, stored under `boundTokenId`), never past the
 * family's absolute expiry. Grants are re-read live. */
export async function issueAppAccess(service,tx,family){
 const grants=await service.liveGrantIds(tx,family);await service.bounded(tx,'token',256);
 const now=service.clock(),bound=family.access==='dpop',access_token=service.random(),expiresAt=Math.min(now+appAccessMs(service,family),family.expiresAt),expires_in=Math.floor((expiresAt-now)/1000);if(expires_in<1)fail('invalid_grant');
 const id=bound?await boundTokenId(service,access_token):await digest(service.crypto,`token\0${access_token}`);
 await tx.set(key('token',id),{issuer:service.issuer,audience:service.audience,subject:family.subject,epoch:family.epoch,...family.connection?{connection:structuredClone(family.connection)}:{},familyId:family.familyId,clientId:family.clientId,grants,expiresAt,...bound?{jkt:family.jkt}:{}});
 const granted_fragments=[];for(const grant of grants){const record=await tx.get(key('grant',grant));granted_fragments.push({grant,fragment:record.fragment,digest:record.digest,fields:structuredClone(record.fields)});}
 return {access_token,token_type:bound?'DPoP':'Bearer',expires_in,issuer:service.issuer,subject:family.subject,client_id:family.clientId,audience:service.audience,grants,granted_fragments};
}
/** One family per approval. `options`: `familyId` (reserved by linked approval), `expiresAt` (a user-chosen absolute
 * limit; default none), `lineage` ({owner, lineageId}), `access: 'dpop'` (bound access tokens) and `grantType`. */
export async function createAppSession(service,tx,authority,jkt,options={}){
 const now=service.clock(),ended=[];
 // At most eight live sessions per client and owner; the least recently used yields before the per-account bound is counted.
 const siblings=(await tx.list(key('family',''))).map(row=>row.value).filter(f=>f.status==='active'&&f.subject===authority.subject&&f.clientId===authority.clientId).sort((a,b)=>(a.lastUsedAt??0)-(b.lastUsedAt??0));
 for(const family of siblings.slice(0,Math.max(0,siblings.length-APP_SESSION.perClient+1))){await revokeFamily(service,tx,family);ended.push(family);}
 // Families the account-wide prune deletes (idle, revoked, stale grant or connection) end their lineage too.
 const before=(await tx.list(key('family',''))).map(row=>row.value).filter(f=>f.subject===authority.subject&&f.lineage&&f.status==='active');
 await service.pruneRefreshFamilies(tx,authority);
 for(const family of before)if(!await tx.get(key('family',family.familyId)))ended.push(family);
 const familyId=options.familyId??service.random();if(typeof familyId!=='string'||!/^[A-Za-z0-9_.-]{16,128}$/.test(familyId)||await tx.get(key('family',familyId)))fail('invalid_grant');
 const expiresAt=options.expiresAt==null?NO_EXPIRY:options.expiresAt;if(!Number.isSafeInteger(expiresAt)||expiresAt<=now)fail('invalid_grant');
 const rotationKey=base64url(service.crypto.getRandomValues(new Uint8Array(32))),refresh_token=service.random(),hash=await digest(service.crypto,`refresh\0${refresh_token}`);
 const family={...structuredClone(authority),issuer:service.issuer,audience:service.audience,familyId,expiresAt,idleExpiresAt:Math.min(now+appRefreshIdleMs(service),expiresAt),lastUsedAt:now,createdAt:now,jkt,rotationKey,status:'active',currentHash:hash,history:[hash],grantType:options.grantType??'authorization_code',...options.lineage?{lineage:{owner:options.lineage.owner,lineageId:options.lineage.lineageId}}:{},...options.access==='dpop'?{access:'dpop'}:{}};
 await tx.set(key('family',familyId),family);await tx.set(key('refresh',hash),{familyId,used:false,expiresAt});
 await endLineage(service,ended);
 return {family,refresh_token,...expiresIn(family,now)};
}
const DEVICE_GRANT='urn:ietf:params:oauth:grant-type:device_code';
async function live(service,family){
 // A device-grant client must still be a device-eligible registration (review LA2-S11).
 if(family.grantType===DEVICE_GRANT&&!service.clients.get(family.clientId)?.grantTypes?.includes(DEVICE_GRANT))return false;
 await service.active(family.subject,family.epoch);if(service.connections&&(!family.connection||await service.connections.check(family.connection,family.clientId)!==true))fail('unauthorized');
 return lineageLive(service,family);
}
/** Rotation for a bound family inside the refresh transaction. Returns either a
 * token response or {failure} after committing a revocation. */
export async function rotateBound(service,tx,{record,family,hash,token,proof}){
 const now=service.clock(),end=async()=>{await revokeFamily(service,tx,family);await endLineage(service,[family]);return {failure:'invalid_grant'};};
 // A valid token without its key neither renews nor revokes the session.
 if(!proof||proof.jkt!==family.jkt)fail('invalid_dpop_proof','A DPoP proof from the session key is required.');
 if(family.idleExpiresAt<=now)return end();
 if(record.used){
  const grace=!record.graceUsed&&now-record.usedAt<=APP_SESSION.grace&&record.nextHash===family.currentHash;
  if(!grace)return end();
  if(!await live(service,family))return end();
  record.graceUsed=true;await tx.set(key('refresh',hash),record);
  return {...await issueAppAccess(service,tx,family),refresh_token:await successor(service,family,token),...expiresIn(family,now)};
 }
 if(family.currentHash!==hash||!Array.isArray(family.history))return end();
 if(!await live(service,family))return end();
 const response=await issueAppAccess(service,tx,family),refresh_token=await successor(service,family,token),nextHash=await digest(service.crypto,`refresh\0${refresh_token}`);
 Object.assign(record,{used:true,usedAt:now,nextHash});await tx.set(key('refresh',hash),record);
 Object.assign(family,{currentHash:nextHash,lastUsedAt:now,idleExpiresAt:Math.min(now+appRefreshIdleMs(service),family.expiresAt)});family.history.push(nextHash);
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
 const refresh=await digest(service.crypto,`refresh\0${input.token}`),access=await digest(service.crypto,`token\0${input.token}`),bound=await boundTokenId(service,input.token);
 const ended=await service.store.transaction(async tx=>{
  const record=await tx.get(key('refresh',refresh)),family=record&&await tx.get(key('family',record.familyId));
  // A bound family is revoked only by its current token: an old token from its history, without the key, revokes nothing.
  if(family){if(family.clientId===input.clientId&&family.status==='active'&&(!family.jkt||family.currentHash===refresh)){await revokeFamily(service,tx,family);return family;}return null;}
  for(const id of [access,bound]){const token=await tx.get(key('token',id));if(token&&token.clientId===input.clientId)await tx.delete(key('token',id));}return null;
 });
 if(ended)await endLineage(service,[ended]);return {};
}
