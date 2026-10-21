// HTTP routes of slice BB-C1a, core links (docs/architecture/messaging-extraction.md §2.5): owner views and
// revocation of app-issued links. Mounted only with BINDLEBOX_ENABLED; with the flag off nothing here answers, so
// the paths stay 404 and no allowlist reveals them. The contact landing, inspection, oEmbed and audience-response
// routes stay in their current modules until the cutover moves them here.
import {json,body} from './shared.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const bad=()=>json({error:'invalid_request',message:'Choose a valid link query.'},400);
const only=(request,method)=>request.method===method?null:json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:method});

export const stages={
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
