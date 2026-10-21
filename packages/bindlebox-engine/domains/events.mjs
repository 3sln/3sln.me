// BB-B3: durable, owner-only progress. Journal writes share the obligation transaction.
import {MailboxQuery} from '../engine.mjs';
const KEY='bb:send:events',ROW='bb:send:event/',STAGE='bb:send:event-message/',DAY=86400000;
export const EVENT_LIMITS=Object.freeze({count:1000,age:DAY,coalesce:250,lifetime:300000});
const token=(owner,log,n=log.sequence)=>`${owner}/${log.epoch}/${n}`;
const fresh=random=>({epoch:random.uuid(),sequence:0,rows:[],pending:[]});
async function prune(tx,log,now){while(log.rows.length&&(log.rows[0][1]<=now-DAY||log.rows.length>1000)){const [sequence]=log.rows.shift();await tx.delete(ROW+sequence);}}
async function push(tx,log,row){const sequence=++log.sequence;await tx.put(ROW+sequence,{...row,sequence});log.rows.push([sequence,row.at]);}
async function flush(tx,log,now){
 const later=[];for(const [id,due]of log.pending){
  if(due>now){later.push([id,due]);continue;}
  const stage=await tx.get(STAGE+id);if(stage?.pending){await push(tx,log,stage.pending);await tx.put(STAGE+id,{last:now,pending:null});}
 }log.pending=later;
}
export async function recordProgress(tx,{owner,clock,random},message){
 const now=clock.now(),log=await tx.get(KEY)??fresh(random);await flush(tx,log,now);
 const id=message.messageId,row={type:'message',at:now,data:message},stage=await tx.get(STAGE+id)??{last:null,pending:null};
 if(stage.last!==null&&now-stage.last<250){if(!stage.pending)log.pending.push([id,stage.last+250]);stage.pending=row;}
 else{await push(tx,log,row);stage.last=now;stage.pending=null;log.pending=log.pending.filter(([pending])=>pending!==id);}
 await tx.put(STAGE+id,stage);await prune(tx,log,now);
 await tx.put(KEY,log);return token(owner,log);
}
export async function progressPage(tx,{owner,clock,random},after){
 const now=clock.now(),log=await tx.get(KEY)??fresh(random);
 await flush(tx,log,now);await prune(tx,log,now);await tx.put(KEY,log);
 let sequence=0,reset=false;
 if(after!==undefined&&after!==null&&after!==''){
  const parts=typeof after==='string'?after.split('/'):[];
  sequence=Number(parts[2]);reset=parts.length!==3||parts[0]!==owner||parts[1]!==log.epoch||!/^(0|[1-9][0-9]*)$/.test(parts[2])||!Number.isSafeInteger(sequence)||sequence>log.sequence||sequence<(log.rows[0]?.[0]??log.sequence+1)-1;
 }
 const rows=reset?[{type:'reset',data:{reason:'resume_gap',refetch:['outbox']},sequence:log.sequence,at:now}]:await Promise.all(log.rows.filter(([n])=>n>sequence).map(([n])=>tx.get(ROW+n)));
 return {events:rows.map(({type,data,sequence,at})=>({type,data,at,id:token(owner,log,sequence)})),resumeToken:token(owner,log),reset,maxAgeMs:EVENT_LIMITS.lifetime};
}
export function encodeSSE(page){return page.events.map(event=>`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join('');}
export class SendEvents extends MailboxQuery {
 static operation='send.events';static deps=['outbox'];static refreshOn=['outbox-changed'];
 fetch({outbox}){return outbox.events(this.input?.after);}
}
// Finite SSE replay: adapters may reconnect with Last-Event-ID; no timer keeps an idle mailbox awake.
export class SendEventStream extends MailboxQuery {
 static operation='send.events-stream';static deps=['outbox'];static refreshOn=['outbox-changed'];
 async fetch({outbox}){const page=await outbox.events(this.input?.after);return new Response(encodeSSE(page),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Resume-Token':page.resumeToken}});}
}
export const EVENT_OPERATIONS=[SendEvents,SendEventStream];
