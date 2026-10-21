// HTTP routes of slice C3, key-delegation.v1 (docs/spec/bindlebox.md §3.4; messaging-extraction.md C3): the public
// delegation status endpoint receivers query, and owner views and revocation. Mounted only with BINDLEBOX_ENABLED;
// with the flag off nothing here answers, so the paths stay 404 and no allowlist reveals them.
//
// Status: GET|HEAD {identityURI}/delegations/{jkt}, identityURI = <APP_ORIGIN>/identity/<subject> (contact delivery
// S13 naming). The body is exactly {status} or {status, revokedHour}. Unknown, inactive or nonexistent subjects are
// answered as an unknown jkt ({status:'revoked'}) without waking any account, so the endpoint enumerates nothing.
// Cache-Control: `public, max-age=300` (the §3.4 window; shared caches must honor Age) except a persisted revocation,
// which is final (`max-age=86400, immutable`); "cannot be determined" is 503 `no-store` with Retry-After.
import {json,body,privateHeaders,accountHandle,pseudonym,subnet,consume} from './shared.mjs';
import {statusCacheControl,isJkt} from '../../identity/delegation.mjs';

const STATUS=/^\/identity\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/delegations\/([^/]+)$/;
const enabled=env=>env.BINDLEBOX_ENABLED==='true';
const publicHeaders={'X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'};
const answer=(request,value,status=200,extra={})=>new Response(request.method==='HEAD'?null:JSON.stringify(value),{status,headers:{...privateHeaders,...publicHeaders,'Content-Type':'application/json',...extra}});
const statusBody=result=>result.status==='active'?{status:'active'}:Number.isSafeInteger(result.revokedHour)?{status:'revoked',revokedHour:result.revokedHour}:{status:'revoked'};
const unknown={status:'revoked',final:false};
const only=(request,method)=>request.method===method?null:json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:method});
// Generous per-network and per-subject windows; status is cheap, but every query on an active subject reads its account.
// Without the limiter (no ABUSE binding or hash secret) the endpoint fails closed outside local development (KD-7).
const STATUS_WINDOW_MS=60000,STATUS_PER_WINDOW=600,SUBJECT_PER_WINDOW=1200;
async function admitted(env,request,local,subject){
 const secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;if(!secret||typeof env.ABUSE?.consume!=='function'){if(local)return true;throw new Error('limiter_unavailable');}
 const ip=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown');
 return await consume(env,`delegation-status:${await pseudonym(subnet(ip),secret)}`,STATUS_WINDOW_MS,STATUS_PER_WINDOW)&&await consume(env,`delegation-status-subject:${await pseudonym(subject,secret)}`,STATUS_WINDOW_MS,SUBJECT_PER_WINDOW);
}

export const admission={exempt:path=>path==='/api/delegations/revoke'};
export const stages={
 async public({request,env,path,local}){
  if(!enabled(env))return;
  const match=STATUS.exec(path);if(!match)return;
  if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed',message:'Use GET.'},405,{...publicHeaders,Allow:'GET, HEAD'});
  const [,subject,jkt]=match;
  if(!isJkt(jkt))return answer(request,{error:'invalid_request',message:'Choose a valid key thumbprint.'},400,{'Cache-Control':'no-store'});
  try{if(!await admitted(env,request,local,subject))return answer(request,{error:'rate_limited'},429,{'Cache-Control':'no-store','Retry-After':'60'});}catch{return answer(request,{error:'delegation_unavailable'},503,{'Cache-Control':'no-store','Retry-After':'60'});}
  let result;
  try{
   const account=await env.IDENTITY_REPOSITORY?.get(subject);
   // Only a failing occupancy port is "cannot be determined"; any other account-side fault (lifecycle, missing
   // account) answers like an unknown key, so status codes do not separate account states (KD-8).
   try{result=account?.status==='active'?await accountHandle(env,subject).delegationStatus(subject,jkt):unknown;}catch(error){if(error?.code==='delegation_unavailable')throw error;result=unknown;}
   if(!result||!['active','revoked'].includes(result.status))throw new Error('indeterminate');
  }catch{return answer(request,{error:'delegation_unavailable',message:'Delegation status cannot be determined right now.'},503,{'Cache-Control':'no-store','Retry-After':'60'});}
  return answer(request,statusBody(result),200,{'Cache-Control':statusCacheControl(result)});
 },
 // Owner views and revocation (bindlebox §3.2: the owner can revoke any delegate key, a client's keys, or all).
 async owner({request,env,path,object,id}){
  if(!enabled(env)||!path.startsWith('/api/delegations'))return;
  if(path==='/api/delegations'){const refused=only(request,'GET');if(refused)return refused;return json(await object.listDelegations(id));}
  if(path==='/api/delegations/revoke'){const refused=only(request,'POST');if(refused)return refused;return json(await object.revokeDelegations(id,await body(request,4096)));}
 },
};
