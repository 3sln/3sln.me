// Receive budgets: a BindleBox copy of the reference-service receipt limits (messaging.md "Reference-service receipt
// limits"; extraction §2 copies, never imports, packages/runtime/message-receipt-budget.mjs), plus the per-sender and
// per-domain layers of architecture §11 and the public-request limits of §12.1. Pure: the caller loads and stores the
// state inside its admission transaction, after replay resolution (a replay is never charged) and before any
// classification. UTC fixed windows. Debits are nonrefundable. Values are provisional service policy.
import {MailboxFault} from '../faults.mjs';

export const WINDOWS=Object.freeze({minute:60000,hour:3600000,day:86400000});
const MiB=1048576,names=Object.keys(WINDOWS);
const owner=(m,b)=>Object.freeze(Object.fromEntries(names.map((n,i)=>[n,Object.freeze({messages:m[i],bytes:b[i]*MiB})])));
const half=limits=>Object.freeze(Object.fromEntries(Object.entries(limits).map(([n,l])=>[n,Object.freeze({messages:l.messages/2,bytes:l.bytes/2})])));
const plan=(m,b)=>{const o=owner(m,b);return Object.freeze({owner:o,parent:half(o),sender:Object.freeze({messages:Math.max(10,m[2]/10),bytes:b[2]*MiB/8}),
 // §12.1: per sender principal or address 5/day, per email domain 50/day, per owner 200 public requests/day. The
 // native issuer-domain row is a provisional reading (a hostile provider can mint principals cheaply).
 public:Object.freeze({sender:5,emailDomain:50,issuer:100,owner:200})});};
export const BUDGET_DEFAULTS=Object.freeze({free:plan([30,300,1000],[16,128,512]),paid:plan([120,1000,5000],[64,512,2048]),plus:plan([240,2000,10000],[128,1024,4096]),ultra:plan([240,2000,10000],[256,2048,8192])});
// Hard cardinality ceiling for per-day maps; exceeding it fails closed as rate_limited rather than growing rows.
export const MAX_DAY_KEYS=4096;

const epochs=now=>Object.fromEntries(names.map(n=>[n,Math.floor(now/WINDOWS[n])]));
const retryAfter=(window,now)=>Math.max(1,Math.ceil(((Math.floor(now/WINDOWS[window])+1)*WINDOWS[window]-now)/1000));
const limited=(window,now)=>{const error=new MailboxFault('rate_limited','Too many messages. Try again later.',429);error.retryAfter=retryAfter(window,now);throw error;};
const fresh=now=>{const e=epochs(now);return {version:1,windows:Object.fromEntries(names.map(n=>[n,{epoch:e[n],messages:0,bytes:0}])),day:e.day,parents:{},senders:{},public:{owner:0,senders:{},domains:{}}};};
// Rolls stale windows forward and drops yesterday's per-key maps, so state never outlives one UTC day.
export function currentBudget(state,now){
 if(!state||state.version!==1)return fresh(now);
 const e=epochs(now),next=structuredClone(state);
 for(const n of names)if(next.windows[n]?.epoch!==e[n])next.windows[n]={epoch:e[n],messages:0,bytes:0};
 if(next.day!==e.day){next.day=e.day;next.parents={};next.senders={};next.public={owner:0,senders:{},domains:{}};}
 return next;
}
const fits=(row,limit,bytes)=>row.messages+1<=limit.messages&&row.bytes+bytes<=limit.bytes;
// One admitted new message attempt. charge = {bytes, parent (jti), sender (principal key), request?:{sender, domain,
// email}}. Every layer is checked before any is applied. A message larger than any configured window is too_large.
export function chargeBudget(state,{now,plan:planName='free',limits=BUDGET_DEFAULTS[planName]??BUDGET_DEFAULTS.free,bytes,parent,sender,request}){
 if(!Number.isSafeInteger(bytes)||bytes<0)throw new TypeError('Invalid charge');
 const next=currentBudget(state,now);
 for(const n of names){if(bytes>limits.owner[n].bytes||bytes>limits.parent[n].bytes)throw new MailboxFault('too_large','The message is too large.',413);}
 for(const n of names)if(!fits(next.windows[n],limits.owner[n],bytes))limited(n,now);
 const parentRow=next.parents[parent]??{messages:0,bytes:0},senderRow=next.senders[sender]??{messages:0,bytes:0};
 if(!fits(parentRow,limits.parent.day,bytes)||!fits(senderRow,limits.sender,bytes))limited('day',now);
 const newKeys=(next.parents[parent]?0:1)+(next.senders[sender]?0:1)+(request&&!next.public.senders[request.sender]?1:0)+(request?.domain&&!next.public.domains[request.domain]?1:0);
 if(Object.keys(next.parents).length+Object.keys(next.senders).length+Object.keys(next.public.senders).length+Object.keys(next.public.domains).length+newKeys>MAX_DAY_KEYS)limited('day',now);
 if(request){
  const p=limits.public,domainLimit=request.email?p.emailDomain:p.issuer;
  if(next.public.owner+1>p.owner||(next.public.senders[request.sender]??0)+1>p.sender||(request.domain&&(next.public.domains[request.domain]??0)+1>domainLimit))limited('day',now);
  next.public.owner++;next.public.senders[request.sender]=(next.public.senders[request.sender]??0)+1;if(request.domain)next.public.domains[request.domain]=(next.public.domains[request.domain]??0)+1;
 }
 for(const n of names){next.windows[n].messages++;next.windows[n].bytes+=bytes;}
 next.parents[parent]={messages:parentRow.messages+1,bytes:parentRow.bytes+bytes};next.senders[sender]={messages:senderRow.messages+1,bytes:senderRow.bytes+bytes};
 return next;
}
// Read-only pre-check of the owner layer (no sender identity, so it is not an oracle), used before expensive work.
export function ownerExhausted(state,{now,plan:planName='free',limits=BUDGET_DEFAULTS[planName]??BUDGET_DEFAULTS.free}){
 const current=currentBudget(state,now);for(const n of names)if(current.windows[n].messages>=limits.owner[n].messages)limited(n,now);return false;
}
