import { IdentityAction, OwnerQuery, DeviceRequestQuery, IdentityFault } from '../identity/index.mjs';
import { enforceAbusePolicy } from '../core/abuse-policy.mjs';
import { MessagingFault, CONTACT_TOKEN_MIME } from '../messaging/index.mjs';
import { StorageError } from '../storage/policy.mjs';
import QRCode from 'qrcode';
import {verifyPolarWebhook} from '../billing/index.mjs';

const encoder=new TextEncoder();
const privateHeaders={ 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()' };
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...privateHeaders,'Content-Type':'application/json',...extra}});
const cookie=(token,local,maxAge=86400)=>`${local?'bindle_session':'__Host-bindle_session'}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local?'':'; Secure'}`;
function sessionToken(request,local){const name=local?'bindle_session':'__Host-bindle_session';for(const piece of (request.headers.get('Cookie')||'').split(';')){const [key,...rest]=piece.trim().split('=');if(key===name)return decodeURIComponent(rest.join('='));}return undefined;}
function deviceCookie(request,local){const name=local?'bindle_device':'__Host-bindle_device';for(const piece of (request.headers.get('Cookie')||'').split(';')){const [key,...rest]=piece.trim().split('=');if(key===name)return decodeURIComponent(rest.join('='));}return undefined;}
export function subnet(value){if(/^\d+\.\d+\.\d+\.\d+$/.test(value))return value.split('.').slice(0,3).join('.')+'/24';if(value.includes(':')){const [left,right='']=value.toLowerCase().split('::');const a=left?left.split(':'):[],b=right?right.split(':'):[];const groups=[...a,...Array(Math.max(0,8-a.length-b.length)).fill('0'),...b];return groups.slice(0,3).map(x=>parseInt(x||'0',16).toString(16)).join(':')+'::/48';}return 'unknown';}
async function pseudonym(value,secret){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function consume(env,key,windowMs,limit){return env.ABUSE.consume(key,{windowMs,limit});}
async function limit(env,{operation,remoteIP,handle,phase}){
  const secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY;if(!secret)return false;
  const ip=await pseudonym(remoteIP||'unknown',secret);const network=await pseudonym(subnet(remoteIP||'unknown'),secret);
  return enforceAbusePolicy({consume:window=>consume(env,window.key,window.windowMs,window.limit)},{operation,phase,ipHash:ip,subnetHash:network,handleHash:handle?await pseudonym(handle,secret):undefined});
}
async function turnstile(env,input){
  if(env.LOCAL_DEVELOPMENT==='true'&&input.token==='local-browser-test-token')return true;
  if(!env.TURNSTILE_SECRET_KEY)return false;
  try{const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:input.token,remoteip:input.remoteIP}),signal:AbortSignal.timeout(10000)});const result=await response.json();return result.success===true&&(env.LOCAL_DEVELOPMENT==='true'||result.hostname===input.hostname&&result.action===input.action);}catch{return false;}
}
async function identity(env){return env.IDENTITY_ENGINE();}
const authMethods={
 '/api/auth/signup':'signup','/api/auth/passkey/register/begin':'beginPasskeyRegistration','/api/auth/passkey/register':'registerPasskey','/api/auth/password/pending':'setPendingPassword',
 '/api/auth/recovery/download':'downloadRecovery','/api/auth/recovery/confirm':'confirmRecovery','/api/auth/login/password':'loginPassword','/api/auth/login/passkey/begin':'beginPasskeyLogin',
 '/api/auth/login/passkey/finish':'finishPasskeyLogin','/api/auth/recover':'recover','/api/auth/logout':'logout','/api/auth/email/start':'emailStart','/api/auth/email/confirm':'emailConfirm','/api/auth/email/login/start':'emailLoginStart','/api/auth/email/login/confirm':'emailLoginConfirm'
 ,'/api/auth/passkeys/begin':'credentialBegin','/api/auth/passkeys/finish':'credentialFinish','/api/auth/passkeys/remove':'removePasskey','/api/auth/passkeys/rename':'renamePasskey','/api/auth/devices/revoke':'revokeSession','/api/auth/devices/revoke-others':'revokeOtherSessions'
 ,'/api/auth/device/start':'createDeviceLogin','/api/auth/device/approve':'approveDeviceLogin','/api/auth/device/deny':'denyDeviceLogin','/api/auth/device/poll':'pollDeviceLogin','/api/auth/device/cancel':'cancelDeviceLogin'
 ,'/api/auth/email/login/settings':'configureEmailLogin'
};
async function body(request,max=100000){const content=request.headers.get('Content-Type')||'';if(!content.startsWith('application/json'))throw Object.assign(new Error('Use JSON for this request.'),{code:'json_required',status:415});const reader=request.body?.getReader();if(!reader)throw Object.assign(new Error('Request body required'),{status:400});let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Object.assign(new Error('Request is too large.'),{code:'body_too_large',status:413});}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{const result=JSON.parse(new TextDecoder().decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();return result;}catch{throw Object.assign(new Error('Request JSON must be an object.'),{code:'invalid_json',status:400});}}
function status(error){if(error.status)return error.status;return {unauthorized:401,csrf:403,forbidden:403,not_found:404,conflict:409,handle_unavailable:409,idempotency_conflict:409,quota_exceeded:429,account_quota_exceeded:429,rate_limited:429,email_unavailable:503,challenge_failed:403}[error.code]||400;}
function providerConfig(env){return {google: {enabled:false,configured:Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),reason:'Google Drive is not available on this service yet.'},s3:{enabled:Boolean(env.KEY_ENCRYPTION_KEY)},webdav:{enabled:Boolean(env.KEY_ENCRYPTION_KEY),reason:'For your security, this service must approve the server you connect to.'},dropbox:{enabled:false,reason:'Dropbox is not available on this service yet.'},onedrive:{enabled:false,reason:'Microsoft OneDrive is not available on this service yet.'}};}

export default {
 turnstile, rateLimit:limit,
 async fetch(request,env,execution){
  let engine;
  try{
   const url=new URL(request.url);const local=env.LOCAL_DEVELOPMENT==='true';
   if(url.origin!==env.APP_ORIGIN)return json({error:'invalid_origin',message:'Use the configured account domain.'},403);
   const path=url.pathname;const mutation=!['GET','HEAD','OPTIONS'].includes(request.method);
   if(path==='/api/billing/webhook'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    const verified=await verifyPolarWebhook(request,env);if(verified.ignored)return json({accepted:true,ignored:true});
    const account=await env.IDENTITY_REPOSITORY.get(verified.owner);if(!account||account.status!=='active')return json({error:'billing_account_unavailable'},409);
    return json(await accountHandle(env,verified.owner).billingWebhookVerified(verified.owner,verified));
   }
   if(path==='/manifest.webmanifest'&&request.method==='GET'){const asset=await env.ASSETS.fetch(request);const manifest=await asset.json();const name=env.BRAND_NAME||'3sln.me';return new Response(JSON.stringify({...manifest,name,short_name:name}),{headers:{'Content-Type':'application/manifest+json','Cache-Control':'no-cache'}});}
   const signedContact=/^\/users\/([a-z][a-z0-9_-]{2,31})\/contact\/([a-f0-9-]{36})$/.exec(path);
   if(signedContact||path==='/api/messages'&&request.method==='OPTIONS'){
    const publicHeaders={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, POST, OPTIONS','Access-Control-Allow-Headers':'Accept, Content-Type, Authorization, Idempotency-Key','X-Robots-Tag':'noindex, nofollow, nosnippet'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...privateHeaders,...publicHeaders}});
    if(signedContact){
     if(!['GET','HEAD','POST'].includes(request.method))return json({error:'method_not_allowed'},405,{...publicHeaders,Allow:'GET, HEAD, POST, OPTIONS'});
     if(request.url.length>18000)return json({error:'invalid_contact'},400,publicHeaders);
     const accept=request.headers.get('Accept')||'*/*';const wantsToken=accept.split(',').some(value=>value.trim().split(';')[0]===CONTACT_TOKEN_MIME&&!/;\s*q=0(?:\.0*)?(?:;|$)/.test(value));
     const wantsInfo=accept.split(',').some(value=>value.trim().split(';')[0]==='application/json');
     const wantsHTML=accept.includes('text/html')||accept.includes('*/*');
     if(request.method==='GET'&&wantsHTML&&!wantsToken&&!wantsInfo){const page=securePage(await brandPage(await env.ASSETS.fetch(new Request(new URL('/',url),request)),env));const headers=new Headers(page.headers);for(const [key,value]of Object.entries(publicHeaders))headers.set(key,value);return new Response(page.body,{status:page.status,headers});}
     if(!wantsToken&&!wantsInfo&&!wantsHTML&&request.method!=='POST')return json({error:'not_acceptable'},406,publicHeaders);
     if(!await limit(env,{operation:'message',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429,publicHeaders);
     let claims;try{const sig=url.searchParams.get('sig');if(!sig||sig.length>16384)throw new Error();claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sig.split('.')[1].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));}catch{return json({error:'unauthorized',message:'This contact link is invalid or no longer active.'},401,publicHeaders);}
     if(typeof claims.sub!=='string'||!/^[a-f0-9-]{36}$/.test(claims.sub))return json({error:'unauthorized'},401,publicHeaders);
     const recipient=await env.IDENTITY_REPOSITORY.get(claims.sub);if(!recipient||recipient.status!=='active'||recipient.handle!==signedContact[1])return json({error:'unauthorized'},401,publicHeaders);
     const handle=accountHandle(env,claims.sub);
     if(request.method==='HEAD'){await handle.inspectContact(claims.sub,request.url);return new Response(null,{headers:{...privateHeaders,...publicHeaders,'Content-Type':wantsToken?CONTACT_TOKEN_MIME:'text/html'}});}
     if(request.method==='GET'&&wantsInfo)return json(await handle.inspectContact(claims.sub,request.url),200,publicHeaders);
     if(request.method==='GET'){const minted=await handle.mintContact(claims.sub,request.url);return new Response(minted.token,{headers:{...privateHeaders,...publicHeaders,'Content-Type':CONTACT_TOKEN_MIME,'X-Token-Expires-At':String(minted.expiresAt)}});}
     const input=await multipartMessage(request);const result=await handle.deliverContact(claims.sub,request.url,input);execution?.waitUntil?.(handle.searchDrain(claims.sub,{limit:10}).catch(()=>{}));return json(result,202,publicHeaders);
    }
   }
   const allow=allowedMethods(path);if(allow&&!allow.includes(request.method))return json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:allow.join(', ')});
   if(path.startsWith('/api/demo'))return json({error:'not_found'},404);
   if(path==='/api/config')return json({origin:env.APP_ORIGIN,brand:{name:env.BRAND_NAME||(local?'3sln.me':'3sln.me'),host:new URL(env.APP_ORIGIN).host},termsVersion:env.TERMS_VERSION,turnstileSiteKey:env.TURNSTILE_SITE_KEY,localDevelopment:local,signupEnabled:local||env.RELEASE_READY==='true'&&Boolean(env.TURNSTILE_SECRET_KEY&&env.KEY_ENCRYPTION_KEY),passwordEnabled:true,passkeyEnabled:true,emailEnabled:env.EMAIL_AVAILABLE===true,notificationEmailEnabled:false,pushEnabled:false,vapidPublicKey:env.VAPID_PUBLIC_KEY,billingEnabled:env.BILLING_ENABLED==='true',searchEnabled:true,semanticSearchEnabled:false,providers:providerConfig(env)});
   if(path==='/api/notifications/unsubscribe'&&request.method==='POST'){
     const input=await body(request);const pieces=typeof input.token==='string'?input.token.split('.'):[];const owner=pieces.length===2?pieces[0]:input.owner;const token=pieces.length===2?pieces[1]:input.token;
     if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner)||typeof token!=='string'||token.length!==43)return json({error:'invalid_unsubscribe',message:'This unsubscribe link is invalid.'},400);
     return json(await env.ACCOUNTS.get(owner).unsubscribe(owner,token));
   }
   // Public delivery uses the contact bearer token, not the owner's session or CSRF.
   const landing=/^\/users\/([a-z][a-z0-9_-]{2,31})\/message$/.exec(path);
   if((path==='/api/messages'||landing)&&request.method==='POST'&&request.headers.get('Authorization')?.startsWith('Bearer ')){
    if(!await limit(env,{operation:'message',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited',message:'Please wait before sending another message.'},429);
    const input=await body(request,1500000);const token=request.headers.get('Authorization').slice(7);if(token.length>16384)return json({error:'unauthorized'},401);
    let claims;try{claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[1].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));}catch{return json({error:'unauthorized'},401);}
    // The unverified subject is used only to route; AccountObject cryptographically
    // verifies and intersects exact recorded claims before accepting any bytes.
    if(typeof claims.sub!=='string'||!/^[a-f0-9-]{36}$/.test(claims.sub))return json({error:'unauthorized'},401);
    const directory=env.IDENTITY_REPOSITORY;const recipient=await directory.get(claims.sub);
    if(!recipient||recipient.status!=='active'||landing&&recipient.handle!==landing[1])return json({error:'unauthorized'},401);
    const account=accountHandle(env,claims.sub);let bytes;
    if(typeof input.text==='string')bytes=encoder.encode(input.text);else if(typeof input.dataBase64==='string'){try{bytes=Uint8Array.from(atob(input.dataBase64),c=>c.charCodeAt(0));}catch{return json({error:'invalid_message'},400);}}else return json({error:'invalid_message'},400);
    if(bytes.length>1048576)return json({error:'body_too_large'},413);
    const result=await account.receive(claims.sub,token,{collection:input.collection,mimeType:input.mimeType,bytes:Array.from(bytes),idempotencyKey:input.idempotencyKey,senderMetadata:input.senderMetadata});execution?.waitUntil?.(account.searchDrain(claims.sub,{limit:10}).catch(()=>{}));return json(result,202,{'Access-Control-Allow-Origin':'*'});
   }
   if(mutation&&path.startsWith('/api/')&&request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
   if(path.startsWith('/api/')){
    engine=await identity(env);const context={origin:request.headers.get('Origin')||env.APP_ORIGIN,sessionToken:sessionToken(request,local),csrfToken:request.headers.get('X-CSRF-Token'),remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),deviceBinding:deviceCookie(request,local)};
    if(path==='/api/auth/device/start')context.deviceBinding=crypto.randomUUID()+crypto.randomUUID();
    if(path==='/api/auth/device/inspect')return json(await engine.query(new DeviceRequestQuery(await body(request),context)).peek());
    if(path==='/api/auth/device/qr'){
      const input=await body(request);let qr;try{qr=new URL(input.verificationUriComplete);}catch{return json({error:'invalid_request'},400);}if(qr.origin!==env.APP_ORIGIN||qr.pathname!=='/device'||qr.search||!qr.hash.startsWith('#request='))return json({error:'invalid_request'},400);return json({svg:await QRCode.toString(qr.href,{type:'svg',width:320,margin:2})});
    }
    if(authMethods[path]){
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      if(path==='/api/auth/signup'&&!local&&env.RELEASE_READY!=='true')return json({error:'release_gated',message:'Account creation is not open yet.'},503);
      const input=await body(request);const event=await engine.dispatch(new IdentityAction(authMethods[path],input,context)).next('result');const result=event.detail;
      const headers={};if(result.sessionToken){headers['Set-Cookie']=cookie(result.sessionToken,local);delete result.sessionToken;}if(path==='/api/auth/logout')headers['Set-Cookie']=cookie('',local,0);
      if(path==='/api/auth/device/start')headers['Set-Cookie']=`${local?'bindle_device':'__Host-bindle_device'}=${context.deviceBinding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300${local?'':'; Secure'}`;
      return json(result,200,headers);
    }
    let owner;try{owner=await engine.query(new OwnerQuery(context)).peek();}catch(error){if(path==='/api/session'&&error.code==='unauthorized')return json({authenticated:false});throw error;}
    if(path==='/api/session')return json({authenticated:true,...owner});
    const id=owner.account.id;const object=accountHandle(env,id);
    // Owner mutations independently require session CSRF, even when not an identity action.
    if(mutation&&context.csrfToken!==owner.csrfToken)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
    await object.touch(id);
    if(path==='/api/account'&&request.method==='GET')return json({...await object.snapshot(id),account:owner.account,credentials:owner.credentials,devices:owner.devices,audit:owner.audit,grants:[]});
    if(path==='/api/storage/usage')return json(await object.storageUsage(id));
    if(path==='/api/billing'&&request.method==='GET')return json(await object.billingStatus(id));
    if(path==='/api/billing/checkout'&&request.method==='POST')return json(await object.billingCheckout(id,(await body(request)).plan));
    if(path==='/api/billing/portal'&&request.method==='POST')return json(await object.billingPortal(id));
    if(path==='/api/messages/page'){const p=url.searchParams;return json(await object.messagePage(id,{limit:Number(p.get('limit')||100),...p.has('collection')?{collection:p.get('collection')}:{},...p.has('unread')?{unread:p.get('unread')==='true'}:{},...p.has('quarantined')?{quarantined:p.get('quarantined')==='true'}:{},cursor:p.get('cursor')||undefined}));}
    if(path==='/api/search'){const p=url.searchParams;if(!await limit(env,{operation:'search',remoteIP:context.remoteIP,handle:owner.account.handle}))return json({error:'rate_limited',message:'Please wait before searching again.'},429);return json(await object.omniSearch(id,{text:p.get('q')||'',mode:p.get('mode')||'lexical',tags:{all:p.getAll('tag'),any:p.getAll('anyTag')},types:p.getAll('type'),...p.has('from')?{from:Number(p.get('from'))}:{},...p.has('to')?{to:Number(p.get('to'))}:{},limit:Number(p.get('limit')||20),cursor:p.get('cursor')||undefined}));}
    if(path==='/api/collections')return json(request.method==='POST'?await object.collections(id,(await body(request)).name):await object.collections(id));
    if(path==='/api/contacts')return json(request.method==='POST'?await object.createContact(id,owner.account.handle,await body(request)): (await object.snapshot(id)).contacts);
    const quarantine=/^\/api\/contacts\/([a-f0-9-]{36})\/quarantine$/.exec(path);if(quarantine&&request.method==='POST')return json(await object.quarantineContact(id,quarantine[1],(await body(request)).quarantined));
    const contact=/^\/api\/contacts\/([a-f0-9-]{36})(?:\/(qr\.svg|url))?$/.exec(path);
    if(contact){if(request.method==='DELETE')return json(await object.revokeContact(id,contact[1]));const share=await object.contactURL(id,contact[1]);if(contact[2]==='qr.svg'){const svg=await QRCode.toString(share,{type:'svg',width:320,margin:2});return new Response(svg,{headers:{...privateHeaders,'Content-Type':'image/svg+xml','Content-Security-Policy':"default-src 'none'; sandbox"}});}return json({url:share});}
    const message=/^\/api\/messages\/([a-f0-9-]{36})(?:\/(download))?$/.exec(path);
    if(message){if(request.method==='PATCH'){const result=await object.updateMessage(id,message[1],await body(request));return json(result);}if(request.method==='DELETE'){const result=await object.deleteMessage(id,message[1]);return json(result);}if(message[2]){const payload=await object.messageBytes(id,message[1]);return new Response(Uint8Array.from(payload.bytes),{headers:{...privateHeaders,'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="message.bin"'}});}return json(await object.message(id,message[1]));}
    if(path==='/api/messages')return json((await object.snapshot(id)).messages);
    if(path==='/api/rules')return json(await object.rules(id,request.method==='PUT'? (await body(request)).rules:undefined));
    const rule=/^\/api\/rules\/([^/]+)$/.exec(path);if(rule&&request.method==='DELETE'){const rules=await object.rules(id);return json(await object.rules(id,rules.filter(r=>r.id!==rule[1])));}
    if(path==='/api/notifications')return json(await object.notificationPreferences(id,request.method==='PUT'?await body(request):undefined,Boolean(owner.account.verifiedEmail)));
    if(path==='/api/notifications/unsubscribe-link'&&request.method==='POST')return json({url:`${env.APP_ORIGIN}/unsubscribe#token=${encodeURIComponent(await object.unsubscribeLink(id))}`});
    if(path==='/api/notifications/subscribe'&&request.method==='POST')return json(await object.subscribe(id,await body(request)));
    const device=/^\/api\/notifications\/devices\/([^/]+)$/.exec(path);if(device&&request.method==='DELETE')return json(await object.removeSubscription(id,device[1]));
    if(path==='/api/resources')return json(request.method==='POST'?await object.addResource(id,await body(request)):await object.resources(id));
    const resource=/^\/api\/resources\/([a-f0-9-]{36})(?:\/(verify))?$/.exec(path);if(resource){if(request.method==='DELETE')return json(await object.deleteResource(id,resource[1]));if(resource[2]&&request.method==='POST')return json(await object.verifyResource(id,resource[1]));}
    return json({error:'not_found'},404);
   }
   if(path==='/.well-known/bindle/manifest.json')return json({error:'not_yet_conformant',message:'Federated OAuth service is not enabled.'},503);
   if(path==='/artefacts/contracts/object-storage/v1'){const target=new URL(request.headers.get('Accept')?.includes('text/html')?'/docs/spec/storage.html':'/artefacts/contracts/object-storage/v1.json',url);const asset=await env.ASSETS.fetch(new Request(target,request));const headers=new Headers(asset.headers);headers.set('Vary','Accept');if(!target.pathname.endsWith('.html'))headers.set('Content-Type','application/schema+json');return new Response(asset.body,{status:asset.status,headers});}
   if(path==='/recovery/setup'||path==='/recovery/restore'){const page=await env.ASSETS.fetch(new Request(new URL('/',url),request));return securePage(await brandPage(page,env),true);}
   if(path.startsWith('/users/')||path==='/unsubscribe'||path==='/email/confirm'||path==='/email/login'||path==='/device'||path==='/device/approve'||path.startsWith('/artefacts/')){
     if(path.startsWith('/artefacts/'))return env.ASSETS.fetch(request);
     const page=await env.ASSETS.fetch(new Request(new URL('/',url),request));return securePage(await brandPage(page,env));
   }
   return securePage(await brandPage(await env.ASSETS.fetch(request),env),path==='/recovery-kdf-worker.mjs');
  }catch(error){const pathname=new URL(request.url).pathname;const cap=/^\/users\/[^/]+\/contact\/[^/]+$/.test(pathname)||pathname==='/api/messages'&&request.headers.get('Authorization')?.startsWith('Bearer ');const headers=cap?{'Access-Control-Allow-Origin':'*','X-Robots-Tag':'noindex, nofollow, nosnippet'}:{};if(error instanceof IdentityFault||error instanceof MessagingFault||error instanceof StorageError||error.status)return json({error:error.code||'invalid_request',message:error.message},status(error),headers);if(env.LOCAL_DEVELOPMENT==='true')console.error('Local runtime exception:',error.name,error.message);return json({error:'internal_error',message:'We could not complete this request. Please try again.'},500,headers);}
  finally{engine?.dispose();}
 },
 async scheduled(controller,env,ctx){
   // No automatic deletion until verified notification/recovery gates are implemented.
   // Account-object alarms perform safe cold shelving; lifecycle proposals are public docs.
 }
};
function securePage(response,isolatedRecovery=false){const headers=new Headers(response.headers);for(const [k,v]of Object.entries(privateHeaders))headers.set(k,v);headers.set('Content-Security-Policy',isolatedRecovery?"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'self'":"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'");return new Response(response.body,{status:response.status,headers});}
async function brandPage(response,env){if(!env.BRAND_NAME||env.BRAND_NAME==='3sln.me'||!response.headers.get('Content-Type')?.includes('text/html'))return response;const name=env.BRAND_NAME.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let html=await response.text();html=html.replace(/<title>3sln\.me[^<]*<\/title>/,`<title>${name}</title>`).replaceAll('<span>3sln.me</span>',`<span>${name}</span>`);return new Response(html,{status:response.status,headers:response.headers});}
function allowedMethods(path){
 if(path.startsWith('/api/auth/'))return ['POST'];
 if(['/api/billing/checkout','/api/billing/portal'].includes(path))return ['POST'];
 if(['/api/storage/usage','/api/billing','/api/messages/page','/api/search'].includes(path))return ['GET'];
 if(['/api/config','/api/session','/api/account'].includes(path))return ['GET'];
 if(['/api/collections','/api/contacts','/api/resources'].includes(path))return ['GET','POST'];
 if(['/api/rules','/api/notifications'].includes(path))return ['GET','PUT'];
 if(path==='/api/messages')return ['GET','POST'];
 if(['/api/notifications/subscribe','/api/notifications/unsubscribe','/api/notifications/unsubscribe-link'].includes(path))return ['POST'];
 if(/^\/api\/messages\/[^/]+$/.test(path))return ['GET','PATCH','DELETE'];
 if(/^\/api\/messages\/[^/]+\/download$/.test(path))return ['GET'];
 if(/^\/api\/contacts\/[^/]+$/.test(path))return ['GET','DELETE'];
 if(/^\/api\/contacts\/[^/]+\/(url|qr\.svg)$/.test(path))return ['GET'];
 if(/^\/api\/contacts\/[^/]+\/quarantine$/.test(path))return ['POST'];
 if(/^\/api\/resources\/[^/]+\/verify$/.test(path))return ['POST'];
 if(/^\/api\/resources\/[^/]+$/.test(path))return ['DELETE'];
 if(/^\/api\/(rules|notifications\/devices)\/[^/]+$/.test(path))return ['DELETE'];
 return null;
}
function accountHandle(env,id){const stub=env.ACCOUNTS.get(id);return new Proxy({}, {get:(_,method)=>async(...args)=>{const result=await stub.invoke({method,args});if(result?.$fault){const error=new Error(result.$fault.message);Object.assign(error,{code:result.$fault.code,status:result.$fault.status||status(result.$fault)});throw error;}return result;}});}
async function multipartMessage(request){
 if(!request.headers.get('Content-Type')?.startsWith('multipart/form-data'))throw Object.assign(new Error('Send a multipart form with a message field.'),{code:'multipart_required',status:415});
 const reader=request.body?.getReader();if(!reader)throw Object.assign(new Error('Message body required.'),{status:400});const chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000){await reader.cancel();throw Object.assign(new Error('Message exceeds the request limit.'),{code:'body_too_large',status:413});}chunks.push(value);}
 const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
 let form;try{form=await new Request(request.url,{method:'POST',headers:request.headers,body:buffer}).formData();}catch{throw Object.assign(new Error('The message form is invalid.'),{code:'invalid_message',status:400});}
 const names=[...form.keys()];if(names.length>7||names.some(name=>!['collection','mimeType','idempotencyKey','message','subject','tags','title'].includes(name))||new Set(names).size!==names.length)throw Object.assign(new Error('The message fields are invalid.'),{code:'invalid_message',status:400});
 const message=form.get('message');let bytes,mimeType=form.get('mimeType')||'text/plain';
 if(typeof message==='string')bytes=encoder.encode(message);else if(message instanceof Blob){bytes=new Uint8Array(await message.arrayBuffer());if(message.type&&form.get('mimeType')&&message.type!==form.get('mimeType'))throw Object.assign(new Error('Message content type does not match.'),{code:'invalid_message',status:400});mimeType=form.get('mimeType')||message.type||'application/octet-stream';}else throw Object.assign(new Error('A message field is required.'),{code:'invalid_message',status:400});
 if(bytes.byteLength>1048576)throw Object.assign(new Error('Message exceeds one MiB.'),{code:'body_too_large',status:413});
 let tags=[];try{if(form.has('tags'))tags=JSON.parse(form.get('tags'));}catch{throw Object.assign(new Error('Tags must be a JSON list.'),{code:'invalid_message_metadata',status:400});}
 return {collection:form.get('collection'),mimeType,bytes:Array.from(bytes),idempotencyKey:form.get('idempotencyKey')||request.headers.get('Idempotency-Key'),senderMetadata:{subject:form.get('subject')||form.get('title')||'',tags}};
}
