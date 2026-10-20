// HTTP routes of slice 8, Search (docs/architecture/app-engine.md §12): search preferences and omni search.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {json,body,limit} from './shared.mjs';

export function allowedMethods(path){
 if(path==='/api/search')return ['GET'];
 if(path==='/api/search/preferences')return ['GET','PUT'];
 return null;
}
// Turning semantic search off is protective: it is never refused for capacity.
export const admission={protective:[{match:path=>path==='/api/search/preferences',test:change=>change.enabled===false}]};
export const stages={
 async owner({request,env,url,path,owner,id,object,context}){
    if(path==='/api/search/preferences'){if(request.method==='PUT')return json(await object.updateSearchPreferences(id,await body(request)));return json(await object.searchPreferences(id));}
    if(path==='/api/search'){const p=url.searchParams;if(!await limit(env,{operation:'search',remoteIP:context.remoteIP,handle:owner.account.handle}))return json({error:'rate_limited',message:'Please wait before searching again.'},429);return json(await object.omniSearch(id,{text:p.get('q')||'',mode:p.get('mode')||'lexical',tags:{all:p.getAll('tag'),any:p.getAll('anyTag')},types:p.getAll('type'),...p.has('from')?{from:Number(p.get('from'))}:{},...p.has('to')?{to:Number(p.get('to'))}:{},limit:Number(p.get('limit')||20),cursor:p.get('cursor')||undefined}));}
 },
};
