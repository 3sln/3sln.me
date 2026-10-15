import {IdentityAction,OwnerQuery} from '../identity/index.mjs';
import {MAX_ACCOUNTS,accountFault,accountCookieName,parseAccountCookies,observedAccountMembers,accountSnapshotRevision,createPickerToken,verifyPickerToken,defaultAccountCookie,defaultAccountOwner,selectedAccountMember,removedAccountCookies,removedMemberCookie,clearedDefaultCookie,installedAccountCookies,readCleanupMembers,cleanupAccountCookie,clearCleanupCookie} from './account-cookies.mjs';
export const accountRoutePaths=['/api/auth/accounts','/api/auth/accounts/switch','/api/auth/accounts/logout','/api/auth/accounts/logout-all','/api/auth/accounts/cleanup'];
const memberContext=(context,member)=>({...context,sessionToken:member.token,expectedOwner:member.owner,sessionContext:member.sessionContext,csrfToken:null});
const cookieHeaders=values=>{const h=new Headers();for(const value of values)h.append('Set-Cookie',value);return h;};
const samePair=(a,b)=>a.owner===b.owner&&a.sessionContext===b.sessionContext;
// Owner revocation precedes success. Unauthorized means the session is already
// gone; any other failure is unresolved and stays in retry-only custody.
// A context conflict proves the token is still live, so retry by token alone rather than drop custody.
async function revoke(engine,context,member,exact=true){try{await engine.dispatch(new IdentityAction('logoutSaved',{},{...memberContext(context,member),...exact?{}:{sessionContext:undefined}})).next('result');return true;}catch(error){if(error.code==='session_context_conflict'&&exact)return revoke(engine,context,member,false);return error.code==='unauthorized';}}
// An unreadable cleanup cookie (rotated key, changed origin, corruption) is expired, never a lockout.
const cleanupMembers=(env,cookies,local)=>readCleanupMembers(env,cookies,local).then(members=>({members,unreadable:false}),()=>({members:[],unreadable:true}));
export async function accountSessionRoutes({request,env,local,engine,context,body,json,legacyCleared}){
 const path=new URL(request.url).pathname;if(!accountRoutePaths.includes(path))return null;
 // First-party only: exact Origin when present, and no cross-site/same-site Fetch Metadata.
 if(request.headers.get('Origin')!==null&&request.headers.get('Origin')!==env.APP_ORIGIN||['cross-site','same-site'].includes(request.headers.get('Sec-Fetch-Site')))throw accountFault('csrf',403);
 const cookies=parseAccountCookies(request,local),observed=await observedAccountMembers(env,cookies,local,Date.now(),['/api/auth/accounts','/api/auth/accounts/logout-all'].includes(path)?MAX_ACCOUNTS*4:undefined),revision=await accountSnapshotRevision(observed),stale=observed.stale.map(name=>removedMemberCookie(name,local));
 let active=null;try{active=await selectedAccountMember(request,env,local,cookies);}catch{}
 if(path==='/api/auth/accounts'){
  if(request.method!=='GET')throw accountFault('method_not_allowed',405);const accounts=[],unavailable=[];
  for(const member of observed){try{const owner=await engine.query(new OwnerQuery(memberContext(context,member))).peek();accounts.push({account:{id:owner.account.id,handle:owner.account.handle},expiresAt:owner.expiresAt,sessionContext:owner.sessionContext});}catch(error){if(!['unauthorized','session_context_conflict','account_context_conflict'].includes(error.code))throw error;unavailable.push(member);}}
  // Revoked/suspended members are dropped from this browser without selecting another account.
  for(const member of unavailable)stale.push(removedMemberCookie(accountCookieName(member.owner,local),local));
  const listed=observed.filter(m=>!unavailable.includes(m)),listedRevision=await accountSnapshotRevision(listed),defaultOwner=await defaultAccountOwner(env,cookies,local).catch(()=>null);if(defaultOwner&&!listed.some(m=>m.owner===defaultOwner))stale.push(clearedDefaultCookie(local));
  return json({accounts,activeOwner:active&&listed.some(m=>m.owner===active.owner)?active.owner:null,limit:MAX_ACCOUNTS,revision:listedRevision,cleanupPending:await cleanupMembers(env,cookies,local).then(c=>{if(c.unreadable)stale.push(clearCleanupCookie(local));return c.members.length>0;}),pickerToken:await createPickerToken(env,listed,listedRevision)},200,cookieHeaders(stale));
 }
 if(request.method!=='POST')throw accountFault('method_not_allowed',405);if(request.headers.get('Origin')!==env.APP_ORIGIN)throw accountFault('csrf',403);
 const input=await body(request,8192),all=path.endsWith('logout-all')||path.endsWith('/cleanup'),allowed=all?['expectedRevision','pickerToken','pushSubscription']:['owner','expectedRevision','pickerToken','pushSubscription'];if(Object.hasOwn(input,'pushSubscription')&&(typeof input.pushSubscription!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.pushSubscription)))throw accountFault('invalid_request',400);if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.expectedRevision!=='string'||input.expectedRevision!==revision)throw accountFault('vault_conflict',409);
 // Either the private picker proof for this exact snapshot, or the selected member's live CSRF.
 if(typeof input.pickerToken==='string'){await verifyPickerToken(env,input.pickerToken,observed,revision);}else{if(!active)throw accountFault('csrf',403);const owner=await engine.query(new OwnerQuery(memberContext(context,active))).peek();if(typeof context.csrfToken!=='string'||context.csrfToken!==owner.csrfToken)throw accountFault('csrf',403);}
 if(path.endsWith('/switch')){const member=observed.find(m=>m.owner===input.owner);if(!member)throw accountFault('account_unavailable',401);const owner=await engine.query(new OwnerQuery(memberContext(context,member))).peek();return json({account:owner.account,csrfToken:owner.csrfToken,expiresAt:owner.expiresAt,sessionContext:owner.sessionContext,vaultRevision:revision},200,cookieHeaders([...stale,await defaultAccountCookie(env,member.owner,local)]));}
 const pending=(await cleanupMembers(env,cookies,local)).members,defaultOwner=await defaultAccountOwner(env,cookies,local).catch(()=>null);
 const targets=path.endsWith('/cleanup')?[]:path.endsWith('logout-all')?observed:observed.filter(m=>m.owner===input.owner);if(!all&&!targets.length)throw accountFault('account_unavailable',401);
 // Earlier unresolved revocations are retried with every sign-out, never dropped.
 // This device's push subscription is removed per signed-out account before its session is revoked (best effort).
 if(input.pushSubscription&&env.ACCOUNTS)for(const member of targets)try{await env.ACCOUNTS.get(member.owner).invoke({method:'removeSubscription',args:[member.owner,input.pushSubscription]});}catch{}
 const work=[...targets,...pending.filter(c=>!targets.some(m=>samePair(m,c)))],failed=[],headers=[...stale];for(const member of work)if(!await revoke(engine,context,member))failed.push(member);
 for(const member of targets)headers.push(...removedAccountCookies(member.owner,local,member.owner===defaultOwner||path.endsWith('logout-all')));
 headers.push(failed.length?await cleanupAccountCookie(env,failed,local):clearCleanupCookie(local));if(targets.length===observed.length&&legacyCleared)headers.push(legacyCleared);
 return json({loggedOut:true,accountsRemaining:observed.length-targets.length,cleanupPending:failed.length>0,vaultRevision:revision},200,cookieHeaders(headers));
}
// Login/activation installs one member without evicting others. A session minted
// beyond the limit is revoked before refusing; a same-owner predecessor is revoked.
export async function installAccountSession({request,env,local,engine,context,result,legacyCleared}){
 const owner=result.account.id,fresh={owner,token:result.sessionToken,expiresAt:result.expiresAt,sessionContext:result.sessionContext};let cookies,members;
 // Any refusal before installation revokes the freshly minted session; its token never left the server.
 try{cookies=parseAccountCookies(request,local);members=await observedAccountMembers(env,cookies,local);}catch(error){await revoke(engine,context,fresh);throw error;}
 if(members.filter(m=>m.owner!==owner).length>=MAX_ACCOUNTS){await revoke(engine,context,fresh);throw accountFault('account_limit',409,'Sign out of an account before adding another.');}
 const failed=[];for(const member of members.filter(m=>m.owner===owner&&m.sessionContext!==fresh.sessionContext))if(!await revoke(engine,context,member))failed.push(member);
 const headers=[...members.stale.map(name=>removedMemberCookie(name,local)),...await installedAccountCookies(env,fresh,local),legacyCleared];
 if(failed.length){const pending=await readCleanupMembers(env,cookies,local).catch(()=>[]);headers.push(await cleanupAccountCookie(env,[...failed,...pending.filter(c=>!failed.some(m=>samePair(m,c)))],local));}
 return headers;
}
