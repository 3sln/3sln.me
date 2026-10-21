// HTTP router (docs/architecture/app-engine.md §7, §12). It keeps the cross-cutting steps (origin, method
// allowlist, CSRF, session, owner resolution, capacity admission, activity) and runs the per-slice route stages
// of packages/runtime/routes/index.mjs between them. Shared helpers live in packages/runtime/routes/shared.mjs.
import {accountRoutePaths} from './account-session-http.mjs';
import {accountCookiesEnabled,selectedAccountMember,parseAccountCookies,hasAccountVault,installedAccountCookies,accountFault} from './account-cookies.mjs';
import {OwnerQuery,IdentityFault} from '../identity/index.mjs';
import {MessagingFault} from '../messaging/index.mjs';
import {StorageError} from '../storage/policy.mjs';
import {json,status,body,cookie,sessionToken,setupCookie,deviceCookie,signedContactPath,identity,limit,turnstile,accountHandle} from './routes/shared.mjs';
import {stage,routeMethods,admission} from './routes/index.mjs';
export {subnet,signupEnabled} from './routes/shared.mjs';

// The router's own paths; every other path's methods come from its route module.
const allowedMethods=path=>['/api/session','/api/account'].includes(path)?['GET']:routeMethods(path);

export default {
 turnstile, rateLimit:limit,
 async fetch(request,env,execution){
  let engine;
  try{
   const url=new URL(request.url);const local=env.LOCAL_DEVELOPMENT==='true';
   const route={request,env,execution,url,local};let response;
   response=await stage('edge',route);if(response)return response.passthrough??response;
   if(url.origin!==env.APP_ORIGIN)return json({error:'invalid_origin',message:'Use the configured account domain.'},403);
   // Island documents and assets are served only on the embed origin, never under the app origin (review M3).
   if(url.pathname==='/embed'||url.pathname.startsWith('/embed/'))return json({error:'not_found'},404);
   const path=url.pathname;const mutation=!['GET','HEAD','OPTIONS'].includes(request.method);
   Object.assign(route,{path,mutation});
   response=await stage('public',route);if(response)return response.passthrough??response;
   const allow=allowedMethods(path);if(allow&&!allow.includes(request.method))return json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:allow.join(', ')});
   if(path.startsWith('/api/demo'))return json({error:'not_found'},404);
   response=await stage('anonymous',route);if(response)return response.passthrough??response;
   if(mutation&&path.startsWith('/api/')&&request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
   response=await stage('unauthenticated',route);if(response)return response.passthrough??response;
   if(path.startsWith('/api/')){
    response=await stage('api',route);if(response)return response.passthrough??response;
    // Member cookies are authenticated and the tab selector matched before any owner actor is routed.
    const vault=accountCookiesEnabled(env),accountCookies=vault?parseAccountCookies(request,local):new Map(),vaultPresent=vault&&hasAccountVault(accountCookies,local),accountPath=vault&&accountRoutePaths.includes(path);let accountMember=null;if(vault&&!accountPath&&!(mutation&&request.headers.get('X-Bindle-Account')===null))accountMember=await selectedAccountMember(request,env,local,accountCookies);
    engine=await identity(env);const context={origin:request.headers.get('Origin')||env.APP_ORIGIN,sessionToken:accountMember?.token||(vaultPresent?undefined:sessionToken(request,local)),expectedOwner:accountMember?.owner||request.headers.get('X-Bindle-Account')||undefined,sessionContext:accountMember?.sessionContext||request.headers.get('X-Bindle-Session-Context')||undefined,csrfToken:request.headers.get('X-CSRF-Token'),remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),region:/^[A-Z]{2}$/.test(request.cf?.country||'')?request.cf.country:'unknown',deviceBinding:deviceCookie(request,local),setupBinding:setupCookie(request,local)};
    Object.assign(route,{engine,context,vault,accountCookies,vaultPresent,accountPath,accountMember});
    response=await stage('session',route);if(response)return response.passthrough??response;
    // Header-less private writes would follow a mutable default; tabs must name their member.
    // (Header-less mutations never select the default member, so identity writes fail closed too.)
    if(vaultPresent&&mutation&&request.headers.get('X-Bindle-Account')===null)throw accountFault('account_context_conflict',409);
    let owner;try{owner=await engine.query(new OwnerQuery(context)).peek();}catch(error){if(path==='/api/session'&&error.code==='unauthorized')return json({authenticated:false});throw error;}
    if(path==='/api/session'){if(vault&&!accountMember&&!vaultPresent&&context.sessionToken){const headers=new Headers();for(const value of await installedAccountCookies(env,{owner:owner.account.id,token:context.sessionToken,expiresAt:owner.expiresAt,sessionContext:owner.sessionContext},local))headers.append('Set-Cookie',value);headers.append('Set-Cookie',cookie('',local,0));return json({authenticated:true,...owner},200,headers);}return json({authenticated:true,...owner});}
    const id=owner.account.id;const object=accountHandle(env,id);
    // Engine-first routes (docs/architecture/app-engine.md §7): parse, dispatch one account operation as this owner, serialize.
    const dispatch=(Operation,params={})=>object.dispatch(id,{operation:Operation.operation,...params});
    // Owner mutations independently require session CSRF, even when not an identity action.
    if(mutation&&context.csrfToken!==owner.csrfToken)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
    Object.assign(route,{owner,id,object,dispatch});
    response=await stage('beforeActivity',route);if(response)return response.passthrough??response;
    // Capacity admission: protective changes and exempt paths (declared by their route modules) are never refused.
    let protective=false;const protectiveRule=mutation&&admission.protective.find(rule=>rule.match(path,request.method));
    if(protectiveRule){const change=await body(request.clone());protective=protectiveRule.test(change);}
    const capacityExempt=protective||request.method==='DELETE'||admission.exempt(path);
    if(mutation&&!capacityExempt&&allowedMethods(path))await object.admitWork(id,{initialize:true});
    await object.touch(id);
    if(path==='/api/account'&&request.method==='GET')return json({...await object.snapshot(id),account:owner.account,credentials:owner.credentials,devices:owner.devices,audit:owner.audit,grants:[],...env.DEVICE_AUTHORIZATION_ENABLED==='true'&&env.FEDERATION_AUTHORITY?.ready()?{appSessions:(await env.FEDERATION_AUTHORITY.appSessions(context)).sessions}:{}});
    response=await stage('owner',route);if(response)return response.passthrough??response;
    return json({error:'not_found'},404);
   }
   response=await stage('pages',route);if(response)return response.passthrough??response;
   return json({error:'not_found'},404);
  }catch(error){const pathname=new URL(request.url).pathname;const signedContact=signedContactPath.test(pathname);const cap=signedContact||/^(?:\/api\/messages|\/users\/[^/]+\/message|\/bindle\/rpc)$/.test(pathname)&&request.headers.get('Authorization')?.startsWith('Bearer ')||/^\/api\/conversations\/(?:identity|invitations|inbox)\/[a-f0-9-]{36}$/.test(pathname)||/^\/api\/conversations\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/join$/.test(pathname)||/^\/api\/conversations\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(pathname)&&request.headers.get('Authorization')?.startsWith('Bearer ');const headers=cap?{'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After','X-Robots-Tag':'noindex, nofollow, nosnippet',...(signedContact?{Vary:'Accept, Accept-Language'}:{})}:{};if(Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0)headers['Retry-After']=String(error.retryAfter);if(error instanceof IdentityFault||error instanceof MessagingFault||error instanceof StorageError||error.status)return json({error:error.code||'invalid_request',message:error.message,...error.code==='signup_capacity_reached'?{capacity:error.capacity}:{}},status(error),headers);if(env.LOCAL_DEVELOPMENT==='true')console.error('Local runtime exception:',error.name,error.message);return json({error:'internal_error',message:'We could not complete this request. Please try again.'},500,headers);}
  finally{engine?.dispose();}
 },
 async scheduled(controller,env,ctx){
   if(env.DEVELOPER_CONTACT_POPULATION)ctx.waitUntil(env.DEVELOPER_CONTACT_POPULATION.censusStep());
   // Account lifecycle sweep (present only when LIFECYCLE_ENABLED): arms schedules and nudges bounded ticks;
   // per-account alarms drive notices, suspension and, only when separately enabled, purge.
   if(env.LIFECYCLE_SWEEP)ctx.waitUntil(env.LIFECYCLE_SWEEP.run({trigger:'cron'}).catch(()=>{}));
 }
};
