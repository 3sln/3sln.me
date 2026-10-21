// Independent catalogue (messaging-extraction.md §7). Planned rows are not implementations.
const row=(placement,kind,status,summary,extra={})=>Object.freeze({placement,kind,status,summary,...extra});
export const PROVIDERS=Object.freeze({
 mailboxStore:row('mailbox','platform','local','Transactional mailbox metadata; the single-writer commit boundary.'),
 itemIndex:row('mailbox','platform','planned','Mailbox item index on the same handle as mailboxStore.'),
 userStorage:row('mailbox','platform','planned','Ordinary object-storage resource client.'),
 delegateKeys:row('mailbox','platform','local','App-held delegate keys and certificates.'),
 clock:row('both','effect','skeleton','Injected {now()} in epoch milliseconds.'),
 random:row('both','effect','skeleton','Injected {uuid(),bytes(n)}.'),
 audit:row('both','effect','skeleton','Injected {record(entry)}; never records input.'),
 egress:row('both','effect','local','Injected transport; CLI and tests use only simulated peers.'),
 providerLink:row('both','effect','local','Injected links contract; CLI uses local signed link fixtures.'),
 directory:row('both','effect','local','Injected identity directory and status; CLI uses ephemeral local keys.'),
 classifier:row('mailbox','effect','planned','Optional classifier slot; absent means no AI.'),
 activity:row('mailbox','effect','planned','Ordinary consented activity submission.'),
 contacts:row('mailbox','domain','local','Contact parents and intake.',{scoped:true}),
 receive:row('mailbox','domain','local','Admission and replay.',{scoped:true}),
 outbox:row('mailbox','domain','local','Durable send obligations.',{scoped:true}),
 conversations:row('mailbox','domain','planned','Bilateral conversation state.',{scoped:true}),
 views:row('mailbox','domain','planned','Saved Views.',{scoped:true}),
 rules:row('mailbox','domain','planned','Organization rules.',{scoped:true}),
 tags:row('mailbox','domain','planned','Tag labels and provenance.',{scoped:true}),
 bridge:row('mailbox','domain','planned','Verified bridge intake.',{scoped:true}),
 archive:row('mailbox','domain','planned','Portable archive and writer lease.',{scoped:true}),
});
const subject=actor=>actor&&typeof actor==='object'?{kind:String(actor.kind),...typeof actor.owner==='string'?{owner:actor.owner}:{}}:null;
const entry=(ctx,outcome)=>({operation:ctx.action.constructor.operation??ctx.action.constructor.name,actor:subject(ctx.action.actor),outcome,...ctx.error?.code?{code:String(ctx.error.code)}:{}});
export const auditTrail=Object.freeze({
 deps:['audit'],
 leave({audit},ctx){if(ctx.action)return audit.record(entry(ctx,'ok'));},
 error({audit},ctx){if(ctx.action)return audit.record(entry(ctx,'error'));},
 abort({audit},ctx){if(ctx.action)return audit.record(entry(ctx,'abort'));},
});
// Pure, in-memory development effects, shared by the CLI and harness. Not cryptographic randomness.
export function memoryEffects({seed=1,start=Date.UTC(2026,9,20),clock:providedClock}={}){
 let state=seed>>>0,current=start;
 const next=()=>{state=(state+0x6d2b79f5)>>>0;let n=state;n=Math.imul(n^n>>>15,n|1);n^=n+Math.imul(n^n>>>7,n|61);return ((n^n>>>14)>>>0)/4294967296;};
 const bytes=n=>Uint8Array.from({length:n},()=>Math.floor(next()*256));
 const random={bytes,uuid(){const b=bytes(16);b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}};
 const clock=providedClock??{now:()=>current,set(ms){if(!Number.isSafeInteger(ms))throw new TypeError('Invalid clock value');return current=ms;},advance(ms){if(!Number.isSafeInteger(ms)||ms<0)throw new TypeError('Invalid clock advance');return this.set(current+ms);}};
 const entries=[],audit={entries,record(entry){entries.push({at:clock.now(),...entry});if(entries.length>1000)entries.shift();}};
 return {clock,random,audit};
}
