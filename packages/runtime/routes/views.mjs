// HTTP routes of slice 1, Views and tags (docs/architecture/app-engine.md §12): saved Views, incoming, tag rules and labels; each route dispatches one engine operation.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {SavedViews,CreateView,UpdateView,DeleteView,IncomingPage,UpdateIncoming} from '../../app/domains/views.mjs';
import {TagRules,ReplaceRules,DeleteRule,RestoreDefaultRule,TagLabels,SetTagLabel} from '../../app/domains/tags.mjs';
import {json,body} from './shared.mjs';

export function allowedMethods(path){
 if(path==='/api/incoming')return ['GET','PATCH'];
 if(path==='/api/tags/labels')return ['GET','PUT'];
 if(/^\/api\/rules\/[^/]+\/restore$/.test(path))return ['POST'];
 if(path==='/api/views')return ['GET','POST'];
 if(path==='/api/rules')return ['GET','PUT'];
 if(/^\/api\/views\/[A-Za-z0-9-]{1,64}$/.test(path))return ['PUT','DELETE'];
 if(/^\/api\/rules\/[^/]+$/.test(path))return ['DELETE'];
 return null;
}
export const stages={
 async owner({request,url,path,dispatch}){
    if(path==='/api/tags/labels')return json(request.method==='PUT'?await dispatch(SetTagLabel,{input:await body(request,4096)}):await dispatch(TagLabels));
    const restoreRule=/^\/api\/rules\/([^/]{1,200})\/restore$/.exec(path);if(restoreRule){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);return json(await dispatch(RestoreDefaultRule,{id:decodeURIComponent(restoreRule[1])}));}
    if(path==='/api/views')return json(request.method==='POST'?await dispatch(CreateView,{input:await body(request)}):await dispatch(SavedViews));
    const savedView=/^\/api\/views\/([A-Za-z0-9-]{1,64})$/.exec(path);if(savedView)return json(await dispatch(request.method==='DELETE'?DeleteView:UpdateView,{id:savedView[1],input:await body(request)}));
    if(path==='/api/incoming'&&request.method==='PATCH')return json(await dispatch(UpdateIncoming,{input:await body(request)}));
    if(path==='/api/incoming'){const p=url.searchParams;if([...p.keys()].some(k=>!['view','viewRevision','filter','sort','limit','cursor'].includes(k)||p.getAll(k).length!==1))throw Object.assign(new Error('Choose a valid View query.'),{code:'invalid_view',status:400});let filter;if(p.has('filter'))try{filter=JSON.parse(p.get('filter'));}catch{throw Object.assign(new Error('Choose a valid View filter.'),{code:'invalid_view',status:400});}return json(await dispatch(IncomingPage,{input:{...p.has('view')?{view:p.get('view')}:{},...p.has('viewRevision')?{viewRevision:Number(p.get('viewRevision'))}:{},...p.has('filter')?{filter}:{},...p.has('sort')?{sort:p.get('sort')}:{},...p.has('limit')?{limit:Number(p.get('limit'))}:{},...p.has('cursor')?{cursor:p.get('cursor')}:{}}}));}
    if(path==='/api/rules')return json(request.method==='PUT'?await dispatch(ReplaceRules,{input:{rules:(await body(request)).rules}}):await dispatch(TagRules));
    const rule=/^\/api\/rules\/([^/]+)$/.exec(path);if(rule&&request.method==='DELETE')return json(await dispatch(DeleteRule,{id:rule[1]}));
 },
};
