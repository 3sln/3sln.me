// BRIDGE Durable Object (Cloudflare only). One instance per owner (`owner/<uuid>`: settings, holding queue, dedup,
// reply ledger) and sixteen sender shards (`senders/<n>`: reply budgets and the suppression list). It is reachable
// only through the internal EMAIL_BRIDGE binding (Wrangler migration v9); the default-off deployment flags
// and owner opt-in remain required.
import {DurableObject} from 'cloudflare:workers';
import {runOwnerOperation,runSenderMethod} from './worker.mjs';

export class EmailBridgeObject extends DurableObject{
 async operate(operation,owner,input){
  const result=await runOwnerOperation(this.env,this.ctx.storage,operation,owner,input);
  // Admission and drains arm the durable retry; the next attempt time comes from the drain itself.
  if(operation==='bridge.admit'&&result?.accepted)await this.arm(Date.now()+1000);
  if(operation==='bridge.drain'&&Number.isSafeInteger(result?.nextAt))await this.arm(result.nextAt);
  return result;
 }
 senders(method,key,options){return runSenderMethod(this.ctx.storage,method,key,options);}
 async arm(at){const current=await this.ctx.storage.getAlarm();if(current===null||current>at)await this.ctx.storage.setAlarm(at);}
 async alarm(){const owner=await this.ctx.storage.get('@owner');if(owner)await this.operate('bridge.drain',owner,{});}
}
