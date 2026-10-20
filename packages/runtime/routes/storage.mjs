// HTTP routes of slice 6, Storage, quota, resources and Google Drive (docs/architecture/app-engine.md §12): the Google callback and connection, storage usage and resources.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {json,body,privateHeaders} from './shared.mjs';

export function allowedMethods(path){
 if(['/api/integrations/google/start','/api/integrations/google/complete'].includes(path))return ['POST'];
 if(path==='/api/storage/usage')return ['GET'];
 if(path==='/api/resources')return ['GET','POST'];
 if(/^\/api\/resources\/[^/]+\/verify$/.test(path))return ['POST'];
 if(/^\/api\/resources\/[^/]+$/.test(path))return ['DELETE'];
 return null;
}
export const stages={
 async public({request,url,path}){
   if(path==='/api/integrations/google/callback'){
    if(request.method!=='GET')return json({error:'method_not_allowed'},405,{Allow:'GET'});
    const fragment=new URLSearchParams();for(const key of ['state','code','error']){const values=url.searchParams.getAll(key);if(values.length>1||values.some(v=>v.length>(key==='code'?4096:200)||/[\u0000-\u001f\u007f]/.test(v)))return json({error:'invalid_callback'},400);if(values.length)fragment.set(key,values[0]);}
    return new Response(null,{status:303,headers:{...privateHeaders,Location:'/integrations/google/complete#'+fragment}});
   }
 },
 async beforeActivity({request,path,owner,id,object}){
    if(['/api/integrations/google/start','/api/integrations/google/complete'].includes(path)){const device=owner.devices?.find(d=>d.current);if(!device)return json({error:'unauthorized'},401);const input=await body(request);return json(await object[path.endsWith('/start')?'googleDriveStart':'googleDriveComplete'](id,device.id,input));}
 },
 async owner({request,path,id,object}){
    if(path==='/api/storage/usage')return json(await object.storageUsage(id));
    if(path==='/api/resources')return json(request.method==='POST'?await object.addResource(id,await body(request)):await object.resources(id));
    const resource=/^\/api\/resources\/([a-f0-9-]{36})(?:\/(verify))?$/.exec(path);if(resource){if(request.method==='DELETE')return json(await object.deleteResource(id,resource[1]));if(resource[2]&&request.method==='POST')return json(await object.verifyResource(id,resource[1],await body(request)));}
 },
};
