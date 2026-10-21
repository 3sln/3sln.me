// Long-poll waiting outside the account object (docs/spec/events.md §4.2, §9; Q12, decided provisionally for EV-2).
//
// The account object never holds a request. An empty `read` with `wait` > 0 is admitted there as a lease (caps and the
// daily wait-second budget are charged in its commit) and answered at once with `{wait: {lease, bus, until, mark}}`.
// An adapter outside the account object then holds the request on a small per-account wait object (`BusWaiterCore`;
// the Worker class is apps/worker/event-bus-waiter.mjs) and resumes the read with the lease. The account object can
// therefore idle and be evicted while polls wait; publishes and revocations ring the wait object.
//
// `mark` is the raw bus head at admission and stays server side: the adapter strips `wait` before answering a client.
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

/** In-memory waiters for one account. `wait` resolves {reason: 'advanced'|'revoked'|'timeout'}; nothing is stored. A
 * wait object that restarted between a publish and a wait has lost the head and simply times out; the resumed read
 * still returns every record (latency, never loss). */
export class BusWaiterCore{
 constructor({clock={now:()=>Date.now()},maxWaiters=64,maxMs=26000}={}){Object.assign(this,{clock,maxWaiters,maxMs});this.heads=new Map();this.waiters=new Map();this.size=0;}
 advance({bus,head}={}){
  if(typeof bus!=='string'||!Number.isSafeInteger(head))return {woken:0};
  if(head>(this.heads.get(bus)??-1))this.heads.set(bus,head);
  if(this.heads.size>256)this.heads.delete(this.heads.keys().next().value);
  let woken=0;for(const waiter of [...this.waiters.get(bus)??[]])if(waiter.mark<head){waiter.finish('advanced');woken++;}return {woken};
 }
 revoke({bus}={}){let woken=0;for(const waiter of [...this.waiters.get(bus)??[]]){waiter.finish('revoked');woken++;}return {woken};}
 wait({bus,mark,until}={}){
  if(typeof bus!=='string'||!Number.isSafeInteger(mark)||!Number.isSafeInteger(until))return Promise.resolve({reason:'timeout'});
  if((this.heads.get(bus)??-1)>mark)return Promise.resolve({reason:'advanced'});
  const ms=clamp(until-this.clock.now(),0,this.maxMs);if(!ms||this.size>=this.maxWaiters)return Promise.resolve({reason:'timeout'});
  return new Promise(resolve=>{
   const set=this.waiters.get(bus)??new Set();this.waiters.set(bus,set);
   const waiter={mark,finish:reason=>{if(!set.delete(waiter))return;this.size--;clearTimeout(timer);if(!set.size)this.waiters.delete(bus);resolve({reason});}};
   const timer=setTimeout(()=>waiter.finish('timeout'),ms);set.add(waiter);this.size++;
  });
 }
}

/** Name of an account's wait object; one object per account multiplexes all of its buses (at most 8 waits, §9). */
export const busWaiterName=owner=>`event-bus-waits-v1/${owner}`;
/** The notifier/wait port over a Durable Object namespace binding (`EVENT_BUS_WAITS`). */
export function busWaitsPort(namespace){
 if(!namespace||typeof namespace.idFromName!=='function')return null;
 const stub=owner=>namespace.get(namespace.idFromName(busWaiterName(owner)));
 return {advance:({owner,bus,head})=>stub(owner).advance({bus,head}),revoke:({owner,bus})=>stub(owner).revoke({bus}),wait:({owner,bus,mark,until})=>stub(owner).wait({bus,mark,until})};
}
/** The same port over in-process cores (Node and tests). */
export function memoryBusWaits(options){
 const cores=new Map(),core=owner=>{let found=cores.get(owner);if(!found){found=new BusWaiterCore(options);cores.set(owner,found);}return found;};
 return {advance:({owner,bus,head})=>core(owner).advance({bus,head}),revoke:({owner,bus})=>core(owner).revoke({bus}),wait:({owner,bus,mark,until})=>core(owner).wait({bus,mark,until}),cores};
}

/**
 * Adapter orchestration for one long-poll (app-engine §4 "adapter orchestration"): `read(lease?)` performs the account
 * read (a fresh grant check every time), `waits` is the port above. Waits are held in slices of at most
 * `revokeCheckMs`; between slices `recheck()` (the edge's live grant check, which does not wake the account object)
 * runs, so a revoked reader is answered `forbidden` within 5 s even when no revocation hook rang (§8). The lease is
 * always resumed (released) through the account, whatever the wait outcome.
 */
export async function holdBusRead({owner,read,waits,recheck,clock={now:()=>Date.now()},revokeCheckMs=5000}){
 const first=await read(undefined);if(!first?.wait)return first;
 const {lease,bus,until,mark}=first.wait;let denied=null;
 try{
  // Bounded by slice count as well as time, so a skewed or stalled clock can never spin.
  for(let slices=Math.ceil(Math.max(0,until-clock.now())/revokeCheckMs)+1;slices>0&&clock.now()<until;slices--){
   const outcome=await waits.wait({owner,bus,mark,until:Math.min(until,clock.now()+revokeCheckMs)});
   if(outcome?.reason==='advanced'||outcome?.reason==='revoked')break;
   if(recheck&&clock.now()<until)try{await recheck();}catch(error){denied=error;break;}
  }
 }catch{/* A lost wait object degrades to an immediate resume; the resumed read answers from storage. */}
 const resumed=await read(lease);if(denied)throw denied;return resumed;
}
/** Strip adapter-internal members before a result leaves the host. */
export const publicRead=result=>{if(!result||typeof result!=='object')return result;const {wait,...rest}=result;return rest;};
/** Federation envelope adapter; internal wait leases never enter the public RPC result. */
export async function holdBusRPC({owner,waits,rpc,recheck}){
 let response,admitted;const result=await holdBusRead({owner,waits,recheck:recheck?()=>recheck(admitted):undefined,read:async lease=>{response=await rpc(lease);admitted=response.result?.wait?.lease??admitted;return response.result;}});
 return response.error?response:{...response,result:publicRead(result)};
}
