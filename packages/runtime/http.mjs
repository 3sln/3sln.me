import {accountSessionRoutes,accountRoutePaths,installAccountSession} from './account-session-http.mjs';
import {accountCookiesEnabled,selectedAccountMember,parseAccountCookies,hasAccountVault,installedAccountCookies,removedAccountCookies,accountFault} from './account-cookies.mjs';
import {onboardingEnabled,onboardingOnly} from '../identity/onboarding.mjs';
import {publicBadgePolicy,compileBadgeSprite} from '../identity/badge-policy.mjs';
import {developerContactRoutes} from './developer-contact.mjs';
import {adminRoutes,adminPath} from './admin-http.mjs';
import {signupCapacityLimits} from '../core/abuse-policy.mjs';
import {waitlistEmail} from './waitlist.mjs';
import {paidSignupEnabled,paidSignupPlans} from '../billing/signup.mjs';
import {recoveryAuthorityPublic} from './identity-backup.mjs';
import {automationRoutes,automationAllowedMethods} from '../automation/http.mjs';
import {publicConversationRoutes,ownerConversationRoutes,conversationAllowedMethods} from '../conversations/http.mjs';
import {CONTACT_PROFILE_MIME,CONTACT_INTAKE_MIME,CONTACT_DELIVERY_TOKEN,selectContactRepresentation} from '../beaming/profile.mjs';
import {parseLinkQuery,parseLinkMeta} from '../messaging/bindle-links.mjs';
import {contactPreview,injectPreview,oembed,CONTACT_INTENTS} from './contact-preview.mjs';
import {parseMultipartDelivery,parseRPCDelivery} from '../messaging/contact-delivery-wire.mjs';
import {CONTACT_DELIVERY_STATUS} from '../messaging/contact-delivery-service.mjs';
import {CONTACT_DELIVERY_TOKEN_MIME} from '../messaging/contact-endpoints.mjs';
import {beamRoutes,beamAllowedMethods} from '../beaming/http.mjs';
import { IdentityAction, OwnerQuery, DeviceRequestQuery, IdentityFault } from '../identity/index.mjs';
import { enforceAbusePolicy } from '../core/abuse-policy.mjs';
import {publicArtifact} from '../core/public-contracts.mjs';
import {publicNotificationKeys} from './app-notifications.mjs';
import {federationEpoch} from './federation.mjs';
import {verifyPreparedPostbackToken} from './message-postbacks.mjs';
import {cachedSignupCapacity} from './signup-status.mjs';
import { MessagingFault, CONTACT_TOKEN_MIME } from '../messaging/index.mjs';
import { StorageError } from '../storage/policy.mjs';
import QRCode from 'qrcode';
import {verifyPolarWebhook} from '../billing/index.mjs';
import {handleMcpPublic,handleMcpOwner,mcpPublicPath,mcpOwnerPath} from '../mcp/http.mjs';
import {handleFederation} from '../federation/http.mjs';
import {handleAuthorizationEntry,handleEmbedAPI} from './federation-entry-http.mjs';
import {SHELL_TEMPLATE,SHELL_BUILD,shellBuild,shellConfig,fillShell,shellPolicy} from '../federation/embed-shell.mjs';
import {AVATAR,avatarOrigins,readAvatarSource,reencodeAvatar} from '../federation/embed-avatar.mjs';
import {handleObjectURL} from '../storage/object-http.mjs';

const encoder=new TextEncoder();
const signedContactPath=/^\/users\/((?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9}))\/contact\/([a-f0-9-]{36})$/;
const privateHeaders={ 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=(), tools=(self)' };
const json=(data,status=200,extra={})=>{const headers=new Headers({...privateHeaders,'Content-Type':'application/json'});if(extra instanceof Headers){for(const [key,value]of extra)if(key!=='set-cookie')headers.set(key,value);for(const value of extra.getSetCookie())headers.append('Set-Cookie',value);}else for(const [key,value]of Object.entries(extra))headers.set(key,value);return new Response(JSON.stringify(data),{status,headers});};
const cookie=(token,local,maxAge=86400)=>`${local?'bindle_session':'__Host-bindle_session'}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local?'':'; Secure'}`;
function sessionToken(request,local){const name=local?'bindle_session':'__Host-bindle_session';for(const piece of (request.headers.get('Cookie')||'').split(';')){const [key,...rest]=piece.trim().split('=');if(key===name)return decodeURIComponent(rest.join('='));}return undefined;}
function setupCookie(request,local){const name=local?'bindle_setup':'__Host-bindle_setup';for(const piece of (request.headers.get('Cookie')||'').split(';')){const [key,...rest]=piece.trim().split('=');if(key===name){const value=rest.join('=');return /^[a-f0-9-]{72}$/.test(value)?value:undefined;}}}
function deviceCookie(request,local){const name=local?'bindle_device':'__Host-bindle_device';for(const piece of (request.headers.get('Cookie')||'').split(';')){const [key,...rest]=piece.trim().split('=');if(key===name)return decodeURIComponent(rest.join('='));}return undefined;}
export function subnet(value){if(/^\d+\.\d+\.\d+\.\d+$/.test(value))return value.split('.').slice(0,3).join('.')+'/24';if(value.includes(':')){const [left,right='']=value.toLowerCase().split('::');const a=left?left.split(':'):[],b=right?right.split(':'):[];const groups=[...a,...Array(Math.max(0,8-a.length-b.length)).fill('0'),...b];return groups.slice(0,3).map(x=>parseInt(x||'0',16).toString(16)).join(':')+'::/48';}return 'unknown';}
async function pseudonym(value,secret){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function consume(env,key,windowMs,limit,lifetime=false){return env.ABUSE.consume(key,{windowMs,limit,lifetime});}
async function limit(env,{operation,remoteIP,region,handle,phase,onDenied,signupKind}){
  const secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;if(!secret)return false;
  const ip=await pseudonym(remoteIP||'unknown',secret);const network=await pseudonym(subnet(remoteIP||'unknown'),secret);
  return enforceAbusePolicy({consume:async window=>{if(window.signup){if(!env.ABUSE.consumeSignup)throw Object.assign(new Error('Signup capacity is unavailable.'),{code:'signup_capacity_unavailable',status:503});const result=await env.ABUSE.consumeSignup(window.key,{limit:window.limit,freeLimit:window.signup.freeLimit,kind:window.signup.kind});if(result?.admitted===true)return true;if(!['free','global'].includes(result?.capacity))throw Object.assign(new Error('Signup capacity is unavailable.'),{code:'signup_capacity_unavailable',status:503});throw Object.assign(new Error(result.capacity==='free'?'Free signups are closed for now while we bootstrap and scale.':'Signups are closed for now while we bootstrap and scale.'),{code:'signup_capacity_reached',capacity:result.capacity,status:503});}const admitted=await consume(env,window.key,window.windowMs,window.limit,window.lifetime===true);if(!admitted)onDenied?.(window);return admitted;}},{operation,phase,signupKind,ipHash:ip,subnetHash:network,handleHash:handle?await pseudonym(handle,secret):undefined,regionHash:await pseudonym(region||'unknown',secret),signupLimits:env});
}
export function signupEnabled(env){if(env.SIGNUP_ENABLED==='false')return false;const present=value=>typeof value==='string'&&value.trim().length>0;const local=env.LOCAL_DEVELOPMENT==='true';return (env.SIGNUP_CONTACT_REQUIRED!=='true'||env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true)&&present(env.RECOVERY_SIGNING_KEY)&&(local||(env.SIGNUP_ENABLED===undefined?env.RELEASE_READY==='true':env.SIGNUP_ENABLED==='true')&&[env.TURNSTILE_SITE_KEY,env.TURNSTILE_SECRET_KEY,env.KEY_ENCRYPTION_KEY].every(present));}
async function turnstile(env,input){
  if(env.LOCAL_DEVELOPMENT==='true'&&input.token==='local-browser-test-token')return true;
  if(!env.TURNSTILE_SECRET_KEY)return false;
  try{const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:input.token,remoteip:input.remoteIP}),signal:AbortSignal.timeout(10000)});const result=await response.json();return result.success===true&&(env.LOCAL_DEVELOPMENT==='true'||result.hostname===input.hostname&&result.action===input.action);}catch{return false;}
}
async function identity(env){return env.IDENTITY_ENGINE();}
const authMethods={
 '/api/auth/onboarding/issue':'issueOnboarding','/api/auth/onboarding/inspect':'inspectOnboarding','/api/auth/onboarding/claim':'claimOnboarding',
 '/api/auth/system/bootstrap':'bootstrapSystem',
 '/api/auth/setup/billing/checkout':'setupBillingCheckout','/api/auth/setup/billing/status':'setupBillingStatus','/api/auth/setup/status':'setupStatus','/api/auth/setup/email/start':'setupEmailStart','/api/auth/setup/email/confirm':'setupEmailConfirm','/api/auth/setup/push/start':'setupPushStart','/api/auth/setup/push/confirm':'setupPushConfirm',
 '/api/auth/handles/claim':'claimHandle','/api/auth/handles/certificate':'handleCertificate',
 '/api/auth/signup':'signup','/api/auth/passkey/register/begin':'beginPasskeyRegistration','/api/auth/passkey/register':'registerPasskey','/api/auth/password/pending':'setPendingPassword',
 '/api/auth/recovery/download':'downloadRecovery','/api/auth/recovery/confirm':'confirmRecovery','/api/auth/login/password':'loginPassword','/api/auth/login/passkey/begin':'beginPasskeyLogin',
 '/api/auth/login/passkey/finish':'finishPasskeyLogin','/api/auth/recover':'recover','/api/auth/logout':'logout','/api/auth/email/start':'emailStart','/api/auth/email/confirm':'emailConfirm','/api/auth/email/login/start':'emailLoginStart','/api/auth/email/login/confirm':'emailLoginConfirm'
 ,'/api/auth/passkeys/begin':'credentialBegin','/api/auth/passkeys/finish':'credentialFinish','/api/auth/passkeys/remove':'removePasskey','/api/auth/passkeys/rename':'renamePasskey','/api/auth/devices/rename':'renameSession','/api/auth/devices/revoke':'revokeSession','/api/auth/devices/revoke-others':'revokeOtherSessions'
 ,'/api/auth/device/start':'createDeviceLogin','/api/auth/device/approve':'approveDeviceLogin','/api/auth/device/deny':'denyDeviceLogin','/api/auth/device/poll':'pollDeviceLogin','/api/auth/device/cancel':'cancelDeviceLogin'
 ,'/api/auth/email/login/settings':'configureEmailLogin'
};
async function body(request,max=100000){const content=request.headers.get('Content-Type')||'';if(!content.startsWith('application/json'))throw Object.assign(new Error('Use JSON for this request.'),{code:'json_required',status:415});const reader=request.body?.getReader();if(!reader)throw Object.assign(new Error('Request body required'),{status:400});let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Object.assign(new Error('Request is too large.'),{code:'body_too_large',status:413});}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{const result=JSON.parse(new TextDecoder().decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();return result;}catch{throw Object.assign(new Error('Request JSON must be an object.'),{code:'invalid_json',status:400});}}
function status(error){if(error.status)return error.status;return {unauthorized:401,csrf:403,forbidden:403,not_found:404,conflict:409,handle_unavailable:409,idempotency_conflict:409,quota_exceeded:429,account_quota_exceeded:429,rate_limited:429,email_unavailable:503,push_unavailable:503,contact_required:409,email_already_linked:409,challenge_failed:403,intake_conflict:409,rotation_conflict:409,tag_label_conflict:409,audience_malformed:400}[error.code]||CONTACT_DELIVERY_STATUS[error.code]||400;}
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const jwsPart=(value,index)=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.split('.')[index].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));}catch{return null;}};
// Bounded raw body read; limits apply while streaming.
async function bytesOf(request,max){const reader=request.body?.getReader();if(!reader)throw Object.assign(new Error('Message body required.'),{code:'invalid_envelope',status:400});const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Object.assign(new Error('Message exceeds the request limit.'),{code:'too_large',status:413});}chunks.push(value);}const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}return out;}
const locales=value=>(value||'').split(',').map(part=>part.split(';')[0].trim()).filter(tag=>/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(tag)).slice(0,16);
const delivered=(result,headers)=>json({receipt:result.receipt},202,headers);
async function badgePresentation(env){
 const policy=publicBadgePolicy(env);if(!policy.path)return policy;
 const sprite=await compileBadgeSprite(env);return {...policy,path:policy.path+'?v='+sprite.digest};
}
function providerConfig(env){return {hosted:{enabled:Boolean(env.ACCOUNTS)},google: {enabled:Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.KEY_ENCRYPTION_KEY),configured:Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),...env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET?{}:{reason:'Google Drive credentials are not configured on this service.'}},s3:{enabled:Boolean(env.KEY_ENCRYPTION_KEY)},webdav:{enabled:Boolean(env.KEY_ENCRYPTION_KEY),reason:'For your security, this service must approve the server you connect to.'},dropbox:{enabled:false,reason:'Dropbox is not available on this service yet.'},onedrive:{enabled:false,reason:'Microsoft OneDrive is not available on this service yet.'}};}

export default {
 turnstile, rateLimit:limit,
 async fetch(request,env,execution){
  let engine;
  try{
   const url=new URL(request.url);const local=env.LOCAL_DEVELOPMENT==='true';
   // The dedicated embed origin serves only the islands shell, its assets and the embed API (components profile §3).
   if(env.EMBED_ORIGIN&&url.origin===env.EMBED_ORIGIN&&url.origin!==env.APP_ORIGIN)return await embedOriginRoutes(request,env,url,local);
   if(url.origin!==env.APP_ORIGIN)return json({error:'invalid_origin',message:'Use the configured account domain.'},403);
   // Island documents and assets are served only on the embed origin, never under the app origin (review M3).
   if(url.pathname==='/embed'||url.pathname.startsWith('/embed/'))return json({error:'not_found'},404);
   const path=url.pathname;const mutation=!['GET','HEAD','OPTIONS'].includes(request.method);
   if(path==='/api/badges/sprite.svg'){
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    if([...url.searchParams.keys()].some(key=>key!=='v')||url.searchParams.getAll('v').length>1||url.searchParams.has('v')&&!/^[a-f0-9]{64}$/.test(url.searchParams.get('v')))return json({error:'not_found'},404);
    let sprite;try{sprite=await compileBadgeSprite(env);}catch(error){if(error.code==='badge_policy_unavailable')return json({error:'badges_unavailable'},503);throw error;}
    if(url.searchParams.has('v')&&url.searchParams.get('v')!==sprite.digest)return json({error:'not_found'},404);
    const etag='"'+sprite.digest+'"',headers={'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':url.searchParams.has('v')?'public, max-age=31536000, immutable':'public, max-age=0, must-revalidate',ETag:etag,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"};
    const matches=request.headers.get('If-None-Match')?.split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag);
    return new Response(matches||request.method==='HEAD'?null:sprite.svg,{status:matches?304:200,headers});
   }

   // Legacy entry links select the console, never an arbitrary return target.
   // Keep the exact query for the browser's existing continuation validation.
   if(['GET','HEAD'].includes(request.method)&&(path==='/'&&['signin','signup','return_to'].some(key=>url.searchParams.has(key))||path==='/console/'))return new Response(null,{status:307,headers:{...privateHeaders,Location:'/console'+url.search}});
   const postbackDispatch=/^\/api\/messages\/([a-f0-9-]{36})\/postbacks$/.exec(path);
   if(postbackDispatch){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if(request.headers.has('Cookie')||request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'unauthorized',message:'Use a prepared cookie-free submission.'},403);
    const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}\.[0-9]{13}\.[A-Za-z0-9_-]{43})$/)?.[1];
    if(!token)return json({error:'unauthorized',message:'This prepared submission is invalid or expired.'},401);
    const ownerId=await verifyPreparedPostbackToken(env,token,postbackDispatch[1]);
    const remoteIP=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown');
    if(!await limit(env,{operation:'message-postback-dispatch',remoteIP}))return json({error:'rate_limited'},429,{'Retry-After':'60'});
    const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);
    return json(await accountHandle(env,ownerId).messagePostbackDispatch(ownerId,postbackDispatch[1],token));
   }
   if(path==='/.well-known/bindle/app-notification-keys.json'){
    const headers={...privateHeaders,'Content-Type':'application/jwk-set+json','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=60, must-revalidate'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'}});
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD, OPTIONS'});
    let value;try{value=publicNotificationKeys(env.APP_NOTIFICATION_PUBLIC_JWKS);}catch{return new Response(request.method==='HEAD'?null:JSON.stringify({error:'app_notifications_unavailable',message:'App message verification keys are not configured.'}),{status:503,headers:{...privateHeaders,'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});}
    return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers});
   }
   if(path==='/api/signup/plans'){
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    if(!paidSignupEnabled(env))return json({error:'paid_signup_unavailable',message:'Paid signup is not available.'},503);
    if(url.searchParams.getAll('currency').length>1)return json({error:'invalid_currency'},400);
    if(!await limit(env,{operation:'signup-plans',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429,{'Retry-After':'60'});
    const value=await paidSignupPlans(env,url.searchParams.get('currency')??undefined);
    return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers:{...privateHeaders,'Content-Type':'application/json'}});
   }
   if(path==='/api/signup/status'){
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    const enabled=signupEnabled(env);let capacity=null;if(enabled)try{capacity=await cachedSignupCapacity(env,execution);}catch{}
    const paidEnabled=paidSignupEnabled(env),freeOpen=enabled&&capacity?.freeAvailable===true,paidOpen=enabled&&paidEnabled&&capacity?.globalAvailable===true;
    const value={onboardingOnly:onboardingOnly(env),tokenOnboardingEnabled:onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true,signupEnabled:enabled,freeSignupOpen:freeOpen,paidSignupEnabled:paidEnabled,paidSignupOpen:paidOpen,signupOpen:freeOpen||paidOpen,capacityAvailable:capacity?.freeAvailable??null,reason:!enabled?'disabled':!capacity?'unavailable':!capacity.globalAvailable?'global_capacity':!capacity.freeAvailable?'free_capacity':'open',waitlistEnabled:env.WAITLIST_ENABLED==='true'&&env.WAITLIST_MAIL_AVAILABLE===true};
    return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers:{...privateHeaders,'Content-Type':'application/json','Cache-Control':`public, max-age=${capacity?Math.max(0,Math.floor((capacity.cacheUntil-Date.now())/1000)):0}, must-revalidate`}});
   }
   // Contact-delivery bearer RPC: a disjoint credential class, never the OAuth/app grant path.
   if(path==='/bindle/rpc'&&request.method==='POST'&&/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('Authorization')||'')&&jwsPart(request.headers.get('Authorization').slice(7),0)?.typ==='bindle-contact-delivery+jwt'){
    const token=request.headers.get('Authorization').slice(7);if(token.length>16384)return json({error:'unauthorized'},401);
    let ingressRetry=3600;if(!await limit(env,{operation:'message',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),onDenied:window=>ingressRetry=Math.ceil(window.windowMs/1000)}))return json({error:'rate_limited'},429,{'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After','Retry-After':String(ingressRetry)});
    const sub=jwsPart(token,1)?.sub;if(typeof sub!=='string'||!uuidPattern.test(sub))return json({error:'unauthorized'},401);const recipient=await env.IDENTITY_REPOSITORY.get(sub);if(!recipient||recipient.status!=='active')return json({error:'unauthorized'},401);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'invalid_envelope',message:'Use the contact-delivery RPC JSON request.'},415);
    const handle=accountHandle(env,sub);await handle.verifyLinkCredential(sub,{token});
    const parsed=await parseRPCDelivery(await bytesOf(request,1500000),{allowInsecureLocalhost:local}),result=await handle.deliverLink(sub,{token},{envelope:parsed.envelope,body:parsed.body});execution?.waitUntil?.(handle.searchDrain(sub,{limit:10}).catch(()=>{}));
    return json({version:'0',tx:parsed.tx,result:result.receipt});
   }
   if(path==='/.well-known/bindle/manifest.json'||path.startsWith('/oauth/')||path==='/bindle/rpc'||path.startsWith('/bindle/objects/')||path.startsWith('/api/oauth/')||path==='/api/preferences'||path==='/api/grants'||path.startsWith('/api/grants/')){
    let entryRemote;
    if(env.FEDERATION_ENABLED==='true'&&request.method!=='OPTIONS'){
     const remote=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;
     if(!secret)return json({error:'temporarily_unavailable',message:'Application connections are not configured.'},503);
     const ip=entryRemote=await pseudonym(remote,secret),network=await pseudonym(subnet(remote),secret),lane=parseInt(ip.slice(0,2),16)%16;
     const readOnly=request.method==='GET'||request.method==='HEAD',rpc=path==='/bindle/rpc'||path.startsWith('/bindle/objects/');
     const rateClass=rpc?'rpc':readOnly?'read':'mutation';
     if(!await env.ABUSE.consume(`bindle/${rateClass}/ip/${ip}`,{windowMs:60000,limit:rpc?120:readOnly?120:30})||!await env.ABUSE.consume(`bindle/${rateClass}/subnet/${network}`,{windowMs:60000,limit:rpc?400:200})||!await env.ABUSE.consume(`bindle/${rateClass}/service-v1-${lane}`,{windowMs:60000,limit:rpc?400:200})){const appOrigin=request.headers.get('Origin');const cors=path.startsWith('/bindle/objects/')?{'Access-Control-Allow-Origin':'*'}:appOrigin&&env.FEDERATION_AUTHORITY?.clients?.some(client=>client.origin===appOrigin)?{'Access-Control-Allow-Origin':appOrigin,Vary:'Origin'}:{};return json({error:'rate_limited',message:'Please wait before continuing this application connection.'},429,{'Retry-After':'60',...cors});}
    }
    if(path.startsWith('/bindle/objects/'))return handleObjectURL(request,{controller:env.FEDERATION_AUTHORITY,enabled:env.FEDERATION_ENABLED==='true'});
    // Provider-owned authorization entry (adaptive sign-in §7): cookieless creation keyed by the caller's IP
    // pseudonym, owner steps resolved through the multi-account cookies, and its own strict document policy (F7).
    const entryResponse=await handleAuthorizationEntry(request,{entries:env.FEDERATION_ENTRIES,issuer:env.APP_ORIGIN,assets:env.ASSETS,allowInsecureLocalhost:local,enabled:env.FEDERATION_ENABLED==='true'&&Boolean(env.FEDERATION_ENTRIES),remote:()=>entryRemote,ownerContext:entryRequest=>entryOwnerContext(entryRequest,env,local)});
    if(entryResponse)return entryResponse.headers.get('Content-Type')?.includes('text/html')?securePage(await brandPage(entryResponse,env),false,false,{keepPolicy:true}):entryResponse;
    const response=await handleFederation(request,{controller:env.FEDERATION_AUTHORITY,issuer:env.APP_ORIGIN,allowInsecureLocalhost:local,assets:env.ASSETS,enabled:env.FEDERATION_ENABLED==='true',ownerContext:ownerRequest=>entryOwnerContext(ownerRequest,env,local)});
    // Contact intents (links §6.4, core feature `intents.v1`): this host accepts `bindle_intent` on its console entry.
    // Entry routes and the components profile are advertised only while this adapter mounts them (review F8).
    if(response&&path==='/.well-known/bindle/manifest.json'&&request.method==='GET'&&response.ok){const manifest=await response.json(),entries=env.FEDERATION_ENTRIES?env.FEDERATION_ENTRIES.manifest({components:await embedShellMounted(env)}):{};return json({...manifest,features:{...manifest.features,...entries.features,'intents.v1':{intents:[...CONTACT_INTENTS],login_endpoint:`${env.APP_ORIGIN}/console`}},...entries.profiles?{profiles:{...manifest.profiles,...entries.profiles}}:{}},200,{'Access-Control-Allow-Origin':'*'});}
    if(response)return path==='/oauth/authorize'&&response.headers.get('Content-Type')?.includes('text/html')?securePage(await brandPage(response,env)):response;
    return json({error:'not_found'},404);
   }
   if(mcpPublicPath(path)){
    if(env.MCP_ENABLED!=='true')return handleMcpPublic(request,env);
    if(path==='/mcp/oauth/authorize'||path==='/mcp/oauth/token'){
     const remote=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;
     if(!secret)return json({error:'temporarily_unavailable',message:'Assistant connections are not configured.'},503);
     const ip=await pseudonym(remote,secret),network=await pseudonym(subnet(remote),secret),partition=parseInt(ip.slice(0,2),16)%16;
     if(!await env.ABUSE.consume(`mcp/oauth/ip/${ip}`,{windowMs:60000,limit:30})||!await env.ABUSE.consume(`mcp/oauth/subnet/${network}`,{windowMs:60000,limit:100})||!await env.ABUSE.consume(`mcp/oauth/service-v1-${partition}`,{windowMs:60000,limit:32}))return json({error:'rate_limited'},429);
    }
    return handleMcpPublic(request,env);
   }
   if(path==='/api/billing/webhook'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    const verified=await verifyPolarWebhook(request,env);if(verified.ignored)return json({accepted:true,ignored:true});if(verified.catalog){if(!env.BILLING_CATALOG)throw Object.assign(new Error('Catalog registry is unavailable.'),{code:'billing_unconfigured',status:503});if(!await env.BILLING_CATALOG.relevant(verified))return json({accepted:true,ignored:true});return json(await env.BILLING_CATALOG.applyWebhook(verified));}if(verified.refund){if(!env.BILLING_CATALOG)throw Object.assign(new Error('Catalog registry is unavailable.'),{code:'billing_unconfigured',status:503});Object.assign(verified,await env.BILLING_CATALOG.resolveRefund(verified));}
    if(!verified.owner||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(verified.owner))return json({accepted:true,ignored:true});
    verified.relevant=env.BILLING_CATALOG?await env.BILLING_CATALOG.relevant(verified):Object.values({paid:env.POLAR_PRODUCT_ID_PAID,plus:env.POLAR_PRODUCT_ID_PLUS,ultra:env.POLAR_PRODUCT_ID_ULTRA}).some(id=>id&&(id===verified.productId||verified.productIds?.includes(id)));
    const account=await env.IDENTITY_REPOSITORY.get(verified.owner);if(!account||(account.status!=='active'&&!(['pending','recovering'].includes(account.status)&&account.admission?.version===1&&account.admission.kind==='paid'&&account.admission.initialPaymentRequired!==false)))return json({accepted:true,ignored:true});
    return json(await accountHandle(env,verified.owner).billingWebhookVerified(verified.owner,verified));
   }
   if(path==='/manifest.webmanifest'&&request.method==='GET'){const asset=await env.ASSETS.fetch(request);const manifest=await asset.json();const name=env.BRAND_NAME||'3sln.me';return new Response(JSON.stringify({...manifest,name,short_name:name,...name==='3sln.me'?{}:{icons:[{src:'/generic-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}}),{headers:{'Content-Type':'application/manifest+json','Cache-Control':'no-cache'}});}
   // Public, credentialless previews: oEmbed and the link-scoped avatar redirect (never deliver or evaluate data).
   const avatarPath=/^(\/users\/[^/]+\/contact\/[a-f0-9-]{36})\/avatar$/.exec(path);
   if(path==='/oembed'||avatarPath){
    const previewHeaders={...privateHeaders,'Access-Control-Allow-Origin':'*','X-Robots-Tag':'noindex, nofollow'};
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{...previewHeaders,Allow:'GET, HEAD'});
    if(avatarPath){const preview=await contactPreview({env,target:env.APP_ORIGIN+avatarPath[1]+url.search,profile:previewProfile(env,request,local)});return new Response(null,{status:302,headers:{...previewHeaders,Location:preview.avatarURL??preview.image}});}
    const targets=url.searchParams.getAll('url');if(targets.length!==1||targets[0].length>18000||url.searchParams.getAll('format').some(f=>f!=='json'))return json({error:url.searchParams.has('format')&&url.searchParams.get('format')!=='json'?'not_implemented':'invalid_request'},url.searchParams.get('format')&&url.searchParams.get('format')!=='json'?501:400,previewHeaders);
    const value=oembed(await contactPreview({env,target:targets[0],profile:previewProfile(env,request,local)}));return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers:{...previewHeaders,'Content-Type':'application/json'}});
   }
   const signedContact=signedContactPath.exec(path);
   if(signedContact||path==='/api/messages'&&request.method==='OPTIONS'){
    const publicHeaders={Vary:'Accept, Accept-Language','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, POST, OPTIONS','Access-Control-Allow-Headers':'Accept, Accept-Language, Content-Type, Idempotency-Key','Access-Control-Expose-Headers':'Retry-After','X-Robots-Tag':'noindex, nofollow, nosnippet'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...privateHeaders,...publicHeaders}});
    if(signedContact){
     if(!['GET','HEAD','POST'].includes(request.method))return json({error:'method_not_allowed'},405,{...publicHeaders,Allow:'GET, HEAD, POST, OPTIONS'});
     // One raw-query parser takes every routing decision (links §2; review finding #7).
     let query;try{query=parseLinkQuery(request.url);}catch{return json({error:'link_malformed',message:'This contact link is malformed.'},400,publicHeaders);}
     const linkForm=query.form==='link',refused=()=>linkForm?json({error:'link_invalid',message:'This contact link is invalid or no longer active.'},401,publicHeaders):json({error:'unauthorized',message:'This contact link is invalid or no longer active.'},401,publicHeaders);
     const representation=selectContactRepresentation(request.headers.get('Accept')||'*/*');
     // bindle_data is evaluated only by a JSON inspection GET; everywhere else it is malformed (links §7.2).
     if(query.data!==undefined&&!(request.method==='GET'&&representation==='application/json'))return json({error:'link_malformed',message:'Remove the response from this link before continuing.'},400,publicHeaders);
     // The composer page is identical for every link and evaluates nothing; its own calls verify.
     if(request.method==='GET'&&representation==='text/html'){const page=await securePage(await brandPage(await env.ASSETS.fetch(new Request(new URL('/console.html',url),request)),env));const headers=new Headers(page.headers);for(const [key,value]of Object.entries(publicHeaders))headers.set(key,value);
      // Only this page may fetch other providers' public manifests (handle discovery, links §6.4); still no credentials.
      headers.set('Content-Security-Policy',headers.get('Content-Security-Policy').replace("connect-src 'self'",`connect-src 'self' https:${local?' http://localhost:*':''}`));if(!page.ok||!headers.get('Content-Type')?.includes('text/html'))return new Response(page.body,{status:page.status,headers});return new Response(injectPreview(await page.text(),await contactPreview({env,target:request.url,profile:previewProfile(env,request,local)})),{status:page.status,headers});}
     let sub;if(linkForm){try{const claims=parseLinkMeta(query.meta).claims;if(claims.aud===env.APP_ORIGIN+path)sub=claims.sub;}catch{}}else if(query.form==='legacy'){const sig=url.searchParams.get('sig');if(sig&&sig.length<=16384)sub=jwsPart(sig,1)?.sub;}
     if(typeof sub!=='string'||!uuidPattern.test(sub))return refused();
     const recipient=await env.IDENTITY_REPOSITORY.get(sub);if(!recipient||recipient.status!=='active'||recipient.handle!==signedContact[1])return refused();
     if(!representation&&request.method!=='POST')return json({error:'not_acceptable'},406,publicHeaders);
     const remoteIP=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown');
     let ingressRetry=3600;if(!await limit(env,{operation:'message',remoteIP,onDenied:window=>ingressRetry=Math.ceil(window.windowMs/1000)}))return json({error:'rate_limited'},429,{...publicHeaders,'Retry-After':String(ingressRetry)});
     // Per claimed principal and network before any verification or policy work (links §7.2). Keying by
     // network too means nobody can exhaust another principal's window from elsewhere.
     if(query.data!==undefined){const claimed=jwsPart(query.data,1);if(typeof claimed?.iss==='string'&&typeof claimed?.sub==='string'&&!await limit(env,{operation:'link-audience',remoteIP,handle:`${claimed.iss}\u0000${claimed.sub}\u0000${subnet(remoteIP)}`}))return json({error:'rate_limited'},429,{...publicHeaders,'Retry-After':'60'});}
     const handle=accountHandle(env,sub);
     if(request.method==='HEAD'){if(representation===CONTACT_PROFILE_MIME)await handle.contactProfile(sub,request.url);else await handle.contactMetadata(sub,request.url,[]);return new Response(null,{headers:{...privateHeaders,...publicHeaders,'Content-Type':representation===CONTACT_DELIVERY_TOKEN?CONTACT_DELIVERY_TOKEN_MIME:representation}});}
     if(request.method==='GET'&&representation===CONTACT_PROFILE_MIME)return json(await handle.contactProfile(sub,request.url),200,{...publicHeaders,'Content-Type':CONTACT_PROFILE_MIME});
     if(request.method==='GET'&&representation===CONTACT_INTAKE_MIME)return json(await handle.contactMetadata(sub,request.url,locales(request.headers.get('Accept-Language'))),200,{...publicHeaders,'Content-Type':CONTACT_INTAKE_MIME});
     if(request.method==='GET'&&representation==='application/json')return json(await handle.inspectContactLink(sub,request.url),200,publicHeaders);
     if(request.method==='GET'){const minted=representation===CONTACT_DELIVERY_TOKEN?await handle.mintDeliveryToken(sub,request.url):await handle.mintInvitationBearer(sub,request.url);return new Response(minted.token,{headers:{...privateHeaders,...publicHeaders,'Content-Type':minted.contentType??CONTACT_TOKEN_MIME,'X-Token-Expires-At':String(minted.expiresAt)}});}
     // Authored delivery only (links §6.1): the signed URL is the sole credential on this path.
     if(request.headers.has('Authorization'))return json({error:'ambiguous_credentials',message:'Send the signed contact link as the only credential.'},400,publicHeaders);
     const contentType=request.headers.get('Content-Type')||'';if(!contentType.startsWith('multipart/form-data'))return json({error:'unsupported_media',message:'Send a contact-delivery multipart message.'},415,publicHeaders);
     // Credential first (contact-delivery S4): no envelope parsing or hashing for an invalid link.
     await handle.verifyLinkCredential(sub,{url:request.url});
     const bytes=await bytesOf(request,1500000);let operation;
     try{operation=await parseMultipartDelivery(contentType,bytes,{allowInsecureLocalhost:local});}catch(error){if(['invalid_multipart','author_required'].includes(error.code)&&!new TextDecoder().decode(bytes.subarray(0,4096)).includes('name="envelope"'))return json({error:'author_required',message:'Contact links accept only identity-authored messages. Sign in to send.'},403,publicHeaders);throw error;}
     const result=await handle.deliverLink(sub,{url:request.url},{envelope:operation.envelope,body:operation.body,...request.headers.has('Idempotency-Key')?{idempotencyKey:request.headers.get('Idempotency-Key')}:{}});execution?.waitUntil?.(handle.searchDrain(sub,{limit:10}).catch(()=>{}));return delivered(result,publicHeaders);
    }
   }
   if(path==='/api/integrations/google/callback'){
    if(request.method!=='GET')return json({error:'method_not_allowed'},405,{Allow:'GET'});
    const fragment=new URLSearchParams();for(const key of ['state','code','error']){const values=url.searchParams.getAll(key);if(values.length>1||values.some(v=>v.length>(key==='code'?4096:200)||/[\u0000-\u001f\u007f]/.test(v)))return json({error:'invalid_callback'},400);if(values.length)fragment.set(key,values[0]);}
    return new Response(null,{status:303,headers:{...privateHeaders,Location:'/integrations/google/complete#'+fragment}});
   }
   const conversationPublic=await publicConversationRoutes(request,env,{account:accountHandle,body,json,limit,execution});if(conversationPublic)return conversationPublic;
   const allow=allowedMethods(path);if(allow&&!allow.includes(request.method))return json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:allow.join(', ')});
   if(path.startsWith('/api/demo'))return json({error:'not_found'},404);
   if(path==='/api/recovery/authority'){if(request.method!=='GET')return json({error:'method_not_allowed'},405,{Allow:'GET'});return json(recoveryAuthorityPublic(env));}
   if(path==='/api/config')return json({origin:env.APP_ORIGIN,brand:{name:env.BRAND_NAME||(local?'3sln.me':'3sln.me'),host:new URL(env.APP_ORIGIN).host},termsVersion:env.TERMS_VERSION,turnstileSiteKey:env.TURNSTILE_SITE_KEY,localDevelopment:local,signupEnabled:signupEnabled(env),onboardingOnly:onboardingOnly(env),tokenOnboardingEnabled:onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true,badgePolicy:await badgePresentation(env),signupContactRequired:env.SIGNUP_CONTACT_REQUIRED==='true',emailSetupAvailable:env.EMAIL_SETUP_AVAILABLE===true,pushSetupAvailable:env.PUSH_AVAILABLE===true,passwordEnabled:true,passkeyEnabled:true,emailEnabled:env.EMAIL_AVAILABLE===true,notificationEmailEnabled:false,pushEnabled:false,vapidPublicKey:env.VAPID_PUBLIC_KEY,billingEnabled:env.BILLING_ENABLED==='true',searchEnabled:true,semanticSearchEnabled:env.SEMANTIC_SEARCH_ENABLED==='true',providers:providerConfig(env)});
   if(path==='/api/notifications/unsubscribe'&&request.method==='POST'){
     const input=await body(request);const pieces=typeof input.token==='string'?input.token.split('.'):[];const owner=pieces.length===2?pieces[0]:input.owner;const token=pieces.length===2?pieces[1]:input.token;
     if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner)||typeof token!=='string'||token.length!==43)return json({error:'invalid_unsubscribe',message:'This unsubscribe link is invalid.'},400);
     const identity=await env.IDENTITY_REPOSITORY.get(owner);if(!identity||identity.status!=='active')return json({error:'invalid_unsubscribe',message:'This unsubscribe link is invalid.'},400);
     return json(await env.ACCOUNTS.get(owner).unsubscribe(owner,token));
   }
   // Anonymous inbox-bearer submission is retired: every message through a link is identity-authored (links §6.1, §10).
   const landing=/^\/users\/((?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9}))\/message$/.exec(path);
   if((path==='/api/messages'||landing)&&request.method==='POST'&&request.headers.get('Authorization')?.startsWith('Bearer '))return json({error:'author_required',message:'Contact links accept only identity-authored messages. Sign in to send.'},403,{'Access-Control-Allow-Origin':'*'});
   if(mutation&&path.startsWith('/api/')&&request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
   if(['/api/waitlist/start','/api/waitlist/confirm','/api/waitlist/leave'].includes(path)){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if((path!=='/api/waitlist/leave'&&env.WAITLIST_ENABLED!=='true')||(path==='/api/waitlist/start'&&env.WAITLIST_MAIL_AVAILABLE!==true)||typeof env.ABUSE?.waitlist!=='function')return json({error:'waitlist_unavailable',message:'The waitlist is not available.'},503);
    const input=await body(request,4096),secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY,remoteIP=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown');
    if(!secret)return json({error:'waitlist_unavailable'},503);
    const ip=await pseudonym(remoteIP,secret),network=await pseudonym(subnet(remoteIP),secret),starting=path.endsWith('/start');
    if(!await consume(env,'waitlist:ip:'+ip,3600000,starting?3:30)||!await consume(env,'waitlist:network:'+network,3600000,starting?20:100))return json({error:'rate_limited',message:'Please wait before trying again.'},429,{'Retry-After':'3600'});
    if(!starting&&!await consume(env,'waitlist:proof-service:'+parseInt(ip.slice(0,2),16)%16,60000,100))return json({error:'rate_limited'},429,{'Retry-After':'60'});
    if(!starting)return json(await env.ABUSE.waitlist(path.endsWith('/confirm')?'confirm':'leave',input));
    const email=waitlistEmail(input.email);
    if(!await turnstile(env,{token:input.turnstileToken,remoteIP,hostname:new URL(env.APP_ORIGIN).hostname,action:'waitlist'}))return json({error:'challenge_failed',message:'Complete the verification challenge.'},403);
    const capacity=await env.ABUSE.signupStatus('signup:lifetime-admission',signupCapacityLimits(env));
    const target=await pseudonym('waitlist-target-v1:'+env.APP_ORIGIN+':'+email,secret);
    if(!await consume(env,'waitlist:target-cooldown:'+target,600000,1)||!await consume(env,'waitlist:target-day:'+target,86400000,3))return json({accepted:true},202);
    for(const [name,windowMs,maximum]of [['minute',60000,10],['hour',3600000,100],['day',86400000,500]])if(!await consume(env,'waitlist:mail:'+name,windowMs,maximum))return json({accepted:true},202);
    const result=await env.ABUSE.waitlist('prepare',{email,locale:input.locale,allowNew:!signupEnabled(env)||!capacity.freeAvailable||env.WAITLIST_ALLOW_OPEN==='true'});
    if(result.mail){let timer;try{await Promise.race([env.WAITLIST_MAILER.sendWaitlistConfirmation(result.mail),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mail outcome unknown')),15000);timer.unref?.();})]);}catch{}finally{clearTimeout(timer);}}
    return json({accepted:true},202);
   }
   if(path.startsWith('/api/auth/onboarding/')){
    if(!['/api/auth/onboarding/begin','/api/auth/onboarding/issue','/api/auth/onboarding/inspect','/api/auth/onboarding/claim'].includes(path))return json({error:'not_found'},404);
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if(!(onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true)||!env.RECOVERY_SIGNING_KEY||env.SIGNUP_CONTACT_REQUIRED==='true'&&!(env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true))return json({error:'onboarding_unavailable',message:'Account onboarding is not configured.'},503);
    if(request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'csrf'},403);
    if(!await limit(env,{operation:'onboarding-'+path.split('/').at(-1),remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429);
    if(path.endsWith('/begin')){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);const binding=setupCookie(request,local)||crypto.randomUUID()+crypto.randomUUID();return json({ready:true},200,{'Set-Cookie':`${local?'bindle_setup':'__Host-bindle_setup'}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`});}
   }
   if(path==='/api/auth/system/bootstrap'&&(!env.SYSTEM_BOOTSTRAP_KEY||!env.RECOVERY_SIGNING_KEY||!(env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true)))return json({error:'system_bootstrap_unavailable',message:'System setup is not configured.'},503);
   if(path==='/api/auth/system/bootstrap/begin'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if(!env.SYSTEM_BOOTSTRAP_KEY||!env.RECOVERY_SIGNING_KEY||!(env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true))return json({error:'system_bootstrap_unavailable',message:'System setup is not configured.'},503);
    if(!await limit(env,{operation:'system-bootstrap-begin',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429);
    const binding=setupCookie(request,local)||crypto.randomUUID()+crypto.randomUUID();return json({ready:true},200,{'Set-Cookie':`${local?'bindle_setup':'__Host-bindle_setup'}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`});
   }
   if(path.startsWith('/api/')){
    if(path==='/api/auth/signup'&&request.method==='POST'&&!signupEnabled(env))return json({error:'release_gated',message:'Account creation is not open yet.'},503);
    // Member cookies are authenticated and the tab selector matched before any owner actor is routed.
    const vault=accountCookiesEnabled(env),accountCookies=vault?parseAccountCookies(request,local):new Map(),vaultPresent=vault&&hasAccountVault(accountCookies,local),accountPath=vault&&accountRoutePaths.includes(path);let accountMember=null;if(vault&&!accountPath&&!(mutation&&request.headers.get('X-Bindle-Account')===null))accountMember=await selectedAccountMember(request,env,local,accountCookies);
    engine=await identity(env);const context={origin:request.headers.get('Origin')||env.APP_ORIGIN,sessionToken:accountMember?.token||(vaultPresent?undefined:sessionToken(request,local)),expectedOwner:accountMember?.owner||request.headers.get('X-Bindle-Account')||undefined,sessionContext:accountMember?.sessionContext||request.headers.get('X-Bindle-Session-Context')||undefined,csrfToken:request.headers.get('X-CSRF-Token'),remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),region:/^[A-Z]{2}$/.test(request.cf?.country||'')?request.cf.country:'unknown',deviceBinding:deviceCookie(request,local),setupBinding:setupCookie(request,local)};
    // Host administration (boot-and-admin): explicit actor header and its own boot cookie; inert without configuration.
    if(adminPath(path))return await adminRoutes({path,request,env,local,context,body,json});
    if(accountPath)return await accountSessionRoutes({request,env,local,engine,context,body,json,legacyCleared:cookie('',local,0)});
    if(['/api/auth/signup','/api/auth/recover','/api/auth/login/password','/api/auth/login/passkey/finish'].includes(path))context.setupBinding=crypto.randomUUID()+crypto.randomUUID();
    if(path==='/api/auth/device/start')context.deviceBinding=crypto.randomUUID()+crypto.randomUUID();
    if(path==='/api/auth/device/inspect')return json(await engine.query(new DeviceRequestQuery(await body(request),context)).peek());
    if(path==='/api/auth/device/qr'){
      const input=await body(request);let qr;try{qr=new URL(input.verificationUriComplete);}catch{return json({error:'invalid_request'},400);}if(qr.origin!==env.APP_ORIGIN||qr.pathname!=='/device'||qr.search||!qr.hash.startsWith('#request='))return json({error:'invalid_request'},400);return json({svg:await QRCode.toString(qr.href,{type:'svg',width:320,margin:2})});
    }
    if(authMethods[path]){
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      if(path==='/api/auth/signup'&&!signupEnabled(env))return json({error:'release_gated',message:'Account creation is not open yet.'},503);
      const input=await body(request);
      // Sign-out also forgets this device's push subscription for that account (best effort).
      if(path==='/api/auth/logout'&&Object.hasOwn(input,'pushSubscription')){const id=input.pushSubscription;delete input.pushSubscription;if(typeof id==='string'&&/^[A-Za-z0-9_-]{43}$/.test(id))try{const signedIn=await engine.query(new OwnerQuery(context)).peek();await accountHandle(env,signedIn.account.id).removeSubscription(signedIn.account.id,id);}catch{}}
      if(['credentialBegin','credentialFinish','renamePasskey','renameSession','approveDeviceLogin','emailStart','emailConfirm','configureEmailLogin'].includes(authMethods[path])){
        const authenticated=await engine.query(new OwnerQuery(context)).peek();
        if(context.csrfToken!==authenticated.csrfToken)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
        await accountHandle(env,authenticated.account.id).touch(authenticated.account.id);
      }
      const event=await engine.dispatch(new IdentityAction(authMethods[path],input,context)).next('result');const result=event.detail;
      if(['/api/auth/signup','/api/auth/system/bootstrap','/api/auth/onboarding/claim'].includes(path)&&result.account?.status==='pending')await accountHandle(env,result.account.id).rememberSignupOrigin(result.account.id,{createdAt:result.account.createdAt});
      if(result.sessionToken&&result.account?.id){try{await accountHandle(env,result.account.id).touch(result.account.id);result.billingSync=await accountHandle(env,result.account.id).billingRefresh(result.account.id,{force:true});}catch{result.billingSync={checked:false,error:'billing_provider_unavailable'};}}
      const headers=new Headers();if(result.pendingToken&&context.setupBinding)headers.append('Set-Cookie',`${local?'bindle_setup':'__Host-bindle_setup'}=${context.setupBinding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`);if(result.sessionToken){if(vault){for(const value of await installAccountSession({request,env,local,engine,context,result,legacyCleared:cookie('',local,0)}))headers.append('Set-Cookie',value);}else headers.append('Set-Cookie',cookie(result.sessionToken,local));delete result.sessionToken;}if(path==='/api/auth/logout'){if(accountMember)for(const value of removedAccountCookies(accountMember.owner,local))headers.append('Set-Cookie',value);else headers.append('Set-Cookie',cookie('',local,0));}
      if(path==='/api/auth/device/start')headers.append('Set-Cookie',`${local?'bindle_device':'__Host-bindle_device'}=${context.deviceBinding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300${local?'':'; Secure'}`);
      return json(result,200,headers);
    }
    // Header-less private writes would follow a mutable default; tabs must name their member.
    // (Header-less mutations never select the default member, so identity writes fail closed too.)
    if(vaultPresent&&mutation&&request.headers.get('X-Bindle-Account')===null)throw accountFault('account_context_conflict',409);
    let owner;try{owner=await engine.query(new OwnerQuery(context)).peek();}catch(error){if(path==='/api/session'&&error.code==='unauthorized')return json({authenticated:false});throw error;}
    if(path==='/api/session'){if(vault&&!accountMember&&!vaultPresent&&context.sessionToken){const headers=new Headers();for(const value of await installedAccountCookies(env,{owner:owner.account.id,token:context.sessionToken,expiresAt:owner.expiresAt,sessionContext:owner.sessionContext},local))headers.append('Set-Cookie',value);headers.append('Set-Cookie',cookie('',local,0));return json({authenticated:true,...owner},200,headers);}return json({authenticated:true,...owner});}
    const id=owner.account.id;const object=accountHandle(env,id);
    // Owner mutations independently require session CSRF, even when not an identity action.
    if(mutation&&context.csrfToken!==owner.csrfToken)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
    const automationResponse=await automationRoutes({path,request,owner,object,body,json});if(automationResponse)return automationResponse;
    if(mcpOwnerPath(path))return handleMcpOwner({request,env,owner,body});
    if(['/api/integrations/google/start','/api/integrations/google/complete'].includes(path)){const device=owner.devices?.find(d=>d.current);if(!device)return json({error:'unauthorized'},401);const input=await body(request);return json(await object[path.endsWith('/start')?'googleDriveStart':'googleDriveComplete'](id,device.id,input));}
    if(path==='/api/apps'&&request.method==='GET')return json({apps:await object.appConnections(id)});
    const appMessages=/^\/api\/apps\/([a-f0-9-]{36})\/notifications$/.exec(path);if(appMessages&&request.method==='PUT')return json(await object.appNotificationSettings(id,appMessages[1],await body(request,1024)));
    const appDisconnect=/^\/api\/apps\/([a-f0-9-]{36})$/.exec(path);if(appDisconnect&&request.method==='DELETE')return json(await object.appDisconnect(id,appDisconnect[1]));
    let protective=false;
    if(mutation&&(['/api/search/preferences','/api/profile','/api/notifications'].includes(path)||request.method==='PUT'&&/^\/api\/contacts\/[^/]+\/beam$/.test(path))){const change=await body(request.clone());protective=path==='/api/search/preferences'&&change.enabled===false||path==='/api/profile'&&change.discloseToContacts===false||path==='/api/notifications'||/^\/api\/contacts\/[^/]+\/beam$/.test(path)&&(change.beamEnabled===false||Array.isArray(change.profileFields)&&change.profileFields.length===0&&change.beamEnabled!==true);}
    const capacityExempt=protective||['/api/billing/checkout','/api/billing/change-plan','/api/billing/cancel-change','/api/billing/portal','/api/notifications/unsubscribe','/api/notifications/unsubscribe-link','/api/links/respond','/api/links/envelope'].includes(path)||/^\/api\/contacts\/[^/]+\/quarantine$/.test(path);
    if(mutation&&!capacityExempt&&!path.startsWith('/api/conversations')&&request.method!=='DELETE'&&(!path.startsWith('/api/beams/')||['/api/beams/invites','/api/beams/invites/redeem'].includes(path))&&allowedMethods(path))await object.admitWork(id,{initialize:true});
    await object.touch(id);
    const developerContactResponse=await developerContactRoutes({path,request,env,owner,object,accountHandle,body,json,limit,remoteIP:context.remoteIP});if(developerContactResponse)return developerContactResponse;
    if(path==='/api/contact-links')return json(await object.createContactLink(id,owner.account.handle,await body(request)));
    const intake=/^\/api\/contacts\/([a-f0-9-]{36})\/intake$/.exec(path);if(intake)return json(request.method==='PUT'?await object.updateContactIntake(id,intake[1],await body(request,32768)):await object.contactIntake(id,intake[1]));
    const rotation=/^\/api\/contacts\/([a-f0-9-]{36})\/rotate$/.exec(path);if(rotation){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);return json(await object.rotateContactChallenge(id,rotation[1]));}
    // Opener operations: explicit, authenticated, CSRF-checked and rate-limited per user (links §9).
    if(path==='/api/links/respond'||path==='/api/links/envelope'){if(!await limit(env,{operation:path==='/api/links/respond'?'link-respond':'link-envelope',remoteIP:context.remoteIP,handle:id}))return json({error:'rate_limited',message:'Please wait before trying again.'},429,{'Retry-After':'60'});const input=await body(request,32768);if(path==='/api/links/envelope')return json(await object.authorLinkEnvelope(id,input));if(Object.keys(input).join()!=='link'||typeof input.link!=='string')return json({error:'invalid_request'},400);return json(await object.signLinkResponse(id,owner.account.handle,input.link));}
    if(path==='/api/tags/labels')return json(request.method==='PUT'?await object.setTagLabel(id,await body(request,4096)):await object.tagLabels(id));
    const restoreRule=/^\/api\/rules\/([^/]{1,200})\/restore$/.exec(path);if(restoreRule){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);return json(await object.restoreDefaultRule(id,decodeURIComponent(restoreRule[1])));}
    const beamResponse=await beamRoutes({path,url,request,env,owner,object,accountHandle,body,json});if(beamResponse)return beamResponse;
    if(path==='/api/account'&&request.method==='GET')return json({...await object.snapshot(id),account:owner.account,credentials:owner.credentials,devices:owner.devices,audit:owner.audit,grants:[]});
    if(path==='/api/storage/usage')return json(await object.storageUsage(id));
    if(path==='/api/billing'&&request.method==='GET'){if([...url.searchParams.keys()].some(key=>!['currency','txId'].includes(key))||url.searchParams.getAll('currency').length>1||url.searchParams.getAll('txId').length>1)throw Object.assign(new Error('Choose a supported payment currency.'),{code:'invalid_currency',status:400});return json(await object.billingStatus(id,{country:context.region,...url.searchParams.has('currency')?{currency:url.searchParams.get('currency')}:{},...url.searchParams.has('txId')?{txId:url.searchParams.get('txId')}:{}}));}
    if(path==='/api/billing/cancel-change'&&request.method==='POST'){if(!await limit(env,{operation:'billing',remoteIP:context.remoteIP}))return json({error:'rate_limited'},429,{'Retry-After':'3600'});const input=await body(request);if(Object.keys(input).some(key=>!['txId','scheduledTxId'].includes(key)))throw Object.assign(new Error('Confirm the scheduled change to cancel.'),{code:'invalid_args',status:400});return json(await object.billingCancelChange(id,input));}
    if(path==='/api/billing/change-plan'&&request.method==='POST'){if(!await limit(env,{operation:'billing',remoteIP:context.remoteIP}))return json({error:'rate_limited'},429,{'Retry-After':'3600'});const input=await body(request);if(Object.keys(input).some(key=>!['plan','txId','priceDigest'].includes(key)))throw Object.assign(new Error('Review the target plan before confirming.'),{code:'invalid_args',status:400});return json(await object.billingChangePlan(id,input));}
    if(path==='/api/billing/checkout'&&request.method==='POST'){const input=await body(request);if(Object.keys(input).some(key=>!['plan','currency','locale'].includes(key)))throw Object.assign(new Error('Choose a plan and payment currency.'),{code:'invalid_args',status:400});return json(await object.billingCheckout(id,input.plan,{country:context.region,customerIpAddress:context.remoteIP,...Object.hasOwn(input,'currency')?{currency:input.currency}:{},...Object.hasOwn(input,'locale')?{locale:input.locale}:{}}));}
    if(path==='/api/billing/portal'&&request.method==='POST')return json(await object.billingPortal(id));
    if(path==='/api/views')return json(request.method==='POST'?await object.createView(id,await body(request)):await object.listViews(id));
    const savedView=/^\/api\/views\/([A-Za-z0-9-]{1,64})$/.exec(path);if(savedView)return json(await object[request.method==='DELETE'?'deleteView':'updateView'](id,savedView[1],await body(request)));
    if(path==='/api/incoming'&&request.method==='PATCH')return json(await object.updateIncoming(id,await body(request)));
    if(path==='/api/incoming'){const p=url.searchParams;if([...p.keys()].some(k=>!['view','viewRevision','filter','sort','limit','cursor'].includes(k)||p.getAll(k).length!==1))throw Object.assign(new Error('Choose a valid View query.'),{code:'invalid_view',status:400});let filter;if(p.has('filter'))try{filter=JSON.parse(p.get('filter'));}catch{throw Object.assign(new Error('Choose a valid View filter.'),{code:'invalid_view',status:400});}return json(await object.queryIncoming(id,{...p.has('view')?{view:p.get('view')}:{},...p.has('viewRevision')?{viewRevision:Number(p.get('viewRevision'))}:{},...p.has('filter')?{filter}:{},...p.has('sort')?{sort:p.get('sort')}:{},...p.has('limit')?{limit:Number(p.get('limit'))}:{},...p.has('cursor')?{cursor:p.get('cursor')}:{}}));}
    if(path==='/api/messages/page'){const p=url.searchParams;return json(await object.messagePage(id,{limit:Number(p.get('limit')||100),...p.has('collection')?{collection:p.get('collection')}:{},...p.has('unread')?{unread:p.get('unread')==='true'}:{},...p.has('quarantined')?{quarantined:p.get('quarantined')==='true'}:{},cursor:p.get('cursor')||undefined}));}
    if(path==='/api/search/preferences'){if(request.method==='PUT')return json(await object.updateSearchPreferences(id,await body(request)));return json(await object.searchPreferences(id));}
    if(path==='/api/search'){const p=url.searchParams;if(!await limit(env,{operation:'search',remoteIP:context.remoteIP,handle:owner.account.handle}))return json({error:'rate_limited',message:'Please wait before searching again.'},429);return json(await object.omniSearch(id,{text:p.get('q')||'',mode:p.get('mode')||'lexical',tags:{all:p.getAll('tag'),any:p.getAll('anyTag')},types:p.getAll('type'),...p.has('from')?{from:Number(p.get('from'))}:{},...p.has('to')?{to:Number(p.get('to'))}:{},limit:Number(p.get('limit')||20),cursor:p.get('cursor')||undefined}));}
    const conversationOwner=await ownerConversationRoutes(request,env,{owner:id,account:accountHandle,body,json});if(conversationOwner)return conversationOwner;
    if(path==='/api/collections')return json(request.method==='POST'?await object.collections(id,(await body(request)).name):await object.collections(id));
    if(path==='/api/contacts')return json(request.method==='POST'?await object.createContact(id,owner.account.handle,await body(request)): (await object.snapshot(id)).contacts);
    const quarantine=/^\/api\/contacts\/([a-f0-9-]{36})\/quarantine$/.exec(path);if(quarantine&&request.method==='POST')return json(await object.quarantineContact(id,quarantine[1],(await body(request)).quarantined));
    const contact=/^\/api\/contacts\/([a-f0-9-]{36})(?:\/(qr\.svg|url))?$/.exec(path);
    if(contact){if(request.method==='DELETE')return json(await object.revokeContact(id,contact[1]));const share=await object.contactURL(id,contact[1]);if(contact[2]==='qr.svg'){const svg=await QRCode.toString(share,{type:'svg',width:320,margin:2});return new Response(svg,{headers:{...privateHeaders,'Content-Type':'image/svg+xml','Content-Security-Policy':"default-src 'none'; sandbox"}});}return json({url:share});}
    const message=/^\/api\/messages\/([a-f0-9-]{36})(?:\/(download|presentation|postbacks\/prepare))?$/.exec(path);
    if(message){if(message[2]==='presentation'&&request.method==='POST')return json(await object.messagePresentation(id,message[1],await body(request,150000)));if(message[2]==='postbacks/prepare'&&request.method==='POST'){const account=await env.IDENTITY_REPOSITORY.get(id);if(account?.status!=='active')return json({error:'unauthorized'},401);return json(await object.messagePostbackPrepare(id,message[1],await body(request,20000),await federationEpoch(account)));}if(request.method==='PATCH'){const result=await object.updateMessage(id,message[1],await body(request));return json(result);}if(request.method==='DELETE'){const result=await object.deleteMessage(id,message[1]);return json(result);}if(message[2]){const payload=await object.messageBytes(id,message[1]);return new Response(Uint8Array.from(payload.bytes),{headers:{...privateHeaders,'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="message.bin"'}});}if([...url.searchParams.keys()].some(k=>k!=='revision')||url.searchParams.getAll('revision').length>1||url.searchParams.has('revision')&&!/^(0|[1-9][0-9]?)$/.test(url.searchParams.get('revision')))return json({error:'invalid_request'},400);return json(await object.message(id,message[1],url.searchParams.has('revision')?{revision:Number(url.searchParams.get('revision'))}:{}));}
    if(path==='/api/messages')return json((await object.snapshot(id)).messages);
    if(path==='/api/rules')return json(await object.rules(id,request.method==='PUT'? (await body(request)).rules:undefined));
    const rule=/^\/api\/rules\/([^/]+)$/.exec(path);if(rule&&request.method==='DELETE'){const rules=await object.rules(id);return json(await object.rules(id,rules.filter(r=>r.id!==rule[1])));}
    if(path==='/api/notifications')return json(await object.notificationPreferences(id,request.method==='PUT'?await body(request):undefined,Boolean(owner.account.verifiedEmail)));
    if(path==='/api/notifications/unsubscribe-link'&&request.method==='POST')return json({url:`${env.APP_ORIGIN}/unsubscribe#token=${encodeURIComponent(await object.unsubscribeLink(id))}`});
    if(path==='/api/notifications/subscribe'&&request.method==='POST')return json(await object.subscribe(id,await body(request)));
    const device=/^\/api\/notifications\/devices\/([^/]+)$/.exec(path);if(device&&request.method==='DELETE')return json(await object.removeSubscription(id,device[1]));
    if(path==='/api/resources')return json(request.method==='POST'?await object.addResource(id,await body(request)):await object.resources(id));
    const resource=/^\/api\/resources\/([a-f0-9-]{36})(?:\/(verify))?$/.exec(path);if(resource){if(request.method==='DELETE')return json(await object.deleteResource(id,resource[1]));if(resource[2]&&request.method==='POST')return json(await object.verifyResource(id,resource[1],await body(request)));}
    return json({error:'not_found'},404);
   }
   const artifact=publicArtifact(path),registry=['/artefacts/contracts','/artefacts/contracts/','/artefacts/contracts/index.html','/artefacts/contracts/index.json'].includes(path);
   if(artifact||registry){
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'public, max-age=300'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{...headers,'Cache-Control':'no-store',Allow:'GET, HEAD, OPTIONS'});
    if(path==='/artefacts/contracts')return new Response(null,{status:308,headers:{...headers,Location:'/artefacts/contracts/'}});
    const registryJSON=path.endsWith('/index.json'),target=artifact?.path??(registryJSON?'/artefacts/contracts/index.json':'/artefacts/contracts/index.html');
    let asset=await env.ASSETS.fetch(new Request(new URL(target,url),request));
    if(!asset.ok&&asset.status!==304)return json({error:'not_found'},asset.status===404?404:502,{'Access-Control-Allow-Origin':'*'});
    if(!artifact&&!registryJSON&&asset.status!==304)asset=await securePage(asset);
    const merged=new Headers(asset.headers);for(const [key,value]of Object.entries(headers))merged.set(key,value);
    if(artifact){merged.set('Content-Type',['preferences-fragment','manifest-profile'].includes(artifact.kind)?'application/json':'application/schema+json');merged.set('Content-Location',artifact.path);}
    else if(registryJSON)merged.set('Content-Type','application/json');
    return new Response(request.method==='HEAD'||asset.status===304?null:asset.body,{status:asset.status,headers:merged});
   }
   if(path.startsWith('/artefacts/contracts/')||path.startsWith('/docs/artefacts/'))return json({error:'not_found'},404,{'Access-Control-Allow-Origin':'*'});
   if(path==='/'&&['GET','HEAD'].includes(request.method)){const spanish=url.searchParams.getAll('lang').length===1&&url.searchParams.get('lang')==='es';const page=await securePage(await brandPage(await env.ASSETS.fetch(new Request(new URL(spanish?'/index.es.html':'/',url),request)),env));const headers=new Headers(page.headers);headers.set('Content-Language',spanish?'es':'en');if(page.ok)headers.set('Cache-Control','public, max-age=0, must-revalidate');return new Response(request.method==='HEAD'?null:page.body,{status:page.status,headers});}
   if(path==='/token-onboarding'){if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});const page=await securePage(await brandPage(await env.ASSETS.fetch(new Request(new URL('/console.html',url),request)),env));const headers=new Headers(page.headers);headers.set('X-Robots-Tag','noindex, nofollow');return new Response(request.method==='HEAD'?null:page.body,{status:page.status,headers});}
   if(path==='/console'){if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});const page=await securePage(await brandPage(await env.ASSETS.fetch(new Request(new URL('/console.html',url),request)),env));return request.method==='HEAD'?new Response(null,{status:page.status,headers:page.headers}):page;}
   if(path==='/recovery/setup'||path==='/recovery/restore'){const page=await env.ASSETS.fetch(new Request(new URL('/console.html',url),request));return securePage(await brandPage(page,env),true);}
   if(path==='/preferences'&&request.method==='GET'){const page=await env.ASSETS.fetch(new Request(new URL('/authorize.html',url),request));return securePage(await brandPage(page,env));}
   if(path.startsWith('/users/')||path==='/integrations/google/complete'||path==='/mcp/consent'||path==='/unsubscribe'||path==='/waitlist/confirm'||path==='/waitlist/leave'||path==='/email/confirm'||path==='/email/login'||path==='/device'||path==='/device/approve'||path.startsWith('/artefacts/')){
     if(path.startsWith('/artefacts/'))return env.ASSETS.fetch(request);
     const page=await env.ASSETS.fetch(new Request(new URL('/console.html',url),request));return securePage(await brandPage(page,env));
   }
   const asset=await env.ASSETS.fetch(request);
   const immutable=path.startsWith('/assets/');
   const secured=await securePage(immutable?asset:await brandPage(asset,env),path==='/recovery-kdf-worker.mjs'||/^\/assets\/scripts\/recovery-kdf-worker\.[a-f0-9]{10}\.js$/.test(path),immutable);
   if(/^\/assets\/scripts\/(?:message-frame-controller|message-sanitizer)\.[a-f0-9]{10}\.js$/.test(path)||/^\/packages\/sdk\/src\/(?:define|callback|identity)\.mjs$/.test(path)||/^\/assets\/packages\/sdk\/src\/(?:define|callback|identity)\.[a-f0-9]{10}\.js$/.test(path)){const headers=new Headers(secured.headers);headers.set('Access-Control-Allow-Origin','*');if(!immutable)headers.set('Cache-Control','no-cache');return new Response(secured.body,{status:secured.status,headers});}
   return secured;
  }catch(error){const pathname=new URL(request.url).pathname;const signedContact=signedContactPath.test(pathname);const cap=signedContact||/^(?:\/api\/messages|\/users\/[^/]+\/message|\/bindle\/rpc)$/.test(pathname)&&request.headers.get('Authorization')?.startsWith('Bearer ')||/^\/api\/conversations\/(?:identity|invitations|inbox)\/[a-f0-9-]{36}$/.test(pathname)||/^\/api\/conversations\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/join$/.test(pathname)||/^\/api\/conversations\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(pathname)&&request.headers.get('Authorization')?.startsWith('Bearer ');const headers=cap?{'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After','X-Robots-Tag':'noindex, nofollow, nosnippet',...(signedContact?{Vary:'Accept, Accept-Language'}:{})}:{};if(Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0)headers['Retry-After']=String(error.retryAfter);if(error instanceof IdentityFault||error instanceof MessagingFault||error instanceof StorageError||error.status)return json({error:error.code||'invalid_request',message:error.message,...error.code==='signup_capacity_reached'?{capacity:error.capacity}:{}},status(error),headers);if(env.LOCAL_DEVELOPMENT==='true')console.error('Local runtime exception:',error.name,error.message);return json({error:'internal_error',message:'We could not complete this request. Please try again.'},500,headers);}
  finally{engine?.dispose();}
 },
 async scheduled(controller,env,ctx){
   if(env.DEVELOPER_CONTACT_POPULATION)ctx.waitUntil(env.DEVELOPER_CONTACT_POPULATION.censusStep());
   // No automatic deletion until verified notification/recovery gates are implemented.
   // Account-object alarms perform safe cold shelving; lifecycle proposals are public docs.
 }
};
/** `keepPolicy`: a handler's own CSP stays authoritative; only the build's import-map hash joins its script-src. */
async function securePage(response,isolatedRecovery=false,immutable=false,{keepPolicy=false}={}){
 const own=keepPolicy?response.headers.get('Content-Security-Policy'):null;
 const headers=new Headers(response.headers),html=headers.get('Content-Type')?.includes('text/html');
 for(const [key,value]of Object.entries(privateHeaders))if(key!=='Cache-Control')headers.set(key,value);
 headers.set('Cache-Control',immutable&&response.ok?'public, max-age=31536000, immutable':html?'no-store':headers.get('Cache-Control')||'no-cache');
 let body=response.body,mapPolicy='';
 if(html){
  body=await response.text();
  const hash=/<meta name="bindle-import-map-csp" content="(sha256-[A-Za-z0-9+/]{43}=)">/.exec(body)?.[1];
  if(hash)mapPolicy=` '${hash}'`;
 }
 if(own){headers.set('Content-Security-Policy',mergeImportMapPolicy(own,mapPolicy));return new Response(body,{status:response.status,headers});}
 headers.set('Content-Security-Policy',isolatedRecovery?
  `default-src 'self'; script-src 'self'${mapPolicy} 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'self'`:
  `default-src 'self'; script-src 'self'${mapPolicy} https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'`);
 return new Response(body,{status:response.status,headers});
}

function mergeImportMapPolicy(policy,mapPolicy){return policy.split(';').map(part=>part.trim()).filter(Boolean).map(part=>mapPolicy&&/^script-src\s/i.test(part)&&!/'none'/.test(part)?part+mapPolicy:part).join('; ');}
/** Owner context for federation and entry owner steps: the tab's authenticated member cookie, else the legacy session. */
async function entryOwnerContext(request,env,local){
 const base={csrfToken:request.headers.get('X-CSRF-Token'),origin:request.headers.get('Origin')??env.APP_ORIGIN};
 // Cookieless routes (token, RPC, revocation, entry creation) never decrypt member cookies.
 if(!request.headers.has('Cookie'))return {...base,sessionToken:undefined};
 if(!accountCookiesEnabled(env))return {...base,sessionToken:sessionToken(request,local)};
 const cookies=parseAccountCookies(request,local),mutation=!['GET','HEAD','OPTIONS'].includes(request.method);
 // As in the /api/ block, a header-less write never falls back to the default member (review M1): it is anonymous,
 // so owner steps fail closed while cookie-indifferent routes (token, RPC) are unaffected.
 if(mutation&&hasAccountVault(cookies,local)&&request.headers.get('X-Bindle-Account')===null)return {...base,sessionToken:undefined};
 const member=await selectedAccountMember(request,env,local,cookies);
 if(member)return {...base,sessionToken:member.token,expectedOwner:member.owner,sessionContext:member.sessionContext};
 return {...base,sessionToken:hasAccountVault(cookies,local)?undefined:sessionToken(request,local)};
}
const INERT_ISLAND='<!doctype html><meta charset="utf-8"><title></title>';
/** Embed routes exist only with federation, mounted entries and their configured dedicated embed origin. */
const embedMounted=env=>env.FEDERATION_ENABLED==='true'&&Boolean(env.EMBED_ORIGIN)&&env.FEDERATION_ENTRIES?.embedOrigin===env.EMBED_ORIGIN;
/** The built shell: its template and build description, or null. Both are build outputs, fixed per deployment. */
async function embedShellBuild(env){
 try{
  const [page,meta]=await Promise.all([SHELL_TEMPLATE,SHELL_BUILD].map(path=>env.ASSETS.fetch(new Request(new URL(path,env.APP_ORIGIN),{method:'GET'}))));
  if(page.status!==200||!page.headers.get('Content-Type')?.includes('text/html')||meta.status!==200){await Promise.all([page.body?.cancel(),meta.body?.cancel()]);return null;}
  const template=await page.text(),build=shellBuild(await meta.json());return build&&template.split('{{CONFIG}}').length===2?{template,build}:null;
 }catch{return null;}
}
/** The components profile is offered only with embed routes mounted, DPoP for embed proofs and a built shell. */
async function embedShellMounted(env){return embedMounted(env)&&Boolean(env.FEDERATION_ENTRIES.dpop)&&await embedShellBuild(env)!==null;}
const embedHeaders={'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
/** Island picture sources: the provider's own static assets and operator-approved origins (packages/federation/embed-avatar.mjs). */
const embedAvatars=env=>({responseMs:AVATAR.responseMs,render:async(source,size)=>reencodeAvatar(await readAvatarSource(source,{issuer:env.APP_ORIGIN,assets:env.ASSETS,fetch:env.EMBED_AVATAR_FETCH,origins:avatarOrigins(env.EMBED_AVATAR_ORIGINS)}),size)});
/** Embed origin (components profile §2.2, §3; embed islands §3): cookieless, no CORS, nothing but islands. */
async function embedOriginRoutes(request,env,url,local){
 const path=url.pathname,deny=(status=404,error='not_found',extra={})=>new Response(JSON.stringify({error}),{status,headers:{...embedHeaders,'Cache-Control':'no-store','Content-Type':'application/json','Cross-Origin-Resource-Policy':'same-origin',...extra}});
 if(!embedMounted(env))return deny();
 const asset=/^\/embed\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:m?js|css)$/.test(path)&&!path.includes('..');
 if(path!=='/embed'&&path!=='/embed/sw.js'&&!asset&&!path.startsWith('/embed/api/'))return deny();
 // Immutable hashed assets are static; the shell and the API pass the same per-IP and per-network admission.
 if(!asset){
  const secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;if(!secret)return deny(503,'temporarily_unavailable');
  const remote=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),ip=await pseudonym(remote,secret),network=await pseudonym(subnet(remote),secret),lane=path.startsWith('/embed/api/')?'api':'shell';
  if(!await env.ABUSE.consume(`embed/${lane}/ip/${ip}`,{windowMs:60000,limit:lane==='api'?120:600})||!await env.ABUSE.consume(`embed/${lane}/subnet/${network}`,{windowMs:60000,limit:lane==='api'?400:2000}))return deny(429,'rate_limited',{'Retry-After':'60'});
 }
 if(path.startsWith('/embed/api/'))return await handleEmbedAPI(request,{authority:env.FEDERATION_AUTHORITY,embedOrigin:url.origin,enabled:env.FEDERATION_ENABLED==='true',avatars:embedAvatars(env)})??deny();
 if(!['GET','HEAD'].includes(request.method))return deny(405,'method_not_allowed',{Allow:'GET, HEAD'});
 if(path==='/embed')return embedShell(request,env,url);
 // Hashed assets and the service worker take no query: one URL, one body, so no cache (HTTP or service worker) can be
 // keyed on attacker-chosen variants.
 if(url.search)return deny();
 const file=await env.ASSETS.fetch(new Request(new URL(path,env.APP_ORIGIN),{method:'GET'}));
 if(file.status!==200){await file.body?.cancel();return deny();}
 const script=/\.m?js$/.test(path);
 // COEP on scripts: the island worker is created by a COEP shell and must itself be COEP (Chromium refuses it otherwise).
 // A script response's CSP governs only a worker it starts: the island worker talks to this origin and the issuer only.
 const headers=new Headers({...embedHeaders,'Content-Type':script?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cross-Origin-Resource-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});
 if(script)headers.set('Content-Security-Policy',`default-src 'none'; script-src 'self'; connect-src 'self'${asset?' '+env.APP_ORIGIN:''}; base-uri 'none'`);
 if(asset)headers.set('Cache-Control','public, max-age=31536000, immutable');else{headers.set('Cache-Control','no-cache');headers.set('Service-Worker-Allowed','/embed');}
 return new Response(request.method==='HEAD'?null:file.body,{status:200,headers});
}
/** One static shell per client: frame-ancestors are the client's redirect-URI origins; unknown clients get an inert page. */
async function embedShell(request,env,url){
 const keys=[...url.searchParams.keys()],id=url.searchParams.get('client'),client=keys.length===1&&keys[0]==='client'&&id?env.FEDERATION_ENTRIES.clients.get(id):undefined;
 let ancestors=[];try{ancestors=[...new Set((client?.redirectUris??[]).map(uri=>new URL(uri).origin))].filter(origin=>(/^https:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin)||env.LOCAL_DEVELOPMENT==='true'&&/^http:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin)));}catch{ancestors=[];}
 // Plain-HTTP parents (tamperable on the network path) never frame islands outside local development (serving review S3).
 const built=ancestors.length?await embedShellBuild(env):null;
 const body=built?fillShell(built.template,shellConfig({issuer:env.APP_ORIGIN,clientId:client.id,origins:ancestors,build:built.build})):INERT_ISLAND;
 const policy=built?shellPolicy({issuer:env.APP_ORIGIN,ancestors,scripts:built.build.scripts}):`default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors.length?ancestors.join(' '):"'none'"}`;
 const tag='"'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(policy+'\0'+body)))].map(b=>b.toString(16).padStart(2,'0')).join('')+'"';
 const headers=new Headers({...embedHeaders,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':policy,'Cache-Control':built||!client?'private, max-age=300':'no-store',ETag:tag,'Origin-Agent-Cluster':'?1','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin'});
 if(request.headers.get('If-None-Match')?.split(',').some(value=>value.trim()===tag))return new Response(null,{status:304,headers});
 return new Response(request.method==='HEAD'?null:body,{status:200,headers});
}
async function brandPage(response,env){if(!env.BRAND_NAME||env.BRAND_NAME==='3sln.me'||!response.headers.get('Content-Type')?.includes('text/html'))return response;const name=env.BRAND_NAME.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let html=await response.text();html=html.replace(/(<a\b[^>]*\bdata-bindle-brand-logo(?:="[^"]*")?(?=\s|>)[^>]*>)[\s\S]*?<\/a>/g,(_,open)=>`${open}<span>${name}</span></a>`);html=html.replace(/<title>3sln\.me[^<]*<\/title>/,()=>`<title>${name}</title>`).replaceAll('<span>3sln.me</span>',()=>`<span>${name}</span>`).replace('<img src="/branding/3sln-lockup.svg" alt="3sln" width="91" height="34"><span class="logo-suffix">.me</span>',()=>`<span>${name}</span>`).replaceAll('/icon.svg','/generic-icon.svg').replaceAll('/branding/3sln-avatar.png','/generic-icon.svg');return new Response(html,{status:response.status,headers:response.headers});}
function allowedMethods(path){
 if(['/api/integrations/google/start','/api/integrations/google/complete'].includes(path))return ['POST'];
 const automation=automationAllowedMethods(path);if(automation)return automation;
 const conversation=conversationAllowedMethods(path);if(conversation)return conversation;
 const beam=beamAllowedMethods(path);if(beam)return beam;
 if(path==='/api/auth/accounts')return ['GET'];
 if(path.startsWith('/api/auth/'))return ['POST'];
 if(['/api/billing/checkout','/api/billing/change-plan','/api/billing/cancel-change','/api/billing/portal'].includes(path))return ['POST'];
 if(/^\/api\/apps\/[a-f0-9-]{36}\/notifications$/.test(path))return ['PUT'];
 if(path==='/api/incoming')return ['GET','PATCH'];
 if(['/api/storage/usage','/api/billing','/api/messages/page','/api/search'].includes(path))return ['GET'];
 if(['/api/config','/api/session','/api/account'].includes(path))return ['GET'];
 if(path==='/api/developer-contact')return ['GET'];
 if(['/api/contact-links','/api/links/respond','/api/links/envelope'].includes(path))return ['POST'];
 if(path==='/api/tags/labels')return ['GET','PUT'];
 if(/^\/api\/contacts\/[^/]+\/intake$/.test(path))return ['GET','PUT'];
 if(/^\/api\/contacts\/[^/]+\/rotate$/.test(path)||/^\/api\/rules\/[^/]+\/restore$/.test(path))return ['POST'];
 if(['/api/views','/api/collections','/api/contacts','/api/resources'].includes(path))return ['GET','POST'];
 if(['/api/rules','/api/notifications','/api/search/preferences'].includes(path))return ['GET','PUT'];
 if(path==='/api/messages')return ['GET','POST'];
 if(['/api/notifications/subscribe','/api/notifications/unsubscribe','/api/notifications/unsubscribe-link'].includes(path))return ['POST'];
 if(/^\/api\/messages\/[^/]+$/.test(path))return ['GET','PATCH','DELETE'];
 if(/^\/api\/messages\/[^/]+\/download$/.test(path))return ['GET'];
 if(/^\/api\/messages\/[^/]+\/(presentation|postbacks|postbacks\/prepare)$/.test(path))return ['POST'];
 if(/^\/api\/contacts\/[^/]+$/.test(path))return ['GET','DELETE'];
 if(/^\/api\/contacts\/[^/]+\/(url|qr\.svg)$/.test(path))return ['GET'];
 if(/^\/api\/contacts\/[^/]+\/quarantine$/.test(path))return ['POST'];
 if(/^\/api\/resources\/[^/]+\/verify$/.test(path))return ['POST'];
 if(/^\/api\/resources\/[^/]+$/.test(path))return ['DELETE'];
 if(/^\/api\/views\/[A-Za-z0-9-]{1,64}$/.test(path))return ['PUT','DELETE'];
 if(/^\/api\/(rules|notifications\/devices)\/[^/]+$/.test(path))return ['DELETE'];
 return null;
}
// Owner-permitted profile for a verified link, behind a per-network bound; failures fall back to the generic card.
const previewProfile=(env,request,local)=>async canonical=>{if(!await limit(env,{operation:'contact-preview',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))throw new Error('limited');const recipient=await env.IDENTITY_REPOSITORY.get(canonical.sub);if(!recipient||recipient.status!=='active'||recipient.handle!==canonical.handle)throw new Error('unavailable');return accountHandle(env,canonical.sub).contactProfile(canonical.sub,canonical.link);};
function accountHandle(env,id){const stub=env.ACCOUNTS.get(id);return new Proxy({}, {get:(_,method)=>async(...args)=>{const result=await stub.invoke({method,args});if(result?.$fault){const error=new Error(result.$fault.message);Object.assign(error,{code:result.$fault.code,status:result.$fault.status||status(result.$fault),retryAfter:result.$fault.retryAfter});throw error;}return result;}});}
