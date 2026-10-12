import { ContactTokenService, ContactEndpointService, MessagingService, NotificationService, renderMessage, validateSenderMetadata } from '../../packages/messaging/index.mjs';
import { key,canonical } from '../../packages/messaging/store.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { S3Adapter, WebDAVAdapter } from '../../packages/storage/adapters.mjs';
import { objectKey,StorageError } from '../storage/policy.mjs';
import {StorageQuota,storageState} from './storage-quota.mjs';
import {AccountItemIndex} from './item-index.mjs';
import {BillingService} from '../billing/index.mjs';
import {validateContent} from '../messaging/content.mjs';
import {SearchService,SqliteSearchIndex,MetadataSearchOutbox,enqueueSearchEvent,searchRevisionKey,messageSearchDocument,extractSearchText,planBudget} from '../search/index.mjs';

export class IdentityRepository {
  constructor({metadata}){this.metadata=metadata;}
  async get(id) { return this.metadata.get(`account/${id}`); }
  async findByHandle(handle) { const id=await this.metadata.get(`handle/${handle}`); return id ? this.get(id) : null; }
  async findByEmail(email) { const id=await this.metadata.get(`email/${email}`); return id ? this.get(id) : null; }
  async create(account) {
    return this.metadata.transaction(async tx=>{
      if(await tx.get(`handle/${account.handle}`)||await tx.get(`account/${account.id}`))return false;
      await tx.put(`account/${account.id}`,account);await tx.put(`handle/${account.handle}`,account.id);return true;
    });
  }
  async compareAndSwap(id, revision, account) {
    return this.metadata.transaction(async tx=>{
      const old=await tx.get(`account/${id}`);if(!old||old.revision!==revision)return false;
      const email=account.verifiedEmail;
      if(email){const owner=await tx.get(`email/${email}`);if(owner&&owner!==id)return false;await tx.put(`email/${email}`,id);}
      if(old.verifiedEmail&&old.verifiedEmail!==email)await tx.delete(`email/${old.verifiedEmail}`);
      await tx.put(`account/${id}`,account);return true;
    });
  }
  async lifecycleCandidates({cursor,limit=100}={}) {
    const rows=await this.metadata.list({prefix:'account/',startAfter:cursor,limit});
    return {accounts:[...rows].map(([path,a])=>({cursor:path,id:a.id,status:a.status,createdAt:a.createdAt,lastActiveAt:a.lastActiveAt,verifiedEmail:Boolean(a.verifiedEmail)})),cursor:rows.size===limit?[...rows.keys()].at(-1):null};
  }
  async createDevice(record){return this.metadata.transaction(async tx=>{const oldId=await tx.get(`device-code/${record.userCode}`);if(oldId){const old=await tx.get(`device/${oldId}`);if(old&&old.expiresAt>Date.now())return false;await tx.delete(`device/${oldId}`);}if(await tx.get(`device/${record.id}`))return false;await tx.put(`device/${record.id}`,record);await tx.put(`device-code/${record.userCode}`,record.id);return true;});}
  async getDevice(id){return this.metadata.get(`device/${id}`);}
  async findDeviceByCode(code){const id=await this.metadata.get(`device-code/${code}`);return id?this.getDevice(id):null;}
  async compareAndSwapDevice(id,revision,record){return this.metadata.transaction(async tx=>{const old=await tx.get(`device/${id}`);if(!old||old.revision!==revision)return false;await tx.put(`device/${id}`,record);return true;});}
}

export class FixedWindowGuard {
  constructor({metadata}){this.metadata=metadata;}
  async consume({windowMs,limit}) {
    if(!Number.isSafeInteger(windowMs)||windowMs<1000||!Number.isSafeInteger(limit)||limit<1)return false;
    return this.metadata.transaction(async tx=>{
      const now=Date.now();let value=await tx.get('window');if(!value||value.end<=now)value={count:0,end:now+windowMs};
      if(value.count>=limit)return false;value.count++;await tx.put('window',value);await tx.setAlarm(value.end);return true;
    });
  }
  async alarm(){await this.metadata.transaction(async tx=>{const window=await tx.get('window');if(window&&window.end<=Date.now())await tx.delete('window');else if(window)await tx.setAlarm(window.end);});}
}

function serializable(value){if(value instanceof Uint8Array)return {$bytes:Array.from(value)};if(Array.isArray(value))return value.map(serializable);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,serializable(v)]));return value;}
function restore(value){if(value&&Object.hasOwn(value,'$bytes'))return Uint8Array.from(value.$bytes);if(Array.isArray(value))return value.map(restore);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v)]));return value;}

export class AccountController {
  constructor({metadata,gate,blobs,archives,config,sql,sqlTransaction}){
    this.metadata=metadata;this.gate=gate;this.blobs=blobs;this.archives=archives;this.config=config;this.quota=new StorageQuota({metadata,blobs});this.itemIndex=sql?new AccountItemIndex(sql):null;this.billing=new BillingService({config,metadata});this.searchIndex=sql?new SqliteSearchIndex({sql,transaction:sqlTransaction||sql.transaction?.bind(sql)}):null;this.searchOutbox=new MetadataSearchOutbox(metadata);this.search=this.searchIndex?new SearchService({index:this.searchIndex,outbox:this.searchOutbox,authority:{get:(owner,id,options)=>this.searchDocument(owner,id,options),scan:(owner,options)=>this.scanSearchDocuments(owner,options)}}):null;
    const store={transaction:async operation=>{
      const garbage=[];
      const result=await this.metadata.transaction(async tx=>operation({
        get:k=>tx.get(k),
        set:async(k,v)=>{if(v?.bytes instanceof Uint8Array){const reservation=this.messageReservation;if(!reservation||reservation.owner!==v.owner||reservation.bytes!==v.bytes.byteLength)throw new StorageError('conflict','Message upload reservation is missing.',409);const blobRef=reservation.blobRef;const {bytes,...record}=v;const event=await this.queueMessageSearch(tx,record);record.revision=event.revision;await tx.put(k,{...record,blobRef});this.itemIndex?.upsert(record);await this.quota.commit(tx,reservation.id);}else{if(k.startsWith('message/')){const event=await this.queueMessageSearch(tx,v);v={...v,revision:event.revision};this.itemIndex?.upsert(v);}await tx.put(k,v);}},
        delete:async k=>{const value=await tx.get(k);if(value?.blobRef)garbage.push(value.blobRef);if(k.startsWith('message/')&&value){await this.queueMessageSearch(tx,value,'tombstone');this.itemIndex?.remove(value.id);}await tx.delete(k);},
        list:async prefix=>[...(await tx.list({prefix}))].map(([key,value])=>{if(value?.blobRef){const {blobRef,...record}=value;return {key,value:record};}return {key,value};})
      }));
      for(const blobRef of garbage){try{await this.blobs.delete(blobRef);}catch{await this.metadata.put(`blob-garbage/${crypto.randomUUID()}`,blobRef);}}
      return result;
    }};
    this.store=store;this.tokens=new ContactTokenService({store,issuer:config.APP_ORIGIN,allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true'});
    this.endpoints=new ContactEndpointService({tokens:this.tokens,signer:async({owner,kid})=>{const signer=await this.signingKey(owner);if(signer.kid!==kid)throw new Error('Signing key unavailable');return signer.privateKey;}});
    this.messages=new MessagingService({store,tokens:this.endpoints,maxStoredBytes:100_000_000_000,maxStoredMessages:1_000_000});
    this.notifications=new NotificationService({store});
  }
  async invoke({method,args}){
    const allowed=['touch','snapshot','collections','contacts','createContact','contactURL','revokeContact','quarantineContact','inspectContact','mintContact','deliverContact','receive','message','messageBytes','updateMessage','deleteMessage','rules','notificationPreferences','subscribe','removeSubscription','unsubscribe','unsubscribeLink','resources','addResource','verifyResource','deleteResource','federationRPC','storageUsage','messagePage','billingStatus','billingCheckout','billingPortal','billingWebhookVerified','omniSearch','searchRebuild','searchDrain'];
    if(!allowed.includes(method))return {$fault:{code:'unsupported_method',message:'Unsupported account operation.',status:400}};
    return this.gate.run(async()=>{try{if(['message','messageBytes','updateMessage','deleteMessage','resources','addResource','verifyResource','deleteResource'].includes(method))await this.warm(args[0]);return await this[method](...args);}catch(error){return {$fault:{code:error.code||'invalid_request',message:error.code?error.message:'The account operation could not be completed.',status:error.status}};}});
  }
  async warm(owner) {
    // A committed R2 snapshot survives eviction. Only clear warm records after
    // snapshot success; restores are serialized before any account operation.
    {
      if(await this.metadata.get('shelved')){
        const snapshot=await this.archives.get(`accounts/${owner}.json`);
        if(!snapshot)throw new Error('Account archive unavailable');
        if(snapshot.size>8388608)throw new Error('Account archive exceeds bounds');
        const envelope=await snapshot.json();
        if(envelope.version!==1||envelope.owner!==owner||!Array.isArray(envelope.rows)||envelope.rows.length>2000||envelope.digest!==await archiveDigest(JSON.stringify(envelope.rows)))throw new Error('Account archive integrity check failed');
        const rows=restore(envelope.rows);if(rows.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!row[0].startsWith('message/')&&!row[0].startsWith('resource/')))throw new Error('Account archive record invalid');
        await this.metadata.transaction(async tx=>{for(const [k,v]of rows)await tx.put(k,v);await tx.delete('shelved');});
      }
      await this.metadata.put('owner',owner);await this.migrateItemIndex(owner);
      if(!(await this.messages.collections(owner)).length)await this.messages.createCollection(owner,'Inbox');
      await this.scheduleAlarm(Date.now()+7*86400000);
    }
  }
  async queueMessageSearch(tx,message,operation='upsert'){
    const id=`message:${message.id}`,prior=await tx.get(searchRevisionKey(message.owner,id)),old=await tx.get(key('message',message.owner,message.id));
    const revision=Math.max(prior?.revision||0,old?.revision||(old?1:0))+1;
    const entitlement=await storageState(tx,message.owner,Date.now());
    const event=await enqueueSearchEvent(tx,{owner:message.owner,id,source:{kind:'message',id:message.id},operation,revision},{maxQueue:planBudget(entitlement.plan==='free'?'free':'paid').limits.queue});
    await tx.setAlarm(Date.now()+60000);return event;
  }
  async searchDocument(owner,id,{purpose='index',revision}={}){
    if(typeof id!=='string'||!id.startsWith('message:'))return null;
    const rawId=id.slice(8),message=await this.metadata.get(key('message',owner,rawId));
    if(!message||message.owner!==owner)return null;const currentRevision=message.revision||1;
    if(purpose!=='index'){
      const cached=purpose==='search'?await this.searchIndex?.readContent(owner,id,revision):{title:message.senderMetadata?.subject||'',text:''};
      if(!cached)return null;
      return {id,owner,source:{kind:'message',id:rawId},revision:currentRevision,type:message.mimeType==='message/rfc822'?'email':'message',title:cached.title,text:cached.text,tags:message.tags||[],classification:message.classification||'unclassified',createdAt:message.receivedAt||0,acl:{readers:[owner]},quarantined:Boolean(message.quarantined),deleted:false,embeddingAllowed:false};
    }
    if(!message.blobRef)return {...messageSearchDocument({...message,bytes:new Uint8Array()},{revision:currentRevision}),createdAt:message.receivedAt||0};
    const blob=await this.blobs.get(message.blobRef);if(!blob)throw new StorageError('temporarily_unavailable','Message data is temporarily unavailable.',503);
    if(blob.size>1048576)return messageSearchDocument({...message,bytes:new Uint8Array()},{revision:currentRevision});
    return messageSearchDocument({...message,bytes:new Uint8Array(await blob.arrayBuffer())},{revision:currentRevision});
  }
  async scanSearchDocuments(owner,{limit=50,cursor}={}){const page=await this.messagePage(owner,{limit,cursor});return {items:page.items.map(message=>({id:`message:${message.id}`,owner,revision:message.revision||1,deleted:false})),cursor:page.cursor};}
  async searchDrain(owner,{limit=10}={}){
    if(!this.search)return {processed:0};const entitlement=await this.billing.entitlement(owner),budgets=planBudget(entitlement.plan==='free'?'free':'paid').limits;this.search.budgets=budgets;this.searchIndex.budgets=budgets;
    try{const result=await this.search.drain(owner,{limit});await this.metadata.delete('search-index-error');return result;}catch(error){await this.metadata.put('search-index-error',{code:error.code||'index_unavailable',at:Date.now()});throw error;}
  }
  async searchRebuild(owner,options={}){await this.warm(owner);if(!this.search)throw new StorageError('temporarily_unavailable','Search is unavailable.',503);return this.search.rebuild(owner,{...options,limit:Math.min(options.limit||50,50)});}
  async omniSearch(owner,input){await this.warm(owner);if(!this.search)throw new StorageError('temporarily_unavailable','Search is unavailable.',503);const result=await this.search.search(owner,input);const pending=(await this.metadata.get(key('search-queue-usage',owner)))?.count||0;const error=await this.metadata.get('search-index-error');return {...result,indexing:{pending,ready:pending===0&&!error&&Boolean(await this.metadata.get('search-backfill-ready')),backfillPending:!await this.metadata.get('search-backfill-ready'),limited:Boolean(error),error:error?.code||null}};}
  async billingStatus(owner){return this.billing.status(owner);}
  async billingCheckout(owner,plan){return this.billing.checkout(owner,plan);}
  async billingPortal(owner){return this.billing.portal(owner);}
  async billingWebhookVerified(owner,event){if(event.owner!==owner)throw new StorageError('forbidden','Billing account mismatch.',403);return this.billing.applyWebhook(event);}
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
    if(await this.metadata.get('search-backfill-ready'))return;
    // Source revision initialization and work publication remain atomic. Leave
    // room for new deliveries while legacy work proceeds in bounded pages.
    await this.metadata.transaction(async tx=>{
      const entitlement=await storageState(tx,owner,Date.now()),maxQueue=planBudget(entitlement.plan==='free'?'free':'paid').limits.queue;
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
  }
  async messagePage(owner,options={}){await this.warm(owner);if(!this.itemIndex)return {items:await this.messages.list(owner,options),cursor:null};if(!await this.metadata.get('item-index-ready'))throw new StorageError('temporarily_unavailable','Your inbox index is being upgraded. Try again shortly.',503);return this.itemIndex.page(owner,options);}
  async storageUsage(owner){return this.quota.usage(owner);}
  async scheduleAlarm(time){const cleanup=await this.quota.nextCleanup(),owner=await this.metadata.get('owner'),pending=owner&&((await this.metadata.get(key('search-queue-usage',owner)))?.count||!await this.metadata.get('item-index-ready')||!await this.metadata.get('search-backfill-ready')),garbage=await this.metadata.list({prefix:'blob-garbage/',limit:1});return this.metadata.setAlarm(Math.min(time,cleanup||Infinity,pending||garbage.size?Date.now()+60000:Infinity));}
  async touch(owner) {await this.warm(owner);const now=Date.now();await this.metadata.put('lastOwnerActiveAt',now);await this.metadata.put('lifecycle',{status:'active'});await this.scheduleAlarm(now+7*86400000);}
  async snapshot(owner){await this.warm(owner);return {...await this.messageSnapshot(owner),collections:await this.messages.collections(owner),contacts:await this.contacts(owner),resources:await this.resources(owner),rules:await this.messages.rules(owner),notificationPreferences:await this.notifications.preferences(owner),pushDevices:await this.notifications.subscriptions(owner),storage:await this.storageUsage(owner),lifecycle:await this.metadata.get('lifecycle')||{status:'active'}};}
  async messageSnapshot(owner){const page=await this.messagePage(owner,{limit:100});return {messages:page.items,messageCursor:page.cursor};}
  async collections(owner,name){await this.warm(owner);return name===undefined?this.messages.collections(owner):this.messages.createCollection(owner,name);}
  async contacts(owner){const names=await this.metadata.list({prefix:'contact-name/'});return (await this.tokens.list(owner)).map(g=>({id:g.id,name:names.get(`contact-name/${g.id}`)||'Contact link',active:g.active,quarantined:Boolean(g.quarantined),createdAt:g.createdAt,expiresAt:g.claims.exp*1000,collections:g.claims.collections,mimeTypes:g.claims.mimeTypes,messagesUsed:g.messagesUsed,maxMessages:g.claims.maxMessages,bytesUsed:g.bytesUsed,maxBytes:g.claims.maxBytes}));}
  async signingKey(owner){
    const existing=await this.metadata.get('signing-key');
    if(existing){const jwk=await decryptSecret(existing.encrypted,this.config.KEY_ENCRYPTION_KEY);return {kid:existing.kid,privateKey:await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign'])};}
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const kid=crypto.randomUUID();
    const exported=await crypto.subtle.exportKey('jwk',pair.publicKey);
    // Construct the public shape explicitly; an imported/exported key object
    // must never smuggle private material into the verification registry.
    const publicJwk={kty:'EC',crv:'P-256',x:exported.x,y:exported.y,key_ops:['verify'],ext:true};
    await this.tokens.registerKey(owner,{kid,alg:'ES256',publicJwk});
    await this.metadata.put('signing-key',{kid,encrypted:await encryptSecret(await crypto.subtle.exportKey('jwk',pair.privateKey),this.config.KEY_ENCRYPTION_KEY)});
    return {kid,privateKey:pair.privateKey};
  }
  async createContact(owner,handle,input){await this.warm(owner);if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('Contact name is required');const signer=await this.signingKey(owner);const issued=await this.endpoints.create(owner,{...input,handle,kid:signer.kid});await this.metadata.put(`contact-name/${issued.grant.id}`,input.name.trim());await this.metadata.put(`contact-url/${issued.grant.id}`,await encryptSecret({url:issued.url},this.config.KEY_ENCRYPTION_KEY));return {...(await this.contacts(owner)).find(g=>g.id===issued.grant.id),url:issued.url};}
  async contactURL(owner,id){const g=(await this.tokens.list(owner)).find(g=>g.id===id);if(!g)throw new Error('Contact not found');const record=await this.metadata.get(`contact-url/${id}`);return (await decryptSecret(record,this.config.KEY_ENCRYPTION_KEY)).url;}
  async revokeContact(owner,id){await this.tokens.revoke(owner,id);return {revoked:true};}
  async quarantineContact(owner,id,value){return this.endpoints.quarantine(owner,id,value);}
  async inspectContact(owner,url){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return {collections:await this.messages.collections(owner).then(all=>all.filter(c=>grant.claims.collections.includes(c.id)).map(({id,name})=>({id,name}))),mimeTypes:grant.claims.mimeTypes,maxMessageBytes:grant.claims.maxMessageBytes,expiresAt:grant.claims.exp*1000};}
  async mintContact(owner,url){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return this.endpoints.mint(url);}
  async deliverContact(owner,url,input){const issued=await this.mintContact(owner,url);return this.receive(owner,issued.token,input);}
  async receive(owner,token,input){
    const verified=await this.endpoints.verify(token);if(verified.claims.sub!==owner)throw new Error('Wrong recipient');await this.warm(owner);
    const bytes=Uint8Array.from(input.bytes),receipt=await this.metadata.get(key('message-receipt',verified.claims.parent,input.idempotencyKey));
    if(receipt)return this.messages.receive(token,{...input,bytes});
    validateContent(input.mimeType,bytes);validateSenderMetadata(input.senderMetadata);if(!verified.claims.collections.includes(input.collection)||!verified.claims.mimeTypes.includes(input.mimeType)||(await this.metadata.get(key('collection',owner,input.collection)))?.active!==true)throw new StorageError('forbidden','Message access denied.',403);const grant=await this.metadata.get(key('contact-grant',verified.claims.parent));if(bytes.length>verified.claims.maxMessageBytes||grant.messagesUsed+1>grant.claims.maxMessages||grant.bytesUsed+bytes.length>grant.claims.maxBytes)throw new StorageError('quota_exceeded','The contact invitation limit has been reached.',429);
    const id=crypto.randomUUID(),reservation=await this.quota.reserve(owner,{id,bytes:bytes.length,blobRef:`messages/${owner}/${id}`,kind:'message'});
    this.messageReservation=reservation;
    try{await this.blobs.put(reservation.blobRef,bytes,{httpMetadata:{contentType:'application/octet-stream'}});return await this.messages.receive(token,{...input,bytes});}finally{this.messageReservation=null;await this.quota.release(id);}
  }
  async content(owner,id){const record=await this.messages.read(owner,id);if(record.blobRef){const blob=await this.blobs.get(record.blobRef);if(!blob)throw Object.assign(new Error('Message content is temporarily unavailable.'),{code:'temporarily_unavailable',status:503});return {...record,bytes:new Uint8Array(await blob.arrayBuffer())};}return record;}
  async message(owner,id){const record=await this.content(owner,id);const {bytes,blobRef,...message}=record;return {message,render:renderMessage(record)};}
  async messageBytes(owner,id){const {bytes,mimeType}=await this.content(owner,id);return {bytes:Array.from(bytes),mimeType};}
  async updateMessage(owner,id,actions){return this.messages.update(owner,id,actions);}
  async deleteMessage(owner,id){return this.messages.delete(owner,id);}
  async rules(owner,rules){return rules===undefined?this.messages.rules(owner):this.messages.setRules(owner,rules);}
  async notificationPreferences(owner,input,verifiedEmail){return input===undefined?this.notifications.preferences(owner):this.notifications.setPreferences(owner,input,{verifiedEmail});}
  async subscribe(owner,input){return this.notifications.subscribe(owner,input.subscription||input,input.label);}
  async removeSubscription(owner,id){return this.notifications.unsubscribeDevice(owner,id);}
  async unsubscribe(owner,token){return this.notifications.unsubscribe(token);}
  async unsubscribeLink(owner){return `${owner}.${await this.notifications.issueUnsubscribe(owner,'email')}`;}
  async resources(owner){const rows=await this.metadata.list({prefix:'resource/'});return [...rows.values()].map(({secret,...resource})=>resource);}
  async addResource(owner,input){
    if((await this.resources(owner)).length>=100)throw Object.assign(new Error('This account has reached its resource limit.'),{code:'resource_limit',status:429});
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('Resource name required');
    if(input.provider==='hosted'){const resource={id:crypto.randomUUID(),owner,name:input.name.trim(),provider:'hosted',status:'connected',contracts:['https://3sln.me/artefacts/contracts/object-storage/v1'],capabilities:{read:true,write:true,list:true,range:true,conditionalWrites:true,presigned:{read:false,write:false},maxObjectBytes:1048576},verifiedAt:Date.now()};await this.metadata.put(`resource/${resource.id}`,resource);return resource;}
    if(!['s3','webdav'].includes(input.provider))throw new Error('Provider requires OAuth configuration');
    const config=input.config||input;const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};
    const adapter=input.provider==='s3'?new S3Adapter({...config,write:false,conditionalWrites:false},options):new WebDAVAdapter(config,options);
    const resource={id:crypto.randomUUID(),owner,name:input.name.trim(),provider:input.provider,status:'unverified',contracts:['https://3sln.me/artefacts/contracts/object-storage/v1'],capabilities:adapter.describe(),secret:await encryptSecret({...config,write:false,conditionalWrites:false},this.config.KEY_ENCRYPTION_KEY)};
    await this.metadata.put(`resource/${resource.id}`,resource);const {secret,...publicResource}=resource;return publicResource;
  }
  async verifyResource(owner,id){const resource=await this.metadata.get(`resource/${id}`);if(!resource||resource.owner!==owner)throw new Error('Resource not found');const config=await decryptSecret(resource.secret,this.config.KEY_ENCRYPTION_KEY);const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};const adapter=resource.provider==='s3'?new S3Adapter(config,options):new WebDAVAdapter(config,options);await adapter.list();resource.status='connected';resource.verifiedAt=Date.now();await this.metadata.put(`resource/${id}`,resource);const {secret,...result}=resource;return result;}
  async deleteResource(owner,id){const resource=await this.metadata.get(`resource/${id}`);if(!resource||resource.owner!==owner)throw new Error('Resource not found');if(resource.provider==='hosted'&&(await this.metadata.list({prefix:`hosted/${id}/`,limit:1})).size)throw new StorageError('resource_not_empty','Delete the files in this hosted resource before removing it.',409);await this.metadata.delete(`resource/${id}`);return {deleted:true};}
  async federationRPC(context){
    const owner=/\/entities\/([a-f0-9-]{36})$/.exec(context.subject)?.[1];if(!owner||context.subject!==`${this.config.APP_ORIGIN}/entities/${owner}`)throw new StorageError('forbidden','Resource access denied.',403);
    await this.warm(owner);
    const resourceId=new RegExp(`^${escapeRegex(this.config.APP_ORIGIN)}/entities/${owner}/resources/([a-f0-9-]{36})$`).exec(context.resource)?.[1];
    const resource=resourceId&&await this.metadata.get(`resource/${resourceId}`);
    if(!resource||resource.owner!==owner||resource.status!=='connected'||context.contract!=='https://3sln.me/artefacts/contracts/object-storage/v1')throw new StorageError('forbidden','Resource access denied.',403);
    if(!/^[a-f0-9-]{36}$/.test(context.tx)||typeof context.clientId!=='string')throw new StorageError('invalid_args','A transaction UUID is required.');
    const fingerprint=await archiveDigest(canonical({resource:context.resource,contract:context.contract,method:context.method,args:context.args}));
    const journalKey=`rpc-journal/${encodeURIComponent(context.clientId)}/${context.tx}`;const prior=await this.metadata.get(journalKey);
    if(prior){if(prior.fingerprint!==fingerprint)throw new StorageError('tx_conflict','Transaction identifier was reused with different arguments.',409);if(prior.state!=='done')throw new StorageError('indeterminate','The earlier operation must be reconciled before retrying.',503);if(prior.error)throw new StorageError(prior.error.code,prior.error.message,prior.error.status);if(prior.resultRef){const blob=await this.blobs.get(prior.resultRef);if(!blob)throw new StorageError('temporarily_unavailable','Stored outcome is temporarily unavailable.',503);return blob.json();}return prior.result;}
    const mutating=['put','delete'].includes(context.method);
    // A durable reservation precedes effects. Recovery never repeats a write
    // whose effect may have happened before the completed journal was stored.
    if(mutating)await this.metadata.put(journalKey,{fingerprint,state:'reserved',createdAt:Date.now()});
    try{
      let result;
      if(resource.provider==='hosted')result=await this.hostedOperation(resource,context.method,context.args);
      else {const config=await decryptSecret(resource.secret,this.config.KEY_ENCRYPTION_KEY);const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};const adapter=resource.provider==='s3'?new S3Adapter(config,options):new WebDAVAdapter(config,options);if(context.method==='capabilities')result=adapter.describe();else if(context.method==='get'){const value=await adapter.get(context.args);result={dataBase64:base64(value.bytes),object:{key:context.args.key,version:value.version,size:value.bytes.byteLength,contentType:value.contentType}};}else if(['list','presign'].includes(context.method))result=await adapter[context.method](context.args);else throw new StorageError('unsupported_method','This connector does not support that operation.');}
      const encoded=JSON.stringify(result);let saved={result};if(new TextEncoder().encode(encoded).byteLength>65536){const resultRef=`rpc-results/${owner}/${await archiveDigest(context.clientId)}/${context.tx}`;await this.blobs.put(resultRef,encoded);saved={resultRef};}await this.metadata.put(journalKey,{fingerprint,state:'done',...saved,createdAt:Date.now()});await this.metadata.put('lastResourceActiveAt',Date.now());return result;
    }catch(error){if(mutating){const safe=error instanceof StorageError?{code:error.code,message:error.message,status:error.status}:{code:'indeterminate',message:'Storage outcome is unknown; reconcile before retrying.',status:503};await this.metadata.put(journalKey,{fingerprint,state:'done',error:safe,createdAt:Date.now()});throw new StorageError(safe.code,safe.message,safe.status);}throw error;}
  }
  async migrateHostedIndex(resource){
    if(!this.itemIndex||await this.metadata.get(`hosted-index-ready/${resource.id}`))return;
    const cursor=await this.metadata.get(`hosted-index-cursor/${resource.id}`),prefix=`hosted/${resource.id}/`;
    const rows=await this.metadata.list({prefix,...cursor?{startAfter:cursor}:{},limit:200});
    await this.metadata.transaction(async tx=>{for(const [,object]of rows)this.itemIndex.upsertObject(resource.id,object);if(rows.size<200){await tx.put(`hosted-index-ready/${resource.id}`,true);await tx.delete(`hosted-index-cursor/${resource.id}`);}else await tx.put(`hosted-index-cursor/${resource.id}`,[...rows.keys()].at(-1));});
  }
  async hostedOperation(resource,method,args={}){
    if(method==='capabilities')return resource.capabilities;
    if(method==='list'){
      const limit=args.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new StorageError('invalid_args','List arguments are invalid.');
      await this.migrateHostedIndex(resource);
      if(!this.itemIndex||!await this.metadata.get(`hosted-index-ready/${resource.id}`))throw new StorageError('temporarily_unavailable','The object index is being upgraded. Try again shortly.',503);
      return this.itemIndex.objectPage(resource.id,{prefix:args.prefix??'',limit:Math.min(limit,200),cursor:args.cursor});
    }
    objectKey(args.key);const path=`hosted/${resource.id}/${encodeURIComponent(args.key)}`,current=await this.metadata.get(path);
    if(method==='get'){
      if(!current)throw new StorageError('not_found','Object not found.',404);if(args.ifVersion!==undefined&&args.ifVersion!==current.version)throw new StorageError('conflict','Object changed.',409);
      const blob=await this.blobs.get(current.blobRef);if(!blob)throw new StorageError('temporarily_unavailable','Object data is temporarily unavailable.',503);let bytes=new Uint8Array(await blob.arrayBuffer());
      if(args.range){const {start,end}=args.range;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=bytes.length)throw new StorageError('invalid_args','Byte range is invalid.');bytes=bytes.slice(start,end+1);}const {blobRef,...object}=current;return {object,dataBase64:base64(bytes)};
    }
    if(method==='put'){
      if(args.condition?.absent===true?Boolean(current):typeof args.condition?.version!=='string'||args.condition.version!==current?.version)throw new StorageError('conflict','Object changed or the creation condition is missing.',409);
      if(typeof args.dataBase64!=='string'||args.dataBase64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.dataBase64))throw new StorageError('invalid_args','Canonical base64 data is required.');
      const bytes=Uint8Array.from(atob(args.dataBase64),c=>c.charCodeAt(0));if(bytes.length>1048576)throw new StorageError('quota_exceeded','Objects are limited to one MiB.',429);
      if(args.contentType!==undefined&&(typeof args.contentType!=='string'||args.contentType.length>100||/[\r\n]/.test(args.contentType)))throw new StorageError('invalid_args','Content type is invalid.');
      const usage=await this.metadata.get('hosted-usage')||{bytes:0,objects:0};if(usage.objects+(!current?1:0)>1_000_000)throw new StorageError('quota_exceeded','The object count limit has been reached.',429);
      const version=crypto.randomUUID(),blobRef=`objects/${resource.owner}/${resource.id}/${version}`;
      const reservation=await this.quota.reserve(resource.owner,{id:version,bytes:bytes.length,replacedBytes:current?.size||0,blobRef,kind:'object'});
      try{
        await this.blobs.put(blobRef,bytes);
        const object={key:args.key,version,size:bytes.length,contentType:args.contentType||'application/octet-stream',modifiedAt:Date.now(),blobRef};
        await this.metadata.transaction(async tx=>{await tx.put(path,object);await tx.put('hosted-usage',{bytes:usage.bytes-(current?.size||0)+bytes.length,objects:usage.objects+(!current?1:0)});this.itemIndex?.upsertObject(resource.id,object);await this.quota.commit(tx,reservation.id);if(current)await tx.put(`blob-garbage/${crypto.randomUUID()}`,current.blobRef);});
        const {blobRef:privateRef,...publicObject}=object;return {object:publicObject};
      }finally{await this.quota.release(reservation.id);await this.scheduleAlarm(Date.now()+60000);}
    }
    if(method==='delete'){
      if(!current)throw new StorageError('not_found','Object not found.',404);if(typeof args.version!=='string'||current.version!==args.version)throw new StorageError('conflict','Object changed.',409);
      await this.metadata.transaction(async tx=>{const usage=await tx.get('hosted-usage');await tx.delete(path);if(usage)await tx.put('hosted-usage',{bytes:usage.bytes-current.size,objects:usage.objects-1});this.itemIndex?.removeObject(resource.id,args.key);await tx.put(`blob-garbage/${crypto.randomUUID()}`,current.blobRef);});await this.scheduleAlarm(Date.now()+60000);return {deleted:true};
    }
    throw new StorageError('unsupported_method','Hosted storage does not support that operation.');
  }
  async collectBlobGarbage({limit=32}={}){
    const cursor=await this.metadata.get('blob-garbage-cursor');let rows=await this.metadata.list({prefix:'blob-garbage/',...cursor?{startAfter:cursor}:{},limit});if(!rows.size&&cursor)rows=await this.metadata.list({prefix:'blob-garbage/',limit});
    let cleaned=0;for(const [path,ref]of rows){try{await this.blobs.delete(ref);await this.metadata.delete(path);cleaned++;}catch{/* Retain ownership of retryable garbage. */}}
    if(rows.size)await this.metadata.put('blob-garbage-cursor',[...rows.keys()].at(-1));return {cleaned};
  }
  async alarm(){
    await this.gate.run(async()=>{
      await this.quota.cleanup();await this.collectBlobGarbage();const owner=await this.metadata.get('owner');if(!owner)return;
      if(await this.metadata.get('shelved')){await this.scheduleAlarm(Date.now()+7*86400000);return;}
      await this.migrateItemIndex(owner);
      if((await this.metadata.get(key('search-queue-usage',owner)))?.count){try{await this.searchDrain(owner,{limit:10});}catch{/* Durable outbox and health marker retain retry work. */}}
      if((await this.metadata.get(key('search-queue-usage',owner)))?.count||this.itemIndex&&(!await this.metadata.get('item-index-ready')||!await this.metadata.get('search-backfill-ready'))){await this.scheduleAlarm(Date.now()+60000);return;}
      const last=await this.metadata.get('lastOwnerActiveAt')||0;if(Date.now()-last<7*86400000){await this.scheduleAlarm(last+7*86400000);return;}
      const messageRows=await this.metadata.list({prefix:key('message',owner),limit:2001}),resourceRows=await this.metadata.list({prefix:'resource/',limit:101});if(messageRows.size>2000||resourceRows.size>100){await this.metadata.put('cold-index-mode',{mode:'indexed-sqlite',reason:'paged-metadata-shelving-pending'});await this.scheduleAlarm(Date.now()+7*86400000);return;}const all=new Map([...messageRows,...resourceRows]);
      // Keep signing/public capability records hot, so invalid bearers cannot
      // trigger an archive restore. Only cold content metadata/resources move.
      const rows=[...all].filter(([k])=>k.startsWith('message/')||k.startsWith('resource/'));
      const serializedRows=serializable(rows);const serialized=JSON.stringify({version:1,owner,rows:serializedRows,digest:await archiveDigest(JSON.stringify(serializedRows))});const archiveKey=`accounts/${owner}.json`;
      if(new TextEncoder().encode(serialized).byteLength>8388608){await this.metadata.put('cold-index-mode',{mode:'indexed-sqlite',reason:'paged-metadata-shelving-pending'});await this.scheduleAlarm(Date.now()+7*86400000);return;}
      await this.archives.put(archiveKey,serialized,{httpMetadata:{contentType:'application/json'}});
      const verified=await this.archives.get(archiveKey);if(!verified||await verified.text()!==serialized)throw new Error('Archive verification failed');
      await this.metadata.transaction(async tx=>{for(let i=0;i<rows.length;i+=100)await tx.delete(rows.slice(i,i+100).map(([k])=>k));await tx.put('shelved',true);});await this.scheduleAlarm(Date.now()+7*86400000);
    });
  }
}
async function archiveDigest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function base64(bytes){let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
