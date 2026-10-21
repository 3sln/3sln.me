// HTTP routes of slice EV-2, event buses (docs/spec/events.md §3.1, §5 owner-only operations): the owner's built-in
// feeds. Mounted only with EVENT_BUSES_ENABLED; with the flag off nothing here answers, so the paths stay 404 and no
// allowlist reveals them. App access never uses these routes: apps publish and read through `event-bus/v1` RPC.
//   GET    /api/events/buses                     list
//   POST   /api/events/buses                     {url}: create the built-in feed for a registered manifest
//   GET    /api/events/buses/:id                 one feed
//   DELETE /api/events/buses/:id                 delete the feed (grants on it become unusable)
//   POST   /api/events/buses/:id/purge           purge every record (head kept; readers see a gap)
//   PUT    /api/events/buses/:id/retention       {seconds}
//   PUT    /api/events/buses/:id/history         {clientId}: let that app see earlier events (owner-choice feeds)
//   PUT    /api/events/buses/:id/features        {feature, read, publish}
import {json,body} from './shared.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const only=(request,...methods)=>methods.includes(request.method)?null:json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:methods.join(', ')});
const ACTIONS={purge:['POST','events.purge'],retention:['PUT','events.retention'],history:['PUT','events.history'],features:['PUT','events.feature']};

export const stages={
 async owner({request,env,path,object,id}){
  if((env.EVENT_BUSES_ENABLED!=='true'&&env.EVENT_BUSES_ENABLED!==true)||!path.startsWith('/api/events/buses'))return;
  const call=(operation,params={})=>object.eventBusOwner(id,{operation,...params});
  // Owner writes draw the owner's own work allowance (as other owner routes do); feed publishes never do (§9).
  const admit=async()=>{if(!['GET','HEAD','DELETE'].includes(request.method))await object.admitWork(id,{initialize:true});};
  if(path==='/api/events/buses'){
   const refused=only(request,'GET','POST');if(refused)return refused;
   if(request.method==='GET')return json({buses:await call('events.buses')});
   await admit();return json(await call('events.create',{input:await body(request,4096)}));
  }
  const match=/^\/api\/events\/buses\/([^/]+)(?:\/([a-z]+))?$/.exec(path);if(!match||!UUID.test(match[1]))return;
  const [,bus,action]=match;
  if(action===undefined){const refused=only(request,'GET','DELETE');if(refused)return refused;return json(await call(request.method==='GET'?'events.bus':'events.delete',{id:bus}));}
  if(!Object.hasOwn(ACTIONS,action))return;
  const [method,operation]=ACTIONS[action],refused=only(request,method);if(refused)return refused;
  await admit();const input=await body(request,4096);return json(await call(operation,{id:bus,input}));
 },
};
