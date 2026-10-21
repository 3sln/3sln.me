import {MailboxAction,ownerOf,operations} from '../../../packages/bindlebox-engine/engine.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
export class BindMailbox extends MailboxAction {
 static operation='shell.bind';static deps=['mailboxStore'];
 run({mailboxStore:store}){const owner=ownerOf(this.actor);return store.transaction(async tx=>{const bound=await tx.get('owner');if(bound!==undefined&&bound!==owner)fault('forbidden','Mailbox owner mismatch.',403);await tx.put('owner',owner);return {owner};});}
}
// Trusted provisioning, never a public route. Monotonic revisions fence delayed disconnect/setup updates.
export class MailboxAuthorization extends MailboxAction {
 static operation='shell.authorization';static deps=['mailboxStore'];
 async run({mailboxStore:store}){
  const owner=ownerOf(this.actor),input=this.input;
  if(!input||!Number.isSafeInteger(input.revision)||input.revision<1||typeof input.active!=='boolean'||!Array.isArray(input.recipients)||input.recipients.length>1000)fault('invalid_input','Invalid authorization snapshot.',400);
  if(input.connection!==undefined&&(typeof input.connection!=='string'||!input.connection||input.connection.length>128||!Number.isSafeInteger(input.generation)||input.generation<0))fault('invalid_input','Invalid connection binding.',400);
  for(const p of input.recipients)try{if(new URL(p.issuer).origin!==p.issuer||!p.issuer.startsWith('https://')||typeof p.subject!=='string'||!p.subject)throw new Error();}catch{fault('invalid_input','Invalid recipient.',400);}
  return store.transaction(async tx=>{if(await tx.get('owner')!==owner)fault('forbidden','Mailbox owner mismatch.',403);const prior=await tx.get('shell:authorization');if(prior?.revision>=input.revision)return {applied:false,revision:prior.revision};await tx.put('shell:authorization',{revision:input.revision,active:input.active,recipients:input.recipients.map(({issuer,subject})=>({issuer,subject})),...input.connection!==undefined?{connection:input.connection,generation:input.generation}:{}});if(!input.active)await tx.delete('shell:renewal');return {applied:true,revision:input.revision};});
 }
}
export async function authorizeSend(tx,task){const grant=await tx.get('shell:authorization');return grant?.active===true&&grant.recipients.some(p=>p.issuer===task.principal.issuer&&p.subject===task.principal.subject);}
export class RenewMailboxDelegation extends MailboxAction {
 static operation='shell.delegation-renew';static deps=['mailboxStore','delegateKeys','clock'];
 async run({mailboxStore:store,delegateKeys,clock}){
  const owner=ownerOf(this.actor),grant=await store.get('shell:authorization');if(!grant?.active)fault('not_authorized','The connection is inactive.',403);
  // Persist retry BEFORE remote I/O; failures/crashes cannot strand renewal. No external work in a transaction.
  await store.transaction(async tx=>{if(await tx.get('owner')!==owner)fault('forbidden','Mailbox owner mismatch.',403);const live=await tx.get('shell:authorization');if(!live?.active||live.revision!==grant.revision)fault('not_authorized','The connection changed.',403);await tx.put('shell:renewal',{at:clock.now()+60000});});
  if(typeof delegateKeys?.renew!=='function')fault('recipient_unavailable','Delegation service unavailable.',503);
  const result=await delegateKeys.renew();return {jkt:result.jkt,expiresAt:result.expiresAt};
 }
}
export const SHELL_OPERATIONS=operations(BindMailbox,MailboxAuthorization,RenewMailboxDelegation);
