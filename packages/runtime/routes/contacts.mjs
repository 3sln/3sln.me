// HTTP routes of slice 3, Contacts and intake (docs/architecture/app-engine.md §12): link previews, signed contact links, contact links and intake, opener operations, developer contact.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {developerContactRoutes} from '../developer-contact.mjs';
import {CONTACT_PROFILE_MIME,CONTACT_INTAKE_MIME,CONTACT_DELIVERY_TOKEN,selectContactRepresentation} from '../../beaming/profile.mjs';
import {parseLinkQuery,parseLinkMeta} from '../../messaging/bindle-links.mjs';
import {contactPreview,injectPreview,oembed} from '../contact-preview.mjs';
import {CONTACT_DELIVERY_TOKEN_MIME} from '../../messaging/contact-endpoints.mjs';
import {CONTACT_TOKEN_MIME} from '../../messaging/index.mjs';
import QRCode from 'qrcode';
import {UUID as uuidPattern} from '../../core/primitives.mjs';
import {json,body,limit,subnet,jwsPart,securePage,brandPage,privateHeaders,accountHandle,signedContactPath} from './shared.mjs';
import {signedContactDelivery} from './delivery.mjs';

const locales=value=>(value||'').split(',').map(part=>part.split(';')[0].trim()).filter(tag=>/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(tag)).slice(0,16);
// Owner-permitted profile for a verified link, behind a per-network bound; failures fall back to the generic card.
const previewProfile=(env,request,local)=>async canonical=>{if(!await limit(env,{operation:'contact-preview',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))throw new Error('limited');const recipient=await env.IDENTITY_REPOSITORY.get(canonical.sub);if(!recipient||recipient.status!=='active'||recipient.handle!==canonical.handle)throw new Error('unavailable');return accountHandle(env,canonical.sub).contactProfile(canonical.sub,canonical.link);};

export function allowedMethods(path){
 if(path==='/api/developer-contact')return ['GET'];
 if(['/api/contact-links','/api/links/respond','/api/links/envelope'].includes(path))return ['POST'];
 if(/^\/api\/contacts\/[^/]+\/intake$/.test(path))return ['GET','PUT'];
 if(/^\/api\/contacts\/[^/]+\/rotate$/.test(path))return ['POST'];
 if(path==='/api/contacts')return ['GET','POST'];
 if(/^\/api\/contacts\/[^/]+$/.test(path))return ['GET','DELETE'];
 if(/^\/api\/contacts\/[^/]+\/(url|qr\.svg)$/.test(path))return ['GET'];
 if(/^\/api\/contacts\/[^/]+\/quarantine$/.test(path))return ['POST'];
 return null;
}
// Opener operations and quarantine are not refused for capacity.
export const admission={exempt:path=>['/api/links/respond','/api/links/envelope'].includes(path)||/^\/api\/contacts\/[^/]+\/quarantine$/.test(path)};
export const stages={
 async public({request,env,execution,url,path,local}){
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
     return signedContactDelivery({request,local,execution,sub,handle,publicHeaders});
    }
   }
 },
 async owner({request,env,path,owner,id,object,context}){
    const developerContactResponse=await developerContactRoutes({path,request,env,owner,object,accountHandle,body,json,limit,remoteIP:context.remoteIP});if(developerContactResponse)return developerContactResponse;
    if(path==='/api/contact-links')return json(await object.createContactLink(id,owner.account.handle,await body(request)));
    const intake=/^\/api\/contacts\/([a-f0-9-]{36})\/intake$/.exec(path);if(intake)return json(request.method==='PUT'?await object.updateContactIntake(id,intake[1],await body(request,32768)):await object.contactIntake(id,intake[1]));
    const rotation=/^\/api\/contacts\/([a-f0-9-]{36})\/rotate$/.exec(path);if(rotation){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);return json(await object.rotateContactChallenge(id,rotation[1]));}
    // Opener operations: explicit, authenticated, CSRF-checked and rate-limited per user (links §9).
    if(path==='/api/links/respond'||path==='/api/links/envelope'){if(!await limit(env,{operation:path==='/api/links/respond'?'link-respond':'link-envelope',remoteIP:context.remoteIP,handle:id}))return json({error:'rate_limited',message:'Please wait before trying again.'},429,{'Retry-After':'60'});const input=await body(request,32768);if(path==='/api/links/envelope')return json(await object.authorLinkEnvelope(id,input));if(Object.keys(input).join()!=='link'||typeof input.link!=='string')return json({error:'invalid_request'},400);return json(await object.signLinkResponse(id,owner.account.handle,input.link));}
    if(path==='/api/contacts')return json(request.method==='POST'?await object.createContact(id,owner.account.handle,await body(request)): (await object.snapshot(id)).contacts);
    const quarantine=/^\/api\/contacts\/([a-f0-9-]{36})\/quarantine$/.exec(path);if(quarantine&&request.method==='POST')return json(await object.quarantineContact(id,quarantine[1],(await body(request)).quarantined));
    const contact=/^\/api\/contacts\/([a-f0-9-]{36})(?:\/(qr\.svg|url))?$/.exec(path);
    if(contact){if(request.method==='DELETE')return json(await object.revokeContact(id,contact[1]));const share=await object.contactURL(id,contact[1]);if(contact[2]==='qr.svg'){const svg=await QRCode.toString(share,{type:'svg',width:320,margin:2});return new Response(svg,{headers:{...privateHeaders,'Content-Type':'image/svg+xml','Content-Security-Policy':"default-src 'none'; sandbox"}});}return json({url:share});}
 },
};
