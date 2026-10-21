// HTTP routes owned by Phase 0 (docs/architecture/app-engine.md §12): the badge sprite, legacy entry links, the web
// manifest, public configuration, contract artefacts, pages and static assets. `pages` always answers, so it is
// the router's final stage. Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {onboardingEnabled,onboardingOnly} from '../../identity/onboarding.mjs';
import {publicBadgePolicy,compileBadgeSprite} from '../../identity/badge-policy.mjs';
import {publicArtifact} from '../../core/public-contracts.mjs';
import {json,privateHeaders,signupEnabled,securePage,brandPage,passthrough} from './shared.mjs';
import {deviceAuthorizationEnabled} from '../device-grant.mjs';

async function badgePresentation(env){
 const policy=publicBadgePolicy(env);if(!policy.path)return policy;
 const sprite=await compileBadgeSprite(env);return {...policy,path:policy.path+'?v='+sprite.digest};
}
function providerConfig(env){return {hosted:{enabled:Boolean(env.ACCOUNTS)},google: {enabled:Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.KEY_ENCRYPTION_KEY),configured:Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),...env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET?{}:{reason:'Google Drive credentials are not configured on this service.'}},s3:{enabled:Boolean(env.KEY_ENCRYPTION_KEY)},webdav:{enabled:Boolean(env.KEY_ENCRYPTION_KEY),reason:'For your security, this service must approve the server you connect to.'},dropbox:{enabled:false,reason:'Dropbox is not available on this service yet.'},onedrive:{enabled:false,reason:'Microsoft OneDrive is not available on this service yet.'}};}

export const allowedMethods=path=>path==='/api/config'?['GET']:null;
export const stages={
 async public({request,env,url,path}){
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
   if(path==='/manifest.webmanifest'&&request.method==='GET'){const asset=await env.ASSETS.fetch(request);const manifest=await asset.json();const name=env.BRAND_NAME||'3sln.me';return new Response(JSON.stringify({...manifest,name,short_name:name,...name==='3sln.me'?{}:{icons:[{src:'/generic-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}}),{headers:{'Content-Type':'application/manifest+json','Cache-Control':'no-cache'}});}
 },
 async anonymous({env,path,local}){
   if(path==='/api/config')return json({origin:env.APP_ORIGIN,brand:{name:env.BRAND_NAME||(local?'3sln.me':'3sln.me'),host:new URL(env.APP_ORIGIN).host},termsVersion:env.TERMS_VERSION,turnstileSiteKey:env.TURNSTILE_SITE_KEY,localDevelopment:local,signupEnabled:signupEnabled(env),onboardingOnly:onboardingOnly(env),tokenOnboardingEnabled:onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true,badgePolicy:await badgePresentation(env),signupContactRequired:env.SIGNUP_CONTACT_REQUIRED==='true',emailSetupAvailable:env.EMAIL_SETUP_AVAILABLE===true,pushSetupAvailable:env.PUSH_AVAILABLE===true,passwordEnabled:true,passkeyEnabled:true,emailEnabled:env.EMAIL_AVAILABLE===true,notificationEmailEnabled:false,pushEnabled:false,vapidPublicKey:env.VAPID_PUBLIC_KEY,deviceAuthorizationEnabled:deviceAuthorizationEnabled(env),incrementalAuthorizationEnabled:env.INCREMENTAL_AUTH_ENABLED==='true'&&env.INCREMENTAL_AUTHORIZATION?.mounted===true,billingEnabled:env.BILLING_ENABLED==='true',activityV2Enabled:env.ACTIVITY_V2_ENABLED===true||env.ACTIVITY_V2_ENABLED==='true',searchEnabled:true,semanticSearchEnabled:env.SEMANTIC_SEARCH_ENABLED==='true',providers:providerConfig(env)});
 },
 async pages({request,env,url,path}){
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
   if(path==='/recovery/setup'||path==='/recovery/restore'){const page=await env.ASSETS.fetch(new Request(new URL('/console.html',url),request));return passthrough(securePage(await brandPage(page,env),true));}
   // Linked approval (LA3, behind DEVICE_AUTHORIZATION_ENABLED): /approve is the LA4 page, served from the
   // authorization document with no referrer, no framing and its own browsing context group; /device and
   // /device/approve redirect to it for one release (LA-13; browsers carry the fragment, the page drops any code).
   if(deviceAuthorizationEnabled(env)&&(path==='/approve'||path==='/device'||path==='/device/approve')){
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    if(path!=='/approve')return new Response(null,{status:302,headers:{...privateHeaders,Location:'/approve'}});
    const page=await securePage(await brandPage(await env.ASSETS.fetch(new Request(new URL('/authorize.html',url),request)),env)),headers=new Headers(page.headers);
    headers.set('Cross-Origin-Opener-Policy','same-origin');headers.set('X-Robots-Tag','noindex, nofollow');
    return new Response(request.method==='HEAD'?null:page.body,{status:page.status,headers});
   }
   if(path==='/preferences'&&request.method==='GET'){const page=await env.ASSETS.fetch(new Request(new URL('/authorize.html',url),request));return passthrough(securePage(await brandPage(page,env)));}
   if(path.startsWith('/users/')||path==='/integrations/google/complete'||path==='/mcp/consent'||path==='/unsubscribe'||path==='/waitlist/confirm'||path==='/waitlist/leave'||path==='/email/confirm'||path==='/email/login'||path==='/device'||path==='/device/approve'||path.startsWith('/artefacts/')){
     if(path.startsWith('/artefacts/'))return passthrough(env.ASSETS.fetch(request));
     const page=await env.ASSETS.fetch(new Request(new URL('/console.html',url),request));return passthrough(securePage(await brandPage(page,env)));
   }
   const asset=await env.ASSETS.fetch(request);
   const immutable=path.startsWith('/assets/');
   const secured=await securePage(immutable?asset:await brandPage(asset,env),path==='/recovery-kdf-worker.mjs'||/^\/assets\/scripts\/recovery-kdf-worker\.[a-f0-9]{10}\.js$/.test(path),immutable);
   if(/^\/assets\/scripts\/(?:message-frame-controller|message-sanitizer)\.[a-f0-9]{10}\.js$/.test(path)||/^\/packages\/sdk\/src\/(?:define|callback|identity)\.mjs$/.test(path)||/^\/assets\/packages\/sdk\/src\/(?:define|callback|identity)\.[a-f0-9]{10}\.js$/.test(path)){const headers=new Headers(secured.headers);headers.set('Access-Control-Allow-Origin','*');if(!immutable)headers.set('Cache-Control','no-cache');return new Response(secured.body,{status:secured.status,headers});}
   return secured;
 },
};
