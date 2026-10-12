import {BILLING_STATE_KEY,entitlementFromState,assertOwner} from '../billing/catalog.mjs';
import {StorageError} from '../storage/policy.mjs';

export const WORK_LAYOUT=Object.freeze({version:1,shards:16,leaseUnits:16});
export const WORK_DEFAULTS=Object.freeze({service:250000,free:1000,plus:5000,pro:10000});
const STATE='work/month';
const fail=(code='work_unavailable',message='Work admission is temporarily unavailable.',status=503)=>{throw new StorageError(code,message,status);};
function number(value,fallback){if(value===undefined)return fallback;const parsed=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;if(!Number.isSafeInteger(parsed)||parsed<0)fail();return parsed;}
export function workLimits(config={}){return {service:number(config.SERVICE_MONTHLY_WORK_LIMIT,WORK_DEFAULTS.service),free:number(config.FREE_MONTHLY_WORK_LIMIT,WORK_DEFAULTS.free),plus:number(config.PLUS_MONTHLY_WORK_LIMIT,WORK_DEFAULTS.plus),pro:number(config.PRO_MONTHLY_WORK_LIMIT,WORK_DEFAULTS.pro)};}
export function workPartitionLimit(total,partition){if(!Number.isSafeInteger(total)||total<0||!Number.isInteger(partition)||partition<0||partition>=WORK_LAYOUT.shards)fail();return Math.floor(total/WORK_LAYOUT.shards)+(partition<total%WORK_LAYOUT.shards?1:0);}
export async function workShard(owner){assertOwner(owner);const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`work-v1:${owner}`)));return hash[0]%WORK_LAYOUT.shards;}
const monthAt=now=>new Date(now).toISOString().slice(0,7);
function valid(record){return record?.version===WORK_LAYOUT.version&&typeof record.month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(record.month)&&Number.isSafeInteger(record.used)&&record.used>=0&&Number.isSafeInteger(record.remaining)&&record.remaining>=0&&record.remaining<WORK_LAYOUT.leaseUnits;}

/** Admission units count mutations and ingest attempts, not provider invoices.
 * Owner debits and service allocations are durable and nonrefundable. A small
 * prepaid local lease keeps shared service counters off the ordinary path.
 * The immutable 16-way partition can strand capacity in less-active shards. */
export class AccountWorkBudget{
 constructor({metadata,authority,config={},clock=()=>Date.now()}){Object.assign(this,{metadata,authority,clock});this.limits=workLimits(config);this.tail=Promise.resolve();}
 async status(owner){assertOwner(owner);return this.metadata.transaction(async tx=>{const storedOwner=await tx.get('owner');if(storedOwner&&storedOwner!==owner)fail('forbidden','Account owner mismatch.',403);const now=this.clock(),month=monthAt(now),record=await tx.get(STATE);if(record&&(!valid(record)||record.month>month))fail();const billing=await tx.get(BILLING_STATE_KEY),plan=entitlementFromState(billing?.owner===owner?billing:null,now).plan,used=record?.month===month?record.used:0,limit=this.limits[plan],date=new Date(now);return {enabled:true,month,used,limit,remaining:Math.max(0,limit-used),resetsAt:Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1),unit:'covered-changes'};});}
 async admit(owner,{initialize=false}={}){const previous=this.tail;let release;this.tail=new Promise(resolve=>release=resolve);await previous;try{return await this.admitSerial(owner,initialize);}finally{release();}}
 async admitSerial(owner,initialize){
  assertOwner(owner);const month=monthAt(this.clock());
  const remaining=await this.metadata.transaction(async tx=>{
   const storedOwner=await tx.get('owner');if(storedOwner!==owner){if(storedOwner||!initialize)fail('forbidden','Account owner mismatch.',403);await tx.put('owner',owner);}
   let record=await tx.get(STATE);if(record&&(!valid(record)||record.month>month))fail();if(!record||record.month!==month)record={version:WORK_LAYOUT.version,month,used:0,remaining:0};
   const billing=await tx.get(BILLING_STATE_KEY),plan=entitlementFromState(billing?.owner===owner?billing:null,this.clock()).plan;
   if(record.used>=this.limits[plan])fail('owner_work_exceeded','The account monthly work limit has been reached. Try again next month.',429);
   await tx.put(STATE,{...record,used:record.used+1,remaining:Math.max(0,record.remaining-1)});return record.remaining;
  });
  if(monthAt(this.clock())!==month)fail();if(remaining>0)return true;
  if(!this.authority?.consume)fail();const partition=await workShard(owner),limit=workPartitionLimit(this.limits.service,partition);if(!limit)fail('service_work_exceeded','The service monthly work limit has been reached. Try again next month.',429);
  const key=`work-v${WORK_LAYOUT.version}/${month}/${partition}`,batch=Math.min(WORK_LAYOUT.leaseUnits,limit);
  let granted=batch;
  try{if(!await this.authority.consume(key,{limit,lifetime:true,units:batch})){granted=1;if(batch===1||!await this.authority.consume(key,{limit,lifetime:true,units:1}))fail('service_work_exceeded','The service monthly work limit has been reached. Try again next month.',429);}}catch(error){if(error instanceof StorageError)throw error;fail();}
  await this.metadata.transaction(async tx=>{const record=await tx.get(STATE);if(monthAt(this.clock())!==month||!valid(record)||record.month!==month||record.remaining!==0)fail();await tx.put(STATE,{...record,remaining:granted-1});});return true;
 }
}
