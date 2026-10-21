// Island worker (embed-islands EI-13, §5). Every account-dependent operation runs here, never in the island
// document: IndexedDB, the frame key, leader election and restore, the partition bus, embed API calls, avatar
// fetch and raster work. The document only renders what this worker returns. Started only after `ready`
// (the `sign-in` part starts it only on a user activation, profile P10).
import {openStore,frameKey,randomId,listCredentials,saveCredential,deleteCredentials,updateCredential,readGeneration,nextTerm} from '../keys.mjs';
import {embedAPI,createEntry,createRequestEntry,restoreAll,normalizeView} from '../restore.mjs';
import {createElection,ELECTION} from './leader.mjs';
import {monogramPNG,transparentPNG,reencodeAvatar,validBucket} from './avatar.mjs';

const SNAPSHOT_TTL=600000,RENEW_MARGIN=120000,PENDING_RETRY=[250,500,1000,2000,4000,8000,16000,32000],STREAM_RETRY=[2000,4000,8000,16000,32000,60000];
export function createIslandWorker({post,storeFactory=openStore,crypto=globalThis.crypto,fetch=globalThis.fetch?.bind(globalThis),indexedDB=globalThis.indexedDB,locks=globalThis.navigator?.locks,BroadcastChannel:Channel=globalThis.BroadcastChannel,clock=()=>Date.now(),timing={}}){
  let config,instance,role,store,key,api,election,scheme='light',visible=true,started=false,generation=0,renewTimer=null;
  // Operations wait for a started worker (IMPL-1): a forget arriving during a bfcache resume is queued, not dropped.
  let ready=Promise.withResolvers();
  let leadSignal=null,views=[],issuedAt=0,expiry=null,genTimer=null,syncing=null,pagehide=false;
  const buckets=new Map(),sessions=new Map(),retries=new Map(),tiles=new Map(),streams=new Map(),streamFailures=new Map();
  const scope=()=>({issuer:config.issuer,clientId:config.clientId});
  const emit=()=>post({event:'views',views:views.map(({subject,handle,name,delivered})=>({subject,handle,name,delivered})),issuedAt});
  const clearExpiry=()=>{clearTimeout(expiry);expiry=null;};
  function adopt(next,at){views=next;issuedAt=at;tiles.clear();clearExpiry();if(views.length)expiry=setTimeout(()=>adopt([],0),Math.max(0,at+SNAPSHOT_TTL-clock()));emit();}

  // ---- Leader side ----------------------------------------------------------------------------------------
  async function snapshot(){
    const next=[];for(const [id,s] of sessions){if(!s.view||next.length>=8)continue;next.push({id,subject:s.subject,handle:s.view.handle,name:s.view.name,delivered:s.delivered,avatars:{...s.avatars}});}
    const at=clock();election.publish({views:next,issuedAt:at});adopt(next,at);announce();
  }
  async function fetchAvatars(id){
    const s=sessions.get(id);if(!s?.view?.avatar)return;
    for(const bucket of new Set(buckets.values()))if(validBucket(bucket)&&!s.avatars[bucket]){try{s.avatars[bucket]=await api.avatar(s.session,bucket);}catch{}}
  }
  /** One renewal batch for all sessions on the earliest expiry, so redraw frequency does not grow with the binding count (IMPL-7). */
  function scheduleRenew(){clearTimeout(renewTimer);if(!sessions.size)return;const due=Math.min(...[...sessions.values()].map(s=>s.expiresAt));renewTimer=setTimeout(()=>sync({renewAll:true}),Math.max(1000,due-RENEW_MARGIN-clock()));}
  /** Leader work is serialized: restores, stream updates and snapshots never interleave. */
  const serial=work=>(syncing=(syncing??Promise.resolve()).then(work).catch(()=>{}));
  // ---- Data stream (embed-islands §5.1): one `GET /embed/api/events` per held session, leader only ---------------
  function closeStream(id){streams.get(id)?.abort();streams.delete(id);}
  /** The document ends held sessions on `pagehide` itself (a worker is often gone before it reads the message), so it
   * is told the current set of session tokens; nothing else about them leaves the worker. */
  const announce=()=>post({event:'sessions',tokens:election?.leading?[...sessions.values()].map(s=>s.session):[]});
  /** Closes streams and drops held sessions. On demotion (a steal) it also ends them; on pagehide the document does. */
  function release({end=true}={}){for(const id of [...streams.keys()])closeStream(id);if(end)for(const s of sessions.values())api?.end(s.session);sessions.clear();announce();}
  function openStream(id){
    const s=sessions.get(id);if(!s||!election?.leading||!leadSignal||leadSignal.aborted)return;
    closeStream(id);const controller=new AbortController(),signal=AbortSignal.any([leadSignal,controller.signal]),token=s.session;streams.set(id,controller);
    (async()=>{
      try{for await(const event of api.events(token,{signal})){if(signal.aborted)return;streamFailures.delete(id);if(event.type==='view')await serial(()=>applyView(id,token,event.view));}}catch{}
      if(signal.aborted||streams.get(id)!==controller)return;streams.delete(id);
      // The server ended the stream (expiry, eviction by a newer stream, binding no longer live): restore that binding
      // again with backoff; a revoked binding then fails restore with 401 and is deleted (settle).
      const failures=streamFailures.get(id)??0;streamFailures.set(id,failures+1);
      setTimeout(()=>{if(election?.leading&&!signal.aborted&&sessions.get(id)?.session===token)sync({renew:id});},STREAM_RETRY[Math.min(failures,STREAM_RETRY.length-1)]);
    })();
  }
  /** A changed view from the stream: new labels or picture are fetched and fanned out; an unchanged one costs nothing. */
  async function applyView(id,token,raw){
    const s=sessions.get(id),view=normalizeView(raw,{issuer:config.issuer});if(!s||s.session!==token||!view||!election?.leading)return;
    if(s.view&&['handle','name','avatar'].every(key=>s.view[key]===view[key])&&(s.view.subject??null)===(view.subject??s.subject??null))return;
    if(!s.subject&&view.subject){s.subject=view.subject;await updateCredential(store,scope(),id,{subject:view.subject});}
    s.view=view;s.avatars={};tiles.clear();await fetchAvatars(id);await snapshot();
  }
  /** Re-reads the credential set (the generation is the source of truth) and restores what changed, serially. */
  function sync({renew,renewAll}={}){
    return serial(async()=>{
      if(!election?.leading)return;const signal=leadSignal;
      generation=await readGeneration(store,config.clientId);
      const records=await listCredentials(store,scope()),ids=new Set(records.map(r=>r.id));
      for(const id of [...sessions.keys()])if(!ids.has(id)){closeStream(id);sessions.delete(id);}
      const todo=records.filter(r=>renewAll||!sessions.has(r.id)||r.id===renew).slice(0,8);
      for(const result of await restoreAll(api,todo,{issuer:config.issuer,clock,pad:timing.restorePadMs,slots:todo.length?8:0,signal}))if(!signal?.aborted)await settle(records.find(r=>r.id===result.id),result);
      if(election?.leading&&!signal?.aborted){scheduleRenew();await snapshot();}
    });
  }
  async function settle(record,result){
    if(!record)return;
    if(result.ok){
      retries.delete(record.id);let subject=record.subject;
      if(!subject&&result.view?.subject){subject=result.view.subject;await updateCredential(store,scope(),record.id,{subject});}
      const previous=sessions.get(record.id);
      sessions.set(record.id,{session:result.session,expiresAt:result.expiresAt,view:result.view,subject,delivered:record.delivered===true,avatars:previous?.view?.avatar&&result.view?.avatar?previous.avatars:{}});
      // A renewal replaces the session: its stream moves to the new one and the old session is ended.
      if(previous&&previous.session!==result.session){closeStream(record.id);api.end(previous.session);}
      await fetchAvatars(record.id);openStream(record.id);return;
    }
    // A pending credential is unusable until the app exchanges the paired code: retry within its window only. The app's
    // exchange races this restore (both follow the same `code`), so the first retries are short: a 2 s first step left a
    // just-signed-in island blank for 6–14 s whenever the exchange lost the race (the islands avatar flake). Same ~64 s reach.
    const attempt=retries.get(record.id)??0;
    if(record.pendingUntil>clock()&&attempt<PENDING_RETRY.length){retries.set(record.id,attempt+1);setTimeout(()=>sync({renew:record.id}),PENDING_RETRY[attempt]);return;}
    if(result.status===401){retries.delete(record.id);closeStream(record.id);sessions.delete(record.id);await deleteCredentials(store,scope(),r=>r.id===record.id);}
  }
  async function watchGeneration(){if(election?.leading&&await readGeneration(store,config.clientId)!==generation)sync();}

  // ---- Bus (all members) ----------------------------------------------------------------------------------
  /** Drops forgotten accounts from this island's own views at once, whoever leads (IMPL-5). */
  const dropViews=subject=>{const next=views.filter(v=>subject!==undefined&&v.subject!==null&&v.subject!==subject);if(next.length!==views.length){views=next;tiles.clear();emit();}};
  function receive(message){
    if(message.type==='forget')dropViews(message.subject);
    if(message.type==='snapshot'){if(!election.leading)adopt(message.views,message.issuedAt);return;}
    if(!election.leading)return;
    if(message.type==='hello'){buckets.set(message.instance,message.avatarBucket);(async()=>{for(const id of sessions.keys())await fetchAvatars(id);await snapshot();})().catch(()=>{});}
    else sync(); // credentials-changed or forget: the receiver already wrote IndexedDB
  }
  function startElection(){
    // Memory-only storage gives each island its own terms and credentials: lead alone (§5.4; IMPL-4).
    election=createElection({name:`bindle-embed:${config.clientId}`,instance,locks:store.persistent?locks:undefined,openBus:Channel?()=>new Channel(`bindle-embed:${config.clientId}`):undefined,nextTerm:()=>nextTerm(store,config.clientId),
      lead:async({signal})=>{leadSignal=signal;sessions.clear();await sync();},
      demote:()=>{clearTimeout(renewTimer);release({end:!pagehide});},
      receive,isVisible:()=>visible,clock,...timing.election});
    election.start();election.send({type:'hello',instance,avatarBucket:buckets.get(instance)??null});
    genTimer=setInterval(()=>watchGeneration().catch(()=>{}),timing.election?.heartbeatMs??ELECTION.heartbeatMs);
  }
  async function start(options){
    config=options.config;instance=options.instance;role=options.role;scheme=options.scheme??'light';visible=options.visible!==false;
    if(validBucket(options.bucket))buckets.set(instance,options.bucket);
    store=await storeFactory({indexedDB});key=await frameKey(store,{...scope(),crypto,clock});api=embedAPI({origin:config.origin,key,fetch});started=true;
    if(role==='member')startElection();
    ready.resolve();
  }
  // Same teardown in every state (EIR-4): resign, end held sessions with keepalive, close streams, bus and storage.
  function stop(){if(!started)return;started=false;ready=Promise.withResolvers();pagehide=true;election?.stop();pagehide=false;release({end:false});clearInterval(genTimer);clearTimeout(renewTimer);clearExpiry();store?.close();}
  const hint=message=>election?election.send(message):(()=>{if(!Channel)return;const bus=new Channel(`bindle-embed:${config.clientId}`);bus.postMessage(message);bus.close();})();

  // ---- Tiles ----------------------------------------------------------------------------------------------
  async function tile(subject,bucket){
    if(subject===null)return transparentPNG(bucket);
    const monogram=tiles.get(`m\0${subject}\0${bucket}\0${scheme}`)??await monogramPNG(subject,{size:bucket,scheme});tiles.set(`m\0${subject}\0${bucket}\0${scheme}`,monogram);
    const view=views.find(v=>v.subject===subject),source=view?.avatars?.[bucket];if(!source)return monogram;
    const cached=tiles.get(`a\0${view.id}\0${bucket}`);if(cached)return cached;
    const avatar=await reencodeAvatar(source,bucket);if(avatar)tiles.set(`a\0${view.id}\0${bucket}`,avatar);return avatar??monogram;
  }

  const ops={
    start,
    visible:value=>{visible=value===true;},
    scheme:value=>{if(value==='light'||value==='dark')scheme=value;},
    bucket:value=>{if(validBucket(value)){buckets.set(instance,value);election?.send({type:'hello',instance,avatarBucket:value});if(election?.leading)receive({type:'hello',instance,avatarBucket:value});}},
    render:async({subjects,bucket})=>{if(!Array.isArray(subjects)||subjects.length>9||!validBucket(bucket))throw new TypeError('render');return Promise.all(subjects.map(s=>tile(typeof s==='string'?s:null,bucket)));},
    createEntry:({prepare,delivery})=>createEntry({...scope(),key,prepare,delivery:delivery==='embed-fedcm'?'embed-fedcm':'embed-popup',fetch}),
    createRequestEntry:({prepare,subjectConstraint})=>createRequestEntry({...scope(),key,prepare,subjectConstraint,fetch}),
    /** The FedCM `params.proof`: a fresh single-use nonce from the embed API, signed with the frame key for this entry. */
    async fedcmProof({entry,assertUrl}){if(typeof entry!=='string'||new URL(assertUrl).origin!==config.issuer)throw new TypeError('fedcm');const {nonce}=await api.nonce();return key.fedcmProof({assertUrl,entry,nonce});},
    proof:({entry,challenge})=>key.embedProof({issuer:config.issuer,entry,challenge}),
    async redeem({claim,delivered}){const value=await api.claim(claim);if(typeof value.credential!=='string'||!value.credential)throw new TypeError('claim');const now=clock();
      await saveCredential(store,scope(),{id:randomId(crypto),credential:value.credential,subject:null,delivered:delivered===true,createdAt:now,pendingUntil:now+Math.min(Number(value.expires_in)||600,600)*1000});
      hint({type:'credentials-changed',instance});if(election?.leading)sync();return true;},
    /** Inbound `forget` (profile §5.3): deletes this client's credentials (or one subject's) and ends their sessions. */
    // Records whose subject is still unknown (the server view lacks it) match any subject-scoped forget: fail closed (IMPL-2).
    async forget({subject}={}){const removed=await deleteCredentials(store,scope(),r=>subject===undefined||r.subject===subject||r.subject===null);dropViews(subject);hint({type:'forget',instance,...subject!==undefined?{subject}:{}});if(election?.leading)sync();for(const r of removed)api.forget(r.credential).catch(()=>{});return true;},
    /** "Remove from this site" (second in-island confirmation already given). */
    async remove({subject}){if(typeof subject!=='string')return false;return ops.forget({subject});},
    selectable:({subject})=>views.some(v=>v.subject===subject&&v.delivered),
    pagehide:()=>stop(),
    pageshow:async()=>{if(!started&&config)await start({config,instance,role,scheme,visible,bucket:buckets.get(instance)});},
  };
  return async function handle(data){
    const {id,op,args}=data??{};if(!Object.hasOwn(ops,op))return;
    if(!['start','pageshow','pagehide','visible','scheme','bucket'].includes(op))await ready.promise;
    try{const value=await ops[op](args??{});if(id!==undefined)post({id,ok:true,value});}catch{if(id!==undefined)post({id,ok:false});}
  };
}
// Worker entry: only when running as a dedicated worker.
if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope){
  const handle=createIslandWorker({post:message=>globalThis.postMessage(message)});
  globalThis.onmessage=event=>{handle(event.data);};
}
