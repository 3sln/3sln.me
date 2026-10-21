import {validateHostAlias,configuredReservedName} from '../identity/badge-policy.mjs';
import {onboardingAlias,sameOnboardingIdentity} from '../identity/onboarding.mjs';
import {cleanupPostbackPreparations,erasePostbackPreparations} from './message-postbacks.mjs';
import {messagePresentationSummary} from '../messaging/presentation-summary.mjs';
import {erasePresentations} from './message-presentations.mjs';
import {appNotificationAllowed} from './app-notifications.mjs';
import {ActivePopulationStorage,recordOwnerPopulation} from './active-population.mjs';
import {createAppEngine,operate,operationPolicy} from '../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../app/providers.mjs';
import {ACCOUNT_OPERATIONS} from '../app/operations.mjs';
import {accountProviders} from '../app/account.mjs';
import {SavedViews} from '../app/domains/views.mjs';
import {TagRules,TagLabels} from '../app/domains/tags.mjs';
import {linkPolicyRegistry} from './developer-contact.mjs';
import {admitLinkAudience,collectLinkState} from './contact-links.mjs';
import {sameSystemIdentity} from '../identity/system-bootstrap.mjs';
import {ContactDeliveryService} from '../messaging/contact-delivery-service.mjs';
import {localAuthorResolver} from '../messaging/contact-delivery.mjs';
import {WaitlistService} from './waitlist.mjs';
import {accountRemovalProtection} from '../identity/lifecycle-protection.mjs';
import {consumeSignupCapacity,signupCapacityStatus} from './signup-capacity.mjs';
import {encodeFreeHandleNumber,normalizeHandle} from '../identity/handles.mjs';
import {GoogleDriveService} from '../storage/google-drive.mjs';
import {AppConnections} from '../apps/connections.mjs';
import {retryReady,retryTime,retryFailure} from './cleanup-retry.mjs';
import {lifecycleMethods,lifecycleBlocked,lifecycleActivity,lifecycleTick} from './lifecycle-runner.mjs';
import {BeamService} from '../beaming/index.mjs';
import {BeamContacts} from '../beaming/contacts.mjs';
import {ContactTokenService,ContactEndpointService,MessagingService,NotificationService} from '../../packages/messaging/index.mjs';
import {key} from '../../packages/messaging/store.mjs';
import {indexDeviceExpiry,sweepDeviceExpiry,IdentityShardStorage} from './identity-shards.mjs';
import {StorageError} from '../storage/policy.mjs';
import {StorageQuota} from './storage-quota.mjs';
import {AccountStorageWriteBudget} from './storage-write-budget.mjs';
import {MessageReceiptBudget} from './message-receipt-budget.mjs';
import {guardedBucket} from './guarded-bucket.mjs';
import {AccountItemIndex} from './item-index.mjs';
import {BillingService} from '../billing/index.mjs';
import {SearchService,SqliteSearchIndex,MetadataSearchOutbox,DurableSemanticBudget,SearchMutationGate} from '../search/index.mjs';
import {installAccountMethods,accountRPC} from './account/index.mjs';
import {archiveDigest} from './account/support.mjs';

export class IdentityRepository {
  async shardRead(...args){return new IdentityShardStorage(this.metadata,this.config).read(...args);}
  async shardPrepare(...args){return new IdentityShardStorage(this.metadata,this.config).prepare(...args);}
  async shardSettle(...args){return new IdentityShardStorage(this.metadata,this.config).settle(...args);}
  async shardFinish(...args){return new IdentityShardStorage(this.metadata,this.config).finish(...args);}
  async shardLookup(...args){return new IdentityShardStorage(this.metadata,this.config).lookup(...args);}
  async shardClaim(...args){return new IdentityShardStorage(this.metadata,this.config).claim(...args);}
  async shardRelease(...args){return new IdentityShardStorage(this.metadata,this.config).release(...args);}
  async shardNamespaceBound(...args){return new IdentityShardStorage(this.metadata,this.config).namespaceBound(...args);}
  async shardPaidHandleRead(...args){return new IdentityShardStorage(this.metadata,this.config).paidHandleRead(...args);}
  async shardPaidHandleAnchor(...args){return new IdentityShardStorage(this.metadata,this.config).paidHandleAnchor(...args);}
  async shardPaidHandleFinish(...args){return new IdentityShardStorage(this.metadata,this.config).paidHandleFinish(...args);}
  async shardPaidHandleClaim(...args){return new IdentityShardStorage(this.metadata,this.config).paidHandleClaim(...args);}
  async shardOnboardingReserve(...args){return new IdentityShardStorage(this.metadata,this.config).onboardingReserve(...args);}
  async shardOnboardingClaim(...args){return new IdentityShardStorage(this.metadata,this.config).onboardingClaim(...args);}
  async shardOnboardingStep(...args){return new IdentityShardStorage(this.metadata,this.config).onboardingStep(...args);}
  async shardOnboardingSweep(...args){return new IdentityShardStorage(this.metadata,this.config).onboardingSweep(...args);}
  async shardSystemReserve(...args){return new IdentityShardStorage(this.metadata,this.config).systemReserve(...args);}
  async shardSystemStep(...args){return new IdentityShardStorage(this.metadata,this.config).systemStep(...args);}
  async shardHandleLookup(...args){return new IdentityShardStorage(this.metadata,this.config).handleLookup(...args);}
  async shardHandleClaim(...args){return new IdentityShardStorage(this.metadata,this.config).handleClaim(...args);}
  async shardHandleConsume(...args){return new IdentityShardStorage(this.metadata,this.config).handleConsume(...args);}
  async shardHandleGrandfather(...args){return new IdentityShardStorage(this.metadata,this.config).handleGrandfather(...args);}
  async shardNextHandleNumber(...args){return new IdentityShardStorage(this.metadata,this.config).nextHandleNumber(...args);}
  async shardPage(...args){return new IdentityShardStorage(this.metadata,this.config).page(...args);}
  constructor({metadata,config={}}){this.metadata=metadata;this.config=config;}
  async get(id) { return this.metadata.get(`account/${id}`); }
  async findByHandle(handle) {
    handle=normalizeHandle(handle);
    const id=await this.metadata.get(`handle/${handle}`);
    if(id){const account=await this.get(id);await this.shardHandleGrandfather(handle,id,account?.assignmentId);return account;}
    const claim=await this.shardHandleLookup(handle);if(claim?.state==='operator-alias'){const account=await this.get(claim.owner);return account?.assignmentId===claim.assignmentId&&onboardingAlias(account)===handle&&sameOnboardingIdentity(account.onboardingIdentity,claim.onboarding?.marker)?account:null;}if(claim?.state==='system-alias'){const account=await this.get(claim.owner);return account?.assignmentId===claim.assignmentId&&sameSystemIdentity(account.systemIdentity,claim.bootstrap?.marker)?account:null;}if(claim?.state!=='paid-alias')return null;const account=await this.get(claim.owner);return account?.assignmentId===claim.assignmentId?account:null;
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
    handle=validateHostAlias(handle);if(configuredReservedName(this.config,handle))return false;
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
  async onboardingLookup(handle){return this.shardHandleLookup(handle);}
  async reserveOnboardingIdentity(item,claims,digest){const oldOwner=await this.metadata.get(`handle/${item.name}`);if(oldOwner){const old=await this.get(oldOwner);await this.shardHandleGrandfather(item.name,oldOwner,old?.assignmentId);}return this.shardOnboardingReserve(item,claims,digest);}
  async claimOnboardingIdentity(handle,digest,binding){return this.shardOnboardingClaim(handle,digest,binding);}
  async onboardingStep(handle,digest,binding,step,canonical){return this.shardOnboardingStep(handle,digest,binding,step,canonical);}
  async finishOnboardingIdentity(handle,digest,binding){const row=await this.onboardingLookup(handle),account=row&&await this.get(row.owner);if(!account||account.assignmentId!==row.assignmentId||account.handle!==row.onboarding?.canonical||!sameOnboardingIdentity(account.onboardingIdentity,row.onboarding.marker))return null;return this.onboardingStep(handle,digest,binding,'consumed');}
  async reserveSystemIdentity(claims,digest,binding){const oldOwner=await this.metadata.get(`handle/${claims.handle}`);if(oldOwner){const old=await this.get(oldOwner);await this.shardHandleGrandfather(claims.handle,oldOwner,old?.assignmentId);}return this.shardSystemReserve(claims,digest,binding);}
  async setSystemAdmission(handle,digest,binding){return this.shardSystemStep(handle,digest,binding,'admitted');}
  async setSystemCanonical(handle,digest,binding,canonical){return this.shardSystemStep(handle,digest,binding,'canonical',canonical);}
  async finishSystemIdentity(handle,digest,binding){const claim=await this.shardHandleLookup(handle),account=claim&&await this.get(claim.owner);if(!account||account.assignmentId!==claim.assignmentId||account.handle!==claim.bootstrap?.canonical||!sameSystemIdentity(account.systemIdentity,claim.bootstrap?.marker))return null;return this.shardSystemStep(handle,digest,binding,'consumed');}
  async findByEmail(email) { const id=await this.metadata.get(`email/${email}`); return id ? this.get(id) : null; }
  async create(account) {
    return this.metadata.transaction(async tx=>{
      if(account.onboardingIdentity){const handle=onboardingAlias(account),claim=handle&&await tx.get(`identity-namespace/${handle}`);if(account.systemIdentity||claim?.state!=='operator-alias'||claim.owner!==account.id||claim.assignmentId!==account.assignmentId||claim.onboarding?.phase!=='claiming'||!claim.onboarding.admitted||claim.onboarding.canonical!==account.handle||!sameOnboardingIdentity(account.onboardingIdentity,claim.onboarding.marker))return false;}
      if(account.systemIdentity){const claim=await tx.get(`identity-namespace/${account.systemIdentity.handle}`);if(claim?.state!=='system-alias'||claim.owner!==account.id||claim.assignmentId!==account.assignmentId||claim.bootstrap?.phase!=='reserved'||!claim.bootstrap.admitted||claim.bootstrap.canonical!==account.handle||!sameSystemIdentity(account.systemIdentity,claim.bootstrap.marker))return false;}
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
      const old=await tx.get(`account/${id}`);if(!old||old.revision!==revision||account.handle!==old.handle||account.assignmentId!==old.assignmentId||!sameSystemIdentity(account.systemIdentity,old.systemIdentity)||!sameOnboardingIdentity(account.onboardingIdentity,old.onboardingIdentity))return false;
      const email=account.verifiedEmail;
      if(email){const owner=await tx.get(`email/${email}`);if(owner&&owner!==id)return false;await tx.put(`email/${email}`,id);}
      if(old.verifiedEmail&&old.verifiedEmail!==email)await tx.delete(`email/${old.verifiedEmail}`);
      await tx.put(`account/${id}`,account);return true;
    });
  }
  // Identity storage alarm: release expired, never-redeemed onboarding reservations.
  // A failing sweep (for example an unreadable name policy) releases nothing and retries hourly.
  async alarm(){try{await this.shardOnboardingSweep({now:Date.now()});await sweepDeviceExpiry(this.metadata);}catch{await this.metadata.setAlarm(Date.now()+3600000);}}
  async lifecycleCandidates({cursor,limit=100}={}) {
    const rows=await this.metadata.list({prefix:'account/',startAfter:cursor,limit});
    return {accounts:[...rows].map(([path,a])=>({cursor:path,id:a.id,status:a.status,createdAt:a.createdAt,lastActiveAt:a.lastActiveAt,verifiedEmail:Boolean(a.verifiedEmail)})),cursor:rows.size===limit?[...rows.keys()].at(-1):null};
  }
  async createDevice(record){return this.metadata.transaction(async tx=>{const oldId=await tx.get(`device-code/${record.userCodeHash}`);if(oldId){const old=await tx.get(`device/${oldId}`);if(old&&old.expiresAt>Date.now())return false;await tx.delete(`device/${oldId}`);}if(await tx.get(`device/${record.id}`))return false;await tx.put(`device/${record.id}`,record);await tx.put(`device-code/${record.userCodeHash}`,record.id);await indexDeviceExpiry(tx,`device/${record.id}`,record.expiresAt);await indexDeviceExpiry(tx,`device-code/${record.userCodeHash}`,record.pendingUntil??record.expiresAt,record.id);return true;});}
  async getDevice(id){return this.metadata.get(`device/${id}`);}
  async findDeviceByCode(code){const id=await this.metadata.get(`device-code/${code}`);return id?this.getDevice(id):null;}
  async compareAndSwapDevice(id,revision,record){return this.metadata.transaction(async tx=>{const old=await tx.get(`device/${id}`);if(!old||old.revision!==revision)return false;await tx.put(`device/${id}`,record);await indexDeviceExpiry(tx,`device/${id}`,record.expiresAt);return true;});}
}

export class FixedWindowGuard {
  constructor({metadata,config={},clock=()=>Date.now()}){this.metadata=metadata;this.config=config;this.clock=clock;this.population=new ActivePopulationStorage({metadata});this.waitlist=new WaitlistService({metadata,config});}
  async populationAction(method,input){if(!['initialize','touch','summary','claimCensus','finishCensus','baseline','invalidate'].includes(method))throw new Error('Invalid population operation');const result=await this.population[method](input);if(method==='baseline'&&!result.complete&&!await this.metadata.getAlarm()){await this.metadata.put('population/census-wake',true);await this.metadata.setAlarm(Date.now()+1000);}return result;}
  async waitlistAction(method,input){if(!['prepare','confirm','leave'].includes(method))throw new Error('Invalid waitlist operation');return this.waitlist[method](input);}
  async consumeSignup(options){return consumeSignupCapacity(this.metadata,options);}
  async signupStatus(options){return signupCapacityStatus(this.metadata,options);}
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
      const now=this.clock();let value=await tx.get('window');
      // Rollback shorter than one window keeps counting; a window starting more than a window ahead came
      // from a clock glitch that was later corrected and must not lock the key for the glitch's duration.
      if(!value||value.end<=now||value.end>now+2*windowMs)value={count:0,end:now+windowMs};
      if(!Number.isSafeInteger(value.count)||value.count<0||value.count+units>limit)return false;value.count+=units;await tx.put('window',value);await tx.setAlarm(value.end);return true;
    });
  }
  async alarm(){if(await this.metadata.get('population/census-v1')||await this.metadata.get('population/census-wake')){if(this.config.ACTIVE_POPULATION_CENSUS)try{await this.config.ACTIVE_POPULATION_CENSUS();}catch{await this.metadata.setAlarm(Date.now()+60000);}}if(await this.metadata.get('waitlist/counts'))await this.waitlist.cleanupExpired();await this.metadata.transaction(async tx=>{const window=await tx.get('window');if(window&&window.end<=this.clock())await tx.delete('window');else if(window)await tx.setAlarm(window.end);});}
}

function serializable(value){if(value instanceof Uint8Array)return {$bytes:Array.from(value)};if(Array.isArray(value))return value.map(serializable);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,serializable(v)]));return value;}
function restore(value){if(value&&Object.hasOwn(value,'$bytes'))return Uint8Array.from(value.$bytes);if(Array.isArray(value))return value.map(restore);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v)]));return value;}

export class AccountController {
  constructor({metadata,gate,blobs,archives,config,sql,sqlTransaction}){
    if(config.WORK_LIMITS_ENABLED!==undefined&&!['true','false',true,false].includes(config.WORK_LIMITS_ENABLED))throw new TypeError('Invalid logical activity admission configuration.');
    if(config.STORAGE_WRITE_ENABLED!==undefined&&!['true','false',true,false].includes(config.STORAGE_WRITE_ENABLED))throw new TypeError('Invalid storage write admission configuration.');
    this.physicalWriteEnabled=config.STORAGE_WRITE_ENABLED==='true'||config.STORAGE_WRITE_ENABLED===true;this.logicalWorkEnabled=config.WORK_LIMITS_ENABLED==='true'||config.WORK_LIMITS_ENABLED===true||(config.WORK_LIMITS_ENABLED===undefined&&Boolean(config.WORK_AUTHORITY));this.storageWriteBudget=this.physicalWriteEnabled||this.logicalWorkEnabled?new AccountStorageWriteBudget({metadata,authority:config.STORAGE_WRITE_AUTHORITY??config.WORK_AUTHORITY,config:{...config,STORAGE_WRITE_ENABLED:true}}):null;
    const wrap=(bucket,maintenance)=>guardedBucket(bucket,{admit:async clientId=>{if(this.physicalWriteEnabled){if(!maintenance&&(await metadata.get('storage/garbage-retry'))?.paused===true||!maintenance&&(await metadata.get('storage/cleanup-retry'))?.paused===true)throw new StorageError('storage_write_unavailable','Storage writes are paused while retained uploads are cleaned up.',503);await this.storageWriteBudget.admit(await metadata.get('owner'),{clientId,maintenance});}}});blobs=wrap(blobs,false);archives=wrap(archives,true);
    this.messageReceiptBudget=new MessageReceiptBudget({metadata,config});
    this.metadata=metadata;this.googleDrive=new GoogleDriveService({metadata,config,fetcher:config.GOOGLE_DRIVE_FETCH??fetch});this.apps=new AppConnections({metadata,origin:config.APP_ORIGIN,severed:async owner=>{await this.connectionsDrain(owner);await this.integrationEventsKick(owner);}});this.gate=gate;this.workBudget=this.storageWriteBudget;this.blobs=blobs;this.archives=archives;this.config=config;this.quota=new StorageQuota({metadata,blobs,config});this.itemIndex=sql?new AccountItemIndex(sql):null;this.billing=new BillingService({config,metadata});this.searchIndex=sql?new SqliteSearchIndex({sql,transaction:sqlTransaction||sql.transaction?.bind(sql)}):null;this.searchOutbox=new MetadataSearchOutbox(metadata);this.semanticBudget=new DurableSemanticBudget({state:metadata,configured:config.SEMANTIC_SEARCH_ENABLED==='true'&&Boolean(config.AI?.run&&(config.SEARCH_VECTORS?.query||[0,1,2,3].every(shard=>config[`SEARCH_VECTORS_${shard}`]?.query))),globalSpend:config.SEMANTIC_SPEND});this.vectorGate=new SearchMutationGate();this.search=this.searchIndex?new SearchService({index:this.searchIndex,outbox:this.searchOutbox,semanticPolicy:this.semanticBudget,onSemanticError:(event,error)=>this.deferSemanticSearch(event,error),authority:{get:(owner,id,options)=>this.searchDocument(owner,id,options),scan:(owner,options)=>this.scanSearchDocuments(owner,options)}}):null;
    const store={transaction:async operation=>{
      const garbage=[];
      const result=await this.metadata.transaction(async tx=>operation({
        get:k=>tx.get(k),
        set:async(k,v)=>{if(v?.bytes instanceof Uint8Array){const reservation=this.messageReservation;if(!reservation||reservation.owner!==v.owner||reservation.bytes!==v.bytes.byteLength)throw new StorageError('conflict','Message upload reservation is missing.',409);const blobRef=reservation.blobRef;const {bytes,...record}=v;record.notificationSummary=await messagePresentationSummary(v);const event=await this.queueMessageSearch(tx,record);record.revision=event.revision;await tx.put(k,{...record,blobRef});this.itemIndex?.upsert(record);await this.quota.commit(tx,reservation.id);}else{if(k.startsWith('message/')){const event=await this.queueMessageSearch(tx,v);v={...v,revision:event.revision};this.itemIndex?.upsert(v);}await tx.put(k,v);}},
        delete:async k=>{const value=await tx.get(k);if(value?.blobRef){const garbageKey=`blob-garbage/${crypto.randomUUID()}`;await tx.put(garbageKey,value.blobRef);garbage.push({key:garbageKey,blobRef:value.blobRef});const alarm=typeof tx.getAlarm==='function'?await tx.getAlarm():null;await tx.setAlarm?.(alarm?Math.min(alarm,Date.now()+60000):Date.now()+60000);}if(k.startsWith('message/')&&value){await erasePostbackPreparations(tx,value.owner,value.id);await erasePresentations(tx,value,garbage);await this.queueMessageSearch(tx,value,'tombstone');this.itemIndex?.remove(value.id);}await tx.delete(k);},
        list:async prefix=>[...(await tx.list({prefix}))].map(([key,value])=>{if(value?.blobRef){const {blobRef,...record}=value;return {key,value:record};}return {key,value};})
      }));
      for(const {key,blobRef}of garbage){try{await this.blobs.delete(blobRef);await this.metadata.delete(key);}catch{/* Ownership was committed with logical deletion; GC can retry after a crash. */}}
      return result;
    }};
    this.store=store;this.tokens=new ContactTokenService({store,issuer:config.APP_ORIGIN,allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true'});
    this.endpoints=new ContactEndpointService({tokens:this.tokens,linkPolicies:linkPolicyRegistry(config),signer:async({owner,kid})=>{const signer=await this.signingKey(owner);if(signer.kid!==kid)throw new Error('Signing key unavailable');return signer.privateKey;}});
    // Identity-authored link delivery (links §6.1). Cross-account identity lookups run outside the account gate.
    this.delivery=new ContactDeliveryService({store,issuer:config.APP_ORIGIN,allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true',maxStoredBytes:1_000_000_000_000,maxStoredMessages:1_000_000,parents:{verify:credential=>this.endpoints.verifyCredential(credential),live:(tx,verified)=>this.endpoints.liveCredential(tx,verified)},intake:(id,tx)=>this.endpoints.intakeOf(id,tx),resolve:localAuthorResolver({issuer:config.APP_ORIGIN,lookup:(subject,kid)=>this.identityKey(subject,kid)}),admissionKey:async()=>{const owner=await this.metadata.get('owner');return this.signingKey(owner);},audience:{admit:(tx,input)=>admitLinkAudience(tx,input)}});
    this.messages=new MessagingService({store,tokens:this.endpoints,clock:systemClock.now,crypto:{randomUUID:cryptoRandom.uuid,subtle:crypto.subtle,getRandomValues:array=>crypto.getRandomValues(array)},maxStoredBytes:1_000_000_000_000,maxStoredMessages:1_000_000});
    this.notifications=new NotificationService({store,messageAllowed:appNotificationAllowed});
    this.beams=new BeamService({metadata,config,entitlement:owner=>this.billing.entitlement(owner)});this.beamContacts=new BeamContacts({metadata,endpoints:this.endpoints});
    // Account placement of the application engine (docs/architecture/app-engine.md): migrated domains are
    // Actions/Queries over these providers, reached through `dispatch`. The remaining services above are
    // wrapped as providers slice by slice. One engine per controller, so per DO instance / Node account.
    // `messaging` is still the pre-built instance over the side-effecting store above (search, item index, blobs);
    // the harness builds it lazily over accountStore without those effects until slice 2 owns them.
    this.engine=createAppEngine({providers:accountProviders({accountStore:metadata,itemIndex:this.itemIndex,messaging:this.messages,clock:systemClock,random:cryptoRandom,audit:nullAudit})});
  }
  /** Runs one registered account operation as the given owner. Only {operation, id, input} cross the RPC
   * boundary (cloned, so a Node caller's object is never shared); the actor is the authenticated owner this
   * account belongs to. The account gate around `invoke` still serializes it with every other method. */
  async dispatch(owner,request){
    const {operation,id,input}=structuredClone(request??{}),Operation=typeof operation==='string'&&Object.hasOwn(ACCOUNT_OPERATIONS,operation)?ACCOUNT_OPERATIONS[operation]:null;
    if(!Operation)throw new StorageError('unsupported_method','Unsupported account operation.',400);
    await this.warm(owner);return operate(this.engine,new Operation({actor:{kind:'owner',owner},id,input}));
  }
  async invoke({method,args}){
    if(typeof method!=='string'||!Object.hasOwn(ACCOUNT_RPC,method))return {$fault:{code:'unsupported_method',message:'Unsupported account operation.',status:400}};
    // Account lifecycle suspension/deletion fence (live mode only); lifecycle methods own their gate.
    // Engine operations declare their own lifecycle level, gate placement and activity (`operationPolicy`);
    // named methods declare theirs in their slice's `rpc` (packages/runtime/account/index.mjs).
    const policy=method==='dispatch'?operationPolicy(ACCOUNT_OPERATIONS,args[1]?.operation):ACCOUNT_RPC[method];
    try{const blocked=await lifecycleBlocked(this,method,policy);if(blocked)return {$fault:blocked};}catch{return {$fault:{code:'lifecycle_unavailable',message:'Account status is temporarily unavailable.',status:503}};}
    if(method in lifecycleMethods){try{return await this[method](...args);}catch(error){return {$fault:{code:error.code||'invalid_request',message:error.code?error.message:'The account operation could not be completed.',status:error.status}};}}
    // Fanout runs outside the account gate: a recipient may concurrently submit
    // to this source while its own account gate is held. Receiver writes retain
    // their own serialization, including the source's local inbox.
    if(policy.gate==='none'||method==='conversationPublicIdentity'&&await this.metadata.get('signing-key')){try{return await this[method](...args);}catch(error){return {$fault:{code:error.code||'invalid_request',message:error.code?error.message:method.startsWith('conversation')?'Conversation delivery could not be completed.':'The account operation could not be completed.',status:error.status,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}}};}}
    const result=await this.gate.run(async()=>{try{if(policy.warm===true)await this.warm(args[0]);return await this[method](...args);}catch(error){return {$fault:{code:error.code||'invalid_request',message:error.code?error.message:'The account operation could not be completed.',status:error.status,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}}};}});
    // Qualifying owner/app activity resets the inactivity clock outside the account gate.
    if(!result?.$fault)await lifecycleActivity(this,method,args,policy);
    return result;
  }
  async admitWork(owner,{initialize=false,clientId='@system'}={}){if(this.logicalWorkEnabled&&typeof this.workBudget.authority?.consume!=='function')throw new StorageError('storage_write_unavailable','Activity admission is unavailable.',503);if(initialize)await this.ensureBuiltinStorage(owner);else if(await this.metadata.get('owner')!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);await this.billingRefresh(owner);if(this.logicalWorkEnabled)return this.workBudget.admit(owner,{initialize,clientId});return true;}
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
  async scheduleAlarm(time){
    const now=Date.now(),cleanup=await this.quota.nextCleanup(),owner=await this.metadata.get('owner'),pending=owner&&((await this.metadata.get(key('search-queue-usage',owner)))?.count||!await this.metadata.get('item-index-ready')||!await this.metadata.get('search-backfill-ready')||this.itemIndex&&this.itemIndex.incomingState('ready')!=='1'),garbage=await this.metadata.list({prefix:'blob-garbage/',limit:1});
    const semantic=await this.metadata.get('search-semantic-backfill'),purge=await this.metadata.get('search-vector-purge');
    const next=Math.min(time,cleanup||Infinity,pending?retryTime(await this.metadata.get('search/extraction-retry'),now):Infinity,garbage.size?retryTime(await this.metadata.get('storage/garbage-retry'),now):Infinity,purge?retryTime(await this.metadata.get('search/purge-retry'),now):Infinity,semantic&&!semantic.paused?Math.max(now+60000,semantic.retryAfter||0):Infinity),prior=typeof this.metadata.getAlarm==='function'?await this.metadata.getAlarm():null;if(prior&&prior>now&&prior<=next)return;return this.metadata.setAlarm(next);
  }
  async populationActivity(owner){const stored=await this.metadata.get('owner');if(stored&&stored!==owner)throw new StorageError('wrong_owner','Owner mismatch',403);return {lastActiveAt:await this.metadata.get('lastOwnerActiveAt'),status:(await this.metadata.get('lifecycle'))?.status};}
  async touch(owner) {await this.warm(owner);const now=Date.now();await recordOwnerPopulation(this,owner,{now});const prior=await this.metadata.get('lastOwnerActiveAt');if(Number.isSafeInteger(prior)&&prior>=now-900000)return;await this.metadata.put('lastOwnerActiveAt',now);await this.metadata.put('lifecycle',{status:'active'});await this.scheduleAlarm(now+7*86400000);}
  async snapshot(owner){await this.warm(owner);return {...await this.messageSnapshot(owner),...await this.owned(owner),collections:await this.messages.collections(owner),contacts:await this.contacts(owner),resources:await this.resources(owner),notificationPreferences:await this.notifications.preferences(owner),pushDevices:await this.notifications.subscriptions(owner),storage:await this.storageUsage(owner),work:this.workBudget?await this.workBudget.status(owner):null,messageReceiptAdmission:await this.messageReceiptBudget.status(owner),retention:await this.metadata.transaction(tx=>accountRemovalProtection(tx,owner,{config:this.config})),lifecycle:await this.metadata.get('lifecycle')||{status:'active'}};}
  /** Views, rules and labels for the snapshot, read through the same engine Queries as their routes. */
  async owned(owner){const actor={kind:'owner',owner};return {views:(await operate(this.engine,new SavedViews({actor}))).views,rules:await operate(this.engine,new TagRules({actor})),tagLabels:await operate(this.engine,new TagLabels({actor}))};}
  async messageSnapshot(owner){const page=await this.messagePage(owner,{limit:100});return {messages:page.items,messageCursor:page.cursor};}
  // Runs inside the account gate without letting a fault escape it (a Durable Object resets when
  // a blockConcurrencyWhile callback throws); the fault is rethrown outside.
  async gated(operation){const outcome=await this.gate.run(async()=>{try{return {value:await operation()};}catch(error){return {error};}});if(outcome.error)throw outcome.error;return outcome.value;}
  async alarm(){
    // Lifecycle runs first and outside the account gate; a deleted account does no further work.
    if((await lifecycleTick(this,{source:'alarm'})).action==='deleted')return;
    await cleanupPostbackPreparations(this);
    const populationOwner=await this.metadata.get('owner');if(populationOwner)await recordOwnerPopulation(this,populationOwner,{retry:true});
    const conversationOwner=await this.metadata.get('owner');if(conversationOwner&&this.config.EVENT_BUSES_ENABLED==='true'){const swept=await this.eventBusSweep(conversationOwner);if(swept.more||(await this.eventBusDescriptors(conversationOwner)).length)await this.scheduleAlarm(Date.now()+(swept.more?1000:600000));}if(conversationOwner){if(this.config.BROKERED_INTROSPECTION_MOUNTED===true)await this.brokeredSeveranceDrain(conversationOwner);await this.integrationEventsAlarm(conversationOwner);const revalidated=await this.integrationsRevalidateDue(conversationOwner);if(revalidated.revalidated||revalidated.pending)await this.scheduleAlarm(Date.now()+3600000);await this.conversationDrain(conversationOwner,{limit:16});}
    const retry=await this.metadata.get('maintenance/alarm-retry');if(!retryReady(retry)){await this.metadata.setAlarm(retry?.paused?Date.now()+7*86400000:retryTime(retry));return;}try{await this.gate.run(async()=>{
      await this.beams.cleanup();const beamExpiry=[];for(const prefix of ['beam/offer/','beam/mailbox/','beam/invite/','beam/nearby/'])for(const r of (await this.metadata.list({prefix,limit:129})).values())beamExpiry.push(r.expiresAt);if(beamExpiry.length)await this.scheduleAlarm(Math.min(...beamExpiry));
      await this.quota.cleanup();await this.collectBlobGarbage();const owner=await this.metadata.get('owner');if(!owner)return;await collectLinkState(this,owner);
      if(await this.metadata.get('shelved')){await this.scheduleAlarm(Date.now()+7*86400000);return;}
      await this.migrateItemIndex(owner);await this.configureSemanticSearch(owner);try{await this.purgeSearchVectors(owner);await this.backfillSemanticSearch(owner);}catch(error){await this.metadata.put('search-index-error',{code:error.code||'index_unavailable',at:Date.now()});}
      if((await this.metadata.get(key('search-queue-usage',owner)))?.count){try{await this.searchDrain(owner,{limit:10});}catch{/* Durable outbox and health marker retain retry work. */}}
      if((await this.metadata.get(key('search-queue-usage',owner)))?.count||this.itemIndex&&(!await this.metadata.get('item-index-ready')||!await this.metadata.get('search-backfill-ready')||this.itemIndex.incomingState('ready')!=='1')){await this.scheduleAlarm(Date.now()+7*86400000);return;}
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
// Per-slice methods and the `invoke` allowlist (packages/runtime/account/index.mjs). The core's own RPC methods:
installAccountMethods(AccountController.prototype);
const ACCOUNT_RPC=accountRPC({dispatch:{},admitWork:{},touch:{activity:'owner-return'},snapshot:{}});
