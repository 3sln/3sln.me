import {taskCleanupAt} from '../../../packages/bindlebox-engine/domains/outbox.mjs';
import {OBLIGATION_STATES} from '../../../packages/bindlebox-protocol/index.mjs';
// Called INSIDE every mailbox transaction, including claim before egress. A killed drain therefore leaves both
// its lease and its recovery alarm durable. Keep renewal and queue wakeups on the DO's single alarm.
export async function nextWake(tx,now){
 const due=[];for(const task of (await tx.list({prefix:'bb:send:task/'})).values()){if(!OBLIGATION_STATES[task.state]?.final)due.push(Math.max(now+1,task.nextAttemptAt??now,task.lease?.until??0));const cleanup=taskCleanupAt(task);if(cleanup!==null)due.push(Math.max(now+1,cleanup));}
 const renewal=await tx.get('shell:renewal');if(renewal?.at)due.push(Math.max(now+1,renewal.at));
 if((await tx.list({prefix:'edge-outbox/'})).size||(await tx.list({prefix:'conv-edge-outbox/'})).size)due.push(now+60000);
 if((await tx.get('shell:authorization'))?.active){
  for(const row of (await tx.list({prefix:'conv/work/'})).values())due.push(Math.max(now+1,row.nextAt??now));
  for(const row of (await tx.list({prefix:'conv/response/'})).values())if(row.state==='pending')due.push(Math.max(now+1,row.nextAt??now));
  for(const row of (await tx.list({prefix:'conv/op/'})).values())if(!row.submitted&&!row.abandoned)due.push(now+60000);
 }
 return due.length?Math.min(...due):null;
}
export function workerStore(storage,{clock={now:()=>Date.now()}}={}){
 const handle=tx=>({get:key=>tx.get(key),put:(key,value)=>tx.put(key,value),set:(key,value)=>tx.put(key,value),delete:key=>tx.delete(key),list:options=>tx.list(options)});
 const store={...handle(storage),transaction:work=>storage.transaction(async tx=>{const rows=handle(tx),result=await work(rows),at=await nextWake(rows,clock.now());if(at===null)await tx.deleteAlarm();else await tx.setAlarm(at);return result;})};
 store.put=(key,value)=>store.transaction(tx=>tx.put(key,value));store.delete=key=>store.transaction(tx=>tx.delete(key));
 store.recover=()=>store.transaction(()=>{});return store;
}
