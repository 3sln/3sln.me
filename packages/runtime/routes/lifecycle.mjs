// HTTP routes of slice 9, Lifecycle and retention (docs/architecture/app-engine.md §12): account lifecycle status and reactivation.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {json,body} from './shared.mjs';

export function allowedMethods(path){
 if(path==='/api/account/lifecycle')return ['GET'];
 if(path==='/api/account/lifecycle/reactivate')return ['POST'];
 return null;
}
export const stages={
 async beforeActivity({request,path,owner,id,object}){
    // Restricted lifecycle routes stay reachable while suspended and run before activity is recorded.
    if(path==='/api/account/lifecycle')return json(await object.lifecycleStatus(id));
    if(path==='/api/account/lifecycle/reactivate'){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);const current=owner.devices?.find(device=>device.current);if(!current)return json({error:'unauthorized'},401);return json(await object.lifecycleReactivate(id,{kind:'owner-session',owner:id,authenticatedAt:current.createdAt}));}
 },
};
