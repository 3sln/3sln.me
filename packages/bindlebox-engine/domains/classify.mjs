// BB-B5 classifier consumer. The host port owns live slot occupancy/grants and the first occupant's transport.
// Port: decide({text,hints}) -> {labels:{category:probability},evidence:{model,version,schema}}. It MUST NOT
// retry another occupant after an ambiguous dispatch; this consumer never requests failover or passes identity.
// Shared with BB-B2/X10: the published item-classifier slot; decision-model/v1 remains an unpublished .example contract.
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {minimize} from './intake.mjs';
import {TAG_CATEGORIES,heuristicSuspectedTags,applyAutomatedTags,boundedString} from './tags.mjs';
import {incomingItem,organizationOf} from '../store/item-index.mjs';
import {KEYS} from '../store/mailbox.mjs';
import {fromBase64url} from '../../bindlebox-protocol/index.mjs';
export const CLASSIFIER_SLOT='https://3sln.me/artefacts/slots/item-classifier/v1',CLASSIFIER_CONTRACT='https://spec.bindle.example/contracts/decision-model/v1';
const SETTINGS='bb:classify:settings',defaults=()=>({revision:0,consent:false,allowance:200,usage:{day:0,calls:0},pins:[],conversations:[]});
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),evidenceOK=e=>plain(e)&&boundedString(e.model,100)&&boundedString(e.version,64)&&boundedString(e.schema,128);
const modelKey=e=>JSON.stringify([e.model,e.version,e.schema]),decoder=new TextDecoder(),encoder=new TextEncoder();
// Conservative byte ceiling: the port's model tokenizer is unknown; 8,000 characters cannot prove 2,000 tokens.
export const MAX_CLASSIFIER_BYTES=2000;
const minimizedText=text=>{let out='',bytes=0;for(const c of minimize(text)){bytes+=encoder.encode(c).length;if(bytes>MAX_CLASSIFIER_BYTES)break;out+=c;}return out;};
function normalizePin(p){
 if(!evidenceOK(p)||!plain(p.thresholds)||!Object.keys(p.thresholds).length||Object.entries(p.thresholds).some(([k,v])=>!TAG_CATEGORIES.includes(k)||typeof v!=='number'||!Number.isFinite(v)||v<=0||v>1))fault('invalid_classification','Choose model-bound thresholds.',400);
 return {model:p.model,version:p.version,schema:p.schema,thresholds:{...p.thresholds}};
}
function headerHints(item){
 if(item.origin!=='channel')return heuristicSuspectedTags({});
 const hints=new Set((item.asserted?.automation??[]).map(h=>String(h).toLowerCase())),headers={};
 if(hints.has('auto-submitted'))headers['auto-submitted']='auto-generated';
 if(hints.has('list-unsubscribe')||hints.has('list-id'))headers['list-id']='present';
 if(hints.has('precedence-bulk'))headers.precedence='bulk';
 return heuristicSuspectedTags(headers);
}
async function textOf(tx,item){
 if(item.origin==='channel')return (item.message?.parts??[]).filter(p=>p.mimeType?.startsWith('text/plain')).map(p=>decoder.decode(fromBase64url(p.dataBase64url))).join('\n');
 const body=item.content?.mimeType?.startsWith('text/plain')?await tx.get(KEYS.body(item.id)):null;
 return `${item.subject??''}\n\n${body?decoder.decode(body):''}`;
}
function typedResult(value){
 if(!plain(value)||Object.keys(value).some(k=>!['labels','evidence'].includes(k))||!evidenceOK(value.evidence)||!plain(value.labels)||Object.keys(value.labels).length>TAG_CATEGORIES.length||Object.entries(value.labels).some(([k,p])=>!TAG_CATEGORIES.includes(k)||!Number.isFinite(p)||p<0||p>1))return null;
 return {labels:{...value.labels},evidence:{model:value.evidence.model,version:value.evidence.version,schema:value.evidence.schema}};
}
export class ClassificationSettings extends MailboxAction {
 static operation='classify.settings';static deps=['tags'];static changes='classification-settings-changed';
 run({tags}){
  const input=structuredClone(this.input??{});
  if(!plain(input)||Object.keys(input).some(k=>!['consent','allowance','pin','conversation'].includes(k))||input.consent!==undefined&&typeof input.consent!=='boolean'||input.allowance!==undefined&&(!Number.isSafeInteger(input.allowance)||input.allowance<0||input.allowance>100000))fault('invalid_classification');
  const pin=input.pin===undefined?null:normalizePin(input.pin),conversation=input.conversation;
  if(conversation!==undefined&&(!plain(conversation)||!boundedString(conversation.id,1024)||typeof conversation.enabled!=='boolean'))fault('invalid_classification');
  return tags.transaction(async tx=>{const s={...defaults(),...await tx.get(SETTINGS)};
   if(input.consent!==undefined)s.consent=input.consent;if(input.allowance!==undefined)s.allowance=input.allowance;
   if(pin)s.pins=[...s.pins.filter(p=>modelKey(p)!==modelKey(pin)),pin].slice(-16);
   if(conversation){s.conversations=s.conversations.filter(id=>id!==conversation.id);if(conversation.enabled){if(s.conversations.length>=1000)fault('limit_reached');s.conversations.push(conversation.id);}}
   s.revision++;await tx.put(SETTINGS,s);return s;
  });
 }
}
// This query reports local consent only; a bound classifier port is never advertised as verified occupancy.
export class ClassificationStatus extends MailboxQuery {
 static operation='classify.status';static deps=['tags'];static refreshOn=['classification-settings-changed'];
 fetch({tags}){return tags.transaction(async tx=>{const s={...defaults(),...await tx.get(SETTINGS)};return {consent:s.consent,allowance:s.allowance,revision:s.revision,pins:s.pins,conversations:s.conversations};});}
}
export class ClassifyItem extends MailboxAction {
 static operation='classify.item';static deps=['tags','classifier','clock'];static changes='incoming-changed';
 async run({tags,classifier,clock}){
  const id=this.id??this.input?.id,now=clock.now(),day=Math.floor(now/86400000);
  const snapshot=await tags.transaction(async tx=>{
   const item=await incomingItem(tx,id),s={...defaults(),...await tx.get(SETTINGS)},m=organizationOf(item);
   // §12.1 public requests are already classified by BB-B2; never retier, reject or release them here.
   if(item.request||['pending','rejected'].includes(item.state))return {skip:'public-intake'};
   const conversation=item.type==='conversation'||item.kind==='conversation'||item.conversationId!==undefined;
   if(conversation&&!s.conversations.includes(item.conversationId??item.id))return {skip:'conversation-opt-in'};
   if(item.origin!=='channel'&&!conversation&&item.kind!=='one-off')return {skip:'unsupported-kind'};
   let reserved=false,text='';const used=s.usage.day===day?s.usage.calls:0;
   if(s.consent&&typeof classifier?.decide==='function'&&used<s.allowance){reserved=true;s.usage={day,calls:used+1};await tx.put(SETTINGS,s);text=minimizedText(await textOf(tx,item));}
   return {item,settings:s,revision:m.organizationRevision,reserved,text,hints:headerHints(item)};
  });
  if(snapshot.skip)return {id,status:'skipped',reason:snapshot.skip};
  let result=null;
  if(snapshot.reserved)try{result=typedResult(await classifier.decide({text:snapshot.text,hints:snapshot.item.origin==='channel'?(snapshot.item.asserted?.automation??[]).filter(h=>['auto-submitted','list-id','list-unsubscribe','precedence-bulk'].includes(h)).slice(0,16):[]}));}catch{/* An unavailable, unconsented, malformed or failed occupant fails closed to header hints. */}
  return tags.transaction(async tx=>{
   const item=await incomingItem(tx,id),s={...defaults(),...await tx.get(SETTINGS)};
   if(organizationOf(item).organizationRevision!==snapshot.revision||s.revision!==snapshot.settings.revision)return {id,status:'skipped',reason:'changed'};
   if(result){
    const pin=s.pins.find(p=>modelKey(p)===modelKey(result.evidence));
    // No default probability threshold: a new model/schema/version enters calibration and adds no model tags.
    if(pin){const labels=Object.entries(result.labels).filter(([category,p])=>pin.thresholds[category]!==undefined&&p>=pin.thresholds[category]).map(([category,probability])=>({tag:'sys:suspected.'+category,probability}));
     const value=await applyAutomatedTags(tx,item,{source:'classifier',status:'complete',model:result.evidence.model,version:result.evidence.version,schema:result.evidence.schema,labels},now);return {id,status:'complete',source:'classifier',evidence:result.evidence,item:value};}
   }
   const value=await applyAutomatedTags(tx,item,snapshot.hints,now);return {id,status:result?'calibration':'heuristic',source:'heuristic',item:value};
  });
 }
}
export const CLASSIFY_OPERATIONS=[ClassificationSettings,ClassificationStatus,ClassifyItem];
