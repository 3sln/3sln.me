// AccountController slice 8, Search (docs/architecture/app-engine.md §12): lexical and semantic search, indexing and the search outbox.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {migrateTags} from '../../messaging/tags.mjs';
import {retryReady,retryFailure} from '../cleanup-retry.mjs';
import {key} from '../../messaging/store.mjs';
import {StorageError} from '../../storage/policy.mjs';
import {storageState} from '../storage-quota.mjs';
import {vectorBinding} from '../semantic-routing.mjs';
import {enqueueSearchEvent,searchRevisionKey,messageSearchDocument,planBudget,WorkersAIEmbeddingAdapter,VectorizeSearchIndex,SEMANTIC_MODEL,SEMANTIC_DIMENSIONS} from '../../search/index.mjs';

export const methods={
  async queueMessageSearch(tx,message,operation='upsert'){
    const id=`message:${message.id}`,prior=await tx.get(searchRevisionKey(message.owner,id)),old=await tx.get(key('message',message.owner,message.id));
    const revision=Math.max(prior?.revision||0,old?.revision||(old?1:0))+1;
    const entitlement=await storageState(tx,message.owner,Date.now(),this.config);
    const event=await enqueueSearchEvent(tx,{owner:message.owner,id,source:{kind:'message',id:message.id},operation,revision},{maxQueue:planBudget(entitlement.plan==='free'?'free':'paid').limits.queue});
    await tx.setAlarm(Date.now()+60000);return event;
  },
  async configureSemanticSearch(owner){
    if(!this.search||!this.semanticBudget.configured)return;
    if(this.search.vectorIndex){if(this.search.vectorIndex.owner!==owner)throw new StorageError('forbidden','Search owner mismatch.',403);return;}
    const route=await vectorBinding(this.config,owner),priorRoute=await this.metadata.get('search-vector-route');
    if(priorRoute&&(priorRoute.layoutVersion!==route.layoutVersion||priorRoute.shard!==route.shard))throw new StorageError('semantic_routing_mismatch','Search routing requires an explicit migration.',503);
    await this.metadata.put('search-vector-route',{layoutVersion:route.layoutVersion,shard:route.shard});
    this.search.embedder=new WorkersAIEmbeddingAdapter({binding:this.config.AI,model:SEMANTIC_MODEL,dimensions:SEMANTIC_DIMENSIONS,maxInputBytes:480,budget:this.semanticBudget});
    // This gate is distinct from the account gate already held by invoke/alarm.
    this.search.vectorIndex=new VectorizeSearchIndex({binding:route.binding,state:this.metadata,gate:this.vectorGate,owner,dimensions:SEMANTIC_DIMENSIONS,maxVectors:this.semanticBudget.limits.vectors,budget:this.semanticBudget});
  },
  async searchPreferences(owner){return {...await this.semanticBudget.status(owner),indexingPending:Boolean(await this.metadata.get('search-semantic-backfill')),cleanupPending:Boolean(await this.metadata.get('search-vector-purge')),error:(await this.metadata.get('search-semantic-error'))?.code||null};},
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
  },
  async purgeSearchVectors(owner,{limit=20}={}){
    if(!this.search?.vectorIndex)return {processed:0};
    const work=await this.metadata.get('search-vector-purge');if(!work)return {processed:0};const retry=await this.metadata.get('search/purge-retry');if(!retryReady(retry))return {processed:0,paused:Boolean(retry?.paused)};try{
    const prefix=key('search-vector-revision',owner),rows=await this.metadata.list({prefix,...work.cursor?{startAfter:work.cursor}:{},limit});
    for(const [path,record]of rows){if(record.active||record.cleanupIds?.length){const id=decodeURIComponent(path.slice(prefix.length).split('/')[0]);await this.search.vectorIndex.tombstone({owner,id,revision:record.revision});}}
    if(rows.size<limit)await this.metadata.delete('search-vector-purge');else await this.metadata.put('search-vector-purge',{owner,cursor:[...rows.keys()].at(-1)});
    await this.metadata.delete('search/purge-retry');return {processed:rows.size};}catch(error){await retryFailure(this.metadata,'search/purge-retry',error);throw error;}
  },
  async backfillSemanticSearch(owner){
    const work=await this.metadata.get('search-semantic-backfill');if(!work||work.paused||work.retryAfter>Date.now()||!retryReady(await this.metadata.get('search/semantic-retry'))||!await this.semanticBudget.enabled(owner))return;try{
    const page=await this.searchRebuild(owner,{limit:10,cursor:work.cursor});
    const deferred=await this.metadata.get('search-semantic-backfill');if(deferred?.paused||deferred?.retryAfter>Date.now())return;
    if(page.cursor)await this.metadata.put('search-semantic-backfill',{owner,cursor:page.cursor});else{await this.metadata.delete('search-semantic-backfill');await this.metadata.delete('search-semantic-error');await this.metadata.delete('search/semantic-retry');}}catch(error){await this.deferSemanticSearch({owner},error);}
  },
  async deferSemanticSearch(event,error){
    const now=Date.now(),date=new Date(now),budget=['semantic_account_budget','semantic_global_budget','search_vector_budget'].includes(error.code);
    const retry=budget?null:await retryFailure(this.metadata,'search/semantic-retry',error,now);const retryAfter=budget?Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1):retry.retryAt;
    await this.metadata.put('search-semantic-error',{code:error.code||'semantic_provider_unavailable',at:now});
    if(await this.semanticBudget.enabled(event.owner))await this.metadata.put('search-semantic-backfill',{owner:event.owner,retryAfter,...error.code==='search_vector_budget'||retry?.paused?{paused:true}:{}});
    else await this.metadata.put('search-vector-purge',{owner:event.owner});
  },
  async searchDocument(owner,id,{purpose='index',revision}={}){
    await this.configureSemanticSearch(owner);
    if(typeof id!=='string'||!id.startsWith('message:'))return null;
    const rawId=id.slice(8),message=await this.metadata.get(key('message',owner,rawId));
    if(!message||message.owner!==owner)return null;const currentRevision=message.revision||1;const embeddingAllowed=await this.semanticBudget.enabled(owner)&&['text/plain','text/html','application/vnd.3sln.web-archive+json'].includes(message.mimeType)&&!message.quarantined;
    if(purpose!=='index'){
      const cached=purpose==='search'?await this.searchIndex?.readContent(owner,id,revision):{title:message.senderMetadata?.subject||'',text:''};
      if(!cached)return null;
      const tagged=migrateTags(message);return {id,owner,source:{kind:'message',id:rawId},revision:currentRevision,type:message.mimeType==='message/rfc822'?'email':'message',title:cached.title,text:cached.text,tags:tagged.tags||[],classification:tagged.classification||'unclassified',createdAt:message.receivedAt||0,acl:{readers:[owner]},quarantined:Boolean(message.quarantined),deleted:false,embeddingAllowed};
    }
    if(!message.blobRef)return {...messageSearchDocument({...message,bytes:new Uint8Array()},{revision:currentRevision}),createdAt:message.receivedAt||0,embeddingAllowed};
    const blob=await this.blobs.get(message.blobRef);if(!blob)throw new StorageError('temporarily_unavailable','Message data is temporarily unavailable.',503);
    if(blob.size>1048576)return messageSearchDocument({...message,bytes:new Uint8Array()},{revision:currentRevision});
    return {...messageSearchDocument({...message,bytes:new Uint8Array(await blob.arrayBuffer())},{revision:currentRevision}),embeddingAllowed};
  },
  async scanSearchDocuments(owner,{limit=50,cursor}={}){const page=await this.messagePage(owner,{limit,cursor});return {items:page.items.map(message=>({id:`message:${message.id}`,owner,revision:message.revision||1,deleted:false})),cursor:page.cursor};},
  async searchDrain(owner,{limit=10}={}){
    if(!this.search)return {processed:0};const retry=await this.metadata.get('search/extraction-retry');if(!retryReady(retry))return {processed:0,paused:Boolean(retry?.paused)};await this.configureSemanticSearch(owner);const entitlement=await this.billing.entitlement(owner),budgets=planBudget(entitlement.plan==='free'?'free':'paid').limits;this.search.budgets=budgets;this.searchIndex.budgets=budgets;
    try{const result=await this.search.drain(owner,{limit});await this.metadata.delete('search-index-error');await this.metadata.delete('search/extraction-retry');return result;}catch(error){await retryFailure(this.metadata,'search/extraction-retry',error);await this.metadata.put('search-index-error',{code:error.code||'index_unavailable',at:Date.now()});throw error;}
  },
  async searchRebuild(owner,options={}){await this.warm(owner);if(!this.search)throw new StorageError('temporarily_unavailable','Search is unavailable.',503);await this.configureSemanticSearch(owner);return this.search.rebuild(owner,{...options,limit:Math.min(options.limit||50,50)});},
  async omniSearch(owner,input){await this.warm(owner);if(!this.search)throw new StorageError('temporarily_unavailable','Search is unavailable.',503);await this.configureSemanticSearch(owner);const result=await this.search.search(owner,input);const pending=(await this.metadata.get(key('search-queue-usage',owner)))?.count||0;const error=await this.metadata.get('search-index-error');return {...result,semantic:await this.searchPreferences(owner),indexing:{pending,ready:pending===0&&!error&&Boolean(await this.metadata.get('search-backfill-ready')),backfillPending:!await this.metadata.get('search-backfill-ready'),limited:Boolean(error),error:error?.code||null}};},
};

export const rpc={
 omniSearch:{},
 searchRebuild:{},
 searchDrain:{},
 searchPreferences:{},
 updateSearchPreferences:{},
};
