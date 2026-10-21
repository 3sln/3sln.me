// CX-3: owner-only browser domain over the existing account APIs. No demo routes.
import {Query} from '../shared/stack.mjs';
import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
import {EVENT_BUS_CONTRACT} from '../../../../packages/consent/reviewed-contracts.mjs';
export const accessEnabled=s=>s.config?.integrationsEnabled===true||s.config?.INTEGRATIONS_ENABLED===true||s.config?.INTEGRATIONS_ENABLED==='true';
export const accessBusesEnabled=s=>accessEnabled(s)&&(s.config?.eventBusesEnabled===true||s.config?.EVENT_BUSES_ENABLED===true||s.config?.EVENT_BUSES_ENABLED==='true');
const incremental=s=>s.config?.incrementalAuthEnabled===true||s.config?.INCREMENTAL_AUTH_ENABLED===true||s.config?.INCREMENTAL_AUTH_ENABLED==='true';
const list=value=>Array.isArray(value)?value:[],host=value=>{try{return new URL(value).host;}catch{return '';}};
const current=s=>accessEnabled(s)&&!s.offline&&s.session?.account&&s.access?.owner===s.session.account.id&&s.access?.generation===(s.beamGeneration??0)&&s.access?.session===s.session.sessionContext?s.access:null;
const update=(r,ctx,patch)=>publish(r,ctx,{access:{...snapshot(r).access,...patch}});
const stamp=s=>({owner:s.session.account.id,session:s.session.sessionContext,generation:s.beamGeneration??0});
export const accessLink=(kind,id)=>'/console#access/'+kind+'/'+encodeURIComponent(id);
export function accessRoute(value){try{const match=/^(?:\/console#|\/#|#)?access\/(app|fragment|resource|bus)\/(.+)$/.exec(value);return match?{kind:match[1],id:decodeURIComponent(match[2])}:null;}catch{return null;}}
export function accessProjection(s){const a=current(s);return a?{...a,locale:s.locale==='es'?'es':'en',busy:s.busy,error:s.error,buses:accessBusesEnabled(s)?a.buses:[],groups:accessBusesEnabled(s)?a.groups:a.groups.filter(g=>!g.bus),preferences:accessBusesEnabled(s)?a.preferences:a.preferences.filter(p=>!p.schema?.slot?.bus),busEnabled:accessBusesEnabled(s)}:null;}
export class AccessView extends Query {
 static deps=['state','browser'];
 boot({state,browser},{notify,engineFeed}){this.feed=engineFeed;this.refresh=()=>{this.cancelDeadline?.();const value=accessProjection(state.snapshot()),now=browser.now?.();if(value&&Number.isFinite(now)){value.ending=Object.fromEntries(Object.entries(value.ending??{}).filter(([,row])=>new Date(row.accessEndsBy).getTime()>now));const next=Math.min(...Object.values(value.ending).map(row=>new Date(row.accessEndsBy).getTime()));if(Number.isFinite(next)&&browser.delay)this.cancelDeadline=browser.delay(this.refresh,Math.min(2147483647,Math.max(1,next-now)));}notify(value);};engineFeed.addEventListener('browser-state-updated',this.refresh);this.refresh();}
 kill(){this.cancelDeadline?.();this.feed.removeEventListener('browser-state-updated',this.refresh);}
}
function build({grants,preferences,apps,buses,subscriptions,suppressions,contracts},catalog,s){
 const manifests=Object.fromEntries(preferences.map(p=>[p.fragment,{schema:p.schema}])),resources=Object.fromEntries(preferences.flatMap(p=>list(p.resources).map(r=>[r.id,{...r,storageHost:r.storageHost??(['hosted','bindle'].includes(r.provider)?host(s.config?.origin):null)}]))),directory=Object.fromEntries(grants.map(g=>[g.clientId,{reviewed:g.client?.reviewed===true}])),readers={};
 for(const g of grants)if(Object.values(g.methods??{}).some(cs=>cs[EVENT_BUS_CONTRACT]?.includes('read')))readers[g.fragment]=[...readers[g.fragment]??[],{app:g.clientId,capabilities:grants.filter(x=>x.clientId===g.clientId).flatMap(x=>Object.values(x.methods??{}).flatMap(cs=>Object.entries(cs).flatMap(([contract,methods])=>methods.map(method=>({contract,method})))))}];
 const facts={manifests,resources,apps:directory,contracts,readers},groups=[];
 for(const grant of grants){const preference=preferences.find(p=>p.fragment===grant.fragment),schema=preference?.schema,bus=!!schema?.slot?.bus,cards=[];
  if(bus&&!accessBusesEnabled(s))continue;
  for(const field of grant.fields??[]){const spec=schema?.fields?.[field],methods=grant.methods?.[field]??{},resourceIds=list(grant.resources?.[field]),inputs=spec?.type==='resource'?Object.entries(methods).map(([contract,methods])=>contract===EVENT_BUS_CONTRACT&&bus&&methods.some(m=>['read','publish'].includes(m))?{kind:'bus',fragment:grant.fragment,mode:methods.includes('publish')?methods.includes('read')?'readwrite':'write':'read'}:{kind:'contract',contract,methods}):[{kind:'settings',fragment:grant.fragment,fields:[field]}];
   if(spec?.type==='resource'&&!inputs.length)inputs.push({kind:'reference',fragment:grant.fragment,fields:[field]});
   for(const [index,input]of inputs.entries()){let card=null;try{if(!spec||!schema||preference.digest&&grant.digest!==preference.digest)throw Error('stale');card=catalog.describe(facts,{...input,app:grant.clientId,locale:{account:s.locale}});}catch{/* Keep the grant revocable when its description is unavailable. */}
    cards.push({id:grant.id+':'+field+':'+index,field,title:spec?.title??field,card,resourceIds,resources:resourceIds.map(id=>resources[id]??{id,label:host(id)}),methods:input.methods??[],scopes:grant.resourceScopes?.[field]??{}});
   }
  }
  const app=apps.find(a=>a.clientId===grant.clientId);groups.push({id:grant.id,clientId:grant.clientId,appName:grant.client?.reviewed===true?grant.client.name??host(grant.clientId):host(grant.clientId),fragment:grant.fragment,title:schema?.title??host(grant.fragment),since:grant.approvedAt??grant.createdAt,lastUsed:grant.lastUsedAt,connection:app?.id,bus,cards,grant});
 }
 return {groups,apps:apps.map(a=>({...a,name:directory[a.clientId]?.reviewed===true?a.name:host(a.clientId)})),preferences,resources:Object.values(resources),buses:buses.map(b=>({...b,storageHost:host(s.config?.origin)})),subscriptions,suppressions,canReview:typeof catalog.review==='function',canTransition:typeof catalog.transition==='function'};
}
async function load(r,ctx){const s=snapshot(r),a=current(s);if(!accessEnabled(s))return;
 update(r,ctx,{phase:'loading',confirmation:null});
 try{const [g,p,a,c,b]=await Promise.all([r.api.get('/api/grants'),r.api.get('/api/preferences'),r.api.get('/api/apps'),r.api.get('/api/connections/contracts').catch(()=>({contracts:{}})),accessBusesEnabled(s)?r.api.get('/api/events/buses'):Promise.resolve({buses:[]})]);
  const blocked=incremental(s)?await r.api.get('/api/incremental/suppressions'):[],blocks=list(blocked.suppressions??blocked),clients=[...new Set([...list(g.grants).map(g=>g.clientId),...list(a.apps).map(a=>a.clientId)])],suppressions=blocks.flatMap(row=>clients.filter(id=>r.accessCatalog.site(id)===row.site).map(clientId=>({...row,clientId})));
  const buses=list(b.buses),subscriptions={};if(accessBusesEnabled(s))await Promise.all(buses.map(async bus=>{try{subscriptions[bus.id]=await r.api.get('/api/events/buses/'+encodeURIComponent(bus.id)+'/subscriptions');}catch{subscriptions[bus.id]=null;}}));
  update(r,ctx,{...stamp(s),...build({grants:list(g.grants).filter(g=>g.active!==false),preferences:list(p.preferences),apps:list(a.apps??a),buses,subscriptions,suppressions,contracts:c.contracts??{}},r.accessCatalog,s),phase:'ready',confirmation:null,stale:false});
 }catch(error){update(r,ctx,{phase:'error',stale:true,...!a?{groups:[],apps:[],preferences:[],resources:[],buses:[],suppressions:[]}: {}});throw error;}
}
function target(a,d){if(d.operation==='revoke')return a.groups.find(g=>g.id===d.id);if(['disconnect','suspend','resume'].includes(d.operation))return a.apps.find(g=>g.id===d.id);if(['purge','delete','feature'].includes(d.operation))return a.buses.find(g=>g.id===d.id);if(d.operation==='unblock')return a.suppressions.find(g=>g.id===d.id);}
const fingerprint=value=>JSON.stringify(value);
export class AccessAction extends OwnerFlow {
 static deps={state:{write:true},api:{},browser:{},accessCatalog:{}};
 constructor(kind,detail={}){super(detail);this.kind=kind;}
 async execute(r,ctx){if(!accessEnabled(snapshot(r)))return;return super.execute(r,ctx);}
 async perform(resources,ctx,d){const s=snapshot(resources),session=s.session.sessionContext,r={...resources,current:()=>resources.current()&&snapshot(resources).session?.sessionContext===session&&accessEnabled(snapshot(resources))},a=current(s);
  if(this.kind==='open'){publish(r,ctx,{access:{...stamp(s),groups:[],apps:[],resources:[],preferences:[],buses:[],suppressions:[],route:d.route??{kind:'apps'},phase:'loading',canReview:false},error:''});await load(r,ctx);return;}
  if(!a)return;
  if(this.kind==='refresh'){await load(r,ctx);return;}
  if(this.kind==='navigate'){if(d.route?.kind==='bus'&&!accessBusesEnabled(s))return;update(r,ctx,{route:d.route,confirmation:null});return;}
  if(this.kind==='cancel'){update(r,ctx,{confirmation:null});r.browser.restoreFocus?.();return;}
  if(a.phase!=='ready'||a.stale)return;
  if(this.kind==='review'){if(typeof r.accessCatalog.review!=='function'||!a.groups.some(g=>g.clientId===d.clientId)&&!a.apps.some(g=>g.clientId===d.clientId)||d.fragment&&!a.groups.some(g=>g.clientId===d.clientId&&g.fragment===d.fragment))return;await r.accessCatalog.review({clientId:d.clientId,fragment:d.fragment,owner:a.owner,api:r.api});return;}
  if(['purge','delete','feature'].includes(d.operation)&&!accessBusesEnabled(s))return;
  if(['suspend','resume'].includes(d.operation)&&typeof r.accessCatalog.transition!=='function')return;
  if(d.operation==='unblock'&&!incremental(s))return;
  const found=target(a,d);if(d.operation==='suspend'&&!['active','degraded','configuring'].includes(found?.state??found?.status)||d.operation==='resume'&&found?.state!=='suspended')return;if(d.operation==='feature'&&!found?.features?.[d.feature])return;if(!found)throw Error('Refresh access before making this change.');
  if(this.kind==='confirm'){update(r,ctx,{confirmation:{operation:d.operation,id:d.id,feature:d.feature,target:found,fingerprint:fingerprint(found)}});r.browser.focusAccessConfirmation?.();return;}
  const c=a.confirmation;if(this.kind!=='apply'||d.confirmed!==true||!c||c.id!==d.id||c.operation!==d.operation||c.feature!==d.feature||c.fingerprint!==fingerprint(found))throw Error('Review and confirm what will change.');
  update(r,ctx,{confirmation:null,phase:'saving',stale:true});let result;
  try{if(d.operation==='revoke')result=await r.api.request('/api/grants/'+encodeURIComponent(found.id),{},'DELETE');
  else if(d.operation==='disconnect')result=await r.api.request('/api/apps/'+encodeURIComponent(found.id),{},'DELETE');
  else if(['suspend','resume'].includes(d.operation))result=await r.accessCatalog.transition({operation:d.operation,connection:found.id,expectedGeneration:found.generation,owner:a.owner,api:r.api});
  else if(d.operation==='unblock'){if(!incremental(s))return;result=await r.api.request('/api/incremental/suppressions/'+encodeURIComponent(found.id)+'?client='+encodeURIComponent(found.clientId),{},'DELETE');}
  else if(d.operation==='feature'){if(!found.features?.[d.feature])return;result=await r.api.request('/api/events/buses/'+encodeURIComponent(found.id)+'/features',{feature:d.feature,read:false,publish:false},'PUT');}
  else result=await r.api.request('/api/events/buses/'+encodeURIComponent(found.id)+(d.operation==='purge'?'/purge':''),{},d.operation==='purge'?'POST':'DELETE');
  }catch(error){update(r,ctx,{phase:'error',stale:true});throw error;}
  // Publish known success before refreshing. A lost refresh never invites a repeat mutation.
  const ends=result?.access_ends_by??result?.accessEndsBy,ending=ends?{...a.ending,[found.id]:{accessEndsBy:ends,acknowledged:result.acknowledged??null,target:found,operation:d.operation}}:a.ending;
  update(r,ctx,{confirmation:null,phase:'saved',stale:true,ending,notice:{operation:d.operation,name:found.appName??found.name??found.title??host(found.clientId),title:found.title,accessEndsBy:ends},...d.operation==='revoke'?{groups:a.groups.filter(g=>g.id!==found.id)}:{},...d.operation==='disconnect'?{apps:a.apps.filter(g=>g.id!==found.id),groups:a.groups.filter(g=>g.clientId!==found.clientId)}:{},...d.operation==='delete'?{buses:a.buses.filter(b=>b.id!==found.id)}:{}});
  r.browser.restoreFocus?.();try{await load(r,ctx);}catch{update(r,ctx,{phase:'error',stale:true});}
 }
}
