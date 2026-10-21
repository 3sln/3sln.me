import {ConversationsCreate} from '../../../packages/bindlebox-engine/domains/conversations.mjs';
import {parseLinkURL,contactMeta} from '../../../packages/bindlebox-engine/domains/contacts.mjs';
import {verifyES256} from '../../../packages/bindlebox-protocol/certificate.mjs';
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
// The browser selects stored contacts; a live verified directory/descriptor resolves the principal and ingress.
export class CreateContactConversation extends ConversationsCreate {
 static operation='shell.conversation-create';static deps=[...ConversationsCreate.deps,'directory'];
 async run(deps){
  const {conversations:h,directory}=deps,ids=this.input?.contacts;if(!Array.isArray(ids)||!ids.length||ids.length>63||ids.some(id=>typeof id!=='string'))fault('invalid_input','Choose contacts.',400);
  const participants=[];
  for(const id of ids){
   const contact=await h.store.get('contact/'+id);if(!contact||typeof directory?.resolveContact!=='function')fault('recipient_unavailable','Contact verification unavailable.',503);
   const resolved=await directory.resolveContact({id,principal:contact.principal,link:contact.link}),{meta}=parseLinkURL(contact.link),parsed=contactMeta(meta);
   if(!resolved||resolved.principal?.issuer!==contact.principal.issuer||resolved.principal?.subject!==contact.principal.subject||typeof resolved.principal.identityURI!=='string')fault('author_unverifiable','Contact identity unavailable.',503);
   const key=await directory.resolveKey({...resolved.principal,keyId:parsed.jws.header.kid});
   if(!key||key.identityURI!==resolved.principal.identityURI||key.keyId!==parsed.jws.header.kid||!await verifyES256(key.publicJwk,parsed.jws.signature,parsed.jws.signingInput))fault('author_unverifiable','Contact signature unavailable.',403);
   participants.push({principal:resolved.principal,keyId:resolved.keyId,ingress:resolved.ingress,link:contact.link});
  }
  this.input={subject:this.input.subject??'',text:this.input.text??'',operationId:this.input.operationId,participants};return super.run(deps);
 }
}
export const SHELL_OPERATIONS=operations(BindMailbox,MailboxAuthorization,RenewMailboxDelegation,CreateContactConversation);
