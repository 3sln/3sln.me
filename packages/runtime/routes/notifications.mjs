// HTTP routes of slice 10, Notifications, push, app connections and MCP account tools (docs/architecture/app-engine.md §12): app-notification keys, unsubscribe, app connections, notification preferences and push devices.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {publicNotificationKeys} from '../app-notifications.mjs';
import {json,body,privateHeaders} from './shared.mjs';

export function allowedMethods(path){
 if(/^\/api\/apps\/[a-f0-9-]{36}\/notifications$/.test(path))return ['PUT'];
 if(path==='/api/notifications')return ['GET','PUT'];
 if(['/api/notifications/subscribe','/api/notifications/unsubscribe','/api/notifications/unsubscribe-link'].includes(path))return ['POST'];
 if(/^\/api\/notifications\/devices\/[^/]+$/.test(path))return ['DELETE'];
 return null;
}
// Notification preferences are protective; unsubscribing is never refused for capacity.
export const admission={
 protective:[{match:path=>path==='/api/notifications',test:()=>true}],
 exempt:path=>['/api/notifications/unsubscribe','/api/notifications/unsubscribe-link'].includes(path),
};
export const stages={
 async public({request,env,path}){
   if(path==='/.well-known/bindle/app-notification-keys.json'){
    const headers={...privateHeaders,'Content-Type':'application/jwk-set+json','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=60, must-revalidate'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'}});
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD, OPTIONS'});
    let value;try{value=publicNotificationKeys(env.APP_NOTIFICATION_PUBLIC_JWKS);}catch{return new Response(request.method==='HEAD'?null:JSON.stringify({error:'app_notifications_unavailable',message:'App message verification keys are not configured.'}),{status:503,headers:{...privateHeaders,'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});}
    return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers});
   }
 },
 async anonymous({request,env,path}){
   if(path==='/api/notifications/unsubscribe'&&request.method==='POST'){
     const input=await body(request);const pieces=typeof input.token==='string'?input.token.split('.'):[];const owner=pieces.length===2?pieces[0]:input.owner;const token=pieces.length===2?pieces[1]:input.token;
     if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner)||typeof token!=='string'||token.length!==43)return json({error:'invalid_unsubscribe',message:'This unsubscribe link is invalid.'},400);
     const identity=await env.IDENTITY_REPOSITORY.get(owner);if(!identity||identity.status!=='active')return json({error:'invalid_unsubscribe',message:'This unsubscribe link is invalid.'},400);
     return json(await env.ACCOUNTS.get(owner).unsubscribe(owner,token));
   }
 },
 async beforeActivity({request,path,id,object}){
    if(path==='/api/apps'&&request.method==='GET')return json({apps:await object.appConnections(id)});
    const appMessages=/^\/api\/apps\/([a-f0-9-]{36})\/notifications$/.exec(path);if(appMessages&&request.method==='PUT')return json(await object.appNotificationSettings(id,appMessages[1],await body(request,1024)));
    const appDisconnect=/^\/api\/apps\/([a-f0-9-]{36})$/.exec(path);if(appDisconnect&&request.method==='DELETE')return json(await object.appDisconnect(id,appDisconnect[1]));
 },
 async owner({request,env,path,owner,id,object}){
    if(path==='/api/notifications')return json(await object.notificationPreferences(id,request.method==='PUT'?await body(request):undefined,Boolean(owner.account.verifiedEmail)));
    if(path==='/api/notifications/unsubscribe-link'&&request.method==='POST')return json({url:`${env.APP_ORIGIN}/unsubscribe#token=${encodeURIComponent(await object.unsubscribeLink(id))}`});
    if(path==='/api/notifications/subscribe'&&request.method==='POST')return json(await object.subscribe(id,await body(request)));
    const device=/^\/api\/notifications\/devices\/([^/]+)$/.exec(path);if(device&&request.method==='DELETE')return json(await object.removeSubscription(id,device[1]));
 },
};
