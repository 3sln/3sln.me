// §15.1 provider-page adapter: presentation facts come from the selected entry; writes stay in its decision.
import {createConsentExperience,configurationChanges} from './authorize-entry-consent.mjs';
import {createConsentProvider} from '../../../../packages/consent/model.mjs';
import {EVENT_BUS_CONTRACT} from '../../../../packages/consent/reviewed-contracts.mjs';

export function providerConsent({model,secrets,api}){
 let pins={},contracts={},readerFacts={},appFacts={};const config={INCREMENTAL_AUTH_ENABLED:true},post=decision=>api.post(`/api/oauth/entries/${model.entryId}/decision`,{nonce:model.entry.nonce,...decision},{member:secrets.member,csrf:secrets.member?.csrf,entryToken:secrets.entryToken});
 const experience=createConsentExperience({config,prepare:async({entry,view})=>{
  if(view.superseded)return {items:[],blocked:true,superseded:true};
  contracts=(await api.get('/api/incremental/contracts')).contracts;
  const fragments=entry.intent==='configure'?[view.fragment]:(view.requests??[]).filter(r=>!r.status).map(r=>r.fragment);pins={};for(const fragment of fragments)pins[fragment]=await api.get('/api/incremental/schema?fragment='+encodeURIComponent(fragment));
  const facts={items:[],setup:[],blocked:view.blocked||view.superseded===true,declines:view.offerAppScope?3:0,alreadyAllowed:[]};
  if(entry.intent==='configure'){
   const schema=pins[view.fragment].schema,fields=Object.fromEntries(view.fields.map(f=>[f.name,{...schema.fields[f.name],sensitive:f.sensitive,suppressed:f.suppressed}])),values=Object.fromEntries(view.fields.map(f=>[f.name,f.current])),affectedApps=view.fields.flatMap(f=>f.receivers.map(r=>({name:r.name??r.client??r.clientId,fields:[f.name]}))),candidates=Object.fromEntries(view.fields.filter(f=>f.occupant?.candidates).map(f=>[f.name,f.occupant.candidates.map(candidate=>({...candidate,host:new URL(candidate.origin).host,eligible:true}))]));
   // Suppressed suggestions are absent in the authoritative view. Never recover them from entry metadata.
   entry.suggestion={values:Object.fromEntries(view.fields.filter(f=>Object.hasOwn(f,'suggested')).map(f=>[f.name,f.suggested]))};facts.configuration={fragment:view.fragment,schema:{...schema,fields},values,revision:view.revision,affectedApps,candidates};return facts;
  }
  const held=(await api.get('/api/grants',{member:secrets.member})).grants??[];readerFacts={};appFacts=Object.fromEntries(held.map(g=>[g.clientId,{reviewed:g.client?.reviewed!==false}]));
  for(const r of view.requests??[]){if(r.status)continue;const {preference,candidates}=await api.get('/api/incremental/preferences?fragment='+encodeURIComponent(r.fragment)+'&client='+encodeURIComponent(entry.client.id),{member:secrets.member}),schema=pins[r.fragment].schema,fieldNames=[...new Set([...r.delta.fields,...Object.keys(r.delta.methods)])];facts.alreadyAllowed.push(...r.alreadyAllowed.fields.map(f=>`${schema.fields[f]?.title??f} (${r.fragment})`));
   for(const name of fieldNames){const field=schema.fields[name],methods=r.delta.methods[name]??{},atomic=field.type!=='resource';
    const bus=Object.hasOwn(methods,EVENT_BUS_CONTRACT),readers=held.filter(g=>g.fragment===r.fragment&&Object.values(g.methods??{}).some(cs=>cs[EVENT_BUS_CONTRACT]?.includes('read'))),publishers=held.filter(g=>g.fragment===r.fragment&&Object.values(g.methods??{}).some(cs=>cs[EVENT_BUS_CONTRACT]?.includes('publish')));
    if(bus)readerFacts[r.fragment]=readers.map(g=>({app:g.clientId,capabilities:held.filter(other=>other.clientId===g.clientId).flatMap(other=>Object.values(other.methods??{}).flatMap(cs=>Object.entries(cs).flatMap(([contract,ms])=>ms.map(method=>({contract,method})))))}));
    const descriptions=atomic||!Object.keys(methods).length?[{kind:atomic?'settings':'reference',fragment:r.fragment,fields:[name]}]:Object.entries(methods).map(([contract,list])=>contract===EVENT_BUS_CONTRACT?{kind:'bus',fragment:r.fragment,mode:list.includes('publish')?list.includes('read')?'readwrite':'write':'read'}:{kind:'contract',contract,methods:list});
    for(const [index,description]of descriptions.entries())facts.items.push({id:`${r.fragment}|${name}|${index}`,fragment:r.fragment,digest:r.digest,title:field.title??name,fields:[name],fieldTitles:{[name]:field.title??name},methods:{[name]:methods},...!atomic&&!r.alreadyAllowed.resources?.[name]?.length&&preference?.values?.[name]?{resources:{[name]:[preference.values[name]].flat().map(v=>typeof v==='string'?v:v.resource).filter(id=>candidates.some(c=>c.id===id))}}:{},description:{...description,purpose:r.purpose},...bus?{disclosure:{retentionDays:Math.max(1,Math.ceil(schema.slot.bus.retention.max_seconds/86400)),readers:readers.map(g=>new URL(g.clientId).host),publishers:publishers.map(g=>new URL(g.clientId).host),host:new URL(preference?.resources?.find(resource=>[preference?.values?.[name]].flat().some(v=>(typeof v==='string'?v:v?.resource)===resource.id))?.id??r.fragment).host}}:{},suppressed:r.suppressed});
   }
   if(r.setup.length)facts.setup.push({fragment:r.fragment,title:schema.title,schema:{fields:Object.fromEntries(r.setup.map(f=>[f.field,schema.fields[f.field]]))},values:{},required:false,candidates:r.setup.flatMap(f=>(f.candidates??[]).map(c=>({...c,host:new URL(c.origin).host,eligible:true})))});
  }return facts;
 },describe:input=>createConsentProvider({manifests:pins,contracts,readers:readerFacts,apps:{...appFacts,[input.app]:{reviewed:model.entry.client.reviewed!==false}},registrableDomain:host=>host}).model(input),transport:{
  setup:async({updates})=>({fragments:updates.map(u=>({fragment:u.fragment,staged:{values:u.values,sharedAcknowledged:u.updateShared},items:model.walkthrough.items.filter(i=>i.fragment===u.fragment).map(i=>({...i,resources:Object.fromEntries(i.fields.filter(f=>pins[u.fragment].schema.fields[f].type==='resource').map(f=>[f,[u.values[f]].flat().filter(Boolean)]))}))}))}),
  decision:({approved,declined,suppression,reviewSuppressed,staged})=>post(declined?{...model.consent.blocked?{notice:'return'}:{denied:true},...suppression?{suppress:suppression}:{}}:{approved:approved.map(({fragment,fields,methods,resources})=>({fragment,fields,methods,resources})),...reviewSuppressed?{reveal:true}:{},setup:Object.entries(staged??{}).map(([fragment,s])=>({fragment,...s}))}),
  suppress:({suppression})=>post({...model.consent.blocked?{notice:'return'}:{denied:true},suppress:suppression}),
  configure:({values,updateShared,occupants})=>{const state=model.walkthrough,changes=configurationChanges(state);return post({changes:Object.keys(changes).map(field=>state.choices[field]?.kind==='suggestion'?{field,take:'suggested',via:state.choices[field]?.via??'field'}:{field,value:occupants?.[field]??values[field]}),...updateShared?{sharedAcknowledged:true}:{},...state.reviewSuppressed?{reveal:true}:{}});}
 }});
 return experience;
}
