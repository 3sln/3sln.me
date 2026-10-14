import {BILLING_STATE_KEY,entitlementFromState,assertOwner} from '../billing/catalog.mjs';
import {StorageError} from '../storage/policy.mjs';
import {key} from '../messaging/store.mjs';

export const MESSAGE_RECEIPT_STATE='message-receipt-budget/v1';
export const MESSAGE_RECEIPT_WINDOWS=Object.freeze({minute:60000,hour:3600000,day:86400000});
export const MESSAGE_RECEIPT_MAX_PARENTS=256;
export const MESSAGE_RECEIPT_MAX_STATE_BYTES=120000;
const plans=['free','paid','plus','ultra'],scopes=['owner','contact'],names=Object.keys(MESSAGE_RECEIPT_WINDOWS);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxMessageBytes=1048576;
const make=(counts,mib)=>Object.freeze(Object.fromEntries(scopes.map(scope=>[scope,Object.freeze(Object.fromEntries(names.map((name,i)=>[name,Object.freeze({messages:counts[i]/(scope==='contact'?2:1),bytes:mib[i]*1048576/(scope==='contact'?2:1)})])))])));
export const MESSAGE_RECEIPT_DEFAULTS=Object.freeze({
 free:make([30,300,1000],[16,128,512]),
 paid:make([120,1000,5000],[64,512,2048]),
 plus:make([240,2000,10000],[128,1024,4096]),
 ultra:make([240,2000,10000],[256,2048,8192])
});
function fail(code='message_receipt_unavailable',message='Message receipt admission is unavailable.',status=503,retryAfter){const error=new StorageError(code,message,status);if(retryAfter!==undefined)error.retryAfter=retryAfter;throw error;}
const record=value=>value!==null&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function messageReceiptLimits(config={}){
 let input=config.MESSAGE_RECEIPT_LIMITS;
 if(input===undefined)return structuredClone(MESSAGE_RECEIPT_DEFAULTS);
 if(typeof input==='string'){try{input=JSON.parse(input);}catch{fail();}}
 if(!record(input)||Object.keys(input).some(p=>!plans.includes(p)))fail();
 const result=structuredClone(MESSAGE_RECEIPT_DEFAULTS);
 for(const [plan,value]of Object.entries(input)){
  if(!exact(value,scopes))fail();
  for(const scope of scopes){if(!exact(value[scope],names))fail();for(const name of names){const limit=value[scope][name];if(!exact(limit,['messages','bytes'])||!integer(limit.messages)||!integer(limit.bytes))fail();}}
  for(const name of names)for(const unit of ['messages','bytes'])if(value.contact[name][unit]>value.owner[name][unit])fail();
  result[plan]=structuredClone(value);
 }
 return result;
}
function windowsAt(now){return Object.fromEntries(names.map(name=>[name,{epoch:Math.floor(now/MESSAGE_RECEIPT_WINDOWS[name]),messages:0,bytes:0}]));}
function validWindows(value,last){
 if(!exact(value,names)||!names.every(name=>{const row=value[name];return exact(row,['epoch','messages','bytes'])&&integer(row.epoch)&&row.epoch<=Math.floor(last/MESSAGE_RECEIPT_WINDOWS[name])&&integer(row.messages)&&row.messages>0&&integer(row.bytes)&&row.bytes/row.messages<=maxMessageBytes;}))return false;
 return value.hour.epoch===Math.floor(value.minute.epoch/60)&&value.day.epoch===Math.floor(value.minute.epoch/1440)&&['messages','bytes'].every(unit=>value.minute[unit]<=value.hour[unit]&&value.hour[unit]<=value.day[unit]);
}
function validState(state,owner){
 if(!exact(state,['version','owner','last','windows','contacts'])||state.version!==1||state.owner!==owner||!integer(state.last)||!validWindows(state.windows,state.last)||!names.every(name=>state.windows[name].epoch===Math.floor(state.last/MESSAGE_RECEIPT_WINDOWS[name]))||!record(state.contacts)||Object.keys(state.contacts).length>MESSAGE_RECEIPT_MAX_PARENTS)return false;
 if(!Object.entries(state.contacts).every(([parent,windows])=>uuid.test(parent)&&validWindows(windows,state.last)&&windows.day.epoch===state.windows.day.epoch))return false;
 return names.every(name=>['messages','bytes'].every(unit=>{const total=Object.values(state.contacts).reduce((sum,windows)=>sum+(windows[name].epoch===state.windows[name].epoch?windows[name][unit]:0),0);return Number.isSafeInteger(total)&&total<=state.windows[name][unit];}));
}
function currentWindows(windows,now){const current=windowsAt(now);for(const name of names)if(windows?.[name].epoch===current[name].epoch)current[name]={...windows[name]};return current;}
function report(windows,limits,now){return Object.fromEntries(names.map(name=>{const row=windows[name],limit=limits[name];return [name,{...row,limit:{...limit},remaining:{messages:Math.max(0,limit.messages-row.messages),bytes:Math.max(0,limit.bytes-row.bytes)},resetsAt:(row.epoch+1)*MESSAGE_RECEIPT_WINDOWS[name]}];}));}

/** Supplemental UTC fixed-window admission for NEW message attempts. Debits are
 * durable and nonrefundable, including downstream work/storage failure. Caller
 * must authenticate and resolve established receipt replay before admission.
 * No provider/global counter or rejected-attempt telemetry write is performed. */
export class MessageReceiptBudget{
 constructor({metadata,config={},clock=()=>Date.now()}){Object.assign(this,{metadata,config,clock});this.limits=messageReceiptLimits(config);}
 async context(tx,owner){
  assertOwner(owner);if(await tx.get('owner')!==owner)fail('forbidden','Account owner mismatch.',403);
  const now=this.clock();if(!integer(now))fail();
  const stored=await tx.get(MESSAGE_RECEIPT_STATE);if(stored!==undefined&&(!validState(stored,owner)||stored.last>now||new TextEncoder().encode(JSON.stringify(stored)).byteLength>MESSAGE_RECEIPT_MAX_STATE_BYTES))fail();
  const billing=await tx.get(BILLING_STATE_KEY);
  // A provisional checkout uplift is not confirmed paid receipt capacity.
  const state=billing?.owner===owner?{...billing,upgrade:undefined}:null;
  const plan=entitlementFromState(state,now,this.config).plan;
  return {now,stored,plan,limits:this.limits[plan]};
 }
 async parent(tx,owner,parent,now){
  if(typeof parent!=='string'||!uuid.test(parent))fail('invalid_message','A contact parent is required.',400);
  const grant=await tx.get(key('contact-grant',parent));
  if(!grant?.active||grant.owner!==owner||grant.id!==parent||grant.claims?.sub!==owner||!Number.isSafeInteger(grant.claims?.exp)||grant.claims.exp<=Math.floor(now/1000))fail('unauthorized','The contact link is not active.',401);
 }
 async status(owner){return this.metadata.transaction(async tx=>{const {now,stored,plan,limits}=await this.context(tx,owner);return {enabled:true,plan,unit:'admitted-new-message-attempts',window:'fixed-utc',windows:report(currentWindows(stored?.windows,now),limits.owner,now),contactLimits:structuredClone(limits.contact)};});}
 async admit(owner,{parent,bytes,source='contact'}={}){
  if(!['contact','conversation','app-notification'].includes(source)||source!=='contact'&&parent!==undefined)fail('invalid_message','Invalid receipt source.',400);
  if(!integer(bytes)||bytes>maxMessageBytes)fail('invalid_message','Messages are limited to one MiB.',400);
  return this.metadata.transaction(async tx=>{
   const {now,stored,plan,limits}=await this.context(tx,owner);if(source==='contact')await this.parent(tx,owner,parent,now);
   const state=stored?structuredClone(stored):{version:1,owner,last:now,windows:windowsAt(now),contacts:{}};
   const day=Math.floor(now/MESSAGE_RECEIPT_WINDOWS.day);
   for(const [id,windows]of Object.entries(state.contacts))if(windows.day.epoch<day)delete state.contacts[id];
   if(source==='contact'&&!Object.hasOwn(state.contacts,parent)&&Object.keys(state.contacts).length>=MESSAGE_RECEIPT_MAX_PARENTS){const expiry=Math.min(...Object.values(state.contacts).map(w=>(w.day.epoch+1)*MESSAGE_RECEIPT_WINDOWS.day));fail('message_receipt_capacity','Contact receipt admission is temporarily full.',429,Math.max(1,Math.ceil((expiry-now)/1000)));}
   const ownerWindows=currentWindows(state.windows,now),contactWindows=currentWindows(state.contacts[parent],now);
   let retryAfter=0;
   const entries=[['owner',ownerWindows],...(source==='contact'?[['contact',contactWindows]]:[])];
   for(const [scope,windows]of entries)for(const name of names){
    const row=windows[name],limit=limits[scope][name];
    if(!limit.messages||!limit.bytes)fail('message_receipt_disabled','Message receipt is disabled by the configured allowance.',429);
    if(bytes>limit.bytes)fail('message_receipt_too_large','The message exceeds the receipt byte allowance.',413);
    if(!Number.isSafeInteger(row.messages+1)||!Number.isSafeInteger(row.bytes+bytes))fail();
    if(row.messages+1>limit.messages||row.bytes+bytes>limit.bytes)retryAfter=Math.max(retryAfter,Math.ceil(((row.epoch+1)*MESSAGE_RECEIPT_WINDOWS[name]-now)/1000));
   }
   if(retryAfter)fail('message_receipt_limited','The message receipt allowance has been reached. Try again later.',429,Math.max(1,retryAfter));
   for(const [,windows]of entries)for(const name of names){windows[name].messages++;windows[name].bytes+=bytes;}
   state.last=now;state.windows=ownerWindows;if(source==='contact')state.contacts[parent]=contactWindows;
   if(new TextEncoder().encode(JSON.stringify(state)).byteLength>MESSAGE_RECEIPT_MAX_STATE_BYTES)fail('message_receipt_capacity','Contact receipt admission is temporarily full.',429,Math.max(1,Math.ceil(((day+1)*MESSAGE_RECEIPT_WINDOWS.day-now)/1000)));
   await tx.put(MESSAGE_RECEIPT_STATE,state);
   return {plan,unit:'admitted-new-message-attempts'};
  });
 }
}
