// AccountController slice 2, Messages and collections (docs/architecture/app-engine.md §12): message reads, updates, pages, presentations and postbacks.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {messagePostbackPrepare,messagePostbackDispatch,messagePostbackAvailability} from '../message-postbacks.mjs';
import {messageWithPresentation,messagePresentation} from '../message-presentations.mjs';
import {key} from '../../messaging/store.mjs';
import {StorageError} from '../../storage/policy.mjs';
import {storageState} from '../storage-quota.mjs';
import {enqueueSearchEvent,searchRevisionKey,planBudget} from '../../search/index.mjs';

export const methods={
  async migrateItemIndex(owner){
    if(!this.itemIndex)return;
    const prefix=key('message',owner);
    // Catalog progress never depends on extraction capacity. A full search
    // queue must not roll back the owner's authoritative inbox browse index.
    if(!await this.metadata.get('item-index-ready')){
      const cursor=await this.metadata.get('item-index-migration');
      const rows=await this.metadata.list({prefix,...cursor?{startAfter:cursor}:{},limit:200});
      await this.metadata.transaction(async tx=>{
        for(const [,message]of rows)this.itemIndex.upsert(message);
        if(rows.size<200){await tx.put('item-index-ready',true);await tx.delete('item-index-migration');}
        else{await tx.put('item-index-migration',[...rows.keys()].at(-1));await tx.setAlarm(Date.now()+60000);}
      });
    }
    if(await this.metadata.get('item-index-ready'))await this.metadata.transaction(async tx=>{if(!this.itemIndex.migrateIncoming())await tx.setAlarm(Date.now()+60000);});
    if(await this.metadata.get('search-backfill-ready'))return;
    // Source revision initialization and work publication remain atomic. Leave
    // room for new deliveries while legacy work proceeds in bounded pages.
    await this.metadata.transaction(async tx=>{
      const entitlement=await storageState(tx,owner,Date.now(),this.config),maxQueue=planBudget(entitlement.plan==='free'?'free':'paid').limits.queue;
      const usage=await tx.get(key('search-queue-usage',owner))||{count:0};
      const reserve=Math.min(100,Math.floor(maxQueue/10)),capacity=Math.max(0,maxQueue-reserve-usage.count);
      if(!capacity){await tx.put('search-backfill-blocked',{reason:'queue_capacity'});await tx.setAlarm(Date.now()+60000);return;}
      const cursor=await tx.get('search-backfill-cursor'),limit=Math.min(200,capacity);
      const rows=await tx.list({prefix,...cursor?{startAfter:cursor}:{},limit});
      for(const [path,message]of rows){
        if(message.owner!==owner||typeof message.id!=='string'||typeof message.mimeType!=='string')continue;
        const id=`message:${message.id}`;
        if(!await tx.get(searchRevisionKey(owner,id))){
          const revision=message.revision||1;
          await enqueueSearchEvent(tx,{owner,id,source:{kind:'message',id:message.id},operation:'upsert',revision},{maxQueue});
          message.revision=revision;await tx.put(path,message);this.itemIndex.upsert(message);
        }
      }
      await tx.delete('search-backfill-blocked');
      if(rows.size<limit){await tx.put('search-backfill-ready',true);await tx.delete('search-backfill-cursor');}
      else await tx.put('search-backfill-cursor',[...rows.keys()].at(-1));
      if(rows.size||!await tx.get('search-backfill-ready'))await tx.setAlarm(Date.now()+60000);
    });
  },
  async messagePage(owner,options={}){await this.warm(owner);if(!this.itemIndex)return {items:await this.messages.list(owner,options),cursor:null};if(!await this.metadata.get('item-index-ready'))throw new StorageError('temporarily_unavailable','Your inbox index is being upgraded. Try again shortly.',503);return this.itemIndex.page(owner,options);},
  async collections(owner,name){await this.warm(owner);return name===undefined?this.messages.collections(owner):this.messages.createCollection(owner,name);},
  async content(owner,id){const record=await this.messages.read(owner,id);if(record.blobRef){const blob=await this.blobs.get(record.blobRef);if(!blob)throw Object.assign(new Error('Message content is temporarily unavailable.'),{code:'temporarily_unavailable',status:503});return {...record,bytes:new Uint8Array(await blob.arrayBuffer())};}return record;},
  async message(owner,id,options){return messageWithPresentation(this,owner,id,options);},
  async messagePresentation(owner,id,input){return messagePresentation(this,owner,id,input);},
  async messagePostbackPrepare(owner,id,input,epoch){return messagePostbackPrepare(this,owner,id,input,epoch);},
  async messagePostbackDispatch(owner,id,token){return messagePostbackDispatch(this,owner,id,token);},
  async postbackAvailability(owner,id,record,originalDigest){return messagePostbackAvailability(this,owner,id,record,originalDigest);},
  async messageBytes(owner,id){const {bytes,mimeType}=await this.content(owner,id);return {bytes:Array.from(bytes),mimeType};},
  async updateMessage(owner,id,actions){return this.messages.update(owner,id,actions);},
  async deleteMessage(owner,id){return this.messages.delete(owner,id);},
};

export const rpc={
 collections:{},
 message:{warm:true},
 messagePresentation:{warm:true},
 messagePostbackPrepare:{warm:true},
 messagePostbackDispatch:{},
 messageBytes:{warm:true},
 updateMessage:{warm:true},
 deleteMessage:{warm:true},
 messagePage:{},
};
