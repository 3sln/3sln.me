// BB-B3: one bounded queue per mailbox single writer. Only claim/finish use transactions;
// transport, receipt verification, directory/status calls and optional repairs run outside them.
import {MailboxAction,MailboxQuery,OwnerScopedProvider} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {validateEnvelope,payloadDigest,eventId,sha256,jcs,strictJSON,base64url,encodeDelivery,parseDelivery,parseCredential,checkCredentialKind,verifyReceipt,classifyFailure,aggregate,applyReceipt,OBLIGATION_STATES} from '../../bindlebox-protocol/index.mjs';
import {recordProgress,progressPage} from './events.mjs';
const META='bb:send:queue',M='bb:send:message/',T='bb:send:task/',B='bb:send:breaker/',HOUR=3600000;
export const SEND_LIMITS=Object.freeze({recipients:1000,tasks:1000,bytes:32*1024*1024,concurrent:4,perHost:2,connect:5000,total:15000,response:65536,attempts:100,manualAttempts:10});
const pending=task=>!OBLIGATION_STATES[task.state].final;
const peerKey=p=>`${p.issuer}\n${p.subject}`;
const manualEnd=task=>task.createdAt+(task.kind==='conversation-record'?7*24*HOUR:24*HOUR)-HOUR;
const safeId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const empty=()=>({messages:[],tasks:0,bytes:0,turn:0});
const breakerKey=url=>B+url;
const initialBreaker=()=>({failures:0,opens:0,until:0,probe:null});
const publicTask=t=>({id:t.id,principal:t.principal,state:t.state,revision:t.revision,attempts:t.attempts,nextAttemptAt:t.nextAttemptAt,deadline:t.deadline,...t.reason?{reason:t.reason}:{},...t.class?{class:t.class}:{},...t.deliveredBeforeCancel?{deliveredBeforeCancel:true}:{}});
async function snapshot(tx,id){
 const message=await tx.get(M+id);if(!message)fault('not_found','Message not found.',404);
 const tasks=await Promise.all(message.tasks.map(key=>tx.get(key)));
 return {messageId:id,recipientCount:message.tasks.length,revision:message.revision,...aggregate(tasks.map(t=>t.state)),recipients:tasks.map(publicTask)};
}
async function changed(tx,ctx,ids){for(const id of new Set(ids)){const message=await tx.get(M+id);message.revision++;await tx.put(M+id,message);const view=await snapshot(tx,id);await recordProgress(tx,ctx,{messageId:id,revision:view.revision,recipientCount:view.recipientCount,delivered:view.delivered,pending:view.pending,failed:view.failed,cancelled:view.cancelled});}}
// authorize(tx, task) MUST read live local consent/control state using tx, with no network I/O.
// repair(task) MAY refresh transport credentials/bindings, never the immutable envelope/audience.
// Explicit BINDLEBOX_ENABLED is independent of bound services. Missing authorization fails closed.
export function createOutboxProvider({BINDLEBOX_ENABLED=false,authorize=()=>false,repair,limits={},timers={set:setTimeout,clear:clearTimeout}}={}){
 const caps={...SEND_LIMITS,...limits};
 for(const key of Object.keys(caps))if(!Number.isSafeInteger(caps[key])||caps[key]<1||caps[key]>SEND_LIMITS[key])throw new TypeError(`Invalid send limit ${key}`);
 return class OutboxProvider extends OwnerScopedProvider {
  static deps=['mailboxStore','clock','random','egress','directory'];
  scope({mailboxStore:store,clock,random,egress,directory},owner){
   const ctx={owner,clock,random},check=()=>{if(BINDLEBOX_ENABLED!==true)fault('not_found','BindleBox is disabled.',404);};
   const transaction=fn=>{check();return store.transaction(async tx=>{if(await tx.get('owner')!==owner)fault('forbidden','Mailbox owner mismatch.',403);return fn(tx);});};
   const allowed=(tx,t)=>authorize(tx,structuredClone(t),owner);
   const tasks=async tx=>[...(await tx.list({prefix:T})).values()];
   const cancel=async(tx,t,reason='authorization')=>{t.state='cancelled';t.reason=reason;t.generation++;t.revision++;t.lease=null;await tx.put(T+t.id,t);};
   async function requeue(tx,select){
    const now=clock.now(),ids=[];let count=0;
    for(const t of (await tasks(tx)).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))){
     if(!select(t)||!['expired','unknown'].includes(t.state)||now>=manualEnd(t))continue;
     if(!await allowed(tx,t)){await cancel(tx,t);ids.push(t.messageId);continue;}
     // One additional ten-attempt budget per obligation, ever. Repeated clicks/recovery cannot refill it.
     if(t.manualUsed)continue;t.manualUsed=true;t.budgetEnd=t.attempts+caps.manualAttempts;t.deadline=manualEnd(t);
     const breaker=await tx.get(breakerKey(t.ingress));t.nextAttemptAt=Math.max(now,t.nextAttemptAt,t.notBefore??0,breaker?.until??0);
     t.state=t.nextAttemptAt>=t.deadline?'expired':'retry_scheduled';t.generation++;t.revision++;t.lease=null;await tx.put(T+t.id,t);ids.push(t.messageId);count++;
    }
    await changed(tx,ctx,ids);return {requeued:count};
   }
   async function submit(input){
    check();const data=structuredClone(input);
    if(!data||!safeId(data.operationId)||!Array.isArray(data.recipients)||!data.recipients.length||data.recipients.length>caps.recipients||!(data.body===null||data.body instanceof Uint8Array))fault('malformed','Invalid send.',400);
    const prepared=[],seen=new Set(),bodyHash=data.body===null?null:await sha256(globalThis.crypto,data.body);let bytes=data.body?.byteLength??0;
    for(const r of data.recipients){
     const envelope=await validateEnvelope(r.envelope),p=envelope.payload,url=new URL(r.ingress);
     if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href!==r.ingress||p.operationId!==data.operationId||p.author.principal.subject!==owner||p.content?.sha256!==bodyHash&&!(p.content===null&&bodyHash===null)||p.content&&p.content.byteLength!==data.body?.byteLength)fault('malformed','Invalid recipient.',400);
     checkCredentialKind(envelope,parseCredential(r.credential));
     const principal={issuer:p.recipient.issuer,subject:p.recipient.owner},peer=peerKey(principal);
     if(seen.has(peer))fault('malformed','Duplicate recipient.',400);seen.add(peer);
     const digest=await payloadDigest(envelope),wire=encodeDelivery(envelope,{body:data.body,secret:r.secret??null,boundary:`bb-${data.operationId}`});await parseDelivery(wire.contentType,wire.bytes,{idempotencyKey:data.operationId});
     const id=`${data.operationId}:${prepared.length}`,createdAt=p.createdAt,kind=p.kind,deadline=createdAt+(kind==='conversation-record'?72:23)*HOUR;
     bytes+=new TextEncoder().encode(jcs(envelope)).byteLength+(r.credential?.length??0)+(r.secret?.byteLength??0)+512;
     prepared.push({id,messageId:data.operationId,principal,peer,envelope,credential:r.credential??null,secret:r.secret??null,ingress:r.ingress,host:url.host,conversation:p.record?.conversationId??data.operationId,control:['leave','retract','rotate','secret-share'].includes(p.record?.type),kind,createdAt,deadline,knownRotation:r.knownRotation===true,obligation:{principal,ingress:r.ingress,operationId:p.operationId,kind,payloadDigest:digest,bodyDigest:bodyHash,...kind==='conversation-record'?{eventId:await eventId(envelope)}:{}},state:'queued',generation:0,revision:1,attempts:0,budgetEnd:caps.attempts,nextAttemptAt:clock.now(),notBefore:0,lease:null,repaired:false,manualUsed:false});
    }
    // Include exact signed bytes/credentials and ordered audience in local idempotency, never in audit/events.
    const fingerprint=await sha256(globalThis.crypto,new TextEncoder().encode(jcs({bodyHash,recipients:prepared.map(t=>({envelope:t.envelope,credential:t.credential,ingress:t.ingress,secret:t.secret?base64url(t.secret):null}))})));
    return transaction(async tx=>{
     const previous=await tx.get(M+data.operationId);
     if(previous){if(previous.fingerprint!==fingerprint)fault('send_operation_conflict','Operation already used with different content.',409);return snapshot(tx,data.operationId);}
     if(prepared.some(t=>t.createdAt>clock.now()+60000||t.deadline<=clock.now()))fault('envelope_expired','Send is outside its automatic window.',400);
     const meta=await tx.get(META)??empty();
     if(meta.tasks+prepared.length>caps.tasks||meta.bytes+bytes>caps.bytes)fault('send_capacity','The send queue is full.',429);
     for(const t of prepared)if(!await allowed(tx,t))fault('not_authorized','Recipient is no longer authorized.',403);
     meta.messages.push(data.operationId);meta.tasks+=prepared.length;meta.bytes+=bytes;await tx.put(META,meta);
     const bodyKeys=[];if(data.body!==null)for(let at=0;at<data.body.byteLength;at+=16384){const key=`bb:send:body/${data.operationId}/${at}`;bodyKeys.push(key);await tx.put(key,Array.from(data.body.subarray(at,at+16384)));}
     await tx.put(M+data.operationId,{fingerprint,bodyKeys,hasBody:data.body!==null,tasks:prepared.map(t=>T+t.id),revision:0});for(const t of prepared){if(t.secret)t.secret=Array.from(t.secret);await tx.put(T+t.id,t);}
     await changed(tx,ctx,[data.operationId]);return snapshot(tx,data.operationId);
    });
   }
   async function claim(){return transaction(async tx=>{
    const now=clock.now(),all=await tasks(tx),ids=[],hosts=new Map();let active=0;
    for(const t of all){
     if(!pending(t))continue;
     if(!await allowed(tx,t)){await cancel(tx,t);ids.push(t.messageId);continue;}
     if(t.lease&&t.lease.until>now){active++;hosts.set(t.host,(hosts.get(t.host)??0)+1);continue;}
     if(t.lease){t.lease=null;t.generation++;t.state='unknown';t.reason='unreachable';t.revision++;await tx.put(T+t.id,t);ids.push(t.messageId);}
     if(now>=t.deadline||t.attempts>=t.budgetEnd){t.state='expired';t.revision++;await tx.put(T+t.id,t);ids.push(t.messageId);}
    }
    const meta=await tx.get(META)??empty(),due=all.filter(t=>pending(t)&&!t.lease&&t.nextAttemptAt<=now).sort((a,b)=>Number(b.control)-Number(a.control)||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
    // Rotate conversation+host lanes; one reserved control candidate precedes ordinary round-robin.
    const lanes=new Map();for(const t of due){const key=`${t.host}\n${t.conversation}`;if(!lanes.has(key))lanes.set(key,[]);lanes.get(key).push(t);}
    const keys=[...lanes.keys()],ordered=[];if(keys.length){const offset=meta.turn%keys.length;keys.push(...keys.splice(0,offset));while(lanes.size)for(const key of keys){const lane=lanes.get(key);if(!lane)continue;ordered.push(lane.shift());if(!lane.length)lanes.delete(key);}}
    const control=due.find(t=>t.control);if(control){ordered.splice(ordered.indexOf(control),1);ordered.unshift(control);}
    const claimed=[];
    for(const t of ordered){
     if(active>=caps.concurrent)break;if((hosts.get(t.host)??0)>=caps.perHost)continue;
     const bk=breakerKey(t.ingress),b=await tx.get(bk)??initialBreaker();
     if(b.until>now||b.until&&b.probe?.until>now){const at=Math.max(b.until,b.probe?.until??0);if(t.nextAttemptAt!==at){t.nextAttemptAt=at;t.state=at>=t.deadline?'expired':'retry_scheduled';t.reason='unreachable';t.revision++;await tx.put(T+t.id,t);ids.push(t.messageId);}continue;}
     t.generation++;t.attempts++;t.state='in_progress';t.revision++;t.lease={token:random.uuid(),until:now+caps.total*(t.needsRepair&&repair?2:1)};
     // Persist spacing before network I/O, including a crash between remote custody and local ACK.
     const sample=random.bytes(2),jitter=.8+((sample[0]*256+sample[1])/65535)*.4;
     t.nextAttemptAt=now+Math.max(5000,Math.min(HOUR,Math.round(5000*2**Math.min(20,t.attempts-1)*jitter)));
     if(b.until){b.probe={token:t.lease.token,until:t.lease.until};await tx.put(bk,b);}
     await tx.put(T+t.id,t);const message=await tx.get(M+t.messageId),chunks=await Promise.all(message.bodyKeys.map(key=>tx.get(key)));
     claimed.push({...structuredClone(t),secret:t.secret?Uint8Array.from(t.secret):null,body:message.hasBody?Uint8Array.from(chunks.flat()):null});ids.push(t.messageId);active++;hosts.set(t.host,(hosts.get(t.host)??0)+1);
    }
    meta.turn++;await tx.put(META,meta);await changed(tx,ctx,ids);return claimed;
   });}
   async function bounded(task){
    const controller=new AbortController();let totalTimer,connectTimer;
    const timeout=new Promise((_,reject)=>{totalTimer=timers.set(()=>{controller.abort();reject(Object.assign(new Error('timeout'),{code:'timeout'}));},caps.total);});
    const connecting=new Promise((_,reject)=>{connectTimer=timers.set(()=>{controller.abort();reject(Object.assign(new Error('timeout'),{code:'timeout'}));},caps.connect);});
    try{return await Promise.race([timeout,(async()=>{
     const wire=encodeDelivery(task.envelope,{body:task.body,secret:task.secret,boundary:`bb-${task.messageId}`});
     const response=await Promise.race([connecting,egress.fetch(task.ingress,{method:'POST',redirect:'manual',credentials:'omit',signal:controller.signal,headers:{'Content-Type':wire.contentType,'Idempotency-Key':task.envelope.payload.operationId,...task.credential?{Authorization:task.credential}:{}},body:wire.bytes})]);timers.clear(connectTimer);
     if(!(response instanceof Response))throw new TypeError('Invalid egress response');
     const reader=response.body?.getReader(),chunks=[],stop=()=>{reader?.cancel().catch(()=>{});};let size=0;controller.signal.addEventListener('abort',stop,{once:true});
     try{if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>caps.response)throw Object.assign(new Error('response too large'),{code:'response_limit'});chunks.push(part.value);}}
     finally{controller.signal.removeEventListener('abort',stop);if(controller.signal.aborted||size>caps.response)await reader?.cancel().catch(()=>{});}
     const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
     let body;try{body=strictJSON(bytes,{maxBytes:caps.response});}catch{body={};}
     const result={status:response.status,error:body?.error,retryAfter:response.headers.get('Retry-After')};
     if(response.status===200&&body?.receipt){const verification=await verifyReceipt(body.receipt,{obligation:task.obligation,resolveKey:directory.resolveKey,status:directory.status,now:clock.now()});if(verification.state==='delivered')result.receipt=verification.receipt;}
     return result;
    })()]);}catch(error){return {transport:error?.code==='timeout'?'timeout':['connection_reset','ECONNRESET'].includes(error?.code)?'reset':'network'};}
    finally{timers.clear(totalTimer);timers.clear(connectTimer);controller.abort();}
   }
   async function finish(task,result){return transaction(async tx=>{
    const t=await tx.get(T+task.id);if(!t)return;
    // A verified late receipt may resolve an expired/cancelled task, but never stale repair/failure work.
    const current=t.generation===task.generation&&t.lease?.token===task.lease.token;
    if(!current&&!result.receipt)return;
    const authorized=await allowed(tx,t);
    if(!authorized&&(pending(t)||t.state==='expired'))await cancel(tx,t);
    if(result.receipt){Object.assign(t,applyReceipt(t.state));t.receipt=result.receipt;t.lease=null;t.revision++;await tx.put(T+t.id,t);}
    else if(authorized&&pending(t)){
     const step=classifyFailure({...result,record:t.kind==='conversation-record',repaired:t.repaired,knownRotation:t.knownRotation,now:clock.now()});
     t.lease=null;t.revision++;
     if(step.action==='terminal'){t.state='rejected';t.class=step.class;}
     else{t.state=step.state??'retry_scheduled';t.reason=step.reason;if(step.notBefore!==undefined)t.notBefore=clock.now()+step.notBefore;t.nextAttemptAt=Math.max(t.nextAttemptAt,t.notBefore??0);if(step.action==='repair'){t.repaired=true;t.needsRepair=true;}if(t.attempts>=t.budgetEnd||t.nextAttemptAt>=t.deadline)t.state='expired';}
     await tx.put(T+t.id,t);
    }
    if(current){
     const key=breakerKey(task.ingress),b=await tx.get(key)??initialBreaker(),wasOpen=Boolean(b.until),bad=Boolean(result.transport)||result.status>=500;
     if(bad){b.failures++;if(b.failures>=5||b.probe){b.opens++;b.until=clock.now()+Math.min(HOUR,60000*2**Math.min(6,b.opens-1));b.probe=null;}}
     else if(result.status>=200&&result.status<300){b.failures=0;b.opens=0;b.until=0;b.probe=null;}
     else{b.failures=0;if(b.probe){b.probe=null;b.until=clock.now()+60000;}}
     await tx.put(key,b);
     if(wasOpen&&!b.until)await requeue(tx,t=>t.ingress===task.ingress&&t.state==='expired');
    }
    await changed(tx,ctx,[t.messageId]);
   });}
   async function deliver(task){
    if(task.needsRepair&&repair){
     let patch,timer;try{patch=await Promise.race([repair(structuredClone(task)),new Promise((_,reject)=>{timer=timers.set(()=>reject(new Error('repair timeout')),caps.total);})]);}catch{}finally{timers.clear(timer);}
     const moved=patch&&await transaction(async tx=>{const t=await tx.get(T+task.id);if(t.generation!==task.generation||t.lease?.token!==task.lease.token||!await allowed(tx,t))return false;
      // A repaired descriptor must be verified by the injected policy. No redirects or identity changes here.
      const url=new URL(patch.ingress??t.ingress);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href!==(patch.ingress??t.ingress))return;
      if(t.kind==='conversation-record'&&url.href!==t.ingress)return;
      const moved=url.href!==t.ingress;t.ingress=url.href;t.host=url.host;t.obligation.ingress=url.href;task.ingress=url.href;task.host=url.host;task.obligation.ingress=url.href;
      if(patch.credential!==undefined){checkCredentialKind(t.envelope,parseCredential(patch.credential));t.credential=patch.credential;task.credential=patch.credential;}t.needsRepair=false;
      // Reclaim under the new host's concurrency/breaker bounds instead of forwarding this attempt.
      if(moved){t.state='retry_scheduled';t.reason='moved';t.lease=null;t.generation++;t.revision++;}
      await tx.put(T+t.id,t);if(moved)await changed(tx,ctx,[t.messageId]);return moved;
     });if(moved)return;
    }
    // Cancellation/revocation can interleave with repairs; check again before starting network work.
    const live=await transaction(async tx=>{const t=await tx.get(T+task.id);return t.generation===task.generation&&t.lease?.token===task.lease.token&&await allowed(tx,t);});
    if(!live){await finish(task,{});return;}await finish(task,await bounded(task));
   }
   return {
    submit,
    get:id=>transaction(tx=>snapshot(tx,id)),
    list:()=>transaction(async tx=>{const meta=await tx.get(META)??empty();return Promise.all(meta.messages.map(id=>snapshot(tx,id)));}),
    async drain(){const claimed=await claim();await Promise.all(claimed.map(deliver));return transaction(async tx=>{
     const now=clock.now(),all=(await tasks(tx)).filter(pending),active=all.filter(t=>t.lease?.until>now);
     const due=all.map(t=>{let at=Math.max(now,t.nextAttemptAt,t.lease?.until??0);if(!t.lease){const host=active.filter(a=>a.host===t.host);if(active.length>=caps.concurrent)at=Math.max(at,Math.min(...active.map(a=>a.lease.until)));if(host.length>=caps.perHost)at=Math.max(at,Math.min(...host.map(a=>a.lease.until)));}return at;});
     return {attempted:claimed.length,pending:due.length,nextAlarmAt:due.length?Math.min(...due):null};
    });},
    retry:id=>transaction(async tx=>{if(!await tx.get(M+id))fault('not_found','Message not found.',404);return requeue(tx,t=>t.messageId===id);}),
    catchUp:principal=>transaction(tx=>{if(!principal||typeof principal.issuer!=='string'||typeof principal.subject!=='string')fault('malformed','Invalid peer.',400);return requeue(tx,t=>t.peer===peerKey(principal)&&t.state==='expired');}),
    cancel:(id,principal)=>transaction(async tx=>{const message=await tx.get(M+id);if(!message)fault('not_found','Message not found.',404);for(const key of message.tasks){const t=await tx.get(key);if(pending(t)&&(!principal||t.peer===peerKey(principal)))await cancel(tx,t,'owner');}await changed(tx,ctx,[id]);return snapshot(tx,id);}),
    events:after=>transaction(tx=>progressPage(tx,ctx,after)),
   };
  }
 };
}
export class OutboxMessage extends MailboxQuery {static operation='outbox.get';static deps=['outbox'];static refreshOn=['outbox-changed'];fetch({outbox}){return outbox.get(this.id);}}
export class OutboxList extends MailboxQuery {static operation='outbox.list';static deps=['outbox'];static refreshOn=['outbox-changed'];fetch({outbox}){return outbox.list();}}
export class DrainOutbox extends MailboxAction {static operation='outbox.drain';static deps=['outbox'];static changes='outbox-changed';run({outbox}){return outbox.drain();}}
export class RetryMissing extends MailboxAction {static operation='outbox.retry-missing';static deps=['outbox'];static changes='outbox-changed';run({outbox}){return outbox.retry(this.id);}}
export class CatchUpPeer extends MailboxAction {static operation='outbox.catch-up';static deps=['outbox'];static changes='outbox-changed';run({outbox}){return outbox.catchUp(this.input?.principal);}}
export class CancelSend extends MailboxAction {static operation='outbox.cancel';static deps=['outbox'];static changes='outbox-changed';run({outbox}){return outbox.cancel(this.id,this.input?.principal);}}
export const OUTBOX_PROVIDERS={outbox:createOutboxProvider()};
export const OUTBOX_OPERATIONS=[OutboxMessage,OutboxList,DrainOutbox,RetryMissing,CatchUpPeer,CancelSend];
