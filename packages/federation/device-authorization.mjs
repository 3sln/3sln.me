// Federation half of the device authorization grant (docs/spec/device-authorization.md, `device-authorization.v1`;
// docs/architecture/linked-approval.md slice LA2). The identity half is the LA1 linked-approval core, reached only
// through its unrouted system operations (linked-approval.md §10.1) via the `linked` port. Nothing here is routed:
// LA3 mounts the handlers below behind DEVICE_AUTHORIZATION_ENABLED (default off) and declares the feature only where
// the routes are mounted. Reviewed (statically registered) clients only: metadata-document clients get no device grant.
//
// Request order (spec §10.5): browser refusal and exact media type → form/format checks → network limits → DPoP
// signature and nonce → client → identity read. The owner shard then turns the single redemption into one app session
// (app-sessions.mjs): DPoP-bound refresh and access tokens, no absolute lifetime unless the user chose one, a sliding
// idle limit, and the approval lineage checked on every refresh and every RPC.
import {AppAction} from '../app/engine.mjs';
import {digest,boundedString,canonical} from '../messaging/store.mjs';
import {fail,object,https} from './schema.mjs';
import {verifyProof,DPOP_TYP,jktPattern} from './dpop.mjs';
import {metadataClientHost} from './client-metadata.mjs';
import {linkedNetwork} from '../identity/linked-approval.mjs';
import {createAppSession,issueAppAccess,boundTokenId,revokeFamily,endLineage,appSessionPolicy} from './app-sessions.mjs';
export const DEVICE_GRANT='urn:ietf:params:oauth:grant-type:device_code',DEVICE_FEATURE='device-authorization.v1';
export const DEVICE_LIMITS=Object.freeze({body:8192,client:{windowMs:600000,limit:300},address:{windowMs:600000,limit:3},pollPrefix:{windowMs:60000,limit:120},pollGlobal:{windowMs:60000,limit:20000},approvalMs:600000,jti:20000});
const NO_STORE=Object.freeze({'Cache-Control':'no-store',Pragma:'no-cache'});
const DEVICE_CODE=/^([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/,REQUEST_ID=/^[a-f0-9-]{36}$/,OWNER_TOKEN=/^([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/;
const key=(kind,id)=>`federation/${kind}/${id}`;
const approvalKey=linkedRequestId=>key('code',`device/${linkedRequestId}`);
const fault=(code,message,extra={})=>{throw Object.assign(new Error(message??code),{code},extra);};
/** RFC 6749 §5.2 error result. Pending answers carry only `error` and `interval` (pre-consent privacy, spec §6.2). */
const oauthError=(error,{status=400,interval,retryAfter,headers={}}={})=>({status,body:{error,...Number.isSafeInteger(interval)?{interval}:{}},headers:{...NO_STORE,...Number.isSafeInteger(retryAfter)?{'Retry-After':String(retryAfter)}:{},...headers}});
const lower=headers=>Object.fromEntries(Object.entries(headers??{}).map(([name,value])=>[name.toLowerCase(),value]));
/** Browser refusal (spec §4.1): any Origin or Sec-Fetch-* header. */
const fromBrowser=headers=>Object.keys(headers).some(name=>name==='origin'||name.startsWith('sec-fetch-'));
const formType=headers=>String(headers['content-type']??'').split(';')[0].trim().toLowerCase()==='application/x-www-form-urlencoded';
function form(body,allowed){
 if(typeof body!=='string'||new TextEncoder().encode(body).length>DEVICE_LIMITS.body)fault('invalid_request');
 const params=new URLSearchParams(body),names=[...params.keys()];if(new Set(names).size!==names.length)fault('invalid_request');
 if(names.includes('scope'))fault('invalid_scope');if(names.some(name=>!allowed.includes(name)))fault('invalid_request');return params;
}
// Malformed segments can raise platform decoding errors; every proof failure is invalid_dpop_proof (or a nonce challenge).
const proven=async(...args)=>{try{return await verifyProof(...args);}catch(error){if(typeof error?.code==='string')throw error;fault('invalid_dpop_proof');}};
const control=value=>/[\u0000-\u001f\u007f]/.test(value);
function fragmentRequests(raw,client){
 if(raw===null)return [];let value;try{value=JSON.parse(raw);}catch{fault('invalid_request');}
 if(!Array.isArray(value)||value.length>8||new TextEncoder().encode(canonical(value)).length>8192)fault('invalid_request');const seen=new Set();
 for(const request of value){
  if(!object(request)||Object.keys(request).some(k=>!['fragment','required','purpose','fields','methods'].includes(k))||typeof request.required!=='boolean'||!boundedString(request.purpose,1000)||!Array.isArray(request.fields)||!request.fields.length||request.fields.length>32||request.fields.some(f=>!boundedString(f,200))||new Set(request.fields).size!==request.fields.length||request.methods!==undefined&&!object(request.methods)||seen.has(request.fragment))fault('invalid_request');
  try{https(request.fragment);}catch{fault('invalid_request');}seen.add(request.fragment);
  // Each client may ask only for fragments on its operator-reviewed device allowlist (architecture §6.1).
  if(!Array.isArray(client.deviceFragments)||!client.deviceFragments.includes(request.fragment))fault('invalid_scope');
 }
 return structuredClone(value);
}
/** Non-durable DPoP `jti` cache for the token, cancel and RPC endpoints (spec §6.1): a reset only reopens the iat window. */
export class MemoryJtiCache {
 constructor(clock=()=>Date.now(),max=DEVICE_LIMITS.jti){this.clock=clock;this.max=max;this.seen=new Map();}
 claim(name,expiresAt){const now=this.clock();if(this.seen.size>=this.max)for(const [id,until]of this.seen)if(until<=now)this.seen.delete(id);
  if((this.seen.get(name)??0)>now)return false;if(this.seen.size>=this.max)fault('temporarily_unavailable','Device sign-in is busy. Try again shortly.',{retryAfter:5});this.seen.set(name,expiresAt);return true;}
}
/** Manifest members for LA3's declaration row (only where the routes are mounted and the flag is on). */
export function deviceManifest(issuer){return {device_authorization_endpoint:`${issuer}/oauth/device_authorization`,grant_types_supported:[DEVICE_GRANT,'refresh_token'],dpop_signing_alg_values_supported:['ES256'],revocation_endpoint:`${issuer}/oauth/revoke`,features:{[DEVICE_FEATURE]:{}}};}
/** Owner-shard wiring for app sessions: the host's lifetime policy (app-sessions.mjs `appSessionPolicy`) and the
 * lineage port. LA3 calls this when it builds each owner FederationService, so refreshes on any instance see it. */
export function attachAppSessions(service,{linked,config={},policy=appSessionPolicy(config)}={}){
 service.appSessions=Object.freeze({...policy,...linked?{lineage:Object.freeze({live:ref=>linked.lineageLive(ref),revoke:ref=>linked.lineageRevoke(ref)})}:{}});return service;
}
/** Adapter from the identity engine to the `linked` port: system operations through LinkedSystemAction and the
 * lineage/outbox Queries, the browser decision through LinkedApprovalAction/LinkedResolveQuery. */
export function linkedPort(engine,classes){
 const {LinkedSystemAction,LinkedApprovalAction,LinkedResolveQuery,LinkedLineageQuery,LinkedOutboxQuery}=classes;
 const run=async(Kind,method,input,context)=>(await engine.dispatch(new Kind(method,input,context)).next('result')).detail;
 return Object.freeze({
  startApp:(input,context)=>run(LinkedSystemAction,'linkedStartApp',input,context),redeem:(input,context)=>run(LinkedSystemAction,'linkedRedeem',input,context),cancelApp:input=>run(LinkedSystemAction,'linkedCancelApp',input),
  lineageRevoke:input=>run(LinkedSystemAction,'linkedLineageRevoke',input),outboxAck:input=>run(LinkedSystemAction,'linkedOutboxAck',input),
  lineageLive:input=>engine.query(new LinkedLineageQuery(input)).peek(),outbox:input=>engine.query(new LinkedOutboxQuery(input)).peek(),
  resolve:(input,context)=>engine.query(new LinkedResolveQuery(input,context)).peek(),approve:(input,context)=>run(LinkedApprovalAction,'linkedApprove',input,context)});
}
/** Owner-shard request and entry identifiers derived from the linked request, so a retried review resumes them. */
async function ownerIds(service,owner,linkedRequestId){
 const crypto=service.crypto;return {requestId:`${owner}.${await digest(crypto,`device-owner-request\0${linkedRequestId}`)}`,entryHash:await digest(crypto,`device-entry\0${linkedRequestId}`),challenge:await digest(crypto,`device-challenge\0${linkedRequestId}`),state:await digest(crypto,`device-state\0${linkedRequestId}`)};
}
const authority=(context,mutation)=>({context,mutation});
/** Starts (or resumes) the owner-shard authorization request for a linked app request and returns its consent view.
 * The request uses the client's first registered redirect URI only as an internal binding: its code is never
 * delivered to any browser or redirect, and the device token endpoint redeems it by the linked request ID. */
export async function deviceConsentView(service,context,{owner,linkedRequestId,client,requests}){
 const ids=await ownerIds(service,owner,linkedRequestId);
 await service.beginEntryAuthorization(authority(context,true),{requestId:ids.requestId,entry:{entryHash:ids.entryHash,clientId:client.id,redirectUri:client.redirectUris[0],challenge:ids.challenge,state:ids.state,requests,intent:'login',delivery:'redirect'}});
 return service.inspect(ids.requestId,authority(context,false));
}
/** Owner approval of the consent: issues the grants and an internal code, then stores the code record under the
 * linked request ID until the device redeems it (at most the pending window). */
export async function deviceConsentApprove(service,context,{owner,linkedRequestId,client,requests,approved}){
 const ids=await ownerIds(service,owner,linkedRequestId);
 await service.beginEntryAuthorization(authority(context,true),{requestId:ids.requestId,entry:{entryHash:ids.entryHash,clientId:client.id,redirectUri:client.redirectUris[0],challenge:ids.challenge,state:ids.state,requests,intent:'login',delivery:'redirect'}});
 const result=await service.approve(authority(context,true),{requestId:ids.requestId,approved},{entry:true}),code=new URL(result.redirectUri).searchParams.get('code');if(!code)fail('access_denied');
 const hash=await digest(service.crypto,`code\0${code}`);
 const conflict=await service.store.transaction(async tx=>{const record=await tx.get(key('code',hash));if(!record)fail('invalid_grant');await tx.delete(key('code',hash));
  // An earlier approval for this request is never overwritten (review LA2-S9): the new grants are withdrawn instead.
  if(await tx.get(approvalKey(linkedRequestId))){for(const id of record.grants??[]){const grant=await tx.get(key('grant',id));if(grant){grant.active=false;await tx.set(key('grant',id),grant);}}return true;}
  await tx.set(approvalKey(linkedRequestId),{...record,linkedRequestId,expiresAt:service.clock()+DEVICE_LIMITS.approvalMs});return false;});
 if(conflict)fail('conflict','This request was already decided.');
}
/** Undoes an owner approval whose linked decision failed: no code, inactive grants, and the request reopened for a
 * fresh review (as service.approve's own compensation does). */
export async function deviceConsentRevert(service,{owner,linkedRequestId}){
 const ids=await ownerIds(service,owner,linkedRequestId);
 await service.store.transaction(async tx=>{const record=await tx.get(approvalKey(linkedRequestId));if(record){await tx.delete(approvalKey(linkedRequestId));for(const id of record.grants??[]){const grant=await tx.get(key('grant',id));if(grant){grant.active=false;await tx.set(key('grant',id),grant);}}}
  const request=await tx.get(key('request',ids.requestId));if(request?.status==='approved'){request.status='pending';request.connectionReviewed=false;await tx.set(key('request',ids.requestId),request);}});
}
/** Owner-shard redemption after linked approval consumed the device code: one DPoP-bound app session with the
 * reserved family ID and lineage. Fails (and changes nothing) unless the stored approval matches. */
export async function issueDeviceSession(service,{linkedRequestId,grant,proof}){
 if(!service.refreshEnabled||!service.dpopNonces)fail('temporarily_unavailable','Device sign-in is not available.');
 if(grant.expiresAt!==null&&!Number.isSafeInteger(grant.expiresAt))fail('access_denied');
 return service.store.transaction(async tx=>{
  const record=await tx.get(approvalKey(linkedRequestId)),now=service.clock();
  if(!record||record.expiresAt<=now||record.linkedRequestId!==linkedRequestId||record.clientId!==grant.clientId||record.subject!==`${service.issuer}/entities/${grant.owner}`)fail('access_denied');
  await tx.delete(approvalKey(linkedRequestId));await service.consumeProof(tx,proof);
  await service.active(record.subject,record.epoch);if(service.connections&&(!record.connection||await service.connections.check(record.connection,record.clientId)!==true))fail('access_denied');
  const owner={subject:record.subject,epoch:record.epoch,clientId:record.clientId,grants:structuredClone(record.grants),...record.connection?{connection:structuredClone(record.connection)}:{}};
  const session=await createAppSession(service,tx,owner,proof.jkt,{familyId:grant.familyId,expiresAt:grant.expiresAt,lineage:{owner:grant.owner,lineageId:grant.lineageId},access:'dpop',grantType:DEVICE_GRANT});
  return {...await issueAppAccess(service,tx,session.family),refresh_token:session.refresh_token,refresh_expires_in:session.refresh_expires_in,refresh_idle_expires_in:session.refresh_idle_expires_in};
 });
}
/** Ends idle or revoked device families of one owner and their lineage before a new approval, so abandoned apps
 * cannot fill the account's lineage table (review LA2-S6). */
export async function sweepDeviceFamilies(service,owner){
 const subject=`${service.issuer}/entities/${owner}`,ended=await service.store.transaction(async tx=>{const now=service.clock(),out=[];
  for(const {value:family} of await tx.list(key('family','')))if(family.subject===subject&&family.lineage&&!family.lineageEnded&&(family.status!=='active'||family.idleExpiresAt<=now)){if(family.status==='active')await revokeFamily(service,tx,family);family.lineageEnded=true;await tx.set(key('family',family.familyId),family);out.push(family);}
  return out;});
 await endLineage(service,ended);return ended.length;
}
/** Resource tokens minted by a preferences read inherit the parent's DPoP binding: they move from the Bearer namespace
 * to the bound one with the parent's key, so they need a proof and pass the lineage check (review LA2-S1). */
export async function bindChildTokens(service,result,jkt){
 const tokens=[],walk=value=>{if(Array.isArray(value))value.forEach(walk);else if(object(value)){if(typeof value.token==='string'&&OWNER_TOKEN.test(value.token))tokens.push(value.token);Object.values(value).forEach(walk);}};walk(result);if(!tokens.length)return;
 await service.store.transaction(async tx=>{for(const token of tokens){const bearer=key('token',await digest(service.crypto,`token\0${token}`)),record=await tx.get(bearer);if(!record)continue;await tx.delete(bearer);await tx.set(key('token',await boundTokenId(service,token)),{...record,jkt});}});
}
/** Revokes one family in its owner shard (outbox drain, failed re-check). Unknown or reserved-only IDs are a no-op. */
export async function revokeDeviceFamilies(service,familyIds){
 return service.store.transaction(async tx=>{let revoked=0;for(const id of familyIds){const family=await tx.get(key('family',id));if(family?.status==='active'){await revokeFamily(service,tx,family);revoked++;}}return revoked;});
}
/**
 * The device grant provider (catalogue name `deviceGrant`). Ports:
 * - `clients`: reviewed static clients. Device-eligible ones list DEVICE_GRANT in `grantTypes`; `deviceFragments`
 *   is the operator's device fragment allowlist.
 * - `linked`: the LA1 port (`linkedPort`). `shard(owner)`: that owner's FederationController (or FederationService).
 * - `nonces`: the token-endpoint DPoP nonce issuer/checker (dpop.mjs `dpopNonces`), shared with the owner shards.
 * - `limits`: durable windows `consume(key,{windowMs,limit})` (creation); `pollLimits`: the non-durable limiter.
 */
export function createDeviceGrantProvider({issuer,clients=[],linked,shard,nonces,limits,pollLimits,crypto=globalThis.crypto,clock=()=>Date.now(),jti=new MemoryJtiCache(clock)}={}){
 if(!issuer||!linked||typeof shard!=='function'||!nonces||!limits?.consume||!pollLimits?.consume)throw new TypeError('The device grant needs an issuer, the linked port, owner shards, DPoP nonces and limiters.');
 const registry=new Map(clients.map(client=>[client.id,client]));
 const serviceOf=owner=>{const value=shard(owner);return value?.service??value;};
 const eligible=clientId=>{if(typeof clientId!=='string'||!clientId||clientId.length>2048)fault('invalid_request');const client=registry.get(clientId);
  if(!client)fault(metadataClientHost(clientId)?'unauthorized_client':'invalid_client');
  if(client.reviewed===false||!Array.isArray(client.grantTypes)||!client.grantTypes.includes(DEVICE_GRANT)||!client.redirectUris?.length)fault('unauthorized_client');return client;};
 const mac=value=>digest(crypto,`device-limit\0${value}`);
 const tokenHeaders=async()=>{try{return {'DPoP-Nonce':await nonces.issue('token')};}catch{return {};}};
 const once=async proof=>{if(!jti.claim(`${proof.jkt}:${proof.jti}`,proof.expiresAt))fault('invalid_dpop_proof','This proof was already used.');};
 const tokenProof=async headers=>{const value=headers.dpop;if(typeof value!=='string'||!value||value.includes(',')||value.length>4096)fault('invalid_dpop_proof','A DPoP proof is required.');
  const proof=await proven(crypto,value,{typ:DPOP_TYP,htm:'POST',htu:`${issuer}/oauth/token`,now:clock(),nonce:nonce=>nonces.check('token',nonce)});await once(proof);return proof;};
 const asResult=async(error,extra={})=>{if(['invalid_request','invalid_client','unauthorized_client','invalid_scope','invalid_grant','unsupported_grant_type','invalid_dpop_proof','use_dpop_nonce','access_denied','expired_token','slow_down','authorization_pending'].includes(error?.code))return oauthError(error.code,{...extra,headers:{...extra.headers}});
  if(['temporarily_unavailable','rate_limited','device_unavailable'].includes(error?.code))return oauthError('temporarily_unavailable',{status:503,retryAfter:Number.isSafeInteger(error.retryAfter)?error.retryAfter:60,headers:extra.headers});throw error;};
 return Object.freeze({
  /** Device authorization endpoint (spec §4). `input`: {headers, body, remoteIP?, country?, networkTrusted?}. */
  async authorize(input={}){
   try{
    const headers=lower(input.headers);if(fromBrowser(headers)||!formType(headers))fault('invalid_request');
    const params=form(input.body,['client_id','dpop_jkt','bindle_requests','identity','ui_locales']),client=eligible(params.get('client_id'));
    const jkt=params.get('dpop_jkt');if(!jktPattern.test(jkt??''))fault('invalid_request');
    const requests=fragmentRequests(params.get('bindle_requests'),client),identity=params.get('identity'),locales=params.get('ui_locales');
    if(identity!==null&&(!identity.trim()||identity.length>254||control(identity)))fault('invalid_request');
    if(locales!==null&&(locales.length>160||locales.split(' ').some(tag=>!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(tag))))fault('invalid_request');
    // Per-client creation and live requests per address (≤ 3 per IPv4 address or IPv6 /64 per pending window); the
    // linked core adds its own per-address and per-network rates and the global live cap.
    const net=linkedNetwork(input.remoteIP);
    // The address cap is charged first, so one address cannot drain the client's budget (review LA2-S5).
    if(net.narrow!=='unknown'&&!await limits.consume(`device-address:${await mac(net.narrow)}`,DEVICE_LIMITS.address)||!await limits.consume(`device-client:${await mac(client.id)}`,DEVICE_LIMITS.client))fault('temporarily_unavailable','Too many device sign-ins. Try again later.',{retryAfter:600});
    const host=new URL(client.origin).host,started=await linked.startApp({reviewed:true,clientId:client.id,host,...client.name.length<=80?{reviewedName:client.name}:{},requests,...identity!==null?{identityHint:identity.trim()}:{},dpopJkt:jkt},{remoteIP:input.remoteIP,...input.networkTrusted===true?{networkTrusted:true,country:input.country}:{}});
    return {status:200,body:{device_code:started.deviceCode,user_code:started.userCode,verification_uri:started.verificationUri,expires_in:started.expiresIn,interval:started.interval},headers:{...NO_STORE}};
   }catch(error){return asResult(error);}
  },
  /** Token endpoint, device_code grant (spec §6). `input`: {headers, body, remoteIP?}. Every response carries a fresh
   * token-endpoint DPoP nonce. */
  async token(input={}){
   const headers=lower(input.headers),nonce=await tokenHeaders();
   try{
    if(fromBrowser(headers)||!formType(headers))fault('invalid_request');
    const params=form(input.body,['grant_type','device_code','client_id']);if(params.get('grant_type')!==DEVICE_GRANT)fault('unsupported_grant_type');
    const deviceCode=params.get('device_code'),clientId=params.get('client_id'),match=DEVICE_CODE.exec(deviceCode??'');if(!match||typeof clientId!=='string')fault('invalid_grant');
    // Network and global poll bounds come before any signature check or storage read.
    const net=linkedNetwork(input.remoteIP);
    // Per-network first, so one network cannot spend the global budget for everyone (review LA2-S4).
    if(!await pollLimits.consume(`device-poll:${net.narrow==='unknown'?'unknown':await mac(net.narrow)}`,DEVICE_LIMITS.pollPrefix))fault('slow_down',undefined,{interval:10});
    if(!await pollLimits.consume('device-poll-global',DEVICE_LIMITS.pollGlobal))fault('temporarily_unavailable','Device sign-in is busy.',{retryAfter:5});
    const proof=await tokenProof(headers);eligible(clientId);
    const outcome=await linked.redeem({deviceCode,clientId,dpopJkt:proof.jkt},{remoteIP:input.remoteIP});
    if(outcome?.status!=='approved')fault(['authorization_pending','slow_down','access_denied','expired_token','invalid_grant','invalid_dpop_proof'].includes(outcome?.status)?outcome.status:'invalid_grant',undefined,['authorization_pending','slow_down'].includes(outcome?.status)?{interval:outcome.interval}:{});
    return {status:200,body:await this.issue(match[1],outcome,proof),headers:{...NO_STORE,...nonce}};
   }catch(error){return asResult(error,{interval:error?.interval,headers:nonce});}
  },
  /** Reserve → activate → re-check (architecture §7.4): the session is issued in the owner shard, then the lineage is
   * checked again; any failure after the consume closes the request with access_denied and ends the lineage. */
  async issue(linkedRequestId,grant,proof){
   const ref={owner:grant.owner,lineageId:grant.lineageId,familyId:grant.familyId},service=serviceOf(grant.owner);let response;
   try{response=await issueDeviceSession(service,{linkedRequestId,grant,proof});}
   catch(error){try{await linked.lineageRevoke({owner:grant.owner,lineageId:grant.lineageId});}catch{}if(['access_denied','unauthorized','invalid_grant','stale_consent','forbidden','rate_limited'].includes(error?.code))fault('access_denied');throw error;}
   let live=false;try{live=await linked.lineageLive(ref)===true;}catch{}
   if(!live){await revokeDeviceFamilies(service,[grant.familyId]);try{await linked.lineageRevoke({owner:grant.owner,lineageId:grant.lineageId});}catch{}fault('access_denied');}
   return response;
  },
  /** Approval page, `app` kind, step 1 (LA3/LA4): the linked review plus the owner shard's consent view (current
   * values, revisions and resources). `input`: {context, requestId, code, turnstileToken?}. */
  async review({context,requestId,code,turnstileToken}={}){
   const view=await linked.resolve({code,locator:requestId,...turnstileToken?{turnstileToken}:{}},context);if(view.kind!=='app')return {linked:view};
   const client=eligible(view.app.clientId);
   return {linked:view,consent:await deviceConsentView(serviceOf(view.account.id),context,{owner:view.account.id,linkedRequestId:view.requestId,client,requests:view.app.requests})};
  },
  /** Approval page, `app` kind, step 2: owner consent in the owner shard, then the linked decision (fresh step-up,
   * typed code, account binding, single CAS). A failed linked decision reverts the owner consent. `input`:
   * {context, requestId, code, approved: [selections], choice?, accountHandle?}. */
  async approve({context,requestId,code,approved,choice,accountHandle}={}){
   if(!REQUEST_ID.test(requestId??'')||!Array.isArray(approved))fault('invalid_request');
   const view=await linked.resolve({code,locator:requestId},context);if(view.kind!=='app')fault('invalid_request','Approve device sessions through the linked approval operation.');
   // Checked before any owner-shard write, so an obvious refusal leaves no grants behind; linkedApprove re-checks.
   if(view.freshness?.satisfied!==true)fault('reauthentication_required','Confirm your password or passkey before approving this sign-in.');
   if(choice!==undefined&&!view.durations.some(option=>option.choice===choice))fault('invalid_choice','Choose how long this sign-in lasts.');
   const client=eligible(view.app.clientId),owner=view.account.id,service=serviceOf(owner),target={owner,linkedRequestId:view.requestId};
   await sweepDeviceFamilies(service,owner);
   await deviceConsentApprove(service,context,{...target,client,requests:view.app.requests,approved});
   try{return await linked.approve({requestId,code,approved:true,...choice!==undefined?{choice}:{},...accountHandle!==undefined?{accountHandle}:{}},context);}
   catch(error){await deviceConsentRevert(service,target);throw error;}
  },
  /** Resource RPC with a DPoP-bound access token (`Authorization: DPoP`, spec §6.3). `input`: {authorization, dpop,
   * envelope, origin?}. Checks the proof (ath, iat window, jti), the token's key, then the approval lineage, before
   * the owner shard's own live token, grant, account and connection checks. */
  async rpc({authorization,dpop,envelope,origin}={}){
   const token=typeof authorization==='string'&&authorization.startsWith('DPoP ')?authorization.slice(5):'',owner=OWNER_TOKEN.exec(token)?.[1];if(!owner)fault('unauthorized','A DPoP access token is required.');
   if(typeof dpop!=='string'||!dpop||dpop.includes(',')||dpop.length>4096)fault('unauthorized','A DPoP proof is required.');
   let proof;try{proof=await verifyProof(crypto,dpop,{typ:DPOP_TYP,htm:'POST',htu:`${issuer}/bindle/rpc`,now:clock(),ath:token,nonce:value=>value===undefined?null:nonces.check('rpc',value)});}catch(error){fault(error?.code==='use_dpop_nonce'?'use_dpop_nonce':'unauthorized','A valid DPoP proof is required.');}
   if(!jti.claim(`rpc:${proof.jkt}:${proof.jti}`,proof.expiresAt))fault('unauthorized','This proof was already used.');
   const service=serviceOf(owner),id=await boundTokenId(service,token);
   const family=await service.store.transaction(async tx=>{const record=await tx.get(key('token',id));if(!record||record.jkt!==proof.jkt||record.expiresAt<=clock())fault('unauthorized','A DPoP access token is required.');return record.familyId?tx.get(key('family',record.familyId)):null;});
   // Lineage on every RPC: ending the approving session stops access at once, before the outbox drains.
   if(family?.lineage){let live=false;try{live=await linked.lineageLive({owner:family.lineage.owner,lineageId:family.lineage.lineageId,familyId:family.familyId})===true;}catch{fault('temporarily_unavailable','Try again shortly.');}
    if(!live){await revokeDeviceFamilies(service,[family.familyId]);fault('unauthorized','This application session ended.');}}
   // A client whose device eligibility was withdrawn loses its sessions (review LA2-S11).
   if(family){try{eligible(family.clientId);}catch{await revokeDeviceFamilies(service,[family.familyId]);await endLineage(service,[family]);fault('unauthorized','This application session ended.');}}
   const response=await service.rpc(token,envelope,{tokenHash:id,requestOrigin:origin});await bindChildTokens(service,response.result,proof.jkt);
   if(response.result?.__federationError){const {result,...rest}=response;return {...rest,error:result.__federationError};}return response;
  },
  /** Client cancellation of a pending (or redeemed) device request at the revocation endpoint: `token` is the device
   * code, with a DPoP proof for the request key. RFC 7009 semantics: unknown codes are a silent success. */
  async cancel(input={}){
   const headers=lower(input.headers),nonce=await tokenHeaders();
   try{
    if(fromBrowser(headers)||!formType(headers))fault('invalid_request');
    const params=form(input.body,['token','token_type_hint','client_id']),deviceCode=params.get('token'),clientId=params.get('client_id');
    if(!DEVICE_CODE.test(deviceCode??''))return {status:200,body:{},headers:{...NO_STORE,...nonce}};
    const value=headers.dpop;if(typeof value!=='string'||!value||value.includes(',')||value.length>4096)fault('invalid_dpop_proof');
    const proof=await proven(crypto,value,{typ:DPOP_TYP,htm:'POST',htu:`${issuer}/oauth/revoke`,now:clock(),nonce:value=>nonces.check('token',value)});await once(proof);eligible(clientId);
    try{await linked.cancelApp({deviceCode,clientId,dpopJkt:proof.jkt});}catch(error){if(error?.code!=='invalid_grant')throw error;}
    return {status:200,body:{},headers:{...NO_STORE,...nonce}};
   }catch(error){return asResult(error,{headers:nonce});}
  },
  /** Lineage outbox drain for one account: revoke each queued family in the owner shard, then acknowledge it. */
  async drain({owner}={}){
   if(!REQUEST_ID.test(owner??''))fault('invalid_request');const items=await linked.outbox({owner});if(!items.length)return {revoked:0,acknowledged:0};
   const familyIds=items.map(item=>item.familyId).slice(0,200),revoked=await revokeDeviceFamilies(serviceOf(owner),familyIds),{acknowledged}=await linked.outboxAck({owner,familyIds});
   return {revoked,acknowledged};
  },
 });
}
function enabled(config){if(config?.DEVICE_AUTHORIZATION_ENABLED!==true&&config?.DEVICE_AUTHORIZATION_ENABLED!=='true')fail('not_found','Device authorization is not enabled.');}
// Engine operations (unrouted; LA3 mounts them). Each is absent unless DEVICE_AUTHORIZATION_ENABLED is on.
export class DeviceAuthorize extends AppAction {static operation='federation.device.authorize';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.authorize(this.input);}}
export class DeviceToken extends AppAction {static operation='federation.device.token';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.token(this.input);}}
export class DeviceReview extends AppAction {static operation='federation.device.review';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.review(this.input);}}
export class DeviceApprove extends AppAction {static operation='federation.device.approve';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.approve(this.input);}}
export class DeviceRpc extends AppAction {static operation='federation.device.rpc';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.rpc(this.input);}}
export class DeviceCancel extends AppAction {static operation='federation.device.cancel';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.cancel(this.input);}}
export class DeviceLineageDrain extends AppAction {static operation='federation.device.drain';static deps=['config','deviceGrant'];run({config,deviceGrant}){enabled(config);return deviceGrant.drain(this.input);}}
export const DEVICE_OPERATIONS=Object.freeze([DeviceAuthorize,DeviceToken,DeviceReview,DeviceApprove,DeviceRpc,DeviceCancel,DeviceLineageDrain]);
