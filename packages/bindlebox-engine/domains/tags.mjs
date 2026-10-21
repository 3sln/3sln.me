// BB-B5: copied from packages/messaging/tags.mjs; BindleBox owns this independent tag model.
import {canonical} from '../../core/primitives.mjs';
import {fault as fail} from '../faults.mjs';
import {OwnerScopedProvider,MailboxAction,MailboxQuery} from '../engine.mjs';
import {ownerRules,validateActions} from './rules.mjs';
import {mailboxTransaction,incomingItem,organizationOf,saveOrganization,validItemId} from '../store/item-index.mjs';
export const boundedString=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
// Tags are stable identifiers; labels are presentation. `sys:` is host-reserved.
// See docs/architecture/tags.md for provenance, promotion and migration rules.
export const SYSTEM_PREFIX='sys:',SUSPECTED_PREFIX='sys:suspected.',TAG_MODEL=1,DEFAULT_RULES_VERSION=1,MAX_USER_TAGS=32;
export const TAG_CATEGORIES=Object.freeze(['spam','social','promotional','recruitment','conversation','outreach','transactional','receipt','automation','verification','code']);
const LABELS={spam:'Spam',social:'Social',promotional:'Promotional',recruitment:'Recruitment',conversation:'Conversation',outreach:'Outreach',transactional:'Transactional',receipt:'Receipt',automation:'Automation',verification:'Verification',code:'Security Code',personal:'Personal',work:'Work'};
// Labels are English bab source text in packages/i18n/catalogues.mjs.
export const SYSTEM_TAGS=Object.freeze(Object.fromEntries([...Object.entries(LABELS).map(([name,label])=>[SYSTEM_PREFIX+name,Object.freeze({id:SYSTEM_PREFIX+name,label,kind:'final'})]),...TAG_CATEGORIES.map(name=>[SUSPECTED_PREFIX+name,Object.freeze({id:SUSPECTED_PREFIX+name,label:'Suspected '+LABELS[name],kind:'suspected',final:SYSTEM_PREFIX+name})])]));
export const systemTag=id=>typeof id==='string'&&Object.hasOwn(SYSTEM_TAGS,id)?SYSTEM_TAGS[id]:null;
export const isSystemTag=id=>Boolean(systemTag(id));
// Reserved look-alikes (case, fullwidth colon, invisible prefixes) can never be user tags.
export const reservedTag=id=>typeof id==='string'&&id.normalize('NFKC').replace(/[\s\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,'').toLowerCase().startsWith(SYSTEM_PREFIX);
export const isSuspectedTag=id=>systemTag(id)?.kind==='suspected';
export const validTagId=id=>boundedString(id,64)&&(isSystemTag(id)||!reservedTag(id));
export const validUserTagId=id=>validTagId(id)&&!isSystemTag(id);
export function validTagIds(tags,{suspected=true}={}){return Array.isArray(tags)&&tags.every(validTagId)&&new Set(tags).size===tags.length&&tags.filter(t=>!isSystemTag(t)).length<=MAX_USER_TAGS&&(suspected||!tags.some(isSuspectedTag));}
/** Owner-authored contact intake configuration: IDs only, never suspected tags. */
export const validIntakeTagIds=tags=>validTagIds(tags,{suspected:false});
/** Pre-registry data and app/sender-supplied text never gain system meaning: `sys:x` becomes user tag `sys_x`. */
export const escapeLegacyTag=tag=>reservedTag(tag)?('sys_'+tag.replace(/^[^:：]*[:：]/,'')).slice(0,64):tag;
const uniq=tags=>[...new Set(tags)];
export const CLASSIFICATIONS=Object.freeze(['unclassified','personal','work','spam','automation']);
const FAMILY=['spam','automation','work','personal'];
export const classificationTag=c=>FAMILY.includes(c)?SYSTEM_PREFIX+c:null;
// Derived compatibility value; host-structural `app` facts yield to owner/rule choices.
export const classificationOf=(tags,provenance)=>FAMILY.find(c=>tags?.includes(SYSTEM_PREFIX+c)&&provenance?.[SYSTEM_PREFIX+c]?.source!=='app')??FAMILY.find(c=>tags?.includes(SYSTEM_PREFIX+c))??'unclassified';
/** Lazy legacy read path: escapes pre-registry `sys:` strings and folds the classification enum into tags. */
export function migrateTags(record){
 if(!record||record.tagModel===TAG_MODEL)return record;
 const out={...record,tags:uniq((record.tags??[]).map(escapeLegacyTag)),...Array.isArray(record.deliveryTags)?{deliveryTags:uniq(record.deliveryTags.map(escapeLegacyTag))}:{},tagModel:TAG_MODEL},tag=classificationTag(record.classification);
 if(tag&&!out.tags.includes(tag)){out.tags.push(tag);out.tagProvenance={...out.tagProvenance,[tag]:{source:'migration',at:record.receivedAt??0}};}
 out.classification=classificationOf(out.tags,out.tagProvenance);return out;
}
const note=(m,entry)=>{m.tagHistory=[...m.tagHistory??[],entry].slice(-16);};
export function addTag(m,tag,provenance,now){if(m.tags.includes(tag))return false;m.tags=[...m.tags,tag];m.tagProvenance={...m.tagProvenance,[tag]:{...provenance,at:now}};note(m,{at:now,op:'add',tag,...provenance});return true;}
export function removeTag(m,tag,provenance,now){if(!m.tags.includes(tag))return false;m.tags=m.tags.filter(t=>t!==tag);if(m.tagProvenance){const {[tag]:_,...rest}=m.tagProvenance;m.tagProvenance=rest;}note(m,{at:now,op:'remove',tag,...provenance});return true;}
export function initialTags(m,tags,provenance,now){m.tags=uniq(tags);m.tagProvenance=Object.fromEntries(m.tags.map(t=>[t,{...provenance,at:now}]));m.classification=classificationOf(m.tags,m.tagProvenance);m.tagModel=TAG_MODEL;return m;}
export function validateTagActions(actions,fields){
 if(!actions||typeof actions!=='object'||Array.isArray(actions)||Object.keys(actions).some(f=>!fields.includes(f)))fail('invalid_actions');
 for(const f of ['tags','addTags','removeTags'])if(actions[f]!==undefined&&!validTagIds(actions[f],{suspected:f!=='addTags'}))fail('invalid_actions');
 if(actions.classification!==undefined&&!CLASSIFICATIONS.includes(actions.classification))fail('invalid_actions');
}
/** `tags` replaces only the user partition; listed system IDs are added. No path but automation adds a new suspected tag. */
export function changeTags(m,actions,provenance,now,{owner=false}={}){
 const before=new Set(m.tags),source=typeof provenance==='function'?provenance:()=>provenance;
 const add=t=>{if(!owner&&m.organizationOverrides?.classification&&FAMILY.some(c=>SYSTEM_PREFIX+c===t))return;if(isSuspectedTag(t)&&!before.has(t))fail('invalid_actions');if(owner&&m.tags.includes(t))m.tagProvenance={...m.tagProvenance,[t]:{...source(t),at:now}};else if(owner||!m.tagSuppressed?.includes(t))addTag(m,t,source(t),now);},remove=t=>{if(owner||m.tagProvenance?.[t]?.source!=='owner')removeTag(m,t,source(t),now);};
 if(actions.tags!==undefined){for(const t of m.tags.filter(t=>!isSystemTag(t)&&!actions.tags.includes(t)))remove(t);actions.tags.forEach(add);}
 if(actions.classification!==undefined){for(const c of FAMILY)if(c!==actions.classification&&m.tagProvenance?.[SYSTEM_PREFIX+c]?.source!=='app')remove(SYSTEM_PREFIX+c);if(classificationTag(actions.classification))add(classificationTag(actions.classification));}
 (actions.removeTags??[]).forEach(remove);(actions.addTags??[]).forEach(add);
 if(m.tags.filter(t=>!isSystemTag(t)).length>MAX_USER_TAGS)fail('invalid_actions');
 if(owner){const removed=[...before].filter(t=>!m.tags.includes(t));m.tagSuppressed=uniq([...(m.tagSuppressed??[]).filter(t=>!m.tags.includes(t)),...removed]).slice(-64);}
 m.classification=classificationOf(m.tags,m.tagProvenance);return m;
}
/** Rules match the immutable snapshot (delivery tags + live automated evidence), never rule/owner output,
 * and each rule fires at most once per message: no chains, no oscillation, idempotent replays. */
export const automatedSnapshot=m=>Object.keys(m.automated??{}).filter(t=>!m.tagSuppressed?.includes(t));
export async function applyRules(m,rules,{phase='intake',newly=[],now,active=async()=>true}={}){
 const snapshot=new Set([...m.deliveryTags??[],...automatedSnapshot(m)]),origin={collection:Object.hasOwn(m,'deliveryCollection')?m.deliveryCollection:m.collection,mimeType:m.mimeType,grantId:m.grantId??null};
 const matches=([f,v])=>f==='tagsAll'?v.every(t=>snapshot.has(t)):f==='source'?true:origin[f]===v,sourced=rule=>!rule.match.source||rule.match.tagsAll.filter(isSuspectedTag).every(t=>m.automated?.[t]?.[rule.match.source]);
 for(const rule of rules){
  if(!rule.enabled||m.firedRules?.includes(rule.id)||!Object.entries(rule.match).every(matches)||!sourced(rule))continue;
  if(phase!=='intake'&&!rule.match.tagsAll?.some(t=>newly.includes(t)))continue;
  if(rule.actions.collection&&!await active(rule.actions.collection))continue;
  const base={source:'rule',ruleId:rule.id,ruleRevision:rule.revision??1},from=t=>rule.match.tagsAll?.find(s=>systemTag(s)?.final===t),backup={tags:m.tags,tagProvenance:m.tagProvenance,tagHistory:m.tagHistory,classification:m.classification};
  m.firedRules=[...m.firedRules??[],rule.id].slice(-100);
  // A post-intake tag overflow skips only the tag changes; quarantine/collection still apply.
  try{changeTags(m,rule.actions,t=>from(t)?{...base,from:from(t)}:base,now);}catch(e){if(phase==='intake'||e.code!=='invalid_actions')throw e;Object.assign(m,backup);note(m,{at:now,op:'skip',ruleId:rule.id,reason:'tag_limit'});}
  // Only explicit owner action releases quarantine; automation never re-quarantines a released item.
  if(rule.actions.quarantined&&!m.quarantineReleased)m.quarantined=true;if(rule.actions.collection&&!m.organizationOverrides?.collection)m.collection=rule.actions.collection;
 }
 return m;
}
const defaultBody=name=>({match:{tagsAll:[SUSPECTED_PREFIX+name],source:'classifier'},actions:{addTags:[SYSTEM_PREFIX+name],removeTags:[SUSPECTED_PREFIX+name],...name==='spam'?{quarantined:true}:{}}});
const bodyOf=rule=>canonical({match:rule.match,actions:rule.actions});
/** Version 1 defaults finalize classifier-suggested categories (sender-controlled heuristics stay suspected); only Spam also quarantines (recoverable). */
export const defaultRules=()=>TAG_CATEGORIES.map(name=>({id:'default:promote.'+name,version:DEFAULT_RULES_VERSION,enabled:true,...defaultBody(name)}));
// BindleBox's new registry has no pre-registry rules: never escape IDs from a validated first write.
/** Returns null when current; never re-adds a deleted default or overwrites an edited one. */
export function seedDefaultRules(rules,state){
 if(state?.version===DEFAULT_RULES_VERSION)return null;
 const out=[...rules],seeded={...state?.seeded};
 for(const {id,version,enabled,...body} of defaultRules()){
  const at=out.findIndex(r=>r.id===id),base=bodyOf(body);
  if(seeded[id]===undefined){if(at<0&&out.length<100){out.push({id,enabled,revision:1,...body,default:{version,base}});seeded[id]=version;}}
  else if(seeded[id]<version){if(at>=0){const r=out[at];out[at]=bodyOf(r)===r.default?.base?{...r,...body,revision:(r.revision??1)+1,default:{version,base}}:{...r,default:{...r.default,updateAvailable:version}};}seeded[id]=version;}
 }
 return {rules:out,state:{version:DEFAULT_RULES_VERSION,tagModel:TAG_MODEL,seeded}};
}
/** Server-owned rule metadata: clients cannot forge default markers or revisions. */
export function stampRules(next,prior){
 const byId=new Map(prior.map(r=>[r.id,r]));
 return next.map(({default:_,revision:__,...rule})=>{const p=byId.get(rule.id);if(rule.id.startsWith('default:')&&!p?.default)fail('invalid_rules');return {...rule,revision:p?bodyOf(p)===bodyOf(rule)?p.revision??1:(p.revision??1)+1:1,...p?.default?{default:p.default}:{}};});
}
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
/** Classifier/heuristic boundary input: registered suspected IDs only, with bounded evidence. */
export function normalizeAutomatedResult(input){
 const status=input?.status??'complete';
 if(!plain(input)||Object.keys(input).some(k=>!['source','status','model','version','schema','labels'].includes(k))||!['classifier','heuristic'].includes(input.source)||!['complete','skipped','failed'].includes(status)||!boundedString(input.version,64)||input.model!==undefined&&!boundedString(input.model,100)||input.schema!==undefined&&!boundedString(input.schema,128)||!Array.isArray(input.labels)||input.labels.length>TAG_CATEGORIES.length||status!=='complete'&&input.labels.length)fail('invalid_classification');
 const labels=input.labels.map(l=>{if(!plain(l)||Object.keys(l).some(k=>!['tag','probability'].includes(k))||!isSuspectedTag(l.tag)||l.probability!==undefined&&!(Number.isFinite(l.probability)&&l.probability>=0&&l.probability<=1))fail('invalid_classification');return {tag:l.tag,...l.probability!==undefined?{probability:l.probability}:{}};});
 if(new Set(labels.map(l=>l.tag)).size!==labels.length)fail('invalid_classification');
 return {source:input.source,status,...input.model!==undefined?{model:input.model}:{},version:input.version,...input.schema!==undefined?{schema:input.schema}:{},labels};
}
/** Deterministic, sender-controlled hints: suspected tags only, never final. */
export function heuristicSuspectedTags(headers={}){
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v).trim().toLowerCase()])),labels=[];
 if(h['auto-submitted']&&h['auto-submitted']!=='no')labels.push(SUSPECTED_PREFIX+'automation');
 if(Object.hasOwn(h,'list-unsubscribe')||Object.hasOwn(h,'list-id')||['bulk','list'].includes(h.precedence))labels.push(SUSPECTED_PREFIX+'promotional');
 return {source:'heuristic',status:'complete',version:'headers-1',labels:labels.map(tag=>({tag}))};
}
export const validTagLabel=label=>boundedString(label,64)&&label.trim()===label;
/** Render helper: system labels are catalogue source text; user labels and unknown IDs stay literal. */
export function tagDisplay(id,labels={}){const s=systemTag(id);return s?{id,label:s.label,system:true,suspected:s.kind==='suspected'}:{id,label:plain(labels)&&Object.hasOwn(labels,id)&&typeof labels[id]==='string'?labels[id]:id,system:false,suspected:false};}

// Internal evidence boundary; no operation accepts caller-authored automated results. Classification invokes this
// only after its consent, metering, scope and model/version/schema threshold checks, inside the result transaction.
export async function applyAutomatedTags(tx,item,input,now){
 const result=normalizeAutomatedResult(input),m=organizationOf(item),{source,labels,model,version,schema}=result,newly=[];
 if(canonical(m.classificationResult?.[source]?.result)===canonical(result))return m;
 m.classificationResult={...m.classificationResult,[source]:{result,at:now}};
 for(const {tag,probability} of labels){
  const prior=m.automated?.[tag];if(prior?.[source])continue;
  const evidence={...model?{model}:{},version,...schema?{schema}:{},...probability!==undefined?{probability}:{},at:now};
  newly.push(tag);m.automated={...m.automated,[tag]:{...prior,[source]:evidence}};
  if(!prior&&!m.tagSuppressed?.includes(tag))addTag(m,tag,{source,...evidence},now);
 }
 m.mimeType??=item.content?.mimeType;m.grantId??=item.jti;
 if(newly.length)await applyRules(m,await ownerRules(tx),{phase:'automated',newly,now});
 if(m.quarantined)m.notification=null;m.organizationRevision++;
 return saveOrganization(tx,{...item,notification:m.notification},m);
}
export function createTagsProvider({BINDLEBOX_ENABLED=false}={}){
 return class TagsProvider extends OwnerScopedProvider {
  static deps=['mailboxStore','clock','random'];
  scope({mailboxStore:store,clock,random},owner){
   if(BINDLEBOX_ENABLED!==true)fail('not_found','BindleBox is disabled.',404);
   const transaction=fn=>mailboxTransaction(store,owner,BINDLEBOX_ENABLED,fn);
   return {transaction,owner,labels:()=>transaction(async tx=>await tx.get('bb:tag-labels')??{revision:0,labels:{}}),setLabel(input){
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','label','expectedRevision'].includes(k)))fail('invalid_tag_label');
    const {id,label,expectedRevision}=input;if(label!==null&&!validTagLabel(label)||id!==undefined&&!validUserTagId(id)||id===undefined&&label===null||expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0))fail('invalid_tag_label');
    return transaction(async tx=>{const registry=await tx.get('bb:tag-labels')??{revision:0,labels:{}};
     if(expectedRevision!==undefined&&registry.revision!==expectedRevision)fail('tag_label_conflict','The labels changed.',409);
     const tag=id??'t.'+random.uuid().replaceAll('-','').slice(0,20),labels={...registry.labels};
     if(label===null)delete labels[tag];else{if(!Object.hasOwn(labels,tag)&&Object.keys(labels).length>=500)fail('tag_label_limit');Object.defineProperty(labels,tag,{value:label,enumerable:true,writable:true,configurable:true});}
     const revision=registry.revision+1;await tx.put('bb:tag-labels',{revision,labels});return {id:tag,label,revision};
    });
   },update(input){
    const data=structuredClone(input);if(!data||!validItemId(data.id)||!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<1||Object.keys(data).some(k=>!['id','expectedRevision','expectedActivityRevision','tags','addTags','removeTags','classification','quarantined','collection','read'].includes(k)))fail('invalid_actions');
    const {id,expectedRevision,expectedActivityRevision,...actions}=data;validateActions(actions);if(!Object.keys(actions).length)fail('invalid_actions');
    return transaction(async tx=>{const item=await incomingItem(tx,id),m=organizationOf(item);
     if(m.organizationRevision!==expectedRevision)fail('incoming_conflict','Incoming organization changed.',409);
     if(actions.read===true&&(!Number.isSafeInteger(expectedActivityRevision)||expectedActivityRevision!==(item.activityRevision??0)))fail('incoming_conflict','New activity arrived. Refresh before marking read.',409);
     changeTags(m,actions,{source:'owner'},clock.now(),{owner:true});
     m.organizationOverrides={...m.organizationOverrides,...actions.classification!==undefined?{classification:true}:{},...actions.collection!==undefined?{collection:true}:{}};
     if(actions.collection!==undefined)m.collection=actions.collection;
     if(actions.quarantined!==undefined){m.quarantined=actions.quarantined;m.quarantineReleased=!actions.quarantined;if(m.quarantined)m.notification=null;}
     if(actions.read!==undefined){m.readAt=actions.read?clock.now():null;m.seenActivityRevision=actions.read?item.activityRevision??0:-1;}
     m.organizationRevision++;return saveOrganization(tx,{...item,notification:m.quarantined?null:item.notification},m);
    });
   }};
  }
 };
}
export class TagLabels extends MailboxQuery {
 static operation='tags.labels';static deps=['tags'];static refreshOn=['tag-labels-changed'];
 fetch({tags}){return tags.labels();}
}
export class SetTagLabel extends MailboxAction {
 static operation='tags.set-label';static deps=['tags'];static changes='tag-labels-changed';
 run({tags}){return tags.setLabel(this.input);}
}
export class UpdateIncoming extends MailboxAction {
 static operation='incoming.update';static deps=['tags'];static changes='incoming-changed';
 run({tags}){return tags.update(this.input);}
}
export const TAG_OPERATIONS=[TagLabels,SetTagLabel,UpdateIncoming];
