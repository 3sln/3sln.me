// AccountController slice 4, Inbound delivery and link replay (docs/architecture/app-engine.md §12): authored link delivery and legacy bearer receipt.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {contactIntake,intakeDeliveryTags} from '../../messaging/tag-policy.mjs';
import {validateSenderMetadata} from '../../messaging/index.mjs';
import {key,boundedString,mimeValid} from '../../messaging/store.mjs';
import {StorageError} from '../../storage/policy.mjs';
import {validateContent} from '../../messaging/content.mjs';

export const methods={
  async verifyLinkCredential(owner,credential){let verified;try{verified=await this.endpoints.verifyCredential(credential);}catch(error){throw new StorageError(error?.code==='link_malformed'?'link_malformed':credential?.url&&/[?&]bindle_meta=/.test(credential.url)?'link_invalid':'unauthorized','This contact link is invalid or no longer active.',error?.code==='link_malformed'?400:401);}if(verified.owner!==owner)throw new StorageError('unauthorized','This contact link is invalid or no longer active.',401);return {verified:true};},
  // Ungated orchestration: credential, envelope and author checks plus policy and the
  // revocation fence happen before the gate; budgets, staging and admission inside it.
  async deliverLink(owner,credential,{envelope,body,idempotencyKey}={}){
    const prepared=await this.delivery.prepare(credential,{envelope,body:body instanceof Uint8Array?body:Uint8Array.from(body??[]),idempotencyKey});if(prepared.verified.owner!==owner)throw new StorageError('unauthorized','This contact link is invalid or no longer active.',401);
    const parent=prepared.verified.parent,{principal,keyId}=prepared.author,grant=await this.metadata.get(key('contact-grant',parent));if(grant?.endpoint?.claims?.audience)await this.linkAudienceDecide(owner,parent,principal);
    try{prepared.fence=await this.delivery.resolve({issuer:this.config.APP_ORIGIN,subject:principal.subject,keyId});}catch{throw new StorageError('author_unverifiable','The message author could not be verified.',401);}
    return this.gated(async()=>{
      await this.warm(owner);const bytes=prepared.body.byteLength;
      if(await this.metadata.get(key('contact-delivery-receipt',owner,parent,principal.issuer,principal.subject,prepared.envelope.payload.operationId)))return this.delivery.commit(prepared);
      await this.quota.check(owner,{bytes});await this.messageReceiptBudget.admit(owner,{parent,bytes});await this.admitWork(owner,{clientId:'contact:'+parent});
      const id=crypto.randomUUID(),reservation=await this.quota.reserve(owner,{id,bytes,blobRef:`messages/${owner}/${id}`,kind:'message'});this.messageReservation=reservation;
      try{await this.blobs.put(reservation.blobRef,prepared.body,{httpMetadata:{contentType:'application/octet-stream'},storageAdmission:{clientId:'contact:'+parent}});const result=await this.delivery.commit(prepared);await this.scheduleAlarm(Date.now()+86400000);return result;}finally{this.messageReservation=null;await this.quota.release(id);}
    });
  },
  async receive(owner,token,input){
    const verified=await this.endpoints.verify(token);if(verified.claims.sub!==owner)throw new Error('Wrong recipient');await this.warm(owner);
    if(!boundedString(input.collection)||!mimeValid(input.mimeType)||!boundedString(input.idempotencyKey,128)||!Array.isArray(input.bytes)&&!(input.bytes instanceof Uint8Array))throw new StorageError('invalid_message','Message fields are invalid.');
    const bytes=Uint8Array.from(input.bytes);if(bytes.byteLength>1048576)throw new StorageError('quota_exceeded','Messages are limited to one MiB.',429);const receipt=await this.metadata.get(key('message-receipt',verified.claims.parent,input.idempotencyKey));
    if(receipt)return this.messages.receive(token,{...input,bytes});
    validateContent(input.mimeType,bytes);const senderMetadata=validateSenderMetadata(input.senderMetadata),grant=await this.metadata.get(key('contact-grant',verified.claims.parent));intakeDeliveryTags(contactIntake(grant),senderMetadata.tags);if(!verified.claims.collections.includes(input.collection)||!verified.claims.mimeTypes.includes(input.mimeType)||(await this.metadata.get(key('collection',owner,input.collection)))?.active!==true)throw new StorageError('forbidden','Message access denied.',403);if(bytes.length>verified.claims.maxMessageBytes||grant.messagesUsed+1>grant.claims.maxMessages||grant.bytesUsed+bytes.length>grant.claims.maxBytes)throw new StorageError('quota_exceeded','The contact invitation limit has been reached.',429);
    await this.quota.check(owner,{bytes:bytes.length});await this.messageReceiptBudget.admit(owner,{parent:grant.id,bytes:bytes.length});await this.admitWork(owner,{clientId:'contact:'+grant.id});
    const id=crypto.randomUUID(),reservation=await this.quota.reserve(owner,{id,bytes:bytes.length,blobRef:`messages/${owner}/${id}`,kind:'message'});
    this.messageReservation=reservation;
    try{await this.blobs.put(reservation.blobRef,bytes,{httpMetadata:{contentType:'application/octet-stream'},storageAdmission:{clientId:'contact:'+grant.id}});return await this.messages.receive(token,{...input,bytes});}finally{this.messageReservation=null;await this.quota.release(id);}
  },
};

export const rpc={
 verifyLinkCredential:{gate:'none'},
 deliverLink:{gate:'none'},
 receive:{},
};
