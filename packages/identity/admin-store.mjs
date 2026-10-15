import {hex} from './boot.mjs';
// One linearizable authority (a Node SQLite file or a single Durable Object).
// Policy lives in AdminService; this layer enforces only invariants that must
// hold even for a buggy caller: optimistic revisions, forever-consumed boot
// tokens, a hash-chained append-only audit log and per-actor windows.
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const KEY=/^(?:boot\/(?:principal|sessions)|boot-token\/[a-f0-9]{64}|catalog|reservation\/[a-z0-9][a-z0-9_-]{2,31}|claim\/[a-f0-9-]{36}|claim-name\/[a-z0-9][a-z0-9_-]{2,31}|principal\/[a-f0-9-]{36})$/;
const LIST=/^(?:audit\/|principal\/|reservation\/|claim\/)$/;
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value??null);
const auditHash=async(prev,entry)=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(prev+'\n'+canonical(entry))));
const pad=seq=>String(seq).padStart(12,'0');
export class AdminStorage {
 constructor(metadata){this.metadata=metadata;}
 async invoke(method,args){if(!['get','list','commit','verifyAudit'].includes(method))throw new TypeError('Unknown admin storage method');return this[method](...args);}
 async get(key){if(!KEY.test(key)&&key!=='audit-head')throw new TypeError('Invalid admin key');return await this.metadata.get('admin/'+key)??null;}
 async list(prefix,{startAfter='',limit=50}={}){if(!LIST.test(prefix)||typeof startAfter!=='string'||startAfter.length>64||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid admin listing');const rows=await this.metadata.list({prefix:'admin/'+prefix,startAfter:startAfter?'admin/'+prefix+startAfter:'',limit});return [...rows].map(([key,value])=>({key:key.slice(6+prefix.length),value}));}
 /** expect {key: revision|null}; writes {key: value|null}; audit entry; rate {key,limit,windowMs,now}. */
 async commit({expect={},writes={},audit,rate}={}){
  for(const key of [...Object.keys(expect),...Object.keys(writes)])if(!KEY.test(key))throw new TypeError('Invalid admin key');
  if(rate&&(typeof rate.key!=='string'||!/^[a-z0-9:-]{1,80}$/.test(rate.key)||!Number.isInteger(rate.limit)||!Number.isSafeInteger(rate.windowMs)||!Number.isSafeInteger(rate.now)))throw new TypeError('Invalid admin rate');
  return this.metadata.transaction(async tx=>{
   for(const [key,revision] of Object.entries(expect)){const old=await tx.get('admin/'+key);if((old?.revision??null)!==revision)return {committed:false,conflict:key};}
   if(rate){const key='admin/rate/'+rate.key,window=await tx.get(key),fresh=!window||window.start+rate.windowMs<=rate.now||window.start>rate.now,next=fresh?{start:rate.now,count:1}:{start:window.start,count:window.count+1};if(next.count>rate.limit)return {committed:false,rateLimited:true};await tx.put(key,next);}
   const stored={};
   for(const [key,value] of Object.entries(writes)){const old=await tx.get('admin/'+key);
    if(key.startsWith('boot-token/')){if(value===null||old?.phase==='consumed'||!['reserved','consumed'].includes(value?.phase)||old&&value.phase!=='consumed'||!old&&value.phase!=='reserved')fail('boot_token_consumed','This boot token was already used.');}
    if(value===null){await tx.delete('admin/'+key);continue;}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid admin record');
    stored[key]={...value,revision:(old?.revision??0)+1};await tx.put('admin/'+key,stored[key]);}
   let entry=null;if(audit){const head=await tx.get('admin/audit-head')??{seq:0,hash:'0'.repeat(64)},seq=head.seq+1;entry={...JSON.parse(JSON.stringify(audit)),seq,prev:head.hash};entry.hash=await auditHash(head.hash,entry);await tx.put('admin/audit/'+pad(seq),entry);await tx.put('admin/audit-head',{seq,hash:entry.hash});}
   return {committed:true,records:stored,audit:entry};
  });
 }
 /** Re-walks the chain from `from` (default: genesis) for `count` entries; the
  * head must match only when the walk reaches the end. */
 async verifyAudit({from=1,count=Infinity}={}){if(!Number.isSafeInteger(from)||from<1)throw new TypeError('Invalid audit range');let prev='0'.repeat(64),seq=from-1,startAfter=pad(from-1),seen=0;if(from>1){const before=await this.metadata.get('admin/audit/'+pad(from-1));if(!before)return {valid:false,seq:from-1};prev=before.hash;}
  while(seen<count){const rows=await this.list('audit/',{startAfter,limit:100});if(!rows.length)break;for(const {key,value} of rows){if(seen>=count)break;const {hash,...rest}=value;if(value.seq!==seq+1||key!==pad(value.seq)||value.prev!==prev||hash!==await auditHash(prev,rest))return {valid:false,seq:seq+1};prev=hash;seq=value.seq;seen++;}startAfter=rows.at(-1).key;}
  const head=await this.get('audit-head');if(seen<count)return {valid:(head?.seq??0)===seq&&(head?.hash??'0'.repeat(64))===prev,seq};return {valid:true,seq};}
}
/** Worker adapter: every call crosses an RPC boundary as structured clones. */
export const remoteAdminStore=invoke=>({get:key=>invoke('get',[key]),list:(prefix,options)=>invoke('list',[prefix,options]),commit:input=>invoke('commit',[input]),verifyAudit:options=>invoke('verifyAudit',[options])});
