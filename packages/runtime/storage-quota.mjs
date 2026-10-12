import {retryReady,retryTime,retryFailure} from './cleanup-retry.mjs';
import {BILLING_PLANS,BILLING_STATE_KEY,entitlementFromState} from '../billing/catalog.mjs';
import {key} from '../messaging/store.mjs';
import {StorageError} from '../storage/policy.mjs';
const SUMMARY='storage/reservations';
const PREFIX='storage/reservation/';
const TTL=20*60*1000;
function count(value){if(!Number.isSafeInteger(value)||value<0)throw new StorageError('temporarily_unavailable','Storage accounting is unavailable.',503);return value;}
export async function storageState(tx,owner,now=Date.now()){
 const billing=await tx.get(BILLING_STATE_KEY);const entitlement=entitlementFromState(billing?.owner===owner?billing:null,now);
 const messages=await tx.get(key('message-usage',owner))||{bytes:0,messages:0};
 const objects=await tx.get('hosted-usage')||{bytes:0,objects:0};
 const pending=await tx.get(SUMMARY)||{growthBytes:0,uploadBytes:0,count:0};
 const usedBytes=count(messages.bytes)+count(objects.bytes),reservedBytes=count(pending.growthBytes);
 return {...entitlement,planName:BILLING_PLANS[entitlement.plan].name,usedBytes,reservedBytes,pendingUploadBytes:count(pending.uploadBytes),pendingUploads:count(pending.count),remainingBytes:Math.max(0,entitlement.storageBytes-usedBytes-reservedBytes),overLimit:usedBytes>entitlement.storageBytes,messagesBytes:messages.bytes,objectsBytes:objects.bytes,messageCount:count(messages.messages),objectCount:count(objects.objects),unit:'decimal-bytes'};
}
/** Account-serialized resource. Reservation is durable before uploading bytes;
 * its removal is atomic with authoritative content metadata commit. */
export class StorageQuota {
 constructor({metadata,blobs,clock=()=>Date.now()}){Object.assign(this,{metadata,blobs,clock});}
 usage(owner){return this.metadata.transaction(tx=>storageState(tx,owner,this.clock()));}
 async check(owner,{bytes,replacedBytes=0}){
  count(bytes);count(replacedBytes);const growth=Math.max(0,bytes-replacedBytes);
  return this.metadata.transaction(async tx=>{const usage=await storageState(tx,owner,this.clock());if(usage.pendingUploads>=128||growth>0&&usage.usedBytes+usage.reservedBytes+growth>usage.storageBytes)throw new StorageError('account_quota_exceeded','Your storage limit has been reached. Delete items or choose a larger plan.',429);return true;});
 }
 async reserve(owner,{id,bytes,replacedBytes=0,blobRef,kind}){
  if(!/^[a-f0-9-]{36}$/.test(id)||!['message','object'].includes(kind)||typeof blobRef!=='string'||!blobRef.startsWith(`${kind==='message'?'messages':'objects'}/${owner}/`))throw new StorageError('invalid_args','Invalid storage reservation.');
  count(bytes);count(replacedBytes);const growth=Math.max(0,bytes-replacedBytes);
  return this.metadata.transaction(async tx=>{
   if(await tx.get(PREFIX+id))throw new StorageError('conflict','Upload reservation already exists.',409);
   const usage=await storageState(tx,owner,this.clock()),summary=await tx.get(SUMMARY)||{growthBytes:0,uploadBytes:0,count:0};
   if(summary.count>=128||growth>0&&usage.usedBytes+usage.reservedBytes+growth>usage.storageBytes)throw new StorageError('account_quota_exceeded','Your storage limit has been reached. Delete items or choose a larger plan.',429);
   const record={id,owner,bytes,growthBytes:growth,blobRef,kind,expiresAt:this.clock()+TTL};
   await tx.put(PREFIX+id,record);await tx.put(SUMMARY,{growthBytes:summary.growthBytes+growth,uploadBytes:summary.uploadBytes+bytes,count:summary.count+1});
   const alarm=typeof tx.getAlarm==='function'?await tx.getAlarm():null;await tx.setAlarm(alarm?Math.min(alarm,record.expiresAt):record.expiresAt);return record;
  });
 }
 async commit(tx,id){const record=await tx.get(PREFIX+id);if(!record||record.expiresAt<=this.clock())throw new StorageError('conflict','Upload reservation expired.',409);const usage=await storageState(tx,record.owner,this.clock());if(record.growthBytes>0&&usage.usedBytes+usage.reservedBytes-record.growthBytes>usage.storageBytes)throw new StorageError('account_quota_exceeded','Your storage limit has been reached. Delete items or choose a larger plan.',429);await this.remove(tx,record);}
 async remove(tx,record){const summary=await tx.get(SUMMARY);if(!summary)throw new StorageError('temporarily_unavailable','Storage accounting is unavailable.',503);await tx.delete(PREFIX+record.id);await tx.put(SUMMARY,{growthBytes:count(summary.growthBytes-record.growthBytes),uploadBytes:count(summary.uploadBytes-record.bytes),count:count(summary.count-1)});}
 async release(id){const record=await this.metadata.get(PREFIX+id);if(!record)return;try{await this.blobs.delete(record.blobRef);}catch{return;}await this.metadata.transaction(async tx=>{const current=await tx.get(PREFIX+id);if(current)await this.remove(tx,current);});}
 async cleanup({limit=32}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>128)throw new StorageError('invalid_args','Invalid cleanup batch.');const retry=await this.metadata.get('storage/cleanup-retry');if(!retryReady(retry,this.clock()))return {cleaned:0,pending:(await this.metadata.get(SUMMARY))?.count||0,paused:Boolean(retry?.paused)};let failed=false;const cursor=await this.metadata.get('storage/cleanup-cursor');let rows=await this.metadata.list({prefix:PREFIX,...cursor?{startAfter:cursor}:{},limit});if(!rows.size&&cursor)rows=await this.metadata.list({prefix:PREFIX,limit});let cleaned=0;
  for(const [,record] of rows)if(record.expiresAt<=this.clock()){await this.release(record.id);if(!await this.metadata.get(PREFIX+record.id))cleaned++;else failed=true;}
  if(failed)await retryFailure(this.metadata,'storage/cleanup-retry',null,this.clock());else if(!((await this.metadata.get(SUMMARY))?.count))await this.metadata.delete('storage/cleanup-retry');if(rows.size)await this.metadata.put('storage/cleanup-cursor',[...rows.keys()].at(-1));return {cleaned,pending:(await this.metadata.get(SUMMARY))?.count||0};
 }
 async nextCleanup(){const retry=await this.metadata.get('storage/cleanup-retry');if(retry)return retryTime(retry,this.clock());const rows=await this.metadata.list({prefix:PREFIX,limit:128});return rows.size?Math.min(...[...rows.values()].map(row=>Math.max(this.clock()+60000,row.expiresAt))):null;}
}
