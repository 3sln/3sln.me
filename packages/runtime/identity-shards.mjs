import {encodeFreeHandleNumber,normalizeHandle,validatePaidHandle,MAX_FREE_HANDLE_NUMBER} from '../identity/handles.mjs';
// The layout string is persisted routing protocol: changing it requires an
// offline, verified migration. No request consults the legacy singleton.
export const IDENTITY_LAYOUT = 'v1-64-fresh';
export const IDENTITY_SHARDS = 64;
const families = new Set(['account', 'handle', 'email', 'device', 'device-code', 'namespace']);
const namespaceKey = handle => `identity-namespace/${handle}`;
const MAX_HANDLE_NUMBER = MAX_FREE_HANDLE_NUMBER;
function namespaceIdentity(owner, assignmentId) {
  if (typeof owner !== 'string' || !owner || owner.length > 128 || assignmentId !== undefined && (typeof assignmentId !== 'string' || !assignmentId || assignmentId.length > 128)) throw new TypeError('Invalid handle allocation identity');
}
export async function identityShardName(kind, value) {
  if (!families.has(kind) || typeof value !== 'string' || !value) throw new TypeError('Invalid identity routing key');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return `identity-v1/${kind}/${String(bytes[0] % IDENTITY_SHARDS).padStart(2, '0')}`;
}
const recordKey = (kind, id) => `identity-record/${kind}/${id}`;
const lookupKey = (kind, value) => `identity-lookup/${kind}/${value}`;
const sameClaim = (a, b) => Boolean(a && b && a.owner === b.owner && a.token === b.token);
const sameLink = (a,b) => a.kind === b.kind && a.value === b.value && sameClaim(a,b);
const linksFor = (kind, value) => kind === 'account'
  ? [{kind:'handle', value:value.handle}, ...(value.verifiedEmail ? [{kind:'email', value:value.verifiedEmail}] : [])]
  : [{kind:'device-code', value:value.userCode}];

// These short transactions are the only cross-request atomic sections. They
// never perform RPC, so no distributed lock or global coordinator is required.
export class IdentityShardStorage {
  constructor(metadata) { this.metadata = metadata; }
  async read(kind, id) { return await this.metadata.get(recordKey(kind, id)) || null; }
  async prepare(kind, id, revision, value, token) {
    return this.metadata.transaction(async tx => {
      const key = recordKey(kind,id), state = await tx.get(key) || {value:null, links:[]};
      if (state.pending || (revision === null ? state.value !== null : state.value?.revision !== revision)) return false;
      if (value.id !== id || value.revision !== (revision === null ? 0 : revision + 1)) return false;
      if (state.value && (kind === 'account' ? value.handle !== state.value.handle || value.assignmentId !== state.value.assignmentId : value.userCode !== state.value.userCode || value.expiresAt !== state.value.expiresAt)) return false;
      const links = linksFor(kind,value).map(link => state.links.find(old => old.kind === link.kind && old.value === link.value) || {...link,owner:id,token});
      // The overwhelmingly common session/auth CAS never touches a lookup shard.
      if (state.value && links.length === state.links.length && links.every(link => state.links.includes(link))) {
        await tx.put(key,{value,links,namespaceBound:state.namespaceBound,result:{token,committed:true}}); return 'committed';
      }
      state.pending = {token, value, links, oldLinks:state.links, phase:'prepared'};
      await tx.put(key,state); return 'prepared';
    });
  }
  async settle(kind,id,token,commit) {
    return this.metadata.transaction(async tx => {
      const key=recordKey(kind,id), state=await tx.get(key);
      if (!state?.pending || state.pending.token !== token) return state?.result?.token === token ? state.result.committed : null;
      if (state.pending.phase !== 'prepared') return state.pending.phase === 'committed';
      state.pending.phase=commit?'committed':'aborted';
      if(commit){state.value=state.pending.value;state.links=state.pending.links;if(kind==='account')state.namespaceBound=true;}
      state.result={token,committed:commit};await tx.put(key,state);return commit;
    });
  }
  async finish(kind,id,token) {
    return this.metadata.transaction(async tx => {
      const key=recordKey(kind,id),state=await tx.get(key);
      if(state?.pending?.token===token && state.pending.phase!=='prepared'){delete state.pending;await tx.put(key,state);}
    });
  }
  async lookup(kind,value) {return await this.metadata.get(lookupKey(kind,value)) || null;}
  async claim(kind,value,claim) {
    return this.metadata.transaction(async tx => {
      const key=lookupKey(kind,value),old=await tx.get(key);
      if(old)return old;
      await tx.put(key,claim);return claim;
    });
  }
  async release(kind,value,claim) {
    return this.metadata.transaction(async tx => {
      const key=lookupKey(kind,value),old=await tx.get(key);
      if(sameClaim(old,claim)){await tx.delete(key);return true;}return false;
    });
  }
  async namespaceBound(id) {return this.metadata.transaction(async tx=>{const key=recordKey('account',id),state=await tx.get(key);if(state?.value){state.namespaceBound=true;await tx.put(key,state);}});}
  async handleClaim(handle, claim) {
    return this.metadata.transaction(async tx => {
      const key=namespaceKey(handle),old=await tx.get(key);
      if(old)return false;
      await tx.put(key,{owner:claim.owner,assignmentId:claim.assignmentId??null,state:'allocated'});return true;
    });
  }
  async handleConsume(handle, owner, assignmentId, token) {
    return this.metadata.transaction(async tx => {
      const key=namespaceKey(handle),old=await tx.get(key);
      if(old){
        if(old.owner!==owner||old.assignmentId!==(assignmentId??null))return false;
        if(old.state==='assigned')return old.createToken===token;
        if(old.state!=='allocated')return false;
      }
      await tx.put(key,{owner,assignmentId:assignmentId??null,state:'assigned',createToken:token});return true;
    });
  }
  async handleGrandfather(handle, owner, assignmentId, token) {
    return this.metadata.transaction(async tx => {
      const key=namespaceKey(handle),old=await tx.get(key);
      if(old)return old.owner===owner&&old.assignmentId===(assignmentId??null);
      await tx.put(key,{owner,assignmentId:assignmentId??null,state:'assigned',createToken:token});return true;
    });
  }
  async paidHandleRead(owner){return await this.metadata.get(`identity-paid-handle/${owner}`)||null;}
  async paidHandleAnchor(owner,handle,assignmentId) {
    return this.metadata.transaction(async tx=>{
      const key=`identity-paid-handle/${owner}`,old=await tx.get(key);
      if(old)return old;
      const value={handle,assignmentId,token:crypto.randomUUID(),state:'pending'};await tx.put(key,value);return value;
    });
  }
  async paidHandleFinish(owner,anchor,commit){
    return this.metadata.transaction(async tx=>{
      const key=`identity-paid-handle/${owner}`,old=await tx.get(key);
      if(old?.token!==anchor.token)return false;
      if(old.state==='committed')return commit;
      if(commit){await tx.put(key,{...old,state:'committed'});}else await tx.delete(key);
      return true;
    });
  }
  async paidHandleClaim(handle,owner,assignmentId) {
    return this.metadata.transaction(async tx=>{
      const key=namespaceKey(handle),old=await tx.get(key);
      if(old)return old.state==='paid-alias'&&old.owner===owner&&old.assignmentId===assignmentId;
      await tx.put(key,{owner,assignmentId,state:'paid-alias'});return true;
    });
  }
  async handleLookup(handle){return await this.metadata.get(namespaceKey(handle))||null;}
  async nextHandleNumber(lane) {
    if(!Number.isInteger(lane)||lane<0||lane>=IDENTITY_SHARDS)throw new TypeError('Invalid handle counter lane');
    return this.metadata.transaction(async tx => {
      const key='identity-global-handle-sequence',raw=await tx.get(key),stored=raw===undefined?'0':raw;
      if(typeof stored!=='string'||! /^(0|[1-9][0-9]{0,12})$/.test(stored))throw new Error('Invalid handle allocator state');
      const sequence=BigInt(stored)+1n,number=sequence*BigInt(IDENTITY_SHARDS)+BigInt(lane);
      if(number>MAX_HANDLE_NUMBER)throw new Error('Handle namespace exhausted');
      const burnKey=`identity-global-handle-number/${number}`;
      if(await tx.get(burnKey)!==undefined)throw new Error('Handle allocator counter reuse detected');
      await tx.put(burnKey,{lane,sequence:String(sequence)});
      await tx.put(key,String(sequence));return String(number);
    });
  }
  async page(kind,{cursor,limit=100}={}) {
    const rows=await this.metadata.list({prefix:`identity-record/${kind}/`,...(cursor?{startAfter:cursor}:{}),limit});
    return {rows:[...rows].map(([key,state])=>({key,id:state.value?.id || state.pending?.value.id})).filter(row=>row.id),cursor:rows.size===limit?[...rows.keys()].at(-1):null};
  }
}

export class ShardedIdentityRepository {
  constructor({shard,layout,clock=()=>Date.now()}) {
    if(layout!==IDENTITY_LAYOUT)throw new Error('Identity sharding requires explicit v1-64-fresh layout; legacy identity data must be migrated offline first.');
    this.shard=shard;this.clock=clock;
  }
  async bucket(kind,value){return this.shard(await identityShardName(kind,value));}
  async state(kind,id){return (await this.bucket(kind,id)).shardRead(kind,id);}
  async release(link){return (await this.bucket(link.kind,link.value)).shardRelease(link.kind,link.value,link);}
  active(state,link){return state?.links?.some(old=>old.kind===link.kind&&old.value===link.value&&sameLink(old,link));}
  async reserve(kind,link,depth) {
    const bucket=await this.bucket(link.kind,link.value);
    for(let attempt=0;attempt<2;attempt++){
      const owner=await bucket.shardClaim(link.kind,link.value,link);
      if(sameClaim(owner,link))return true;
      let state=await this.state(kind,owner.owner);
      if(state?.pending && depth<2){await this.resume(kind,owner.owner,state,depth+1);state=await this.state(kind,owner.owner);}
      // Expired device requests cannot approve or redeem a code. An old
      // request can never extend its expiration or remove a newer claim.
      const expired=kind==='device'&&state?.value?.expiresAt<=this.clock();
      if(!expired&&(this.active(state,owner)||state?.pending?.links.some(old=>sameLink(old,owner))))return false;
      if(link.kind==='handle')await (await this.bucket('namespace',link.value)).shardHandleGrandfather(link.value,owner.owner,state?.value?.assignmentId,owner.token);
      await bucket.shardRelease(link.kind,link.value,owner);
    }
    return false;
  }
  async resume(kind,id,state,depth=0,outcome) {
    let pending=state?.pending;if(!pending)return state;
    if(outcome?.token===pending.token&&pending.phase!=='prepared')outcome.committed=pending.phase==='committed';
    const bucket=await this.bucket(kind,id);
    if(pending.phase==='prepared'){
      let commit=true;
      if(kind==='account'&&!state.value){
        const value=pending.value,namespace=await this.bucket('namespace',value.handle),legacy=await (await this.bucket('handle',value.handle)).shardLookup('handle',value.handle);
        if(legacy&& !sameClaim(legacy,{owner:id,token:pending.token})){
          const oldState=await this.state('account',legacy.owner);
          await namespace.shardHandleGrandfather(value.handle,legacy.owner,oldState?.value?.assignmentId,legacy.token);
        }
        commit=await namespace.shardHandleConsume(value.handle,id,value.assignmentId,pending.token);
      }
      for(const link of pending.links){
        if(!commit)break;
        if(pending.oldLinks.some(old=>sameLink(old,link)))continue;
        if(!await this.reserve(kind,link,depth)){commit=false;break;}
      }
      const committed=await bucket.shardSettle(kind,id,pending.token,commit);
      // Retain the outcome already confirmed by the atomic commit. Another
      // helper may finalize and a later CAS may replace the latest receipt
      // before this caller receives its next read response.
      if(outcome?.token===pending.token&&typeof committed==='boolean')outcome.committed=committed;
      state=await bucket.shardRead(kind,id);
      // Another recovery may already have finished this operation.
      if(state?.pending?.token!==pending.token)return state;
      pending=state.pending;
    }
    const discard=pending.phase==='committed'?pending.oldLinks.filter(old=>!pending.links.some(link=>sameLink(old,link))):pending.links.filter(link=>!pending.oldLinks.some(old=>sameLink(old,link)));
    for(const link of discard)await this.release(link);
    await bucket.shardFinish(kind,id,pending.token);
    return bucket.shardRead(kind,id);
  }
  async read(kind,id){const state=await this.state(kind,id);
    if(kind==='account'&&state?.value&&!state.namespaceBound){const value=state.value;if(!await (await this.bucket('namespace',value.handle)).shardHandleGrandfather(value.handle,id,value.assignmentId,state.links?.find(l=>l.kind==='handle')?.token))throw new Error('Permanent handle assignment conflict');await (await this.bucket('account',id)).shardNamespaceBound(id);}
    return state?.pending?this.resume(kind,id,state):state;}
  async allocateFreeHandle(baseIgnored,owner=crypto.randomUUID(),assignmentId){
    namespaceIdentity(owner,assignmentId);
    const random=crypto.getRandomValues(new Uint8Array(1))[0],lane=random%IDENTITY_SHARDS;
    const number=await this.shard(`identity-v1/allocator/${String(lane).padStart(2,'0')}`).shardNextHandleNumber(lane);
    const handle=encodeFreeHandleNumber(number);
    const legacy=await (await this.bucket('handle',handle)).shardLookup('handle',handle);
    if(legacy){const old=await this.state('account',legacy.owner);await (await this.bucket('namespace',handle)).shardHandleGrandfather(handle,legacy.owner,old?.value?.assignmentId,legacy.token);}
    if(!await (await this.bucket('namespace',handle)).shardHandleClaim(handle,{owner,assignmentId}))throw new Error('Permanent handle allocation collision');
    return handle;
  }
  async get(id){return (await this.read('account',id))?.value || null;}
  async getDevice(id){return (await this.read('device',id))?.value || null;}
  async find(kind,value,recordKind,field){
    const bucket=await this.bucket(kind,value),link=await bucket.shardLookup(kind,value);if(!link)return null;
    const state=await this.read(recordKind,link.owner);
    if(!this.active(state,link)||state.value?.[field]!==value){
      // A pending operation may still own this claim; leave it for recovery.
      if(!state?.pending?.links.some(old=>sameLink(old,link))){
        if(kind==='handle')await (await this.bucket('namespace',value)).shardHandleGrandfather(value,link.owner,state?.value?.assignmentId,link.token);
        await bucket.shardRelease(kind,value,link);
      }
      return null;
    }
    if(recordKind==='device'&&state.value.expiresAt<=this.clock())return null;
    return state.value;
  }
  async findByHandle(handle){
    handle=normalizeHandle(handle);
    const claim=await (await this.bucket('namespace',handle)).shardHandleLookup(handle);
    if(claim?.state==='paid-alias'){const account=await this.get(claim.owner);return account?.assignmentId===claim.assignmentId?account:null;}
    return this.find('handle',handle,'account','handle');
  }
  async paidHandleForOwner(owner){const account=await this.get(owner);if(!account)return null;const anchor=await (await this.bucket('namespace',`paid-owner:${owner}`)).shardPaidHandleRead(owner);return anchor?.state==='committed'&&anchor.assignmentId===account.assignmentId?anchor.handle:null;}
  // Callers must establish paid eligibility and recent authentication first.
  async claimPaidHandle(handle,owner,assignmentId){
    handle=validatePaidHandle(handle);
    namespaceIdentity(owner,assignmentId);if(assignmentId===undefined)throw new TypeError('Assignment ID required');
    const account=await this.get(owner);if(!account||account.assignmentId!==assignmentId)return false;
    const coordinator=await this.bucket('namespace',`paid-owner:${owner}`);
    for(let attempt=0;attempt<2;attempt++){
      const anchor=await coordinator.shardPaidHandleAnchor(owner,handle,assignmentId);
      if(anchor.state==='committed')return anchor.handle===handle&&anchor.assignmentId===assignmentId;
      const namespace=await this.bucket('namespace',anchor.handle),legacy=await (await this.bucket('handle',anchor.handle)).shardLookup('handle',anchor.handle);
      if(legacy){const old=await this.state('account',legacy.owner);await namespace.shardHandleGrandfather(anchor.handle,legacy.owner,old?.value?.assignmentId,legacy.token);}
      const claimed=await namespace.shardPaidHandleClaim(anchor.handle,owner,anchor.assignmentId);
      await coordinator.shardPaidHandleFinish(owner,anchor,claimed);
      if(claimed)return anchor.handle===handle&&anchor.assignmentId===assignmentId;
      if(anchor.handle===handle)return false;
    }
    return false;
  }
  findByEmail(email){return this.find('email',email,'account','verifiedEmail');}
  findDeviceByCode(code){return this.find('device-code',code,'device','userCode');}
  async write(kind,id,revision,value){
    await this.read(kind,id);
    const bucket=await this.bucket(kind,id),token=crypto.randomUUID();
    const prepared=await bucket.shardPrepare(kind,id,revision,value,token);
    if(!prepared)return false;if(prepared==='committed')return true;
    const outcome={token},state=await this.resume(kind,id,await bucket.shardRead(kind,id),0,outcome);
    return outcome.committed ?? (state?.result?.token===token&&state.result.committed===true);
  }
  create(value){return this.write('account',value.id,null,value);}
  compareAndSwap(id,revision,value){return this.write('account',id,revision,value);}
  createDevice(value){return this.write('device',value.id,null,value);}
  compareAndSwapDevice(id,revision,value){return this.write('device',id,revision,value);}
  async lifecycleCandidates({cursor,limit=100}={}){
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new TypeError('Invalid lifecycle page size');
    let shard=0,after;
    if(cursor){const parsed=JSON.parse(cursor);shard=parsed.shard;after=parsed.after;if(!Number.isInteger(shard)||shard<0||shard>=IDENTITY_SHARDS||after&&typeof after!=='string')throw new TypeError('Invalid identity cursor');}
    const bucket=this.shard(`identity-v1/account/${String(shard).padStart(2,'0')}`);
    const page=await bucket.shardPage('account',{cursor:after,limit});
    const accounts=[];
    for(const row of page.rows){const a=await this.get(row.id);if(a)accounts.push({cursor:row.key,id:a.id,status:a.status,createdAt:a.createdAt,lastActiveAt:a.lastActiveAt,verifiedEmail:Boolean(a.verifiedEmail)});}
    return {accounts,cursor:page.cursor?JSON.stringify({shard,after:page.cursor}):shard+1<IDENTITY_SHARDS?JSON.stringify({shard:shard+1}):null};
  }
}
