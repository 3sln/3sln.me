// HTTP routes of slice 2, Messages and collections (docs/architecture/app-engine.md §12): prepared postback dispatch, message pages, collections, message reads, updates, presentations and downloads.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {federationEpoch} from '../federation.mjs';
import {verifyPreparedPostbackToken} from '../message-postbacks.mjs';
import {json,body,limit,privateHeaders,accountHandle} from './shared.mjs';

export function allowedMethods(path){
 if(path==='/api/messages/page')return ['GET'];
 if(path==='/api/collections')return ['GET','POST'];
 if(path==='/api/messages')return ['GET','POST'];
 if(/^\/api\/messages\/[^/]+$/.test(path))return ['GET','PATCH','DELETE'];
 if(/^\/api\/messages\/[^/]+\/download$/.test(path))return ['GET'];
 if(/^\/api\/messages\/[^/]+\/(presentation|postbacks|postbacks\/prepare)$/.test(path))return ['POST'];
 return null;
}
export const stages={
 async public({request,env,path,local}){
   const postbackDispatch=/^\/api\/messages\/([a-f0-9-]{36})\/postbacks$/.exec(path);
   if(postbackDispatch){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if(request.headers.has('Cookie')||request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'unauthorized',message:'Use a prepared cookie-free submission.'},403);
    const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}\.[0-9]{13}\.[A-Za-z0-9_-]{43})$/)?.[1];
    if(!token)return json({error:'unauthorized',message:'This prepared submission is invalid or expired.'},401);
    const ownerId=await verifyPreparedPostbackToken(env,token,postbackDispatch[1]);
    const remoteIP=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown');
    if(!await limit(env,{operation:'message-postback-dispatch',remoteIP}))return json({error:'rate_limited'},429,{'Retry-After':'60'});
    const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);
    return json(await accountHandle(env,ownerId).messagePostbackDispatch(ownerId,postbackDispatch[1],token));
   }
 },
 async owner({request,env,url,path,id,object}){
    if(path==='/api/messages/page'){const p=url.searchParams;return json(await object.messagePage(id,{limit:Number(p.get('limit')||100),...p.has('collection')?{collection:p.get('collection')}:{},...p.has('unread')?{unread:p.get('unread')==='true'}:{},...p.has('quarantined')?{quarantined:p.get('quarantined')==='true'}:{},cursor:p.get('cursor')||undefined}));}
    if(path==='/api/collections')return json(request.method==='POST'?await object.collections(id,(await body(request)).name):await object.collections(id));
    const message=/^\/api\/messages\/([a-f0-9-]{36})(?:\/(download|presentation|postbacks\/prepare))?$/.exec(path);
    if(message){if(message[2]==='presentation'&&request.method==='POST')return json(await object.messagePresentation(id,message[1],await body(request,150000)));if(message[2]==='postbacks/prepare'&&request.method==='POST'){const account=await env.IDENTITY_REPOSITORY.get(id);if(account?.status!=='active')return json({error:'unauthorized'},401);return json(await object.messagePostbackPrepare(id,message[1],await body(request,20000),await federationEpoch(account)));}if(request.method==='PATCH'){const result=await object.updateMessage(id,message[1],await body(request));return json(result);}if(request.method==='DELETE'){const result=await object.deleteMessage(id,message[1]);return json(result);}if(message[2]){const payload=await object.messageBytes(id,message[1]);return new Response(Uint8Array.from(payload.bytes),{headers:{...privateHeaders,'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="message.bin"'}});}if([...url.searchParams.keys()].some(k=>k!=='revision')||url.searchParams.getAll('revision').length>1||url.searchParams.has('revision')&&!/^(0|[1-9][0-9]?)$/.test(url.searchParams.get('revision')))return json({error:'invalid_request'},400);return json(await object.message(id,message[1],url.searchParams.has('revision')?{revision:Number(url.searchParams.get('revision'))}:{}));}
    if(path==='/api/messages')return json((await object.snapshot(id)).messages);
 },
};
