import {key} from '../messaging/store.mjs';

// Account-local storage effects of the lifecycle executor: irreversible hosted
// purge after the final grace period, and suspension-time cold tiering. Every
// batch is bounded, resumable from a durable cursor and fenced by a fresh
// lifecycle step (phase, paid protection, admin hold) before it touches data.
export const PURGE_KEY='lifecycle/purge-v1',COLD_KEY='lifecycle/cold-v1',TOMBSTONE_KEY='lifecycle/tombstone-v1';
const ARCHIVE_ROWS=2200,MAX_COLD_BYTES=16777216;

/** Only provider-owned hosted prefixes with exact owner evidence are removable.
 * External connector objects are never addressed by these references. */
export function ownedBlobRef(owner,ref){return typeof ref==='string'&&ref.length<=1024&&(ref.startsWith(`messages/${owner}/`)||ref.startsWith(`objects/${owner}/`))&&!ref.includes('..');}
function collectRefs(value,out,depth=0){
 if(depth>6||!value||typeof value!=='object')return out;
 if(typeof value.blobRef==='string')out.add(value.blobRef);
 for(const child of Array.isArray(value)?value:Object.values(value))if(child&&typeof child==='object')collectRefs(child,out,depth+1);
 return out;
}
function rowRefs(path,value){const refs=collectRefs(value,new Set());if(path.startsWith('blob-garbage/')&&typeof value==='string')refs.add(value);return refs;}
async function archiveRows(c,owner){
 const object=await c.archives.get(`accounts/${owner}.json`);if(!object)return null;
 if(object.size>8388608)throw Object.assign(new Error('Account archive exceeds bounds'),{code:'lifecycle_archive_invalid'});
 const envelope=await object.json();if(envelope?.version!==1||envelope.owner!==owner||!Array.isArray(envelope.rows)||envelope.rows.length>ARCHIVE_ROWS)throw Object.assign(new Error('Account archive invalid'),{code:'lifecycle_archive_invalid'});
 return envelope.rows;
}

/** Purge preconditions read outside the lifecycle transaction. External
 * connector resources keep their host-held mappings until a verified owner
 * reconstruction export exists (docs/release/account-lifecycle-executor-design.md),
 * so such accounts are held at purge review instead of being deleted. */
export async function externalResourcesPresent(c,owner){
 const external=row=>row&&row.kind!=='app-connection'&&row.provider!=='hosted';
 for(const value of (await c.metadata.list({prefix:'resource/'})).values())if(external(value))return true;
 if((await c.metadata.list({prefix:'drive/',limit:1})).size)return true;
 if(await c.metadata.get('shelved')){const rows=await archiveRows(c,owner);if(!rows)return true;if(rows.some(row=>Array.isArray(row)&&String(row[0]).startsWith('resource/')&&external(row[1])))return true;}
 return false;
}
export async function purgeEligibleInTransaction(tx){for(const value of (await tx.list({prefix:'resource/'})).values())if(value&&value.kind!=='app-connection'&&value.provider!=='hosted')return false;return !(await tx.list({prefix:'drive/',limit:1})).size;}

/** Advances the irreversible purge by one bounded batch. `fence()` must re-run
 * the lifecycle step and return true only while the account is still purging,
 * unpaid and not administratively held. Returns {done, stage}. */
export async function purgeBatch(c,owner,{identity,fence,budget=64,log=()=>{}}){
 let job=await c.metadata.get(PURGE_KEY);
 if(!job){const current=await identity.get(owner);job={version:1,owner,stage:'identity',assignmentId:current?.assignmentId,cursor:null,archiveIndex:0,deleted:0,foreign:0,startedAt:Date.now()};await c.metadata.put(PURGE_KEY,job);}
 if(job.version!==1||job.owner!==owner)throw Object.assign(new Error('Purge job requires review'),{code:'lifecycle_unavailable'});
 if(!await fence())return {done:false,stage:job.stage,halted:true};
 const save=async()=>c.metadata.put(PURGE_KEY,job);
 let work=0;const remove=async ref=>{if(!ownedBlobRef(owner,ref)){job.foreign++;return;}await c.blobs.delete(ref);job.deleted++;work++;};
 if(job.stage==='identity'){
  await c.connectionsSeverAccount?.(owner,{reason:'lifecycle-tombstone'});
  // Authentication, sessions, recovery and the email claim end first; the handle stays reserved forever.
  if(!await identity.tombstone(owner,{assignmentId:job.assignmentId}))throw Object.assign(new Error('Identity unavailable for tombstoning'),{code:'lifecycle_identity_unavailable'});
  job.stage='vectors';await save();log({action:'purge-identity-tombstoned'});
 }
 if(job.stage==='vectors'){
  if((await c.metadata.list({prefix:key('search-vector-revision',owner),limit:1})).size){
   if(!await c.metadata.get('search-vector-purge'))await c.metadata.put('search-vector-purge',{owner});
   try{await c.configureSemanticSearch(owner);}catch{}
   if(c.search?.vectorIndex){await c.purgeSearchVectors(owner,{limit:20});if(await c.metadata.get('search-vector-purge'))return {done:false,stage:job.stage};}
   else job.vectorIndexUnavailable=true;
  }
  job.stage='archive';await save();
 }
 if(job.stage==='archive'){
  const rows=await c.metadata.get('shelved')?await archiveRows(c,owner):null;
  if(rows){
   const refs=[...new Set(rows.flatMap(row=>Array.isArray(row)?[...rowRefs(String(row[0]),row[1])]:[]))];
   while(job.archiveIndex<refs.length&&work<budget){await remove(refs[job.archiveIndex]);job.archiveIndex++;}
   await save();if(job.archiveIndex<refs.length)return {done:false,stage:job.stage};
  }
  job.stage='blobs';await save();
 }
 if(job.stage==='blobs'){
  for(let pages=0;work<budget&&pages<16;pages++){
   const rows=await c.metadata.list({prefix:'',...job.cursor?{startAfter:job.cursor}:{},limit:32});
   for(const [path,value]of rows)for(const ref of rowRefs(path,value))await remove(ref);
   if(rows.size)job.cursor=[...rows.keys()].at(-1);await save();
   if(rows.size<32){job.stage='metadata';await save();break;}
  }
  if(job.stage==='blobs')return {done:false,stage:job.stage};
 }
 if(job.stage==='metadata'){
  if(!await fence())return {done:false,stage:job.stage,halted:true};
  await c.archives.delete(`accounts/${owner}.json`);
  const tombstone={version:1,owner,deletedAt:Date.now(),reason:'inactive-unpaid',deletedBlobs:job.deleted,foreignReferences:job.foreign,vectorIndexUnavailable:job.vectorIndexUnavailable===true};
  // The tombstone is written before the wipe and survives it, so a crash never leaves a rebuildable empty account.
  await c.metadata.put(TOMBSTONE_KEY,tombstone);
  if(typeof c.metadata.purgeAll==='function')await c.metadata.purgeAll({keep:['owner',TOMBSTONE_KEY]});
  else{const wiped=c.metadata.deleteAll(),restored=c.metadata.put({owner,[TOMBSTONE_KEY]:tombstone});await wiped;await restored;}
  log({action:'deleted',deletedBlobs:job.deleted,foreignReferences:job.foreign});
  return {done:true,stage:'deleted'};
 }
 return {done:false,stage:job.stage};
}

/** Suspension-time cold tiering. The R2 Workers binding has no copy or
 * in-place class change; `put` accepts `storageClass`, so the closest supported
 * path rewrites identical bytes at the same key with `InfrequentAccess`, guarded
 * by `onlyIf.etagMatches`. Access is already denied by the lifecycle fence; the
 * tier only changes cost. Hosts without storage-class support (Node FileBucket)
 * report the job unsupported instead of simulating savings. */
export async function coldBatch(c,owner,{generation,blocked,minBytes=0,budget=16,supported=false}){
 let job=await c.metadata.get(COLD_KEY);
 if(!job||job.generation!==generation)return {done:true};
 if(!supported){job={...job,stage:'unsupported'};await c.metadata.put(COLD_KEY,job);return {done:true,unsupported:true};}
 if(job.stage==='done'||job.stage==='unsupported')return {done:true};
 let work=0;
 const tier=async ref=>{
  if(!ownedBlobRef(owner,ref)){job.skipped++;return true;}
  if(!await blocked())return false;work++;
  const object=await c.blobs.get(ref);if(!object||object.storageClass==='InfrequentAccess'||object.size<minBytes||object.size>MAX_COLD_BYTES){job.skipped++;return true;}
  const bytes=await object.arrayBuffer();
  const written=await c.blobs.put(ref,bytes,{storageClass:'InfrequentAccess',onlyIf:{etagMatches:object.etag},...object.httpMetadata?{httpMetadata:object.httpMetadata}:{},...object.customMetadata?{customMetadata:object.customMetadata}:{}});
  if(written)job.moved++;else job.skipped++;return true;
 };
 try{
  if(job.stage==='metadata'){
   for(let pages=0;work<budget&&pages<16;pages++){
    const rows=await c.metadata.list({prefix:'',...job.cursor?{startAfter:job.cursor}:{},limit:32});
    for(const [path,value]of rows){if(path.startsWith('blob-garbage/'))continue;for(const ref of collectRefs(value,new Set()))if(!await tier(ref))return {done:false,halted:true};}
    if(rows.size)job.cursor=[...rows.keys()].at(-1);await c.metadata.put(COLD_KEY,job);
    if(rows.size<32){job.stage='archive';job.archiveIndex=0;await c.metadata.put(COLD_KEY,job);break;}
   }
   if(job.stage==='metadata')return {done:false};
  }
  if(job.stage==='archive'){
   const rows=await c.metadata.get('shelved')?await archiveRows(c,owner):null,refs=rows?[...new Set(rows.flatMap(row=>Array.isArray(row)?[...collectRefs(row[1],new Set())]:[]))]:[];
   while(job.archiveIndex<refs.length&&work<budget){if(!await tier(refs[job.archiveIndex]))return {done:false,halted:true};job.archiveIndex++;}
   if(job.archiveIndex>=refs.length)job.stage='done';await c.metadata.put(COLD_KEY,job);
  }
 }catch(error){
  // Storage admission or provider failure pauses tiering; access stays fenced regardless.
  job.failures=(job.failures||0)+1;job.lastError=error?.code||'cold_storage_unavailable';await c.metadata.put(COLD_KEY,job);return {done:false,failed:true};
 }
 return {done:job.stage==='done'};
}
export const coldJob=generation=>({version:1,generation,stage:'metadata',cursor:null,archiveIndex:0,moved:0,skipped:0});
