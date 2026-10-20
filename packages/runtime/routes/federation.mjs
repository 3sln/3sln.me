// HTTP routes of slice 13c, Federation and the MCP authority (docs/architecture/app-engine.md §12): the embed origin, federation protocol and authorization entry, MCP OAuth and owner MCP routes.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {accountCookiesEnabled,selectedAccountMember,parseAccountCookies,hasAccountVault,removedAccountCookies,accountFault,readAccountMember,defaultAccountOwner,removedMemberCookie,accountCookieName} from '../account-cookies.mjs';
import {CONTACT_INTENTS} from '../contact-preview.mjs';
import {IdentityAction} from '../../identity/index.mjs';
import {handleMcpPublic,handleMcpOwner,mcpPublicPath,mcpOwnerPath} from '../../mcp/http.mjs';
import {handleFederation} from '../../federation/http.mjs';
import {handleAuthorizationEntry,handleEmbedAPI} from '../federation-entry-http.mjs';
import {SHELL_TEMPLATE,SHELL_BUILD,shellBuild,shellConfig,fillShell,shellPolicy} from '../../federation/embed-shell.mjs';
import {AVATAR,avatarOrigins,readAvatarSource,reencodeAvatar} from '../../federation/embed-avatar.mjs';
import {handleObjectURL} from '../../storage/object-http.mjs';
import {UUID as uuidPattern} from '../../core/primitives.mjs';
import {json,body,cookie,sessionToken,pseudonym,subnet,identity,securePage,brandPage,passthrough} from './shared.mjs';

const encoder=new TextEncoder();
export const stages={
 async edge({request,env,url,local}){
   // The dedicated embed origin serves only the islands shell, its assets and the embed API (components profile §3).
   if(env.EMBED_ORIGIN&&url.origin===env.EMBED_ORIGIN&&url.origin!==env.APP_ORIGIN)return await embedOriginRoutes(request,env,url,local);
 },
 async public({request,env,path,local}){
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
    if(path.startsWith('/bindle/objects/'))return passthrough(handleObjectURL(request,{controller:env.FEDERATION_AUTHORITY,enabled:env.FEDERATION_ENABLED==='true'}));
    // Provider-owned authorization entry (adaptive sign-in §7): cookieless creation keyed by the caller's IP
    // pseudonym, owner steps resolved through the multi-account cookies, and its own strict document policy (F7).
    const entryResponse=await handleAuthorizationEntry(request,{entries:env.FEDERATION_ENTRIES,issuer:env.APP_ORIGIN,assets:env.ASSETS,allowInsecureLocalhost:local,enabled:env.FEDERATION_ENABLED==='true'&&Boolean(env.FEDERATION_ENTRIES),remote:()=>entryRemote,ownerContext:entryRequest=>entryOwnerContext(entryRequest,env,local),endSession:(entryRequest,context,subject)=>entryEndSession(entryRequest,env,local,subject)});
    if(entryResponse)return entryResponse.headers.get('Content-Type')?.includes('text/html')?passthrough(securePage(await brandPage(entryResponse,env),false,false,{keepPolicy:true})):entryResponse;
    const response=await handleFederation(request,{controller:env.FEDERATION_AUTHORITY,issuer:env.APP_ORIGIN,allowInsecureLocalhost:local,assets:env.ASSETS,enabled:env.FEDERATION_ENABLED==='true',ownerContext:ownerRequest=>entryOwnerContext(ownerRequest,env,local)});
    // Contact intents (links §6.4, core feature `intents.v1`): this host accepts `bindle_intent` on its console entry.
    // Entry routes and the components profile are advertised only while this adapter mounts them (review F8).
    if(response&&path==='/.well-known/bindle/manifest.json'&&request.method==='GET'&&response.ok){const manifest=await response.json(),entries=env.FEDERATION_ENTRIES?env.FEDERATION_ENTRIES.manifest({components:await embedShellMounted(env)}):{};return json({...manifest,features:{...manifest.features,...entries.features,'intents.v1':{intents:[...CONTACT_INTENTS],login_endpoint:`${env.APP_ORIGIN}/console`}},...entries.profiles?{profiles:{...manifest.profiles,...entries.profiles}}:{}},200,{'Access-Control-Allow-Origin':'*'});}
    if(response)return path==='/oauth/authorize'&&response.headers.get('Content-Type')?.includes('text/html')?passthrough(securePage(await brandPage(response,env))):response;
    return json({error:'not_found'},404);
   }
   if(mcpPublicPath(path)){
    if(env.MCP_ENABLED!=='true')return passthrough(handleMcpPublic(request,env));
    if(path==='/mcp/oauth/authorize'||path==='/mcp/oauth/token'){
     const remote=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;
     if(!secret)return json({error:'temporarily_unavailable',message:'Assistant connections are not configured.'},503);
     const ip=await pseudonym(remote,secret),network=await pseudonym(subnet(remote),secret),partition=parseInt(ip.slice(0,2),16)%16;
     if(!await env.ABUSE.consume(`mcp/oauth/ip/${ip}`,{windowMs:60000,limit:30})||!await env.ABUSE.consume(`mcp/oauth/subnet/${network}`,{windowMs:60000,limit:100})||!await env.ABUSE.consume(`mcp/oauth/service-v1-${partition}`,{windowMs:60000,limit:32}))return json({error:'rate_limited'},429);
    }
    return passthrough(handleMcpPublic(request,env));
   }
 },
 async beforeActivity({request,env,path,owner}){
    if(mcpOwnerPath(path))return passthrough(handleMcpOwner({request,env,owner,body}));
 },
};
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
/** Provider end-session for an authorization entry (auth.md D8; multi-account-sessions "App-requested account flows"):
 * ends only this browser's session for the entry's subject, never other saved accounts or other devices. The
 * subject's member cookie is authenticated by name; when present, the page must name exactly that member and send its
 * live CSRF, and the owner session is revoked before success. No session for the subject here is still a success. */
async function entryEndSession(request,env,local,subject){
 const owner=typeof subject==='string'&&subject.startsWith(env.APP_ORIGIN+'/entities/')?subject.slice(env.APP_ORIGIN.length+10):'';if(!uuidPattern.test(owner))throw accountFault('invalid_request',400);
 const context={origin:request.headers.get('Origin')||env.APP_ORIGIN,csrfToken:request.headers.get('X-CSRF-Token'),remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')};let member;
 if(accountCookiesEnabled(env)){
  const jar=parseAccountCookies(request,local);
  // Without any member cookie the legacy session still authenticates owner steps, so it is the one to end (review 5).
  if(!hasAccountVault(jar,local))return legacyEnd();
  try{member=await readAccountMember(env,jar,owner,local);}catch(error){return error.code==='invalid_account_cookie'?[removedMemberCookie(accountCookieName(owner,local),local)]:[];}
  if(request.headers.get('X-Bindle-Account')!==owner||request.headers.get('X-Bindle-Session-Context')!==member.sessionContext)throw accountFault('account_context_conflict',409);
  Object.assign(context,{sessionToken:member.token,expectedOwner:owner,sessionContext:member.sessionContext});return revoke(removedAccountCookies(owner,local,await defaultAccountOwner(env,jar,local).catch(()=>null)===owner));
 }
 return legacyEnd();
 async function legacyEnd(){const token=sessionToken(request,local);if(!token||token.split('.')[0]!==owner)return [];context.sessionToken=token;return revoke([cookie('',local,0)]);}
 // Owner revocation precedes success; a session that is already gone (or no longer usable) has nothing left to end.
 async function revoke(cookies){const engine=await identity(env);try{await engine.dispatch(new IdentityAction('logout',{},context)).next('result');}catch(error){if(error.code!=='unauthorized')throw error;}finally{engine.dispose();}return cookies;}
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
