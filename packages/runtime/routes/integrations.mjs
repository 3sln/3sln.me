// HTTP routes and AccountController slice of EXT-X7, resource discovery and brokered records
// (docs/spec/integrations.md §4, §5.6; docs/architecture/extensibility-design.md X7). Mounted only with
// INTEGRATIONS_ENABLED; record routes also need BROKERING_ENABLED (the domain answers not_found otherwise). With the
// flags off nothing here answers, so the paths stay 404. Applications never reach discovery: these are owner routes
// behind the session, CSRF and owner resolution of packages/runtime/http.mjs.
//   POST   /api/integrations/candidates                  {contracts, probe?}: connections able to offer them
//   POST   /api/integrations/discover                    {connection, contracts, text?, facets?, parent?, ids?, cursor?, limit?}
//   GET    /api/integrations/records[?connection=]       brokered records
//   POST   /api/integrations/records                     {connection, resource, binding, consumer, contracts?}: pick into a field
//   DELETE /api/integrations/records/:id                 detach (severance rows for X8)
//   POST   /api/integrations/records/:id/reconfirm       after revalidation marked it unavailable
//   POST   /api/integrations/records/:id/unassign        {grant}
//   POST   /api/integrations/records/:id/scope           the integration's scoping `describe` (§5.6)
//   POST   /api/integrations/connections/:id/revalidate  owner-opened connection revalidation (§4.4)
//
// Account slice (`account`, registered in packages/runtime/account/index.mjs): integrationsOwner (warm, in the gate:
// writes and revalidation), integrationsSearch (gate none: candidates and discovery are read-only egress, never held
// inside the single writer), and the internal integrationsSystem, integrationsMessagingDescribe (BB-C1b's
// MESSAGING_DESCRIBE port: `messagingDescribe(controller)`) and integrationsRevalidateDue (the account alarm hook).
// Ports from the adapter config: BROKERING_MINT(claims) -> {token} (mintAccessToken over the provider brokering key
// set) and INTEGRATION_EGRESS ({send}, createIntegrationEgress or a DNS-pinned equivalent); without them discovery and
// describe answer discovery_unavailable and descriptors stay recipient_unavailable. The change-hint endpoint
// (integrations §8) is not mounted: it needs an issuer-wide connection -> account directory and client-key egress.
import {createAppEngine,perform,read,operations,AppQuery} from '../../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../../app/providers.mjs';
import {AppConnections} from '../../apps/connections.mjs';
import {brokeredResourcesProvider,readConnection,integrationsFlag,brokeringFlag,BROKERED_OPERATIONS,BROKERED_OWNER_OPERATIONS,DescribeOccupant,RevalidateBrokeredRecords,BrokeredRecords} from '../../federation/brokered.mjs';
import {DiscoveryClient,sharedDiscoveryBudget} from '../../federation/resource-discovery.mjs';
import {validateDescribe} from '../../links/handoff.mjs';
import {json,body} from './shared.mjs';

export const BROKERED_ENGINE_OPERATIONS=operations(...BROKERED_OPERATIONS);
const SEARCH=['integrations.candidates','integrations.discover'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(code,message,status)=>{throw Object.assign(new Error(message),{code,status});};
const notFound=()=>fail('not_found','Not found.',404);
const engines=new WeakMap(),refusals=new WeakMap();
// Failed describes are remembered per (owner, seat incarnation) for a minute, so anonymous descriptor requests cost at
// most one integration call per minute on failure (successes are cached by the link handoff for an hour; X7-R2).
const REFUSAL_MS=60000,REFUSALS=1024;
function engineOf(c){
 let engine=engines.get(c);
 if(!engine){
  const issuer=c.config.APP_ORIGIN,reserved=[c.config.EMBED_ORIGIN].filter(v=>typeof v==='string'&&v).map(v=>{try{return new URL(v).hostname;}catch{return null;}}).filter(Boolean);
  const discovery=new DiscoveryClient({issuer,reserved,mint:typeof c.config.BROKERING_MINT==='function'?c.config.BROKERING_MINT:undefined,egress:typeof c.config.INTEGRATION_EGRESS?.send==='function'?c.config.INTEGRATION_EGRESS:undefined,budget:c.config.INTEGRATION_DISCOVERY_BUDGET??sharedDiscoveryBudget});
  engine=createAppEngine({providers:{clock:systemClock,random:cryptoRandom,audit:nullAudit,brokeredResources:brokeredResourcesProvider({store:c.metadata,discovery,issuer,integrations:integrationsFlag(c.config),brokering:brokeringFlag(c.config),...c.config.CONNECTION_SLOTS?{slots:c.config.CONNECTION_SLOTS}:{}})}});
  engines.set(c,engine);
 }
 return engine;
}
const run=(c,Operation,params)=>{const operation=new Operation(params);return operation instanceof AppQuery?read(engineOf(c),operation):perform(engineOf(c),operation);};
const shape=value=>{if(value!==undefined&&(value===null||typeof value!=='object'||Array.isArray(value)))fail('invalid_request','Unsupported integrations request.',400);return value===undefined?undefined:structuredClone(value);};
// Discovery health feeds the connection lifecycle (integrations §3.1 `degraded`); a failing report never fails the call.
async function report(c,owner,connection,health){
 if(!['degraded','recovered'].includes(health)||typeof connection!=='string')return;
 try{const now=await c.metadata.transaction(tx=>readConnection(tx,owner,connection));if(now)await c.connectionsSystem(owner,{operation:'connections.health',input:{connection,expectedGeneration:now.generation,degraded:health==='degraded'}});}catch{/* Health is advisory. */}
}
async function owned(c,owner,operation,list,{id,input}){
 const Operation=typeof operation==='string'&&list.includes(operation)?BROKERED_ENGINE_OPERATIONS[operation]:null;
 if(!integrationsFlag(c.config)||!Operation)notFound();
 const params={actor:{kind:'owner',owner},input:{...shape(input)??{},...id===undefined?{}:{[operation==='integrations.revalidate'?'connection':'record']:id}}};
 try{const result=await run(c,Operation,params);await report(c,owner,result?.connection??params.input.connection,result?.health);return result;}
 catch(error){await report(c,owner,params.input.connection,error?.health);throw error;}
}
/** BB-C1b MESSAGING_DESCRIBE port over a controller: `({owner, slot, occupant}) -> describe body`. */
export const messagingDescribe=c=>query=>c.integrationsMessagingDescribe(query);

export const account={
 methods:{
  async integrationsOwner(owner,{operation,id,input}={}){return owned(this,owner,operation,BROKERED_OWNER_OPERATIONS.filter(o=>!SEARCH.includes(o)),{id,input});},
  async integrationsSearch(owner,{operation,input}={}){if(await this.metadata.get('owner')!==owner)notFound();return owned(this,owner,operation,SEARCH,{input});},
  async integrationsSystem(owner,{operation,input}={}){
   const Operation=typeof operation==='string'&&Object.hasOwn(BROKERED_ENGINE_OPERATIONS,operation)?BROKERED_ENGINE_OPERATIONS[operation]:null;
   if(!integrationsFlag(this.config)||!Operation)notFound();
   return run(this,Operation,{actor:{kind:'system',owner},...input===undefined?{}:{input:shape(input)}});
  },
  // The occupant's `describe`, validated against bindlebox §2.3, for links/handoff.mjs. The occupancy port answers
  // first (account status, severance, exclusive selection); the seat it names must still be the one whose record is
  // described. Any failure is recipient_unavailable upstream. A changed ingress is recorded on the seat (C1b).
  async integrationsMessagingDescribe({owner,slot,occupant}={}){
   const down=()=>fail('recipient_unavailable','The recipient is unavailable.',503);
   if(!integrationsFlag(this.config)||!brokeringFlag(this.config)||typeof owner!=='string'||await this.metadata.get('owner')!==owner)down();
   const port=await this.linkSlotOccupant({owner,slot});if(!port||port.clientId!==occupant?.clientId||(occupant?.generation??null)!==port.generation)down();
   const found=await new AppConnections({metadata:this.metadata,origin:this.config.APP_ORIGIN,...this.config.CONNECTION_SLOTS?{slots:this.config.CONNECTION_SLOTS}:{}}).occupant(owner,slot);
   const seat=found.sever?null:found.occupants.find(o=>o.cnx===port.cnx);if(!seat||typeof seat.resource!=='string')down();
   // The ingress must sit on the occupant's own origin: the client_id origin, which X3 binds every endpoint to (X7-R5).
   let origin;try{origin=new URL(seat.clientId).origin;}catch{down();}if(typeof seat.origin==='string'&&seat.origin!==origin)down();
   const memo=refusals.get(this)??new Map(),key=`${owner}|${seat.cnx}`,now=Date.now();refusals.set(this,memo);if((memo.get(key)??0)>now)down();
   const refuse=()=>{memo.delete(key);while(memo.size>=REFUSALS)memo.delete(memo.keys().next().value);memo.set(key,now+REFUSAL_MS);down();};
   let result;try{result=await run(this,DescribeOccupant,{actor:{kind:'system',owner},input:{slot,seat:{seat:seat.seat,connection:seat.connection,clientId:seat.clientId,generation:seat.generation,resource:seat.resource,cnx:seat.cnx}}});}catch{refuse();}
   const valid=validateDescribe(result,{origin,allowLoopback:this.config.LOCAL_DEVELOPMENT==='true'});if(!valid)refuse();memo.delete(key);
   if(seat.ingress!==valid.ingress)try{await this.connectionsSystem(owner,{operation:'connections.set-ingress',input:{slot,seat:seat.seat,generation:seat.generation,ingress:valid.ingress}});}catch{/* Recorded on a later describe. */}
   return valid;
  },
  // Account alarm hook (§4.4 "at least daily"): revalidates connections whose records were last checked a day ago, or
  // whose records went stale with a resume/approval (descriptors never rebind from the public path).
  async integrationsRevalidateDue(owner,{now=Date.now(),limit=4}={}){
   if(!integrationsFlag(this.config)||!brokeringFlag(this.config)||await this.metadata.get('owner')!==owner)return {revalidated:0};
   const {records}=await run(this,BrokeredRecords,{actor:{kind:'system',owner}});const due=[...new Set(records.filter(r=>r.state==='stale'||now-(r.revalidatedAt??0)>=86400000).map(r=>r.connection))].slice(0,limit);let revalidated=0;
   for(const connection of due){try{const result=await run(this,RevalidateBrokeredRecords,{actor:{kind:'system',owner},input:{connection,reason:'scheduled'}});await report(this,owner,connection,result?.health);revalidated++;}catch{/* Budgets or egress: retried next time. */}}
   return {revalidated,pending:Math.max(0,new Set(records.map(r=>r.connection)).size-revalidated)};
  },
 },
 rpc:{integrationsOwner:{warm:true},integrationsSearch:{gate:'none'},integrationsMessagingDescribe:{gate:'none'}},
};

const only=(request,...methods)=>methods.includes(request.method)?null:json({error:'method_not_allowed',message:'This operation does not support that request method.'},405,{Allow:methods.join(', ')});
const RECORD_ACTIONS={reconfirm:'integrations.reconfirm',unassign:'integrations.unassign',scope:'integrations.scope-describe'};
export const stages={
 async owner({request,env,path,url,object,id}){
  if(!integrationsFlag(env)||!(path==='/api/integrations'||path.startsWith('/api/integrations/')))return;
  // Discovery is egress the owner causes; it draws the owner's work allowance like other owner writes.
  const admit=()=>object.admitWork(id,{initialize:true});
  if(path==='/api/integrations/candidates'||path==='/api/integrations/discover'){const refused=only(request,'POST');if(refused)return refused;await admit();return json(await object.integrationsSearch(id,{operation:path.endsWith('candidates')?'integrations.candidates':'integrations.discover',input:await body(request,8192)}));}
  if(path==='/api/integrations/records'){
   const refused=only(request,'GET','POST');if(refused)return refused;
   if(request.method==='GET'){const connection=(url??new URL(request.url)).searchParams.get('connection');if(connection!==null&&!UUID.test(connection))return json({error:'invalid_request',message:'Unsupported connection.'},400);return json(await object.integrationsOwner(id,{operation:'integrations.records',input:connection===null?undefined:{connection}}));}
   await admit();return json(await object.integrationsOwner(id,{operation:'integrations.register',input:await body(request,8192)}));
  }
  let match=/^\/api\/integrations\/records\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if(match&&UUID.test(match[1])){
   const [,record,action]=match;
   if(action===undefined){const refused=only(request,'DELETE');if(refused)return refused;return json(await object.integrationsOwner(id,{operation:'integrations.detach',id:record}));}
   if(!Object.hasOwn(RECORD_ACTIONS,action))return;const refused=only(request,'POST');if(refused)return refused;await admit();
   return json(await object.integrationsOwner(id,{operation:RECORD_ACTIONS[action],id:record,input:action==='unassign'?await body(request,1024):undefined}));
  }
  match=/^\/api\/integrations\/connections\/([^/]+)\/revalidate$/.exec(path);
  if(match&&UUID.test(match[1])){const refused=only(request,'POST');if(refused)return refused;await admit();return json(await object.integrationsOwner(id,{operation:'integrations.revalidate',id:match[1]}));}
 },
};
