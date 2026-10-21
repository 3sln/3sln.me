// CX-2 browser domain. The entry adapter supplies authorized, pinned facts through
// prepare/describe; describe is CX-1's consent.model projection, never app copy.
// No new HTTP routes are guessed here. IA-1 supplies the transport at composition.
import {Action,Query} from '../shared/stack.mjs';
const plain=(value,max=80)=>[...String(value??'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'')].slice(0,max).join('');
const BUS_CONTRACT='https://spec.bindle.example/contracts/event-bus/v1',BUS_METHODS={read:['read','subscribe','unsubscribe'],write:['publish']};
const selectedMethod=(row,contract,method)=>row.kind==='bus'?contract===BUS_CONTRACT&&BUS_METHODS[row.mode]?.includes(method):row.contract===contract&&row.method===method;
const clone=value=>structuredClone(value),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),own=(o,k)=>o&&Object.hasOwn(o,k),fault=message=>{throw new Error(message);};
export const consentExperienceEnabled=config=>config?.INCREMENTAL_AUTH_ENABLED===true||config?.INCREMENTAL_AUTH_ENABLED==='true';
const assertEnabled=config=>{if(!consentExperienceEnabled(config))fault('consent_disabled');};
const get=(object,key)=>own(object,key)?object[key]:undefined,set=(object,key,value)=>Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});
const receivers=(state,name)=>(state.configuration?.affectedApps??[]).filter(app=>app.fields.includes(name));
export const sensitiveSuggestion=(state,name)=>{const field=state.configuration.schema.fields[name];return field.sensitive===true||field.type==='url'||['email','hostname'].includes(field.format)||receivers(state,name).length>0;};
export const configurationChanges=state=>Object.fromEntries(Object.entries(state.choices??{}).filter(([name,choice])=>choice.kind!=='keep'&&!same(choice.value,get(state.configuration.values,name))).map(([name,choice])=>[name,choice.value]));
const included=(state,item)=>{const s=state.selections[item.id];return !item.needsSetup&&s.included&&item.fields.some(name=>s.fields[name]!==false&&(!item.resources?.[name]||item.resources[name].some(id=>s.resources[name]?.[id]!==false)))&&item.card.rows.some((row,index)=>s.rows[index]&&(!row.risk.confirmationRequired||s.confirmed[index]));};
export const consentCount=state=>state.items.filter(item=>included(state,item)).length;
export const needsConfirmation=state=>state.items.reduce((n,item)=>n+item.card.rows.filter(row=>row.risk.confirmationRequired).length,0)>=3;
export function consentReady(state){
 if(!state||state.blocked||state.step==='setup'||state.step==='recap'||state.step==='stop')return false;
 if(state.intent==='configure'){const changes=configurationChanges(state);return Object.keys(changes).length>0&&(!Object.keys(changes).some(name=>receivers(state,name).length)||state.sharedAcknowledged);}
 if(needsConfirmation(state)&&state.step!=='confirm')return false;
 return consentCount(state)>0&&!state.items.some(item=>item.required&&!included(state,item));
}
/** Complete delta selection; fragments are merged without ever including the
 * collapsed alreadyAllowed snapshot. The backend owns union/atomic commit. */
export function walkthroughSelections(state){
 const fragments=new Map();for(const item of state.items){if(!included(state,item))continue;const s=state.selections[item.id],rows=item.card.rows.filter((row,index)=>s.rows[index]&&(!row.risk.confirmationRequired||s.confirmed[index])),fields=item.fields.filter(name=>s.fields[name]!==false&&(!item.resources?.[name]||item.resources[name].some(id=>s.resources[name]?.[id]!==false)));if(!fields.length)continue;
 const granted=fragments.get(item.fragment)??{fragment:item.fragment,revision:item.revision,fields:[],resources:{},methods:{}};
 for(const name of fields){if(!granted.fields.includes(name))granted.fields.push(name);if(item.resources?.[name])granted.resources[name]=[...new Set([...(granted.resources[name]??[]),...item.resources[name].filter(id=>s.resources[name]?.[id]!==false)])];
 for(const [contract,methods]of Object.entries(item.methods?.[name]??{})){const selected=methods.filter(method=>rows.some(row=>selectedMethod(row,contract,method)));if(selected.length){if(!own(granted.methods,name))set(granted.methods,name,{});granted.methods[name][contract]=[...new Set([...(granted.methods[name][contract]??[]),...selected])];}}}
 fragments.set(item.fragment,granted);
 }return [...fragments.values()];
}
/** prepare({entry,view}) returns {items,setup?,configuration?,alreadyAllowed?,
 * blocked?,declines?}. Each item has an id, CX-1 description input, fragment,
 * revision, fields, optional resources/methods, and mandatory disclosure facts.
 * Feed facts are structured: retentionDays, readers, publishers, host,
 * brokered, revocationMinutes, historyDays/historyCount. Adapter facts must be
 * scoped to this entry; no registrable-domain heuristic lives in the browser.
 * setup atomically returns {fragments:[{fragment,revision,staged?,items?}]}
 * (or the fragment result directly for one fragment). Refreshed items contain
 * the chosen resource IDs/disclosures; they are projected again through CX-1.
 * Resource creation is staged until decision.
 * configure receives only opened target values and the revision/consumer pin.
 * decision/suppress return the existing provider callback response. */
export function createConsentExperience({config={},prepare,describe,transport={}}={}){
 const enabled=consentExperienceEnabled(config);
 const requireTransport=name=>{if(typeof transport[name]!=='function')fault('consent_transport_unavailable');return transport[name];};
 async function open({entry,view,locale='en'}){
  assertEnabled(config);if(typeof prepare!=='function'||typeof describe!=='function')fault('consent_adapter_unavailable');
  entry=clone(entry);const facts=await prepare({entry,view}),items=clone(facts.items??[]),description=await describe({app:entry.client.id,locale:{account:locale,uiLocales:entry.uiLocales},grants:items.map(item=>({...item.description,id:item.id})),reason:entry.reason});
  if(items.length!==description.grants.length||new Set(items.map(item=>item.id)).size!==items.length)fault('consent_adapter_invalid');
  const cards=new Map(description.grants.map(card=>[card.id,card]));for(const item of items){item.card=cards.get(item.id);if(!item.card||!item.fields?.length)fault('consent_adapter_invalid');if(item.card.kind==='bus'&&(!Number.isInteger(item.disclosure?.retentionDays)||item.disclosure.retentionDays<1||!Array.isArray(item.disclosure.readers)||!Array.isArray(item.disclosure.publishers)||!item.disclosure.host||!Object.values(item.methods??{}).some(contracts=>contracts[BUS_CONTRACT]?.length)))fault('consent_adapter_invalid');item.needsSetup=Boolean(facts.setup?.some(target=>target.fragment===item.fragment));item.title=plain(item.title??item.card.label?.text??item.id,40);for(const name of Object.keys(item.fieldTitles??{}))item.fieldTitles[name]=plain(item.fieldTitles[name],40);if(entry.intent==='grant-more')item.required=false;}
  items.sort((a,b)=>b.card.risk.tier-a.card.risk.tier||Number(b.card.risk.privateInfo)-Number(a.card.risk.privateInfo));
  const selections=Object.fromEntries(items.map(item=>[item.id,{included:!item.suppressed&&item.card.preselected,rows:item.card.rows.map(row=>!item.suppressed&&row.risk.preselected),confirmed:item.card.rows.map(()=>false),fields:Object.fromEntries(item.fields.map(name=>[name,true])),resources:{}}]));
  const state={intent:entry.intent,entry:clone(entry),view,locale:description.locale,items,selections,reason:description.reason,setup:clone(facts.setup??[]),hasSetup:Boolean(facts.setup?.length),completedSetup:[],skippedSetup:[],configuration:clone(facts.configuration??null),alreadyAllowed:clone(facts.alreadyAllowed??[]),blocked:facts.blocked===true,superseded:facts.superseded===true,declines:facts.declines??0,choices:{},sharedAcknowledged:false,stopScope:null,history:{},staged:{},step:entry.intent==='configure'?'configure':facts.setup?.length?'setup':'review'};
  if(state.intent==='configure'&&!state.superseded){
   if(!state.configuration||state.configuration.fragment!==entry.target.fragment)fault('consent_adapter_invalid');
   const fields=entry.target.fields??Object.keys(state.configuration.schema.fields);if(Object.keys(state.configuration.schema.fields).some(name=>!fields.includes(name)))fault('consent_adapter_invalid');
   for(const name of Object.keys(entry.suggestion?.values??{}))if(!own(state.configuration.schema.fields,name)||state.configuration.schema.fields[name].type==='resource')fault('consent_adapter_invalid');
  }
  if(state.intent==='grant-more'&&!state.items.length&&!state.setup.length&&!state.blocked){state.result=await requireTransport('decision')({entry:state.entry,view:state.view,approved:[],noDelta:true});state.returning=true;state.step='recap';}
  return state;
 }
 async function transition(state,kind,detail={}){
  assertEnabled(config);if(!state)fault('consent_not_open');const next=clone(state),item=next.items.find(item=>item.id===detail.id),s=item&&next.selections[item.id];
  if(next.step==='recap'&&kind!=='return')return next;
  if(kind==='include'&&s){s.included=detail.value===true;if(s.included&&item.suppressed)next.reviewSuppressed=true;if(s.included&&!s.rows.some(Boolean))s.rows=item.card.rows.map(()=>true);}
  else if(kind==='row'&&s){if(!Number.isInteger(detail.index)||detail.index<0||detail.index>=item.card.rows.length)fault('consent_item_invalid');s.rows[detail.index]=detail.value===true;if(detail.value&&item.suppressed)next.reviewSuppressed=true;s.included=s.rows.some(Boolean);if(!detail.value)s.confirmed[detail.index]=false;}
  else if(kind==='confirm'&&s){if(!Number.isInteger(detail.index)||detail.index<0||!item.card.rows[detail.index]?.risk.confirmationRequired)fault('consent_item_invalid');s.confirmed[detail.index]=detail.value===true;if(detail.value){s.rows[detail.index]=true;s.included=true;}}
  else if(kind==='field'&&s){if(!item.fields.includes(detail.name))fault('consent_item_invalid');s.fields[detail.name]=detail.value===true;}
  else if(kind==='resource'&&s){if(!item.resources?.[detail.name]?.includes(detail.resource))fault('consent_item_invalid');if(!own(s.resources,detail.name))set(s.resources,detail.name,{});set(s.resources[detail.name],detail.resource,detail.value===true);}
  else if(kind==='history'&&item){if(!item.disclosure?.historyDays)fault('consent_item_invalid');set(next.history,item.id,detail.value===true);}
  else if(kind==='next'&&next.step==='review'&&needsConfirmation(next))next.step='confirm';
  else if(kind==='back'){if(next.step==='review'&&next.completedSetup.length){next.setup=next.completedSetup;next.completedSetup=[];next.step='setup';}else next.step=next.step==='stop'?next.previousStep:'review';next.stopScope=null;}
  else if(kind==='setup-again'){const target=next.skippedSetup.find(target=>target.fragment===detail.fragment);if(!target)fault('consent_item_invalid');next.setup.push(target);next.skippedSetup=next.skippedSetup.filter(target=>target.fragment!==detail.fragment);next.step='setup';}
  else if(kind==='setup-draft'){
   const target=next.setup.find(item=>item.fragment===detail.fragment);if(!target||!own(target.schema.fields,detail.name))fault('consent_item_invalid');target.draft??=clone(target.values??{});if(detail.index!==undefined){const field=target.schema.fields[detail.name];if(!Number.isInteger(detail.index)||detail.index<0||detail.index>=(field.cardinality?.max??1))fault('consent_item_invalid');const values=[...(target.draft[detail.name]??[])];values[detail.index]=detail.value;target.draft[detail.name]=values.filter(value=>value!==''&&value!==undefined);}else target.draft[detail.name]=detail.value;
  }
  else if(kind==='setup'){
   const updates=detail.updates??[detail];if(updates.length!==next.setup.length||new Set(updates.map(update=>update.fragment)).size!==updates.length)fault('consent_item_invalid');
   for(const update of updates){const target=next.setup.find(item=>item.fragment===update.fragment);if(!target)fault('consent_item_invalid');update.expectedRevision=target.revision??null;update.reviewedConsumerDigest=target.consumerDigest;if(target.affectedApps?.length&&!update.updateShared)fault('shared_acknowledgement_required');
    for(const [name,field]of Object.entries(target.schema.fields))if(field.type==='resource'&&(target.values?.[name]||!target.candidates?.some(candidate=>candidate.id===update.values?.[name]&&candidate.eligible===true)))fault('consent_item_invalid');
   }
   // The adapter commits the entire setup step atomically. Resource/occupant
   // choices remain staging data until Allow; decline cannot create a host.
   const result=await requireTransport('setup')({entry:next.entry,view:next.view,...updates.length===1?updates[0]:{},updates});
   for(const update of updates){const target=next.setup.find(item=>item.fragment===update.fragment),saved=result?.fragments?.find(item=>item.fragment===update.fragment)??(updates.length===1?result:null);if(!saved)fault('consent_adapter_invalid');
    for(const item of next.items)if(item.fragment===update.fragment)item.needsSetup=false;
    for(const refreshed of saved.items??[]){const index=next.items.findIndex(item=>item.id===refreshed.id&&item.fragment===update.fragment);if(index<0)fault('consent_adapter_invalid');next.items[index]={...next.items[index],...clone(refreshed),needsSetup:false};}
    if(saved.staged)next.staged[update.fragment]=saved.staged;if(saved.revision)for(const item of next.items)if(item.fragment===update.fragment)item.revision=saved.revision;
    next.completedSetup.push({...target,values:saved.staged?target.values:update.values,draft:update.values,revision:saved.revision??target.revision,consumerDigest:saved.consumerDigest??target.consumerDigest});
   }
   const projected=await describe({app:next.entry.client.id,locale:{account:next.locale},grants:next.items.map(item=>({...item.description,id:item.id})),reason:next.entry.reason});
   for(const item of next.items){const card=projected.grants.find(card=>card.id===item.id);if(!card)fault('consent_adapter_invalid');const before=state.items.find(previous=>previous.id===item.id);if(!same(before?.card.rows,card.rows)||!same(before?.resources,item.resources)){const selected=next.selections[item.id];selected.included=card.preselected;selected.rows=card.rows.map(row=>row.risk.preselected);selected.confirmed=card.rows.map(()=>false);selected.resources={};}item.card=card;item.title=plain(item.title,40);}
   next.setup=[];next.step='review';
  }
  else if(kind==='skip'){
   const target=next.setup.find(item=>item.fragment===detail.fragment);if(!target||target.required)fault('consent_item_invalid');next.skippedSetup.push(target);delete next.staged[detail.fragment];for(const item of next.items)if(item.fragment===detail.fragment)next.selections[item.id].included=false;
   next.setup=next.setup.filter(item=>item.fragment!==detail.fragment);if(!next.setup.length)next.step='review';
  }
  else if(kind==='occupant'){
   const c=next.configuration;if(get(c?.schema.fields,detail.name)?.type!=='resource'||c.values[detail.name]||!c.candidates?.[detail.name]?.some(candidate=>candidate.id===detail.value&&candidate.eligible===true))fault('consent_item_invalid');next.choices[detail.name]={kind:'occupant',value:detail.value};next.sharedAcknowledged=false;
  }
  else if(kind==='choose-item'){
   const c=next.configuration,field=get(c?.schema.fields,detail.name);if(!field||field.type==='resource'||!Number.isInteger(detail.index)||detail.index<0||detail.index>=(field.cardinality?.max??1))fault('consent_item_invalid');const values=[...(get(next.choices,detail.name)?.value??get(c.values,detail.name)??[])];values[detail.index]=detail.value;next.choices[detail.name]={kind:'edit',value:values.filter(value=>value!==''&&value!==undefined)};next.sharedAcknowledged=false;
  }
  else if(kind==='choose'){
   const field=get(next.configuration?.schema.fields,detail.name);if(!field||field.type==='resource'||!['keep','suggestion','edit'].includes(detail.choice))fault('consent_item_invalid');
   if(detail.choice==='suggestion'&&!own(next.entry.suggestion?.values,detail.name))fault('consent_item_invalid');
   next.choices[detail.name]={kind:detail.choice,value:detail.choice==='keep'?next.configuration.values[detail.name]:detail.choice==='suggestion'?next.entry.suggestion.values[detail.name]:detail.value??next.configuration.values[detail.name]};next.sharedAcknowledged=false;
  }
  else if(kind==='bulk'){for(const name of Object.keys(next.entry.suggestion?.values??{}))if(!sensitiveSuggestion(next,name))next.choices[name]={kind:'suggestion',value:next.entry.suggestion.values[name],via:'bulk'};next.sharedAcknowledged=false;}
  else if(kind==='acknowledge')next.sharedAcknowledged=detail.value===true;
  else if(kind==='stop'){if(!['grant-more','configure'].includes(next.intent))fault('consent_item_invalid');next.previousStep=next.step;next.step='stop';next.stopScope=null;}
  else if(kind==='scope'){if(!['fragment','kind',...next.declines>=3?['app']:[]].includes(detail.scope)||detail.scope==='fragment'&&!next.items.some(item=>item.fragment===detail.fragment)&&next.configuration?.fragment!==detail.fragment)fault('consent_item_invalid');next.stopScope={scope:detail.scope,...detail.scope==='fragment'?{fragment:detail.fragment}:detail.scope==='kind'?{kind:next.intent}:{}};}
  else if(kind==='show'){next.blocked=false;next.reviewSuppressed=true;next.stopScope=null;}
  else if(kind==='save'){
   if(next.intent!=='configure'||!consentReady(next))return next;
   const c=next.configuration,changes=configurationChanges(next),occupants=Object.fromEntries(Object.entries(changes).filter(([name])=>c.schema.fields[name].type==='resource')),values={...c.values,...Object.fromEntries(Object.entries(changes).filter(([name])=>c.schema.fields[name].type!=='resource'))};next.result=await requireTransport('configure')({entry:next.entry,view:next.view,fragment:c.fragment,values,...Object.keys(occupants).length?{occupants}:{},expectedRevision:c.revision,reviewedConsumerDigest:c.consumerDigest,updateShared:next.sharedAcknowledged});next.step='recap';next.saved=true;
  }
  else if(kind==='allow'){
   if(!consentReady(next)||next.intent==='configure')return next;
   const approved=walkthroughSelections(next);next.result=await requireTransport('decision')({entry:next.entry,view:next.view,approved,reviewSuppressed:next.reviewSuppressed===true,history:Object.fromEntries(next.items.filter(item=>get(next.history,item.id)===true&&included(next,item)&&item.card.rows.some((row,index)=>row.mode==='read'&&next.selections[item.id].rows[index])).map(item=>[item.id,true])),staged:Object.fromEntries(Object.entries(next.staged).filter(([fragment])=>approved.some(grant=>grant.fragment===fragment)))});next.step='recap';
  }
  else if(kind==='decline'||kind==='suppress'){
   if(kind==='suppress'&&!next.stopScope)return next;
   next.result=await requireTransport(kind==='suppress'?'suppress':'decision')({entry:next.entry,view:next.view,approved:[],declined:true,...kind==='suppress'?{suppression:next.stopScope}:{}});next.step='recap';next.declined=true;
  }
  else if(kind==='return'){if(next.step!=='recap'||!next.result)fault('consent_not_complete');next.returning=true;}
  return next;
 }
 return Object.freeze({enabled,open,transition});
}
// Browser operations use the same ngin providers as the existing entry domain;
// they are local operations, never mounted account RPCs or production APIs.
export class ConsentWalkthroughAction extends Action {
 static deps={model:{write:true},consentWalkthrough:{}};
 constructor(kind,detail={}){super();this.kind=kind;this.detail=detail;}
 async execute({model,consentWalkthrough},ctx){
  if(!consentWalkthrough.enabled||model.busy||model.phase!=='consent')return;model.busy=true;model.error='';const before=model.walkthrough?.step;
  if(['open','setup','save','allow','decline','suppress','return'].includes(this.kind))ctx.engineFeed.dispatchEvent(new Event('entry-changed'));
  try{model.walkthrough=this.kind==='open'?await consentWalkthrough.open(this.detail):await consentWalkthrough.transition(model.walkthrough,this.kind,this.detail);if(before!==model.walkthrough.step)model.surface++;}
  catch{model.error=model.walkthrough?.locale==='es'?'No se pudo completar la solicitud. Revisa los valores e inténtalo de nuevo.':'The request could not be completed. Review the values and try again.';}
  finally{model.busy=false;ctx.engineFeed.dispatchEvent(new Event('entry-changed'));if(model.walkthrough?.returning)ctx.engineFeed.dispatchEvent(new CustomEvent('consent-complete',{detail:model.walkthrough.result}));}
 }
}
export class ConsentWalkthroughView extends Query {static deps=['model'];fetch({model}){return model.walkthrough?clone(model.walkthrough):null;}}
