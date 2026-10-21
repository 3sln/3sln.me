// HTTP routes of slice BB-C1a, core links (docs/architecture/messaging-extraction.md §2.5): owner views and
// revocation of app-issued links. Mounted only with BINDLEBOX_ENABLED; with the flag off nothing here answers, so
// the paths stay 404 and no allowlist reveals them. The contact landing, inspection, oEmbed and audience-response
// routes stay in their current modules until the cutover moves them here.
//
// BB-C1b: the `messaging-address` descriptor (bindlebox §2.3). `GET <contact link>` with exactly
// `Accept: application/vnd.bindlebox.ingress+json` answers the current occupant's ingress descriptor. It runs in the
// `edge` stage because the contacts module answers every contact path in `public`; it therefore checks the app origin
// itself, matches only that exact media type (everything else falls through untouched), and exists only with
// BINDLEBOX_ENABLED. Responses are no-store, no-referrer, credentialless CORS, never vary on cookies, and every
// failure after link verification is the uniform 503 recipient_unavailable with Retry-After 3600.
import {json,body,limit,privateHeaders,accountHandle,signedContactPath} from './shared.mjs';
import {parseLinkQuery,parseLinkMeta} from '../../links/envelope.mjs';
import {DESCRIPTOR_MEDIA_TYPE} from '../../links/types.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const bad=()=>json({error:'invalid_request',message:'Choose a valid link query.'},400);
const only=(request,method)=>request.method===method?null:json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:method});

const descriptorHeaders={...privateHeaders,'Access-Control-Allow-Origin':'*','X-Robots-Tag':'noindex, nofollow'};
const unavailable=()=>json({error:'recipient_unavailable',message:'The recipient is unavailable.'},503,{...descriptorHeaders,'Retry-After':'3600'});
const linkInvalid=()=>json({error:'link_invalid',message:'The link is not valid.'},401,descriptorHeaders);
const wantsDescriptor=request=>{const accept=(request.headers.get('Accept')||'').split(',').map(part=>part.split(';')[0].trim().toLowerCase()).filter(Boolean);return accept.length===1&&accept[0]===DESCRIPTOR_MEDIA_TYPE;};
export async function descriptorRoute({request,env,url,local}){
 if(env.BINDLEBOX_ENABLED!=='true'||url.origin!==env.APP_ORIGIN)return;
 const path=url.pathname;// the edge stage runs before the router sets `path`
 const contact=signedContactPath.exec(path);if(!contact||!['GET','HEAD','OPTIONS'].includes(request.method)||(request.method!=='OPTIONS'&&!wantsDescriptor(request)))return;
 if(request.method==='OPTIONS'){if(request.headers.get('Access-Control-Request-Method')!=='GET'||(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').some(h=>h.trim()&&h.trim()!=='accept'))return;return new Response(null,{status:204,headers:{...descriptorHeaders,'Access-Control-Allow-Methods':'GET, HEAD','Access-Control-Allow-Headers':'Accept'}});}
// Rate limit by network first, before any identity lookup, so handle/subject pairs are not an unthrottled oracle (LH-4).
 if(!await limit(env,{operation:'contact-preview',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited',message:'Too many requests. Try again later.'},429,{...descriptorHeaders,'Retry-After':'60'});
 let query;try{query=parseLinkQuery(request.url);}catch{return json({error:'link_malformed',message:'The link is malformed.'},400,descriptorHeaders);}
 if(query.form!=='link')return linkInvalid();if(query.data!==undefined)return json({error:'link_malformed',message:'The link is malformed.'},400,descriptorHeaders);
 let sub;try{const claims=parseLinkMeta(query.meta).claims;if(claims.aud===env.APP_ORIGIN+path)sub=claims.sub;}catch{}
 if(typeof sub!=='string'||!/^[a-f0-9-]{36}$/.test(sub))return linkInvalid();
 const recipient=await env.IDENTITY_REPOSITORY?.get(sub);if(!recipient||recipient.status!=='active'||recipient.handle!==contact[1])return linkInvalid();
 let descriptor;try{descriptor=await accountHandle(env,sub).linkDescriptor(sub,`${env.APP_ORIGIN}${path}?bindle_meta=${query.meta}`);}
 catch(error){if(error?.code==='link_invalid')return linkInvalid();if(error?.code==='link_malformed')return json({error:'link_malformed',message:'The link is malformed.'},400,descriptorHeaders);return unavailable();}
 return new Response(request.method==='HEAD'?null:JSON.stringify(descriptor),{status:200,headers:{...descriptorHeaders,'Content-Type':DESCRIPTOR_MEDIA_TYPE}});
}

export const stages={
 edge:descriptorRoute,
 async owner({request,env,url,path,object,id}){
  if(env.BINDLEBOX_ENABLED!=='true'||!path.startsWith('/api/links'))return;
  if(path==='/api/links'){
   const refused=only(request,'GET');if(refused)return refused;
   const p=url.searchParams;if([...p.keys()].some(k=>!['type','cursor','limit'].includes(k)||p.getAll(k).length!==1))return bad();
   const limit=p.has('limit')?Number(p.get('limit')):undefined;if(limit!==undefined&&!Number.isSafeInteger(limit))return bad();
   return json(await object.listLinks(id,{...p.has('type')?{type:p.get('type')}:{},...p.has('cursor')?{cursor:p.get('cursor')}:{},...limit===undefined?{}:{limit}}));
  }
  if(path==='/api/links/changes'){
   const refused=only(request,'GET');if(refused)return refused;
   const p=url.searchParams;if([...p.keys()].some(k=>k!=='since'||p.getAll(k).length!==1))return bad();
   const since=p.has('since')?Number(p.get('since')):0;if(!Number.isSafeInteger(since))return bad();
   return json(await object.linkChanges(id,{since}));
  }
  const revoke=/^\/api\/links\/([^/]+)\/revoke$/.exec(path);
  if(revoke){
   const refused=only(request,'POST');if(refused)return refused;
   if(!UUID.test(revoke[1])||Object.keys(await body(request,128)).length)return bad();
   return json(await object.revokeLink(id,revoke[1]));
  }
 },
};
