import {Query} from '../shared/stack.mjs';
import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
import {connectionManifest,connectionLink} from './connections-port.mjs';
export const connectionsEnabled=s=>s.config?.integrationsEnabled===true;
export const connectionsModel=s=>connectionsEnabled(s)&&!s.offline&&s.session?.account?.id&&s.connectionsConsole?.owner===s.session.account.id&&s.connectionsConsole?.session===s.session.sessionContext&&s.connectionsConsole?.generation===(s.beamGeneration??0)?s.connectionsConsole:null;
const base=s=>connectionsModel(s)??{owner:s.session.account.id,session:s.session.sessionContext,generation:s.beamGeneration??0,connections:[],slots:[],offerings:[]};
const put=(r,ctx,p)=>publish(r,ctx,{connectionsConsole:{...base(snapshot(r)),...p}});
// Optional host focus port: moves focus to a rendered panel heading (or back to the console title) after a change.
const focus=(r,id)=>{try{r.browser?.focusConnections?.(id);}catch{}};
const fail=code=>{throw Object.assign(Error(code),{code});};
export class ConnectionsView extends Query {
 static deps=['state'];
 boot({state},{notify,engineFeed}){this.feed=engineFeed;this.paint=()=>notify(connectionsModel(state.snapshot()));engineFeed.addEventListener('browser-state-updated',this.paint);this.paint();}
 kill(){this.feed.removeEventListener('browser-state-updated',this.paint);}
}
// All intent logic runs in the engine. The UI only serializes fields and dispatches this Action.
export class ConnectionsIntent extends OwnerFlow {
 static deps={state:{write:true},api:{},browser:{},connectionsConsole:{}};
 async execute(r,ctx){if(!connectionsEnabled(snapshot(r)))return;return super.execute(r,ctx);}
 async perform(resources,ctx,d){
  const initial=snapshot(resources),session=initial.session.sessionContext,r={...resources,current:()=>resources.current()&&snapshot(resources).session?.sessionContext===session&&connectionsEnabled(snapshot(resources))},port=r.connectionsConsole;
  const options={api:r.api,owner:initial.session.account.id},checked=async fn=>{if(!r.current())fail('connection_changed');const result=await fn();if(!r.current())fail('connection_changed');return result;},call=(operation,input)=>checked(()=>port.owner({operation,...input===undefined?{}:{input}},options)),m=base(initial),v=d.values??{},a=d.action;
  const reload=async()=>{const result=await call('connections.list');put(r,ctx,{connections:result.connections,slots:result.slots,offerings:result.offerings??port.offerings,stale:false,confirm:null,picker:null,setup:null,error:null});};
  const change=async(operation,input)=>{put(r,ctx,{stale:true,confirm:null});await call(operation,input);put(r,ctx,{notice:'saved'});try{await reload();}catch{put(r,ctx,{error:'saved_stale'});}if(m.confirm)focus(r,'connections-title');};
  try{
   if(a==='reload'){await reload();return;}
   if(a==='close'){const back=m.picker&&m.setup?'connections-setup':'connections-title';put(r,ctx,{confirm:null,external:null,...m.picker&&m.setup?{}:{setup:null},picker:null,error:null});focus(r,back);return;}
   if(m.stale)fail('reload_required');
   if(a==='connect-built-in'){const def=m.offerings.find(x=>x.id===d.id);if(!def)fail('connection_changed');put(r,ctx,{confirm:{kind:'connect',id:def.id}});focus(r,'connections-review');return;}
   if(a==='confirm-built-in'){const def=m.offerings.find(x=>x.id===m.confirm?.id);if(m.confirm?.kind!=='connect'||!def||v.confirm!==true)fail('review_required');await change('connections.connect-built-in',{integration:def.id});return;}
   if(a==='connect-external'){
    // Metadata resolution is a trusted SSRF-safe port. Navigation starts OAuth; it never creates a connection locally.
    const client=await checked(()=>port.external({clientId:String(v.clientId??'')},options)),url=connectionLink(client.initiate_login_uri,client.clientId,initial.config.origin);
    if(!url)fail('invalid_client');put(r,ctx,{external:{url,host:new URL(url).host}});focus(r,'connections-external');return;
   }
   if(a==='setup'){const c=m.connections.find(c=>c.id===d.id);if(!c||c.state==='disconnected')fail('connection_changed');const setup=await checked(()=>port.setup({connection:c.id,generation:c.generation},options));put(r,ctx,{setup:{...setup,connection:c.id,generation:c.generation},picker:null,confirm:null});focus(r,'connections-setup');return;}
   if(a==='save-setup'){
    const setup=m.setup,c=m.connections.find(c=>c.id===setup?.connection),fragment=setup?.fragments.find(f=>f.schema.id===d.fragment);if(!c||c.generation!==setup.generation||!fragment||v.confirm!==true)fail('review_required');
    // Conversion/validation belongs to the setup provider, including resource references and shared-value review.
    // Never accept a schema, digest, revision, consumer, or connection from submitted form data.
    put(r,ctx,{stale:true});await checked(()=>port.saveSetup({connection:c.id,generation:c.generation,fragment:fragment.schema.id,digest:fragment.digest,expectedRevision:fragment.revision,values:v.fields??{},resources:setup.resources??{}},options));put(r,ctx,{setup:null,notice:'saved'});try{await reload();}catch{put(r,ctx,{error:'saved_stale'});}focus(r,'connections-title');return;
   }
   if(a==='picker'){
    const setup=m.setup,fragment=setup?.fragments.find(f=>f.schema.id===d.fragment),field=fragment?.schema.fields[d.field];if(field?.type!=='resource'||!(field.contracts?.length))fail('invalid_field');
    const result=await r.api.request('/api/integrations/candidates',{contracts:field.contracts});put(r,ctx,{picker:{fragment:d.fragment,field:d.field,contracts:field.contracts,candidates:result.candidates,items:[],parents:[]}});focus(r,'connections-picker');return;
   }
   if(a==='discover'){
    const p=m.picker,c=p?.candidates.find(c=>c.connection===(d.connection??p.connection));if(!c)fail('connection_changed');
    if(d.next&&!p.cursor)fail('resource_changed');if(d.parent&&!p.items.some(i=>i.id===d.parent&&i.container))fail('resource_changed');
    const parent=d.root?undefined:d.parent??p.parent,text=d.next?p.text:String(v.text??'').slice(0,200),cursor=d.next?p.cursor:undefined;
    const result=await r.api.request('/api/integrations/discover',{connection:c.connection,contracts:p.contracts,text,limit:20,...parent?{parent}:{},...cursor?{cursor}:{}});
    put(r,ctx,{picker:{...p,connection:c.connection,text,parent,cursor:result.cursor??null,items:result.items.slice(0,100)}});return;
   }
   if(a==='pick'){
    const p=m.picker,item=p?.items.find(i=>i.id===d.resource),setup=m.setup,c=m.connections.find(c=>c.id===setup?.connection);if(!item?.assignable||!c)fail('resource_changed');
    // X7 re-reads the item under authenticated discovery. Labels and endpoint claims never cross this write boundary.
    const record=await r.api.request('/api/integrations/records',{connection:p.connection,resource:item.id,binding:{fragment:p.fragment,field:p.field},consumer:{clientId:c.clientId},contracts:p.contracts});
    const key=p.fragment+'#'+p.field;put(r,ctx,{setup:{...setup,resources:{...setup.resources,[key]:record}},picker:null,notice:'picked'});focus(r,'connections-setup');return;
   }
   if(a==='slot-assign'){
    const slot=m.slots.find(s=>s.slot===d.slot),c=m.connections.find(c=>c.id===v.connection),eligible=c&&connectionManifest(c).extensions?.some(e=>e.slot===slot?.slot&&e.role==='occupant');
    if(!slot||!eligible||!['active','degraded'].includes(c.state))fail('connection_changed');
    const input={slot:slot.slot,connection:c.id,expectedRevision:slot.revision,...v.resource?{resource:String(v.resource)}:{}};
    if(slot.selection==='exclusive'&&slot.occupants.length){put(r,ctx,{confirm:{kind:'replace',input:{...input,replace:true},old:slot.occupants[0].name,new:c.name}});focus(r,'connections-review');return;}
    await change('connections.occupy',input);return;
   }
   if(a==='confirm-replace'){if(m.confirm?.kind!=='replace'||v.confirm!==true)fail('review_required');await change('connections.occupy',m.confirm.input);return;}
   if(a==='slot-remove'||a==='slot-up'){
    const slot=m.slots.find(s=>s.slot===d.slot),at=slot?.occupants.findIndex(o=>o.seat===d.seat);if(!slot||at<0)fail('slot_changed');
    if(a==='slot-remove'){await change('connections.vacate',{slot:slot.slot,seat:d.seat,expectedRevision:slot.revision});return;}
    if(slot.selection!=='ordered'||at===0)fail('invalid_order');const seats=slot.occupants.map(o=>o.seat);[seats[at-1],seats[at]]=[seats[at],seats[at-1]];await change('connections.reorder',{slot:slot.slot,seats,expectedRevision:slot.revision});return;
   }
   const c=m.connections.find(c=>c.id===d.id);if(!c)fail('connection_changed');
   if(a==='review-manifest'){if(!c.integration?.staged)fail('connection_changed');put(r,ctx,{confirm:{kind:'manifest',id:c.id,generation:c.generation,stagedRevision:c.integration.stagedRevision,name:c.name,manifest:c.integration.staged}});focus(r,'connections-review');return;}
   if(a==='confirm-manifest'){if(m.confirm?.kind!=='manifest'||m.confirm.id!==c.id||m.confirm.generation!==c.generation||m.confirm.stagedRevision!==c.integration?.stagedRevision||v.confirm!==true)fail('review_required');await change('connections.approve',{connection:c.id,expectedGeneration:c.generation,stagedRevision:m.confirm.stagedRevision});return;}
   if(a==='disconnect'){put(r,ctx,{confirm:{kind:'disconnect',id:c.id,generation:c.generation,name:c.name,slots:m.slots.filter(s=>s.occupants.some(o=>o.connection===c.id)).map(s=>s.title)}});focus(r,'connections-review');return;}
   if(a==='confirm-disconnect'){if(m.confirm?.kind!=='disconnect'||m.confirm.id!==c.id||m.confirm.generation!==c.generation||v.confirm!==true)fail('review_required');await change('connections.disconnect',{connection:c.id,expectedGeneration:c.generation});return;}
   if(a==='suspend'||a==='resume'){await change('connections.'+a,{connection:c.id,expectedGeneration:c.generation});return;}
   fail('invalid_request');
  }catch(error){put(r,ctx,{error:error.code??'unavailable'});}
 }
}
