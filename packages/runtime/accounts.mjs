import {accountRemovalProtection,UNPAID_LIFECYCLE_ORIGIN} from '../identity/lifecycle-protection.mjs';
import {RESOURCE_SCOPING,storageScopeOptions} from '../storage/scoping.mjs';
import {encodeFreeHandleNumber,normalizeHandle,validatePaidHandle} from '../identity/handles.mjs';
import {GoogleDriveService} from '../storage/google-drive.mjs';
import {automationMethods} from '../automation/account.mjs';
import {AppConnections} from '../apps/connections.mjs';
import {mcpCollections as accountMcpCollections,mcpOperation as accountMcpOperation} from '../mcp/account.mjs';
import {conversationMethods} from '../conversations/runtime.mjs';
import {retryReady,retryTime,retryFailure} from './cleanup-retry.mjs';
import {BeamService,beamView,BeamError} from '../beaming/index.mjs';
import {BeamContacts} from '../beaming/contacts.mjs';
import {CloudflareTurnAdapter} from '../beaming/turn.mjs';
import { ContactTokenService, ContactEndpointService, MessagingService, NotificationService, renderMessage, validateSenderMetadata } from '../../packages/messaging/index.mjs';
import { key,canonical,boundedString,mimeValid } from '../../packages/messaging/store.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { IdentityShardStorage } from './identity-shards.mjs';
import { S3Adapter, WebDAVAdapter } from '../../packages/storage/adapters.mjs';
import { objectKey,StorageError } from '../storage/policy.mjs';
import {StorageQuota,storageState} from './storage-quota.mjs';
import {AccountStorageWriteBudget} from './storage-write-budget.mjs';
import {guardedBucket} from './guarded-bucket.mjs';
import {AccountItemIndex} from './item-index.mjs';
import {BillingService} from '../billing/index.mjs';
import {validateContent} from '../messaging/content.mjs';
import {vectorBinding} from './semantic-routing.mjs';
import {SearchService,SqliteSearchIndex,MetadataSearchOutbox,enqueueSearchEvent,searchRevisionKey,messageSearchDocument,extractSearchText,planBudget,DurableSemanticBudget,SearchMutationGate,WorkersAIEmbeddingAdapter,VectorizeSearchIndex,SEMANTIC_MODEL,SEMANTIC_DIMENSIONS} from '../search/index.mjs';

export class IdentityRepository {
  async shardRead(...args){return new IdentityShardStorage(this.metadata).read(...args);}
  async shardPrepare(...args){return new IdentityShardStorage(this.metadata).prepare(...args);}
  async shardSettle(...args){return new IdentityShardStorage(this.metadata).settle(...args);}
  async shardFinish(...args){return new IdentityShardStorage(this.metadata).finish(...args);}
  async shardLookup(...args){return new IdentityShardStorage(this.metadata).lookup(...args);}
  async shardClaim(...args){return new IdentityShardStorage(this.metadata).claim(...args);}
  async shardRelease(...args){return new IdentityShardStorage(this.metadata).release(...args);}
  async shardNamespaceBound(...args){return new IdentityShardStorage(this.metadata).namespaceBound(...args);}
  async shardPaidHandleRead(...args){return new IdentityShardStorage(this.metadata).paidHandleRead(...args);}
  async shardPaidHandleAnchor(...args){return new IdentityShardStorage(this.metadata).paidHandleAnchor(...args);}
  async shardPaidHandleFinish(...args){return new IdentityShardStorage(this.metadata).paidHandleFinish(...args);}
  async shardPaidHandleClaim(...args){return new IdentityShardStorage(this.metadata).paidHandleClaim(...args);}
  async shardHandleLookup(...args){return new IdentityShardStorage(this.metadata).handleLookup(...args);}
  async shardHandleClaim(...args){return new IdentityShardStorage(this.metadata).handleClaim(...args);}
  async shardHandleConsume(...args){return new IdentityShardStorage(this.metadata).handleConsume(...args);}
  async shardHandleGrandfather(...args){return new IdentityShardStorage(this.metadata).handleGrandfather(...args);}
  async shardNextHandleNumber(...args){return new IdentityShardStorage(this.metadata).nextHandleNumber(...args);}
  async shardPage(...args){return new IdentityShardStorage(this.metadata).page(...args);}
  constructor({metadata}){this.metadata=metadata;}
  async get(id) { return this.metadata.get(`account/${id}`); }
  async findByHandle(handle) {
    handle=normalizeHandle(handle);
    const id=await this.metadata.get(`handle/${handle}`);
    if(id){const account=await this.get(id);await this.shardHandleGrandfather(handle,id,account?.assignmentId);return account;}
    const claim=await this.shardHandleLookup(handle);if(claim?.state!=='paid-alias')return null;const account=await this.get(claim.owner);return account?.assignmentId===claim.assignmentId?account:null;
  }
  async allocateFreeHandle(baseIgnored,owner=crypto.randomUUID(),assignmentId){
    if(typeof owner!=='string'||!owner||owner.length>128||assignmentId!==undefined&&(typeof assignmentId!=='string'||!assignmentId||assignmentId.length>128))throw new TypeError('Invalid handle allocation identity');
    const lane=crypto.getRandomValues(new Uint8Array(1))[0]%64;
    // Node transactions share one adapter, but each durable lane has its own counter.
    const metadata={transaction:fn=>this.metadata.transaction(tx=>fn({get:key=>tx.get(`allocator/${lane}/${key}`),put:(key,value)=>tx.put(`allocator/${lane}/${key}`,value)}))};
    const number=await new IdentityShardStorage(metadata).nextHandleNumber(lane),handle=encodeFreeHandleNumber(number);
    const legacy=await this.metadata.get(`handle/${handle}`);if(legacy){const old=await this.get(legacy);await this.shardHandleGrandfather(handle,legacy,old?.assignmentId);}
    if(!await this.shardHandleClaim(handle,{owner,assignmentId}))throw new Error('Permanent handle allocation collision');return handle;
  }
  async paidHandleForOwner(owner){const account=await this.get(owner),anchor=await this.shardPaidHandleRead(owner);return account&&anchor?.state==='committed'&&anchor.assignmentId===account.assignmentId?anchor.handle:null;}
  // Caller has already verified paid eligibility and recent authentication.
  async claimPaidHandle(handle,owner,assignmentId){
    handle=validatePaidHandle(handle);
    if(typeof assignmentId!=='string'||!assignmentId)throw new TypeError('Invalid paid handle identity');
    const account=await this.get(owner);if(!account||account.assignmentId!==assignmentId)return false;
    for(let attempt=0;attempt<2;attempt++){
      const anchor=await this.shardPaidHandleAnchor(owner,handle,assignmentId);
      if(anchor.state==='committed')return anchor.handle===handle&&anchor.assignmentId===assignmentId;
      const oldOwner=await this.metadata.get(`handle/${anchor.handle}`);if(oldOwner){const old=await this.get(oldOwner);await this.shardHandleGrandfather(anchor.handle,oldOwner,old?.assignmentId);}
      const claimed=await this.shardPaidHandleClaim(anchor.handle,owner,anchor.assignmentId);
      await this.shardPaidHandleFinish(owner,anchor,claimed);
      if(claimed)return anchor.handle===handle&&anchor.assignmentId===assignmentId;
      if(anchor.handle===handle)return false;
    }
    return false;
  }
  async findByEmail(email) { const id=await this.metadata.get(`email/${email}`); return id ? this.get(id) : null; }
  async create(account) {
    return this.metadata.transaction(async tx=>{
      const namespace=`identity-namespace/${account.handle}`,oldClaim=await tx.get(namespace),oldOwner=await tx.get(`handle/${account.handle}`);
      if(oldOwner){if(!oldClaim){const oldAccount=await tx.get(`account/${oldOwner}`);await tx.put(namespace,{owner:oldOwner,assignmentId:oldAccount?.assignmentId??null,state:'assigned'});}return false;}
      if(await tx.get(`account/${account.id}`))return false;
      if(oldClaim&&(oldClaim.state!=='allocated'||oldClaim.owner!==account.id||oldClaim.assignmentId!==(account.assignmentId??null)))return false;
      await tx.put(namespace,{owner:account.id,assignmentId:account.assignmentId??null,state:'assigned'});
      await tx.put(`account/${account.id}`,account);await tx.put(`handle/${account.handle}`,account.id);return true;
    });
  }
  async compareAndSwap(id, revision, account) {
    return this.metadata.transaction(async tx=>{
      const old=await tx.get(`account/${id}`);if(!old||old.revision!==revision||account.handle!==old.handle||account.assignmentId!==old.assignmentId)return false;
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
  async consume({windowMs,limit,lifetime=false,units=1,storageWrite}) {
    if(!Number.isSafeInteger(units)||units<1||units>16||!Number.isSafeInteger(limit)||limit<1||typeof lifetime!=='boolean'||!lifetime&&(!Number.isSafeInteger(windowMs)||windowMs<1000))return false;
    if(storageWrite!==undefined){
      if(!lifetime||!storageWrite||typeof storageWrite!=='object'||!['foreground','maintenance'].includes(storageWrite.pool))return false;
      const {pool,totalLimit,foregroundLimit,maintenanceLimit}=storageWrite,limits={total:totalLimit,foreground:foregroundLimit,maintenance:maintenanceLimit};
      if(!Object.values(limits).every(value=>Number.isSafeInteger(value)&&value>=0)||totalLimit!==foregroundLimit+maintenanceLimit||limit!==limits[pool])return false;
      return this.metadata.transaction(async tx=>{
        const stored=await tx.get('storage-write'),record=stored===undefined?{version:1,limits,total:0,foreground:0,maintenance:0}:stored;
        if(!record||record.version!==1||!['total','foreground','maintenance'].every(kind=>Number.isSafeInteger(record[kind])&&record[kind]>=0&&record[kind]<=limits[kind]&&record.limits?.[kind]===limits[kind])||record.total!==record.foreground+record.maintenance)return false;
        if(record.total+units>totalLimit||record[pool]+units>limits[pool])return false;
        await tx.put('storage-write',{...record,total:record.total+units,[pool]:record[pool]+units});return true;
      });
    }
    if(lifetime)return this.metadata.transaction(async tx=>{const stored=await tx.get('lifetime'),count=stored===undefined?0:stored;if(!Number.isSafeInteger(count)||count<0||count+units>limit)return false;await tx.put('lifetime',count+units);return true;});
    return this.metadata.transaction(async tx=>{
      const now=Date.now();let value=await tx.get('window');if(!value||value.end<=now)value={count:0,end:now+windowMs};
      if(!Number.isSafeInteger(value.count)||value.count<0||value.count+units>limit)return false;value.count+=units;await tx.put('window',value);await tx.setAlarm(value.end);return true;
    });
  }
  async alarm(){await this.metadata.transaction(async tx=>{const window=await tx.get('window');if(window&&window.end<=Date.now())await tx.delete('window');else if(window)await tx.setAlarm(window.end);});}
}

function serializable(value){if(value instanceof Uint8Array)return {$bytes:Array.from(value)};if(Array.isArray(value))return value.map(serializable);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,serializable(v)]));return value;}
function restore(value){if(value&&Object.hasOwn(value,'$bytes'))return Uint8Array.from(value.$bytes);if(Array.isArray(value))return value.map(restore);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v)]));return value;}

export class AccountController {
  constructor({metadata,gate,blobs,archives,config,sql,sqlTransaction}){
    if(config.WORK_LIMITS_ENABLED!==undefined&&!['true','false',true,false].includes(config.WORK_LIMITS_ENABLED))throw new TypeError('Invalid logical activity admission configuration.');
    if(config.STORAGE_WRITE_ENABLED!==undefined&&!['true','false',true,false].includes(config.STORAGE_WRITE_ENABLED))throw new TypeError('Invalid storage write admission configuration.');
    this.physicalWriteEnabled=config.STORAGE_WRITE_ENABLED==='true'||config.STORAGE_WRITE_ENABLED===true;this.logicalWorkEnabled=config.WORK_LIMITS_ENABLED==='true'||config.WORK_LIMITS_ENABLED===true||(config.WORK_LIMITS_ENABLED===undefined&&Boolean(config.WORK_AUTHORITY));this.storageWriteBudget=this.physicalWriteEnabled||this.logicalWorkEnabled?new AccountStorageWriteBudget({metadata,authority:config.STORAGE_WRITE_AUTHORITY??config.WORK_AUTHORITY,config:{...config,STORAGE_WRITE_ENABLED:true}}):null;
    const wrap=(bucket,maintenance)=>guardedBucket(bucket,{admit:async clientId=>{if(this.physicalWriteEnabled){if(!maintenance&&(await metadata.get('storage/garbage-retry'))?.paused===true||!maintenance&&(await metadata.get('storage/cleanup-retry'))?.paused===true)throw new StorageError('storage_write_unavailable','Storage writes are paused while retained uploads are cleaned up.',503);await this.storageWriteBudget.admit(await metadata.get('owner'),{clientId,maintenance});}}});blobs=wrap(blobs,false);archives=wrap(archives,true);
    this.metadata=metadata;this.googleDrive=new GoogleDriveService({metadata,config,fetcher:config.GOOGLE_DRIVE_FETCH??fetch});this.apps=new AppConnections({metadata,origin:config.APP_ORIGIN});this.gate=gate;this.workBudget=this.storageWriteBudget;this.blobs=blobs;this.archives=archives;this.config=config;this.quota=new StorageQuota({metadata,blobs,config});this.itemIndex=sql?new AccountItemIndex(sql):null;this.billing=new BillingService({config,metadata});this.searchIndex=sql?new SqliteSearchIndex({sql,transaction:sqlTransaction||sql.transaction?.bind(sql)}):null;this.searchOutbox=new MetadataSearchOutbox(metadata);this.semanticBudget=new DurableSemanticBudget({state:metadata,configured:config.SEMANTIC_SEARCH_ENABLED==='true'&&Boolean(config.AI?.run&&(config.SEARCH_VECTORS?.query||[0,1,2,3].every(shard=>config[`SEARCH_VECTORS_${shard}`]?.query))),globalSpend:config.SEMANTIC_SPEND});this.vectorGate=new SearchMutationGate();this.search=this.searchIndex?new SearchService({index:this.searchIndex,outbox:this.searchOutbox,semanticPolicy:this.semanticBudget,onSemanticError:(event,error)=>this.deferSemanticSearch(event,error),authority:{get:(owner,id,options)=>this.searchDocument(owner,id,options),scan:(owner,options)=>this.scanSearchDocuments(owner,options)}}):null;
    const store={transaction:async operation=>{
      const garbage=[];
      const result=await this.metadata.transaction(async tx=>operation({
        get:k=>tx.get(k),
        set:async(k,v)=>{if(v?.bytes instanceof Uint8Array){const reservation=this.messageReservation;if(!reservation||reservation.owner!==v.owner||reservation.bytes!==v.bytes.byteLength)throw new StorageError('conflict','Message upload reservation is missing.',409);const blobRef=reservation.blobRef;const {bytes,...record}=v;const event=await this.queueMessageSearch(tx,record);record.revision=event.revision;await tx.put(k,{...record,blobRef});this.itemIndex?.upsert(record);await this.quota.commit(tx,reservation.id);}else{if(k.startsWith('message/')){const event=await this.queueMessageSearch(tx,v);v={...v,revision:event.revision};this.itemIndex?.upsert(v);}await tx.put(k,v);}},
        delete:async k=>{const value=await tx.get(k);if(value?.blobRef){const garbageKey=`blob-garbage/${crypto.randomUUID()}`;await tx.put(garbageKey,value.blobRef);garbage.push({key:garbageKey,blobRef:value.blobRef});const alarm=typeof tx.getAlarm==='function'?await tx.getAlarm():null;await tx.setAlarm?.(alarm?Math.min(alarm,Date.now()+60000):Date.now()+60000);}if(k.startsWith('message/')&&value){await this.queueMessageSearch(tx,value,'tombstone');this.itemIndex?.remove(value.id);}await tx.delete(k);},
        list:async prefix=>[...(await tx.list({prefix}))].map(([key,value])=>{if(value?.blobRef){const {blobRef,...record}=value;return {key,value:record};}return {key,value};})
      }));
      for(const {key,blobRef}of garbage){try{await this.blobs.delete(blobRef);await this.metadata.delete(key);}catch{/* Ownership was committed with logical deletion; GC can retry after a crash. */}}
      return result;
    }};
    this.store=store;this.tokens=new ContactTokenService({store,issuer:config.APP_ORIGIN,allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true'});
    this.endpoints=new ContactEndpointService({tokens:this.tokens,signer:async({owner,kid})=>{const signer=await this.signingKey(owner);if(signer.kid!==kid)throw new Error('Signing key unavailable');return signer.privateKey;}});
    this.messages=new MessagingService({store,tokens:this.endpoints,maxStoredBytes:1_000_000_000_000,maxStoredMessages:1_000_000});
    this.notifications=new NotificationService({store});
    this.beams=new BeamService({metadata,config,entitlement:owner=>this.billing.entitlement(owner)});this.beamContacts=new BeamContacts({metadata,endpoints:this.endpoints});
  }
  async invoke({method,args}){
    const allowed=['paidHandleEligibility','identityKeychain','googleDriveStart','googleDriveComplete',...Object.keys(automationMethods),...Object.keys(conversationMethods).filter(m=>m!=='conversationIdentity'),'appConnectionBinding','appConnections','appConnect','appBindleConnect','appDisconnect','appConnectionCheck','mcpCollections','mcpOperation','admitWork','touch','snapshot','collections','contacts','createContact','contactURL','revokeContact','quarantineContact','inspectContact','mintContact','deliverContact','receive','message','messageBytes','updateMessage','deleteMessage','rules','notificationPreferences','rememberSignupOrigin','registerSignupPush','subscribe','removeSubscription','unsubscribe','unsubscribeLink','resources','addResource','verifyResource','deleteResource','federationRPC','storageUsage','messagePage','billingRefresh','billingStatus','billingChangePlan','billingCancelChange','billingCheckout','billingPortal','billingWebhookVerified','omniSearch','searchRebuild','searchDrain','searchPreferences','updateSearchPreferences','beamInviteURL','beamOutbox','beamStatus','beamCreate','beamRaw','beamAction','beamMailbox','beamNotify','beamIce','beamProfile','beamContactEnable','beamContactRedeem','beamContactRemember','beamDirectory','beamContactForget','beamPermission','beamDisclosed','beamContactInfo','contactProfile','beamInviteCreate','beamInviteGet','beamInviteJoin','beamPair'];
    if(!allowed.includes(method))return {$fault:{code:'unsupported_method',message:'Unsupported account operation.',status:400}};
    // Fanout runs outside the account gate: a recipient may concurrently submit
    // to this source while its own account gate is held. Receiver writes retain
    // their own serialization, including the source's local inbox.
    if(method==='conversationDrain'||method==='conversationPublicIdentity'&&await this.metadata.get('signing-key')){try{return await this[method](...args);}catch(error){return {$fault:{code:error.code||'invalid_request',message:error.code?error.message:'Conversation delivery could not be completed.',status:error.status,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}}};}}
    return this.gate.run(async()=>{try{if(['mcpOperation','appConnectionBinding','appConnections','appConnect','appBindleConnect','appDisconnect','appConnectionCheck','message','messageBytes','updateMessage','deleteMessage','resources','addResource','verifyResource','deleteResource'].includes(method))await this.warm(args[0]);return await this[method](...args);}catch(error){return {$fault:{code:error.code||'invalid_request',message:error.code?error.message:'The account operation could not be completed.',status:error.status,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}}};}});
  }
  async appConnections(owner){return this.apps.list(owner);}
  async appConnectionBinding(owner,clientId){return this.apps.binding(owner,clientId);}
  async appConnect(owner,client,expected){return this.apps.register(owner,client,expected);}
  async appBindleConnect(owner,client,expected){return this.apps.register(owner,client,expected,{transport:'bindle',provenance:{kind:'oauth-consent',issuer:this.config.APP_ORIGIN}});}
  async appDisconnect(owner,id){return this.apps.disconnect(owner,id);}
  async appConnectionCheck(owner,id,generation,clientId){return this.apps.check(owner,id,generation,clientId);}
  async mcpCollections(owner){return accountMcpCollections(this,owner);}
  async mcpOperation(owner,clientId,tool,args,connection){await this.apps.check(owner,connection?.id,connection?.generation,clientId);return tool==='collections_list'?this.mcpCollections(owner):accountMcpOperation(this,owner,clientId,tool,args);}
  async admitWork(owner,{initialize=false,clientId='@system'}={}){if(this.logicalWorkEnabled&&typeof this.workBudget.authority?.consume!=='function')throw new StorageError('storage_write_unavailable','Activity admission is unavailable.',503);if(initialize)await this.ensureBuiltinStorage(owner);else if(await this.metadata.get('owner')!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);await this.billingRefresh(owner);if(this.logicalWorkEnabled)return this.workBudget.admit(owner,{initialize,clientId});return true;}
  async beamOutbox(owner,device){return this.beams.outbox(owner,device);}
  async beamStatus(owner){return this.beams.status(owner);}
  async beamCreate(owner,actor,input){const result=await this.beams.create(owner,actor,input);await this.scheduleAlarm(result.expiresAt);return result;}
  async beamRaw(owner,id){return this.beams.raw(id);}
  async beamAction(owner,id,actor,operation,input){const result=await this.beams.action(id,actor,operation,input);if(operation!=='get')await this.scheduleAlarm(result.expiresAt);return result;}
  async beamMailbox(owner,device){return this.beams.mailbox(owner,device);}
  async beamNotify(owner,input){const result=await this.beams.notify(owner,input);await this.scheduleAlarm(input.expiresAt);return result;}
  async beamProfile(owner,input){return this.beamContacts.profile(owner,input);}
  async beamContactEnable(owner,id,input){return this.beamContacts.enable(owner,id,input);}
  async beamContactRedeem(owner,url,peer){return this.beamContacts.redeem(owner,url,peer);}
  async beamContactRemember(owner,binding,url){const result=await this.beamContacts.remember(owner,binding);if(typeof url==='string'){const record=await this.metadata.get('beam/directory/'+binding.owner);record.encryptedURL=await encryptSecret({url},this.config.KEY_ENCRYPTION_KEY);await this.metadata.put('beam/directory/'+binding.owner,record);}return result;}
  async beamDirectory(owner){const rows=await this.beamContacts.directory(owner);return Promise.all(rows.map(async r=>{const record=await this.metadata.get('beam/directory/'+r.peer);return {...r,...record?.encryptedURL?await decryptSecret(record.encryptedURL,this.config.KEY_ENCRYPTION_KEY):{}};}));}
  async beamContactForget(owner,peer){return this.beamContacts.forget(owner,peer);}
  async beamPermission(owner,peer,input){return this.beamContacts.permission(owner,peer,input);}
  async beamContactInfo(owner,peer,input){return this.beamContacts.contactInfo(owner,peer,input);}
  async contactProfile(owner,url){return this.beamContacts.publicProfile(owner,url);}
  async beamDisclosed(owner,peer,input){return this.beamContacts.disclosed(owner,peer,input);}
  async beamInviteCreate(owner,input,device){const result=await this.beamContacts.createInvite(owner,input,device);const record=await this.metadata.get('beam/invite/'+result.id);record.encryptedToken=await encryptSecret({token:result.token},this.config.KEY_ENCRYPTION_KEY);await this.metadata.put('beam/invite/'+result.id,record);await this.scheduleAlarm(result.expiresAt);return result;}
  async beamInviteURL(owner,id){await this.beamContacts.invite(owner,id);const r=await this.metadata.get('beam/invite/'+id),secret=await decryptSecret(r.encryptedToken,this.config.KEY_ENCRYPTION_KEY);return `${this.config.APP_ORIGIN}/#beam-invite=${encodeURIComponent(secret.token)}`;}
  async beamInviteGet(owner,id){return this.beamContacts.invite(owner,id);}
  async beamInviteJoin(owner,token,peer){return this.beamContacts.joinInvite(owner,token,peer);}
  async beamPair(owner,id,peer,expiresAt,deviceId,senderDevice){return this.beamContacts.pair(owner,id,peer,expiresAt,deviceId,senderDevice);}
  async beamIce(owner,id,actor){
    const r=await this.beams.raw(id),role=this.beams.authorize(r,actor);if(r.state!=='accepted')throw new BeamError('beam_not_accepted','Accept the selected files first.',409);
    const status=await this.beams.status(owner);if(!status.paid)throw new BeamError('beam_paid_required','The sending plan is no longer paid.',403);
    if(!status.relayEnabled)return {iceServers:this.config.BEAM_STUN_ENABLED==='true'?[{urls:['stun:stun.cloudflare.com:3478']}]:[],relayEnabled:false};
    await this.metadata.transaction(async tx=>{const current=await tx.get('beam/offer/'+id);if(!current)throw new BeamError('beam_expired','This transfer has expired.',410);this.beams.authorize(current,actor);if(current.state!=='accepted')throw new BeamError('beam_not_accepted','This transfer is no longer accepted.',409);if(current.iceIssued[role])throw new BeamError('beam_turn_already_issued','TURN credentials were already issued for this participant.',409);current.iceIssued[role]='issuing';await tx.put('beam/offer/'+id,current);});
    const bytes=r.files.filter(f=>r.selected.includes(f.id)).reduce((n,f)=>n+f.size,0)*2;
    const reservation=await this.config.BEAM_RELAY_BUDGET.reserve({owner,transfer:id,role,maxBytes:bytes,ttl:300});if(!reservation?.enforced)throw new BeamError('beam_turn_unfunded','An enforceable relay allowance is required.',503);
    const adapter=new CloudflareTurnAdapter({keyId:this.config.CLOUDFLARE_TURN_KEY_ID,apiToken:this.config.CLOUDFLARE_TURN_API_TOKEN}),issued=await adapter.issue({ttl:300});
    try{await this.config.BEAM_RELAY_BUDGET.commit(reservation);await this.metadata.transaction(async tx=>{const current=await tx.get('beam/offer/'+id);if(!current)throw new BeamError('beam_expired','This transfer has expired.',410);this.beams.authorize(current,actor);if(current.state!=='accepted')throw new BeamError('beam_not_accepted','This transfer is no longer accepted.',409);current.iceIssued[role]=true;await tx.put('beam/offer/'+id,current);});}catch(error){for(const username of new Set(issued.iceServers.map(s=>s.username).filter(Boolean)))try{await adapter.revoke(username);}catch{}throw error;}return {...issued,relayEnabled:true};
  }
  async ensureBuiltinStorage(owner){
    const pointerKey='builtin/hosted-resource-v1',contract='https://3sln.me/artefacts/contracts/object-storage/v1',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    const unavailable=()=>{throw new StorageError('storage_unavailable','The built-in storage binding needs repair.',503);};
    const valid=resource=>resource&&uuid.test(resource.id)&&resource.owner===owner&&resource.provider==='hosted'&&resource.builtin===true&&resource.status==='connected'&&resource.kind===undefined&&!Object.hasOwn(resource,'secret')&&resource.contracts?.includes(contract)&&resource.capabilities?.read===true&&resource.capabilities?.write===true;
    return this.metadata.transaction(async tx=>{
      const boundOwner=await tx.get('owner');if(boundOwner!==undefined&&boundOwner!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);
      const existingBuiltins=async()=>{
        const rows=await tx.list({prefix:'resource/',limit:201});if(rows.size>200||[...rows.values()].some(resource=>resource.owner!==owner))unavailable();
        const entries=[...rows].filter(([,resource])=>resource.builtin===true);
        if(entries.length>1||entries.some(([key,resource])=>!valid(resource)||key!==`resource/${resource.id}`))unavailable();return entries.map(([,resource])=>resource);
      };
      const pointer=await tx.get(pointerKey);let id,resource;
      if(pointer!==undefined){
        if(pointer?.version!==1||pointer.owner!==owner||typeof pointer.id!=='string'||!uuid.test(pointer.id))unavailable();id=pointer.id;resource=await tx.get(`resource/${id}`);
        if(resource&&(!valid(resource)||resource.id!==id))unavailable();
        if(!resource){const existing=await existingBuiltins();if(existing.length&&existing[0].id!==id)unavailable();}
      }else {const existing=await existingBuiltins();resource=existing[0];id=resource?.id??crypto.randomUUID();}
      const freshBuiltin=!resource&&pointer===undefined;
      if(!resource){resource={id,owner,name:'Account storage',provider:'hosted',builtin:true,status:'connected',contracts:[contract],capabilities:{read:true,write:true,range:true,conditionalWrites:true,presigned:{read:false,write:false},maxObjectBytes:1048576},verifiedAt:Date.now()};await tx.put(`resource/${id}`,resource);}
      if(pointer===undefined)await tx.put(pointerKey,{version:1,owner,id});if(boundOwner===undefined)await tx.put('owner',owner);return resource;
    });
  }
  async warm(owner) {
    // A committed R2 snapshot survives eviction. Only clear warm records after
    // snapshot success; restores are serialized before any account operation.
    {
      const priorOwner=await this.metadata.get('owner');if(priorOwner!==undefined&&priorOwner!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);
      if(await this.metadata.get('shelved')){
        const snapshot=await this.archives.get(`accounts/${owner}.json`);
        if(!snapshot)throw new Error('Account archive unavailable');
        if(snapshot.size>8388608)throw new Error('Account archive exceeds bounds');
        const envelope=await snapshot.json();
        if(envelope.version!==1||envelope.owner!==owner||!Array.isArray(envelope.rows)||envelope.rows.length>2200||envelope.digest!==await archiveDigest(JSON.stringify(envelope.rows)))throw new Error('Account archive integrity check failed');
        const rows=restore(envelope.rows);if(rows.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!row[0].startsWith('message/')&&!row[0].startsWith('resource/')||!row[1]||row[1].owner!==owner))throw new Error('Account archive record invalid');
        await this.metadata.transaction(async tx=>{for(const [k,v]of rows)await tx.put(k,v);await tx.delete('shelved');});
      }
      const storedOwner=await this.metadata.get('owner');if(storedOwner!==undefined&&storedOwner!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);await this.ensureBuiltinStorage(owner);await this.migrateItemIndex(owner);
      if(!(await this.messages.collections(owner)).length)await this.messages.createCollection(owner,'Inbox');
      await this.scheduleAlarm(Date.now()+7*86400000);await this.billingRefresh(owner);
    }
  }
  async queueMessageSearch(tx,message,operation='upsert'){
    const id=`message:${message.id}`,prior=await tx.get(searchRevisionKey(message.owner,id)),old=await tx.get(key('message',message.owner,message.id));
    const revision=Math.max(prior?.revision||0,old?.revision||(old?1:0))+1;
    const entitlement=await storageState(tx,message.owner,Date.now(),this.config);
    const event=await enqueueSearchEvent(tx,{owner:message.owner,id,source:{kind:'message',id:message.id},operation,revision},{maxQueue:planBudget(entitlement.plan==='free'?'free':'paid').limits.queue});
    await tx.setAlarm(Date.now()+60000);return event;
  }
  async configureSemanticSearch(owner){
    if(!this.search||!this.semanticBudget.configured)return;
    if(this.search.vectorIndex){if(this.search.vectorIndex.owner!==owner)throw new StorageError('forbidden','Search owner mismatch.',403);return;}
    const route=await vectorBinding(this.config,owner),priorRoute=await this.metadata.get('search-vector-route');
    if(priorRoute&&(priorRoute.layoutVersion!==route.layoutVersion||priorRoute.shard!==route.shard))throw new StorageError('semantic_routing_mismatch','Search routing requires an explicit migration.',503);
    await this.metadata.put('search-vector-route',{layoutVersion:route.layoutVersion,shard:route.shard});
    this.search.embedder=new WorkersAIEmbeddingAdapter({binding:this.config.AI,model:SEMANTIC_MODEL,dimensions:SEMANTIC_DIMENSIONS,maxInputBytes:480,budget:this.semanticBudget});
    // This gate is distinct from the account gate already held by invoke/alarm.
    this.search.vectorIndex=new VectorizeSearchIndex({binding:route.binding,state:this.metadata,gate:this.vectorGate,owner,dimensions:SEMANTIC_DIMENSIONS,maxVectors:this.semanticBudget.limits.vectors,budget:this.semanticBudget});
  }
  async searchPreferences(owner){return {...await this.semanticBudget.status(owner),indexingPending:Boolean(await this.metadata.get('search-semantic-backfill')),cleanupPending:Boolean(await this.metadata.get('search-vector-purge')),error:(await this.metadata.get('search-semantic-error'))?.code||null};}
  async updateSearchPreferences(owner,input){
    await this.warm(owner);if(!input||Object.keys(input).some(name=>name!=='enabled')||typeof input.enabled!=='boolean')throw new StorageError('invalid_request','Choose whether to enable semantic search.',400);
    const current=await this.semanticBudget.status(owner);if(current.enabled===input.enabled)return this.searchPreferences(owner);
    if(input.enabled&&await this.metadata.get('search-vector-purge'))throw new StorageError('semantic_cleanup_pending','Semantic search cleanup is still pending. Try again shortly.',409);
    await this.semanticBudget.consent(owner,input.enabled);await this.configureSemanticSearch(owner);this.search?.sessions.clear();
    // Consent authorizes bounded backfill; revocation authorizes bounded purge.
    if(input.enabled)await this.metadata.put('search-semantic-backfill',{owner});
    else{await this.metadata.delete('search-semantic-backfill');await this.metadata.put('search-vector-purge',{owner});}
    await this.scheduleAlarm(Date.now()+60000);
    return this.searchPreferences(owner);
  }
  async purgeSearchVectors(owner,{limit=20}={}){
    if(!this.search?.vectorIndex)return {processed:0};
    const work=await this.metadata.get('search-vector-purge');if(!work)return {processed:0};const retry=await this.metadata.get('search/purge-retry');if(!retryReady(retry))return {processed:0,paused:Boolean(retry?.paused)};try{
    const prefix=key('search-vector-revision',owner),rows=await this.metadata.list({prefix,...work.cursor?{startAfter:work.cursor}:{},limit});
    for(const [path,record]of rows){if(record.active||record.cleanupIds?.length){const id=decodeURIComponent(path.slice(prefix.length).split('/')[0]);await this.search.vectorIndex.tombstone({owner,id,revision:record.revision});}}
    if(rows.size<limit)await this.metadata.delete('search-vector-purge');else await this.metadata.put('search-vector-purge',{owner,cursor:[...rows.keys()].at(-1)});
    await this.metadata.delete('search/purge-retry');return {processed:rows.size};}catch(error){await retryFailure(this.metadata,'search/purge-retry',error);throw error;}
  }
  async backfillSemanticSearch(owner){
    const work=await this.metadata.get('search-semantic-backfill');if(!work||work.paused||work.retryAfter>Date.now()||!retryReady(await this.metadata.get('search/semantic-retry'))||!await this.semanticBudget.enabled(owner))return;try{
    const page=await this.searchRebuild(owner,{limit:10,cursor:work.cursor});
    const deferred=await this.metadata.get('search-semantic-backfill');if(deferred?.paused||deferred?.retryAfter>Date.now())return;
    if(page.cursor)await this.metadata.put('search-semantic-backfill',{owner,cursor:page.cursor});else{await this.metadata.delete('search-semantic-backfill');await this.metadata.delete('search-semantic-error');await this.metadata.delete('search/semantic-retry');}}catch(error){await this.deferSemanticSearch({owner},error);}
  }
  async deferSemanticSearch(event,error){
    const now=Date.now(),date=new Date(now),budget=['semantic_account_budget','semantic_global_budget','search_vector_budget'].includes(error.code);
    const retry=budget?null:await retryFailure(this.metadata,'search/semantic-retry',error,now);const retryAfter=budget?Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1):retry.retryAt;
    await this.metadata.put('search-semantic-error',{code:error.code||'semantic_provider_unavailable',at:now});
    if(await this.semanticBudget.enabled(event.owner))await this.metadata.put('search-semantic-backfill',{owner:event.owner,retryAfter,...error.code==='search_vector_budget'||retry?.paused?{paused:true}:{}});
    else await this.metadata.put('search-vector-purge',{owner:event.owner});
  }
  async searchDocument(owner,id,{purpose='index',revision}={}){
    await this.configureSemanticSearch(owner);
    if(typeof id!=='string'||!id.startsWith('message:'))return null;
    const rawId=id.slice(8),message=await this.metadata.get(key('message',owner,rawId));
    if(!message||message.owner!==owner)return null;const currentRevision=message.revision||1;const embeddingAllowed=await this.semanticBudget.enabled(owner)&&['text/plain','text/html','application/vnd.3sln.web-archive+json'].includes(message.mimeType)&&!message.quarantined;
    if(purpose!=='index'){
      const cached=purpose==='search'?await this.searchIndex?.readContent(owner,id,revision):{title:message.senderMetadata?.subject||'',text:''};
      if(!cached)return null;
      return {id,owner,source:{kind:'message',id:rawId},revision:currentRevision,type:message.mimeType==='message/rfc822'?'email':'message',title:cached.title,text:cached.text,tags:message.tags||[],classification:message.classification||'unclassified',createdAt:message.receivedAt||0,acl:{readers:[owner]},quarantined:Boolean(message.quarantined),deleted:false,embeddingAllowed};
    }
    if(!message.blobRef)return {...messageSearchDocument({...message,bytes:new Uint8Array()},{revision:currentRevision}),createdAt:message.receivedAt||0,embeddingAllowed};
    const blob=await this.blobs.get(message.blobRef);if(!blob)throw new StorageError('temporarily_unavailable','Message data is temporarily unavailable.',503);
    if(blob.size>1048576)return messageSearchDocument({...message,bytes:new Uint8Array()},{revision:currentRevision});
    return {...messageSearchDocument({...message,bytes:new Uint8Array(await blob.arrayBuffer())},{revision:currentRevision}),embeddingAllowed};
  }
  async scanSearchDocuments(owner,{limit=50,cursor}={}){const page=await this.messagePage(owner,{limit,cursor});return {items:page.items.map(message=>({id:`message:${message.id}`,owner,revision:message.revision||1,deleted:false})),cursor:page.cursor};}
  async searchDrain(owner,{limit=10}={}){
    if(!this.search)return {processed:0};const retry=await this.metadata.get('search/extraction-retry');if(!retryReady(retry))return {processed:0,paused:Boolean(retry?.paused)};await this.configureSemanticSearch(owner);const entitlement=await this.billing.entitlement(owner),budgets=planBudget(entitlement.plan==='free'?'free':'paid').limits;this.search.budgets=budgets;this.searchIndex.budgets=budgets;
    try{const result=await this.search.drain(owner,{limit});await this.metadata.delete('search-index-error');await this.metadata.delete('search/extraction-retry');return result;}catch(error){await retryFailure(this.metadata,'search/extraction-retry',error);await this.metadata.put('search-index-error',{code:error.code||'index_unavailable',at:Date.now()});throw error;}
  }
  async searchRebuild(owner,options={}){await this.warm(owner);if(!this.search)throw new StorageError('temporarily_unavailable','Search is unavailable.',503);await this.configureSemanticSearch(owner);return this.search.rebuild(owner,{...options,limit:Math.min(options.limit||50,50)});}
  async omniSearch(owner,input){await this.warm(owner);if(!this.search)throw new StorageError('temporarily_unavailable','Search is unavailable.',503);await this.configureSemanticSearch(owner);const result=await this.search.search(owner,input);const pending=(await this.metadata.get(key('search-queue-usage',owner)))?.count||0;const error=await this.metadata.get('search-index-error');return {...result,semantic:await this.searchPreferences(owner),indexing:{pending,ready:pending===0&&!error&&Boolean(await this.metadata.get('search-backfill-ready')),backfillPending:!await this.metadata.get('search-backfill-ready'),limited:Boolean(error),error:error?.code||null}};}
  async paidHandleEligibility(owner){return this.billing.paidHandleEligibility(owner);}
  async billingRefresh(owner,{force=false}={}){if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/.test(owner)||await this.metadata.get('owner')!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);if(this.config.BILLING_ENABLED!=='true')return {checked:false,disabled:true};const previous=await this.metadata.get('billing/state'),pending=await this.metadata.get('billing/pending'),now=this.billing.now();if(!force&&(!previous||previous.owner!==owner||previous.plan==='free')&&(!pending||pending.owner!==owner||pending.expiresAt<=now))return {checked:false};const attempted=await this.metadata.get('billing/sync-attempt');if(Number.isSafeInteger(attempted)&&attempted>now-(force?15000:300000))return await this.metadata.get('billing/sync')??{checked:false};if(this.billingSyncPending)return this.billingSyncPending;this.billingSyncPending=(async()=>{await this.metadata.put('billing/sync-attempt',now);let result;try{const entitlement=await this.billing.reconcile(owner);result={checked:true,checkedAt:now,...entitlement};}catch(error){result={checked:false,checkedAt:now,error:error.code||'billing_provider_unavailable',validUntil:(await this.billing.entitlement(owner)).validUntil};}await this.metadata.put('billing/sync',result);return result;})().finally(()=>this.billingSyncPending=null);return this.billingSyncPending;}
  async billingStatus(owner,options){await this.billingRefresh(owner,{force:true});const result=await this.billing.status(owner,options);return {...result,plans:result.plans.map(plan=>({...plan,...this.workBudget?{dailyActivityUnits:plan.id==='free'?this.workBudget.limits.freeDay:(plan.activityDay??this.workBudget.limits.paidDay),hourlyActivityUnits:plan.id==='free'?this.workBudget.limits.freeHour:(plan.activityHour??this.workBudget.limits.paidHour)}:{}}))};}
  async billingCancelChange(owner,input){await this.warm(owner);return this.billing.changes.cancel(owner,input);}
  async billingChangePlan(owner,input){await this.warm(owner);return this.billing.changes.change(owner,input);}
  async billingCheckout(owner,plan,options){return this.billing.checkout(owner,plan,options);}
  async billingPortal(owner){return this.billing.portal(owner);}
  async billingWebhookVerified(owner,event){if(event.owner!==owner)throw new StorageError('forbidden','Billing account mismatch.',403);if(await this.metadata.get('owner')!==owner)return {accepted:true,ignored:true};const prior=await this.metadata.get('billing/state'),retained=prior?.owner===owner&&prior.source==='polar'&&(prior.catalogVersion!==3||prior.origin===this.config.APP_ORIGIN&&prior.server===this.config.POLAR_SERVER&&prior.metadataPrefix===(this.config.POLAR_METADATA_PREFIX??'3sln_me_')&&prior.catalogMode===(this.config.POLAR_CATALOG_MODE??'static'))&&(!event.organizationId||prior.organizationId===event.organizationId)&&prior.customerId===event.customerId&&(event.customerEvent?Boolean(prior.productId&&prior.subscriptionId):prior.productId===event.productId&&(!event.subscriptionId||prior.subscriptionId===event.subscriptionId));if(!event.relevant&&!retained)return {accepted:true,ignored:true};return this.billing.applyWebhook(event);}
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
  }
  async messagePage(owner,options={}){await this.warm(owner);if(!this.itemIndex)return {items:await this.messages.list(owner,options),cursor:null};if(!await this.metadata.get('item-index-ready'))throw new StorageError('temporarily_unavailable','Your inbox index is being upgraded. Try again shortly.',503);return this.itemIndex.page(owner,options);}
  async storageUsage(owner){await this.warm(owner);const usage=await this.quota.usage(owner);return {...usage,...this.storageWriteBudget?{writeOperations:await this.storageWriteBudget.status(owner)}:{}};}
  async scheduleAlarm(time){
    const now=Date.now(),cleanup=await this.quota.nextCleanup(),owner=await this.metadata.get('owner'),pending=owner&&((await this.metadata.get(key('search-queue-usage',owner)))?.count||!await this.metadata.get('item-index-ready')||!await this.metadata.get('search-backfill-ready')),garbage=await this.metadata.list({prefix:'blob-garbage/',limit:1});
    const semantic=await this.metadata.get('search-semantic-backfill'),purge=await this.metadata.get('search-vector-purge');
    const next=Math.min(time,cleanup||Infinity,pending?retryTime(await this.metadata.get('search/extraction-retry'),now):Infinity,garbage.size?retryTime(await this.metadata.get('storage/garbage-retry'),now):Infinity,purge?retryTime(await this.metadata.get('search/purge-retry'),now):Infinity,semantic&&!semantic.paused?Math.max(now+60000,semantic.retryAfter||0):Infinity),prior=typeof this.metadata.getAlarm==='function'?await this.metadata.getAlarm():null;if(prior&&prior>now&&prior<=next)return;return this.metadata.setAlarm(next);
  }
  async touch(owner) {await this.warm(owner);const now=Date.now(),prior=await this.metadata.get('lastOwnerActiveAt');if(Number.isSafeInteger(prior)&&prior>=now-900000)return;await this.metadata.put('lastOwnerActiveAt',now);await this.metadata.put('lifecycle',{status:'active'});await this.scheduleAlarm(now+7*86400000);}
  async snapshot(owner){await this.warm(owner);return {...await this.messageSnapshot(owner),collections:await this.messages.collections(owner),contacts:await this.contacts(owner),resources:await this.resources(owner),rules:await this.messages.rules(owner),notificationPreferences:await this.notifications.preferences(owner),pushDevices:await this.notifications.subscriptions(owner),storage:await this.storageUsage(owner),work:this.workBudget?await this.workBudget.status(owner):null,retention:await this.metadata.transaction(tx=>accountRemovalProtection(tx,owner,{config:this.config})),lifecycle:await this.metadata.get('lifecycle')||{status:'active'}};}
  async messageSnapshot(owner){const page=await this.messagePage(owner,{limit:100});return {messages:page.items,messageCursor:page.cursor};}
  async collections(owner,name){await this.warm(owner);return name===undefined?this.messages.collections(owner):this.messages.createCollection(owner,name);}
  async contacts(owner){const beamGrants=await this.metadata.list({prefix:'beam/grant/'});const names=await this.metadata.list({prefix:'contact-name/'});return (await this.tokens.list(owner)).map(g=>({id:g.id,beamEnabled:beamGrants.get('beam/grant/'+g.id)?.beamEnabled===true,profileFields:beamGrants.get('beam/grant/'+g.id)?.profileFields||[],discloseProfile:Boolean(beamGrants.get('beam/grant/'+g.id)?.profileFields?.length),name:names.get(`contact-name/${g.id}`)||'Contact link',active:g.active,quarantined:Boolean(g.quarantined),createdAt:g.createdAt,expiresAt:g.claims.exp*1000,collections:g.claims.collections,mimeTypes:g.claims.mimeTypes,messagesUsed:g.messagesUsed,maxMessages:g.claims.maxMessages,bytesUsed:g.bytesUsed,maxBytes:g.claims.maxBytes}));}
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
  // Internal identity-backup port only; never exposed by owner/MCP HTTP routes.
  async identityKeychain(owner,{create=true}={}){
    if(create){await this.warm(owner);await this.signingKey(owner);}
    const signing=await this.metadata.get('signing-key');
    let encryption=await this.metadata.get('encryption-key');
    if(!signing||(!encryption&&!create))throw new StorageError('identity_keys_unavailable','Identity keys are unavailable.',409);
    if(!encryption){
      const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey','deriveBits']);
      encryption={kid:crypto.randomUUID(),encrypted:await encryptSecret(await crypto.subtle.exportKey('jwk',pair.privateKey),this.config.KEY_ENCRYPTION_KEY)};
      await this.metadata.put('encryption-key',encryption);
    }
    return {version:1,signing:{kid:signing.kid,privateJWK:await decryptSecret(signing.encrypted,this.config.KEY_ENCRYPTION_KEY)},encryption:{kid:encryption.kid,privateJWK:await decryptSecret(encryption.encrypted,this.config.KEY_ENCRYPTION_KEY)}};
  }
  async createContact(owner,handle,input){await this.warm(owner);if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('Contact name is required');const signer=await this.signingKey(owner);const issued=await this.endpoints.create(owner,{...input,handle,kid:signer.kid});await this.metadata.put(`contact-name/${issued.grant.id}`,input.name.trim());if(input.beamEnabled!==undefined||input.profileFields!==undefined||input.discloseProfile!==undefined)await this.beamContacts.enable(owner,issued.grant.id,{beamEnabled:input.beamEnabled??false,...input.profileFields!==undefined?{profileFields:input.profileFields}:{},...input.discloseProfile!==undefined?{discloseProfile:input.discloseProfile}:{}});await this.metadata.put(`contact-url/${issued.grant.id}`,await encryptSecret({url:issued.url},this.config.KEY_ENCRYPTION_KEY));return {...(await this.contacts(owner)).find(g=>g.id===issued.grant.id),url:issued.url};}
  async contactURL(owner,id){const g=(await this.tokens.list(owner)).find(g=>g.id===id);if(!g)throw new Error('Contact not found');const record=await this.metadata.get(`contact-url/${id}`);return (await decryptSecret(record,this.config.KEY_ENCRYPTION_KEY)).url;}
  async revokeContact(owner,id){await this.tokens.revoke(owner,id);return {revoked:true};}
  async quarantineContact(owner,id,value){return this.endpoints.quarantine(owner,id,value);}
  async inspectContact(owner,url){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return {collections:await this.messages.collections(owner).then(all=>all.filter(c=>grant.claims.collections.includes(c.id)).map(({id,name})=>({id,name}))),mimeTypes:grant.claims.mimeTypes,maxMessageBytes:grant.claims.maxMessageBytes,expiresAt:grant.claims.exp*1000};}
  async mintContact(owner,url){const {grant}=await this.endpoints.inspect(url);if(grant.owner!==owner)throw Object.assign(new Error('Invalid contact capability.'),{code:'unauthorized'});return this.endpoints.mint(url);}
  async deliverContact(owner,url,input){const issued=await this.mintContact(owner,url);return this.receive(owner,issued.token,input);}
  async receive(owner,token,input){
    const verified=await this.endpoints.verify(token);if(verified.claims.sub!==owner)throw new Error('Wrong recipient');await this.warm(owner);
    if(!boundedString(input.collection)||!mimeValid(input.mimeType)||!boundedString(input.idempotencyKey,128)||!Array.isArray(input.bytes)&&!(input.bytes instanceof Uint8Array))throw new StorageError('invalid_message','Message fields are invalid.');
    const bytes=Uint8Array.from(input.bytes);if(bytes.byteLength>1048576)throw new StorageError('quota_exceeded','Messages are limited to one MiB.',429);const receipt=await this.metadata.get(key('message-receipt',verified.claims.parent,input.idempotencyKey));
    if(receipt)return this.messages.receive(token,{...input,bytes});
    validateContent(input.mimeType,bytes);validateSenderMetadata(input.senderMetadata);if(!verified.claims.collections.includes(input.collection)||!verified.claims.mimeTypes.includes(input.mimeType)||(await this.metadata.get(key('collection',owner,input.collection)))?.active!==true)throw new StorageError('forbidden','Message access denied.',403);const grant=await this.metadata.get(key('contact-grant',verified.claims.parent));if(bytes.length>verified.claims.maxMessageBytes||grant.messagesUsed+1>grant.claims.maxMessages||grant.bytesUsed+bytes.length>grant.claims.maxBytes)throw new StorageError('quota_exceeded','The contact invitation limit has been reached.',429);
    await this.quota.check(owner,{bytes:bytes.length});await this.admitWork(owner,{clientId:'contact:'+grant.id});
    const id=crypto.randomUUID(),reservation=await this.quota.reserve(owner,{id,bytes:bytes.length,blobRef:`messages/${owner}/${id}`,kind:'message'});
    this.messageReservation=reservation;
    try{await this.blobs.put(reservation.blobRef,bytes,{httpMetadata:{contentType:'application/octet-stream'},storageAdmission:{clientId:'contact:'+grant.id}});return await this.messages.receive(token,{...input,bytes});}finally{this.messageReservation=null;await this.quota.release(id);}
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
  async rememberSignupOrigin(owner,{createdAt}={}){if(!Number.isSafeInteger(createdAt)||createdAt>Date.now()||createdAt<0)throw new StorageError('invalid_signup_origin','Trusted signup creation time is required.');await this.warm(owner);await this.metadata.transaction(async tx=>{if(await tx.get('owner')!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);if(await tx.get(UNPAID_LIFECYCLE_ORIGIN)!==undefined)return;if(await tx.get('billing/state')!==undefined||await tx.get('lifecycle/paid-protection-v1')!==undefined||await tx.get('billing/ever-paid/production/'+owner)!==undefined||await tx.get('billing/ever-paid/sandbox/'+owner)!==undefined)return;await tx.put(UNPAID_LIFECYCLE_ORIGIN,{version:1,owner,origin:this.config.APP_ORIGIN,createdAt,source:'identity-signup'});});return {recorded:true};}
  async registerSignupPush(owner,{subscription}={}){await this.warm(owner);return this.notifications.subscribe(owner,subscription,'Account notifications',{enable:true});}
  async unsubscribeLink(owner){return `${owner}.${await this.notifications.issueUnsubscribe(owner,'email')}`;}
  async resources(owner){const rows=await this.metadata.list({prefix:'resource/'});return [...rows.values()].filter(r=>r.kind!=='app-connection').map(({secret,...resource})=>{const {list:legacyList,...capabilities}=resource.capabilities||{};return {...resource,capabilities};});}
  async addResource(owner,input){
    if((await this.resources(owner)).length>=100)throw Object.assign(new Error('This account has reached its resource limit.'),{code:'resource_limit',status:429});
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('Resource name required');
    if(input.provider==='hosted'){const resource={id:crypto.randomUUID(),owner,name:input.name.trim(),provider:'hosted',status:'connected',contracts:['https://3sln.me/artefacts/contracts/object-storage/v1'],capabilities:{read:true,write:true,range:true,conditionalWrites:true,presigned:{read:false,write:false},maxObjectBytes:1048576},verifiedAt:Date.now()};await this.metadata.put(`resource/${resource.id}`,resource);return resource;}
    if(!['s3','webdav'].includes(input.provider))throw new Error('Provider requires OAuth configuration');
    const config=input.config||input;const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};
    const adapter=input.provider==='s3'?new S3Adapter({...config,write:false,conditionalWrites:false},options):new WebDAVAdapter(config,options);
    const resource={id:crypto.randomUUID(),owner,name:input.name.trim(),provider:input.provider,status:'unverified',contracts:['https://3sln.me/artefacts/contracts/object-storage/v1'],capabilities:adapter.describe(),secret:await encryptSecret({...config,write:false,conditionalWrites:false},this.config.KEY_ENCRYPTION_KEY)};
    await this.metadata.put(`resource/${resource.id}`,resource);const {secret,...publicResource}=resource;return publicResource;
  }
  async googleDriveStart(owner,sessionId,input){await this.warm(owner);if(!input?.resourceId&&(await this.resources(owner)).length>=100)throw new StorageError('resource_limit','This account has reached its resource limit.',429);if(!input||Object.keys(input).some(k=>!['name','resourceId'].includes(k)))throw new StorageError('invalid_args','Choose a connection name.');await this.admitWork(owner);const result=await this.googleDrive.begin(owner,sessionId,input.name,{resourceId:input.resourceId});await this.touch(owner);return {authorizationUrl:result.url,expiresAt:result.expiresAt};}
  async googleDriveComplete(owner,sessionId,input){await this.warm(owner);if(!input||Object.keys(input).some(k=>!['state','code','error'].includes(k)))throw new StorageError('invalid_args','Invalid Google connection callback.');await this.admitWork(owner);const result=await this.googleDrive.complete(owner,sessionId,input);await this.touch(owner);return result;}
  async verifyResource(owner,id,input={}){objectKey(input.key);const resource=await this.metadata.get(`resource/${id}`);if(!resource||resource.owner!==owner||resource.kind==='app-connection')throw new Error('Resource not found');const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};const config=resource.provider==='google-drive'?null:await decryptSecret(resource.secret,this.config.KEY_ENCRYPTION_KEY);const adapter=resource.provider==='google-drive'?await this.googleDrive.adapter(owner,id):resource.provider==='s3'?new S3Adapter(config,options):new WebDAVAdapter(config,options);await adapter.get({key:input.key});const updated=await this.metadata.transaction(async tx=>{const current=await tx.get(`resource/${id}`);if(!current||current.owner!==owner||current.generation!==resource.generation)throw new StorageError('forbidden','The connection changed during verification.',403);const next={...current,capabilities:adapter.describe(),status:'connected',verifiedAt:Date.now()};await tx.put(`resource/${id}`,next);return next;});const {secret,...result}=updated;return result;}
  async deleteResource(owner,id){const builtin=await this.metadata.get('builtin/hosted-resource-v1');if(builtin?.owner===owner&&builtin.id===id)throw new StorageError('builtin_resource','Account storage is always available and cannot be disconnected.',409);const app=await this.metadata.get(`resource/${id}`);if(app?.kind==='app-connection')return this.apps.disconnect(owner,id);const resource=await this.metadata.get(`resource/${id}`);if(!resource||resource.owner!==owner)throw new Error('Resource not found');if(resource.builtin===true)throw new StorageError('builtin_resource','Account storage is always available and cannot be disconnected.',409);if(resource.provider==='google-drive')return this.googleDrive.disconnect(owner,id);if(resource.provider==='hosted'&&(await this.metadata.list({prefix:`hosted/${id}/`,limit:1})).size)throw new StorageError('resource_not_empty','Delete the files in this hosted resource before removing it.',409);await this.metadata.delete(`resource/${id}`);return {deleted:true};}
  async federationRPC(context){
    const owner=/\/entities\/([a-f0-9-]{36})$/.exec(context.subject)?.[1];if(!owner||context.subject!==`${this.config.APP_ORIGIN}/entities/${owner}`)throw new StorageError('forbidden','Resource access denied.',403);
    if(context.method==='list')throw new StorageError('unsupported_method','Object storage has no listing operation; use application-managed directory objects.');
    await this.warm(owner);
    if(context.authority==='bindle'&&(!context.epoch||!context.connection||!this.config.FEDERATION_IDENTITY_CHECK||await this.config.FEDERATION_IDENTITY_CHECK(owner,context.epoch)!==true))throw new StorageError('unauthorized','Application authorization is no longer active.',401);
    if(context.connection)await this.apps.check(owner,context.connection.id,context.connection.generation,context.clientId);
    const resourceId=new RegExp(`^${escapeRegex(this.config.APP_ORIGIN)}/entities/${owner}/resources/([a-f0-9-]{36})$`).exec(context.resource)?.[1];
    const resource=resourceId&&await this.metadata.get(`resource/${resourceId}`);
    if(!resource||resource.owner!==owner||resource.kind==='app-connection'||resource.status!=='connected'||!['https://3sln.me/artefacts/contracts/object-storage/v1',RESOURCE_SCOPING].includes(context.contract))throw new StorageError('forbidden','Resource access denied.',403);
    if(context.resourceGeneration!==undefined&&context.resourceGeneration!==String(resource.generation??resource.id))throw new StorageError('forbidden','The resource connection changed. Review access again.',403);
    if(context.contract===RESOURCE_SCOPING){if(context.method!=='describe'||Object.keys(context.args).length)throw new StorageError('unsupported_method','Scoping options use describe with no arguments.');return storageScopeOptions(resource.capabilities);}
    const assignedScope=context.scope??{};
    if(assignedScope.prefix&&context.args.key!==undefined){const prefix=assignedScope.prefix.replace(/\/$/,'');if(typeof context.args.key!=='string'||context.args.key!==prefix&&!context.args.key.startsWith(prefix+'/'))throw new StorageError('forbidden','The object is outside the assigned scope.',403);}
    if(assignedScope.readOnly&&(['put','delete'].includes(context.method)||context.method==='presign'&&context.args.operation==='write'))throw new StorageError('forbidden','This assignment is read only.',403);
    if(assignedScope.maxObjectBytes&&context.method==='presign')throw new StorageError('unsupported_method','Presigned URLs cannot enforce this assignment byte limit.');
    if(assignedScope.prefix&&context.method==='presign')throw new StorageError('unsupported_method','Presigned URLs cannot conceal this assignment namespace.');
    if(assignedScope.maxObjectBytes&&context.args.range&&resource.provider!=='hosted')throw new StorageError('unsupported_method','This connector cannot verify the full object size for a bounded range read.');
    if(assignedScope.maxObjectBytes&&context.method==='put'&&typeof context.args.dataBase64==='string'&&Math.floor(context.args.dataBase64.length*3/4)-(context.args.dataBase64.endsWith('==')?2:context.args.dataBase64.endsWith('=')?1:0)>assignedScope.maxObjectBytes)throw new StorageError('forbidden','The object exceeds the assigned byte limit.',403);
    if(!/^[a-f0-9-]{36}$/.test(context.tx)||typeof context.clientId!=='string')throw new StorageError('invalid_args','A transaction UUID is required.');
    const fingerprint=await archiveDigest(canonical({resource:context.resource,contract:context.contract,method:context.method,args:context.args,...context.authority==='bindle'?{addressedResource:context.addressedResource,epoch:context.epoch,resourceGeneration:context.resourceGeneration,scope:assignedScope,connection:context.connection}: {}}));
    const journalKey=`rpc-journal/${encodeURIComponent(context.clientId)}/${context.tx}`;let prior=await this.metadata.get(journalKey);if(prior&&prior.createdAt+86400000<=Date.now()){await this.metadata.delete(journalKey);prior=null;}
    if(prior){if(prior.fingerprint!==fingerprint)throw new StorageError('tx_conflict','Transaction identifier was reused with different arguments.',409);if(prior.state!=='done')throw new StorageError('indeterminate','The earlier operation must be reconciled before retrying.',503);if(prior.error)throw Object.assign(new StorageError(prior.error.code,prior.error.message,prior.error.status),prior.error.retryAfter?{retryAfter:prior.error.retryAfter}:{});if(prior.resultRef){const blob=await this.blobs.get(prior.resultRef);if(!blob)throw new StorageError('temporarily_unavailable','Stored outcome is temporarily unavailable.',503);return blob.json();}return prior.result;}
    const mutating=['put','delete'].includes(context.method);
    // A durable reservation precedes effects. Recovery never repeats a write
    // whose effect may have happened before the completed journal was stored.
    let journalReserved=false;const reserveJournal=async()=>{let live=0;for(const [record,value]of await this.metadata.list({prefix:'rpc-journal/',limit:257})){if(value.createdAt+86400000<=Date.now())await this.metadata.delete(record);else live++;}if(live>=256)throw new StorageError('rate_limited','This account has reached its retained write-operation limit.',429);await this.metadata.put(journalKey,{fingerprint,state:'reserved',createdAt:Date.now()});journalReserved=true;};
    try{
      let result;
      if(resource.provider==='hosted')result=await this.hostedOperation(resource,context.method,context.args,reserveJournal,context.clientId);
      else if(resource.provider==='google-drive'){const adapter=await this.googleDrive.adapter(owner,resource.id);if(context.method==='capabilities')result=adapter.describe();else if(context.method==='get'){const value=await adapter.get(context.args);result={dataBase64:base64(value.bytes),object:{key:context.args.key,version:value.version,size:value.size??value.bytes.byteLength,contentType:value.contentType}};}else if(context.method==='put'){if(typeof context.args.dataBase64!=='string'||context.args.dataBase64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(context.args.dataBase64))throw new StorageError('invalid_args','Canonical base64 data is required.');let bytes;try{bytes=Uint8Array.from(atob(context.args.dataBase64),c=>c.charCodeAt(0));}catch{throw new StorageError('invalid_args','Use a valid base64 byte payload.');}if(base64(bytes)!==context.args.dataBase64)throw new StorageError('invalid_args','Canonical base64 data is required.');if(bytes.length>1048576)throw new StorageError('body_too_large','This resource accepts files up to 1 MiB.',413);await this.admitWork(owner,{clientId:context.clientId});await reserveJournal();const value=await adapter.put({...context.args,bytes});result={object:{key:context.args.key,...value}};}else if(context.method==='delete'){await reserveJournal();result=await adapter.delete(context.args);}else throw new StorageError('unsupported_method','Google Drive does not support this operation.');}
      else {const config=await decryptSecret(resource.secret,this.config.KEY_ENCRYPTION_KEY);const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};const adapter=resource.provider==='s3'?new S3Adapter(config,options):new WebDAVAdapter(config,options);if(context.method==='capabilities')result=adapter.describe();else if(context.method==='get'){const value=await adapter.get(context.args);result={dataBase64:base64(value.bytes),object:{key:context.args.key,version:value.version,size:value.size??value.bytes.byteLength,contentType:value.contentType}};}else if(context.method==='presign')result=await adapter[context.method](context.args);else throw new StorageError('unsupported_method','This connector does not support that operation.');}
      if(assignedScope.maxObjectBytes&&context.method==='get'&&result.object?.size>assignedScope.maxObjectBytes)throw new StorageError('forbidden','The object exceeds the assigned byte limit.',403);
      if(context.method==='capabilities'&&Object.keys(assignedScope).length){result={...result,...assignedScope.readOnly?{write:false,delete:false,presigned:{...result.presigned,write:false}}:{},...assignedScope.prefix?{presigned:{read:false,write:false}}:{},...assignedScope.maxObjectBytes?{maxObjectBytes:Math.min(result.maxObjectBytes??1048576,assignedScope.maxObjectBytes),presigned:{read:false,write:false},...resource.provider!=='hosted'?{range:false}:{}}:{}};}
      if(!mutating)return result;
      const encoded=JSON.stringify(result);let saved={result};if(new TextEncoder().encode(encoded).byteLength>65536){const resultRef=`rpc-results/${owner}/${await archiveDigest(context.clientId)}/${context.tx}`;await this.blobs.put(resultRef,encoded,{storageAdmission:{clientId:context.clientId}});saved={resultRef};}await this.metadata.put(journalKey,{fingerprint,state:'done',...saved,createdAt:Date.now()});await this.metadata.put('lastResourceActiveAt',Date.now());return result;
    }catch(error){if(mutating&&journalReserved){const safe=error instanceof StorageError?{code:error.code,message:error.message,status:error.status,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}}:{code:'indeterminate',message:'Storage outcome is unknown; reconcile before retrying.',status:503};await this.metadata.put(journalKey,{fingerprint,state:'done',error:safe,createdAt:Date.now()});throw Object.assign(new StorageError(safe.code,safe.message,safe.status),safe.retryAfter?{retryAfter:safe.retryAfter}:{});}throw error;}
  }
  async migrateHostedIndex(resource){
    if(!this.itemIndex||await this.metadata.get(`hosted-index-ready/${resource.id}`))return;
    const cursor=await this.metadata.get(`hosted-index-cursor/${resource.id}`),prefix=`hosted/${resource.id}/`;
    const rows=await this.metadata.list({prefix,...cursor?{startAfter:cursor}:{},limit:200});
    await this.metadata.transaction(async tx=>{for(const [,object]of rows)this.itemIndex.upsertObject(resource.id,object);if(rows.size<200){await tx.put(`hosted-index-ready/${resource.id}`,true);await tx.delete(`hosted-index-cursor/${resource.id}`);}else await tx.put(`hosted-index-cursor/${resource.id}`,[...rows.keys()].at(-1));});
  }
  async hostedOperation(resource,method,args={},beforeEffect=async()=>{},clientId='@system'){
    if(method==='capabilities'){const {list:legacyList,...capabilities}=resource.capabilities;return capabilities;}
    if(method==='list')throw new StorageError('unsupported_method','Object storage has no listing operation; use application-managed directory objects.');
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
      await this.quota.check(resource.owner,{bytes:bytes.length,replacedBytes:current?.size||0});await this.admitWork(resource.owner,{clientId});
      const version=crypto.randomUUID(),blobRef=`objects/${resource.owner}/${resource.id}/${version}`;
      const reservation=await this.quota.reserve(resource.owner,{id:version,bytes:bytes.length,replacedBytes:current?.size||0,blobRef,kind:'object'});
      try{
        await beforeEffect();
        await this.blobs.put(blobRef,bytes,{storageAdmission:{clientId}});
        const object={key:args.key,version,size:bytes.length,contentType:args.contentType||'application/octet-stream',modifiedAt:Date.now(),blobRef};
        await this.metadata.transaction(async tx=>{await tx.put(path,object);await tx.put('hosted-usage',{bytes:usage.bytes-(current?.size||0)+bytes.length,objects:usage.objects+(!current?1:0)});this.itemIndex?.upsertObject(resource.id,object);await this.quota.commit(tx,reservation.id);if(current)await tx.put(`blob-garbage/${crypto.randomUUID()}`,current.blobRef);});
        const {blobRef:privateRef,...publicObject}=object;return {object:publicObject};
      }finally{await this.quota.release(reservation.id);await this.scheduleAlarm(Date.now()+60000);}
    }
    if(method==='delete'){
      if(!current)throw new StorageError('not_found','Object not found.',404);if(typeof args.version!=='string'||current.version!==args.version)throw new StorageError('conflict','Object changed.',409);
      await beforeEffect();await this.metadata.transaction(async tx=>{const usage=await tx.get('hosted-usage');await tx.delete(path);if(usage)await tx.put('hosted-usage',{bytes:usage.bytes-current.size,objects:usage.objects-1});this.itemIndex?.removeObject(resource.id,args.key);await tx.put(`blob-garbage/${crypto.randomUUID()}`,current.blobRef);});await this.scheduleAlarm(Date.now()+60000);return {deleted:true};
    }
    throw new StorageError('unsupported_method','Hosted storage does not support that operation.');
  }
  async collectBlobGarbage({limit=32}={}){
    const retry=await this.metadata.get('storage/garbage-retry');if(!retryReady(retry))return {cleaned:0,paused:Boolean(retry?.paused)};let failed=false;const cursor=await this.metadata.get('blob-garbage-cursor');let rows=await this.metadata.list({prefix:'blob-garbage/',...cursor?{startAfter:cursor}:{},limit});if(!rows.size&&cursor)rows=await this.metadata.list({prefix:'blob-garbage/',limit});
    let cleaned=0;for(const [path,ref]of rows){try{await this.blobs.delete(ref);await this.metadata.delete(path);cleaned++;}catch{failed=true;/* Retain ownership of retryable garbage. */}}
    if(failed)await retryFailure(this.metadata,'storage/garbage-retry',null);else if(!(await this.metadata.list({prefix:'blob-garbage/',limit:1})).size)await this.metadata.delete('storage/garbage-retry');if(rows.size)await this.metadata.put('blob-garbage-cursor',[...rows.keys()].at(-1));return {cleaned};
  }
  async alarm(){
    const conversationOwner=await this.metadata.get('owner');if(conversationOwner)await this.conversationDrain(conversationOwner,{limit:16});
    const retry=await this.metadata.get('maintenance/alarm-retry');if(!retryReady(retry)){await this.metadata.setAlarm(retry?.paused?Date.now()+7*86400000:retryTime(retry));return;}try{await this.gate.run(async()=>{
      await this.beams.cleanup();const beamExpiry=[];for(const prefix of ['beam/offer/','beam/mailbox/','beam/invite/','beam/nearby/'])for(const r of (await this.metadata.list({prefix,limit:129})).values())beamExpiry.push(r.expiresAt);if(beamExpiry.length)await this.scheduleAlarm(Math.min(...beamExpiry));
      await this.quota.cleanup();await this.collectBlobGarbage();const owner=await this.metadata.get('owner');if(!owner)return;
      if(await this.metadata.get('shelved')){await this.scheduleAlarm(Date.now()+7*86400000);return;}
      await this.migrateItemIndex(owner);await this.configureSemanticSearch(owner);try{await this.purgeSearchVectors(owner);await this.backfillSemanticSearch(owner);}catch(error){await this.metadata.put('search-index-error',{code:error.code||'index_unavailable',at:Date.now()});}
      if((await this.metadata.get(key('search-queue-usage',owner)))?.count){try{await this.searchDrain(owner,{limit:10});}catch{/* Durable outbox and health marker retain retry work. */}}
      if((await this.metadata.get(key('search-queue-usage',owner)))?.count||this.itemIndex&&(!await this.metadata.get('item-index-ready')||!await this.metadata.get('search-backfill-ready'))){await this.scheduleAlarm(Date.now()+7*86400000);return;}
      const semanticPending=await this.metadata.get('search-semantic-backfill');if(semanticPending&&!semanticPending.paused||await this.metadata.get('search-vector-purge')){await this.scheduleAlarm(Date.now()+7*86400000);return;}
      const last=await this.metadata.get('lastOwnerActiveAt')||0;if(Date.now()-last<7*86400000){await this.scheduleAlarm(last+7*86400000);return;}
      const messageRows=await this.metadata.list({prefix:key('message',owner),limit:2001}),resourceRows=await this.metadata.list({prefix:'resource/',limit:201});if(messageRows.size>2000||resourceRows.size>200){await this.metadata.put('cold-index-mode',{mode:'indexed-sqlite',reason:'paged-metadata-shelving-pending'});await this.scheduleAlarm(Date.now()+7*86400000);return;}const all=new Map([...messageRows,...resourceRows]);
      // Keep signing/public capability records hot, so invalid bearers cannot
      // trigger an archive restore. Only cold content metadata/resources move.
      const rows=[...all].filter(([k])=>k.startsWith('message/')||k.startsWith('resource/'));
      const serializedRows=serializable(rows);const serialized=JSON.stringify({version:1,owner,rows:serializedRows,digest:await archiveDigest(JSON.stringify(serializedRows))});const archiveKey=`accounts/${owner}.json`;
      if(new TextEncoder().encode(serialized).byteLength>8388608){await this.metadata.put('cold-index-mode',{mode:'indexed-sqlite',reason:'paged-metadata-shelving-pending'});await this.scheduleAlarm(Date.now()+7*86400000);return;}
      await this.archives.put(archiveKey,serialized,{httpMetadata:{contentType:'application/json'}});
      const verified=await this.archives.get(archiveKey);if(!verified||await verified.text()!==serialized)throw new Error('Archive verification failed');
      await this.metadata.transaction(async tx=>{for(let i=0;i<rows.length;i+=100)await tx.delete(rows.slice(i,i+100).map(([k])=>k));await tx.put('shelved',true);});await this.scheduleAlarm(Date.now()+7*86400000);
    });await this.metadata.delete('maintenance/alarm-retry');}catch(error){const retry=await retryFailure(this.metadata,'maintenance/alarm-retry',error);await this.metadata.setAlarm(retry.paused?Date.now()+7*86400000:retry.retryAt);}
  }
}
for(const [method,implementation]of Object.entries(conversationMethods))Object.defineProperty(AccountController.prototype,method,{value:implementation,writable:true,configurable:true});

async function archiveDigest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function base64(bytes){let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

Object.assign(AccountController.prototype,automationMethods);
