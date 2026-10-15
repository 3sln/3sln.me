// Bindle client: discovery, the conformance floor, authorization requests and
// app sessions for ANY Bindle provider (protocol §2, auth.md). Nothing here is
// specific to 3sln.me except the overridable default host of handle input.
// Token exchange, refresh, revocation and RPC live in tokens.mjs and DPoP in
// dpop.mjs; both load on first use.
import {authorizationIntents,readDeclaration,computeCapabilities,CapabilityStore,freshness,notImplemented} from './capabilities.mjs';
import {parseIdentity,noDefault} from './handle.mjs';
export {authorizationIntents,parseIdentity};

// Stable failure codes let flows report discovery failures without parsing messages.
const coded=(message,code)=>Object.assign(new Error(message),{code});
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;};
const originOf=host=>{try{return parseIdentity(`provider@${host}`,host,{allowInsecureLocalhost:/^localhost(?::\d+)?$/.test(host)}).manifestUrl.replace('/.well-known/bindle/manifest.json','');}catch{return null;}};
// The email fallback goes only to the configured default host, and only after a
// definitive 404/410 from a different host (protocol §2).
const fallbackFor=(defaultHost,emailFallback)=>emailFallback&&!noDefault(defaultHost)?originOf(defaultHost):null;

export async function discoverIdentity(value, { fetcher = fetch, signal, allowInsecureLocalhost=false, defaultHost='3sln.me', emailFallback=true, store, embedderOrigin } = {}) {
  let identity;
  try{identity = parseIdentity(value,defaultHost,{allowInsecureLocalhost});}catch(error){throw coded(error.message,'invalid-identity');}
  return fetchProvider(identity,{fetcher,signal,store,embedderOrigin,fallback:fallbackFor(defaultHost,emailFallback)});
}
// Host-level discovery for flows that have no handle: the default provider, or the
// issuer of the current session. The manifest describes a provider, never a person.
export async function discoverProvider(host, { fetcher = fetch, signal, allowInsecureLocalhost=false, store, embedderOrigin } = {}) {
  let identity;
  try{if(noDefault(host))throw new Error('Enter a handle like alex@provider.example.');identity=parseIdentity(`provider@${host}`,host,{allowInsecureLocalhost});}catch(error){throw coded(error.message,'invalid-identity');}
  const result=await fetchProvider(identity,{fetcher,signal,store,embedderOrigin});
  return {...result,identity:undefined};
}
async function fetchProvider(identity,{fetcher,signal,store,embedderOrigin,fallback=null}){
  const issuer=new URL(identity.manifestUrl).origin,cached=store?.declaration(issuer);
  if(cached)return {identity,kind:'provider',issuer,declaration:cached,manifest:store.manifest(issuer),capabilities:computeCapabilities(cached)};
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  let response;
  try{response = await fetcher(identity.manifestUrl, { signal: boundedSignal, credentials: 'omit', redirect: 'error', referrerPolicy:'no-referrer', cache:'no-cache', headers: { Accept: 'application/json' } });}catch(error){if(signal?.aborted)throw error;throw coded(error?.message??'Provider discovery failed.','discovery-unavailable');}
  // Only a definite absence allows a fallback, and never to the same host. Errors never switch providers.
  if (response.status === 404 || response.status === 410){if(fallback&&fallback!==issuer)return { identity, kind: 'email-fallback', provider: fallback };throw coded('No Bindle provider was found.','no-provider');}
  if (!response.ok) throw coded(`Provider discovery failed (${response.status}).`,'discovery-unavailable');
  let manifest;
  try{manifest=await readManifest(response);}catch(error){throw coded(error.message,'unsupported-provider');}
  const declaration=readDeclaration(manifest,issuer,{embedderOrigin});
  // `manifest` (raw members, floor-checked, frozen) stays available to apps reading members the SDK does not model.
  store?.remember(declaration,freshness(response),manifest);
  return { identity, kind: 'provider', issuer, declaration, manifest:Object.isFrozen(manifest)?manifest:deepFreeze(manifest), capabilities:computeCapabilities(declaration) };
}
async function readManifest(response){
  if (!response.headers?.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('Provider manifest must be JSON.');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); throw new Error('Provider manifest is too large.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder().decode(joined);
  } else text = await response.text();
  if (new TextEncoder().encode(text).length > 65536) throw new Error('Provider manifest is too large.');
  return JSON.parse(text);
}

const encode64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomSecret = crypto => encode64(crypto.getRandomValues(new Uint8Array(32)));
const entryCoreKeys=new Set(['clientId','redirectUri','challenge','challengeMethod','state','intent','loginHint','subjectConstraint','maxAge','requests','uiLocales','colorScheme','presentation','dpopJkt','embedJkt','delivery']);
const opaqueIdentifier=/^(?:[0-9a-f-]{36}\.)?[A-Za-z0-9_-]{43}$/,jktPattern=/^[A-Za-z0-9_-]{43}$/;
const boundedSignal=signal=>signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
const tokens=()=>import('./tokens.mjs'),dpop=()=>import('./dpop.mjs');
// At most this many pending transactions per callback (redirect, popup and island flows at once).
export const pendingLimit=8;
// A metadata-document client ID: HTTPS, non-root path, no query, fragment or credentials (protocol §2).
function metadataClientId(value,redirect){
  if(value===undefined||value===null)return null;let url;try{url=new URL(value);}catch{url=null;}
  if(!url||url.href!==value||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))||url.pathname==='/'||url.search||url.hash||url.username||url.password||url.origin!==redirect.origin)throw new Error('The client metadata URL must be an HTTPS document on the callback origin.');
  return url.href;
}

export class BindleClient {
  // clientId: one string for every provider, a map {issuerOrigin: id}, or a
  // resolver (issuer) => id|null. clientMetadataUrl: an HTTPS client ID used with
  // providers that declare client-id-metadata.v1 when no explicit ID applies.
  constructor({clientId,clientMetadataUrl,redirectUri,fetcher=globalThis.fetch?.bind(globalThis),crypto=globalThis.crypto,storage=globalThis.sessionStorage,storageKey='bindle.pending-login',clock=Date.now,allowInsecureLocalhost=false,history=globalThis.history,defaultHost='3sln.me',emailFallback=true,capabilities=new CapabilityStore({clock}),keyStore,embedderOrigin=globalThis.location?.origin}={}) {
    const callback=new URL(redirectUri);
    const configured=typeof clientId==='string'?!!clientId&&clientId.length<=2048:typeof clientId==='function'||!!clientId&&typeof clientId==='object'&&!Array.isArray(clientId);
    if(!(configured||clientMetadataUrl)||callback.hash||callback.username||callback.password||!['https:','http:'].includes(callback.protocol)||callback.protocol==='http:'&&!['localhost','127.0.0.1'].includes(callback.hostname))throw new Error('A client ID and secure callback URL are required.');
    this.clientIds=configured?clientId:null;this.clientMetadataUrl=metadataClientId(clientMetadataUrl,callback);
    this.redirectUri=callback.href;this.fetcher=fetcher;this.crypto=crypto;this.storage=storage;this.storageKey=storageKey;this.clock=clock;this.history=history;this.session=null;this.refreshPromise=null;this.refreshController=null;this.references=new WeakMap();this.allowInsecureLocalhost=allowInsecureLocalhost;this.defaultHost=defaultHost;this.emailFallback=emailFallback;this.capabilities=capabilities;this.embedderOrigin=embedderOrigin;
    // Island policy (components profile §6.5), set by <bindle-session>.
    this.islandPolicy={islands:'auto',issuers:null};this.userAgent={identityCredential:!!globalThis.IdentityCredential};
    // Login transactions and the installed session have separate generations:
    // starting, completing or canceling a login never cancels RPCs or clears the
    // current session until a replacement token exchange succeeds (EE-08).
    this.generation=0;this.loginGeneration=0;
    // Pending records keyed by state; island and FedCM records stay in memory.
    this.memoryPending=new Map();
    // App sessions held in this document, one per (issuer, subject); `session` is the current one.
    this.sessions=new Map();
    this.dpopKeys=new Map();this.dpopNonces=new Map();this.keyStore=keyStore;
  }
  // A string client ID (or undefined when IDs differ per provider).
  get clientId(){return typeof this.clientIds==='string'?this.clientIds:undefined;}
  clientIdFor(issuer){
    const config=this.clientIds;let id;
    try{id=typeof config==='string'?config:typeof config==='function'?config(issuer):config&&Object.hasOwn(config,issuer)?config[issuer]:undefined;}catch{id=undefined;}
    if((id===undefined||id===null)&&this.clientMetadataUrl&&this.capabilities.declaration(issuer,{stale:true})?.features['client-id-metadata'])id=this.clientMetadataUrl;
    return typeof id==='string'&&id&&id.length<=2048?id:null;
  }
  get defaultIssuer(){return noDefault(this.defaultHost)?null:originOf(this.defaultHost);}
  capabilitiesFor(issuer){
    if(!issuer)return null;
    const policy=this.islandPolicy??{};
    return this.capabilities.capabilities(issuer,{defaultIssuer:this.defaultIssuer,islands:policy.islands,islandIssuers:policy.issuers,identityCredential:!!this.userAgent?.identityCredential});
  }
  discover(identity,{signal}={}){return discoverIdentity(identity,{fetcher:this.fetcher,signal,allowInsecureLocalhost:this.allowInsecureLocalhost,defaultHost:this.defaultHost,emailFallback:this.emailFallback,store:this.capabilities,embedderOrigin:this.embedderOrigin});}
  discoverHost(host,{signal}={}){return discoverProvider(host,{fetcher:this.fetcher,signal,allowInsecureLocalhost:this.allowInsecureLocalhost,store:this.capabilities,embedderOrigin:this.embedderOrigin});}

  // ---- Pending transactions ----
  #recordKey(state){return `${this.storageKey}:${JSON.stringify([this.redirectUri,state])}`;}
  #records(){
    const out=[];
    try{for(let index=0;index<(this.storage?.length??0);index++){const key=this.storage.key(index);if(!key?.startsWith(this.storageKey+':'))continue;let value;try{value=JSON.parse(this.storage.getItem(key));}catch{continue;}if(value&&typeof value==='object'&&value.redirectUri===this.redirectUri)out.push({key,value});}}catch{}
    return out;
  }
  readPending(state){
    if(typeof state!=='string')return [...this.memoryPending.values(),...this.#records().map(record=>record.value)].sort((a,b)=>(b.requestedAt??0)-(a.requestedAt??0))[0]??null;
    const memory=this.memoryPending.get(state);if(memory)return memory;
    try{const value=JSON.parse(this.storage.getItem(this.#recordKey(state)));return value&&typeof value==='object'&&value.state===state?value:null;}catch{return null;}
  }
  hasPending(state){const pending=this.readPending(state);return !!pending&&typeof state==='string'&&pending.state===state&&pending.expiresAt>this.clock();}
  async #challenge(){const verifier=randomSecret(this.crypto),state=randomSecret(this.crypto),challenge=encode64(new Uint8Array(await this.crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));return {verifier,state,challenge};}
  #storePending(declaration,{verifier,state},clientId,extra,{memory=false}={}){
    const now=this.clock();
    const record={verifier,state,issuer:declaration.issuer,tokenEndpoint:declaration.tokenEndpoint,rpcEndpoint:declaration.rpcEndpoint,preferencesContract:declaration.preferencesContract,...declaration.revocationEndpoint?{revocationEndpoint:declaration.revocationEndpoint}:{},clientId,redirectUri:this.redirectUri,expiresAt:now+600000,requestedAt:now,...extra};
    if(memory){
      for(const [key,value] of this.memoryPending)if(value.expiresAt<=now)this.#consume(key,{release:true});
      while(this.memoryPending.size>=pendingLimit)this.#consume(this.memoryPending.keys().next().value,{release:true});
      this.memoryPending.set(state,record);return record;
    }
    const records=this.#records(),live=records.filter(item=>item.value.expiresAt>now).sort((a,b)=>(a.value.requestedAt??0)-(b.value.requestedAt??0));
    // Expired and evicted records release their DPoP keys too.
    for(const {key,value} of [...records.filter(item=>!(item.value.expiresAt>now)),...live.slice(0,Math.max(0,live.length-pendingLimit+1))]){this.storage.removeItem(key);if(value.dpopJkt)this.#releaseKey(value.dpopJkt);}
    this.storage.setItem(this.#recordKey(state),JSON.stringify(record));
    return record;
  }
  // Removes one record; `release` also drops a DPoP key no session or record uses.
  #consume(state,{release=false}={}){
    const record=this.readPending(state);this.memoryPending.delete(state);try{this.storage.removeItem(this.#recordKey(state));}catch{}
    if(release&&record?.dpopJkt)this.#releaseKey(record.dpopJkt);
    return record;
  }
  // With a state: drops that transaction only. Without: every transaction of this
  // client and callback, and any login still being started.
  cancelLogin(state){
    if(typeof state==='string'){this.#consume(state,{release:true});return;}
    this.loginGeneration++;
    for(const {key,value} of this.#records()){this.storage.removeItem(key);if(value.dpopJkt)this.#releaseKey(value.dpopJkt);}
    for(const state of [...this.memoryPending.keys()])this.#consume(state,{release:true});
  }

  // ---- DPoP keys (memory; a redirect round trip may park one in keyStore) ----
  async #newKey({persist}){
    const key=await (await dpop()).createKey(this.crypto);this.dpopKeys.set(key.jkt,key);
    if(persist)await this.keyStore.put(`${this.storageKey}:${key.jkt}`,key);
    return key;
  }
  async dpopKey(jkt){
    if(!jktPattern.test(jkt??''))return null;
    let key=this.dpopKeys.get(jkt);
    // A redirect lands in a fresh document: open the key holder there before looking the key up.
    if(!key&&this.keyStore===undefined)await this.#keyStoreReady().catch(()=>false);
    if(!key&&this.keyStore){try{key=await this.keyStore.get(`${this.storageKey}:${jkt}`);}catch{key=null;}if(key?.jkt===jkt)this.dpopKeys.set(jkt,key);else key=null;}
    if(this.keyStore)this.keyStore.delete(`${this.storageKey}:${jkt}`)?.catch?.(()=>{});
    return key;
  }
  #releaseKey(jkt){
    for(const session of [this.session,...this.sessions.values()])if(session?.dpopJkt===jkt)return;
    for(const record of this.memoryPending.values())if(record.dpopJkt===jkt)return;
    this.dpopKeys.delete(jkt);this.keyStore?.delete(`${this.storageKey}:${jkt}`)?.catch?.(()=>{});
  }
  #keyStoreReady(){
    if(this.keyStore===undefined)return dpop().then(module=>{this.keyStore=module.indexedDBKeyStore();this.keyStore?.sweep?.().catch?.(()=>{});return !!this.keyStore;});
    return Promise.resolve(!!this.keyStore);
  }

  async beginLogin(identity,{requests=[],signal}={}) {
    this.cancelLogin();const generation=this.loginGeneration;
    const discovered=await this.discover(identity,{signal});
    if(generation!==this.loginGeneration)throw coded('Login was canceled.','canceled');
    if(discovered.kind!=='provider')return discovered;
    const clientId=this.clientIdFor(discovered.issuer);if(!clientId)throw coded('This app is not connected to this provider.','unregistered-client');
    return this.#identityRequest(discovered,{clientId,requests,signal,generation,presentation:'redirect'});
  }
  // Identity-pinned authorization request (the conformance floor). Used when the
  // provider declares no authorization entry, or no entry intent applies.
  async #identityRequest(discovered,{clientId,requests,signal,generation,presentation}){
    const declaration=discovered.declaration,issuer=declaration.issuer;
    const secrets=await this.#challenge(),{state,challenge}=secrets;
    const response=await this.#post(declaration.requestEndpoint,{clientId,redirectUri:this.redirectUri,challenge,challengeMethod:'S256',state,requests,identity:discovered.identity.handle},signal);
    const {boundedJSON}=await tokens();
    const result=await boundedJSON(response).catch(error=>{throw coded(error.message,'network-error');});
    if(!response.ok)throw coded(typeof result?.message==='string'?result.message:'Could not start provider authorization.','network-error');
    if(!opaqueIdentifier.test(result.requestId))throw coded('Provider returned an invalid request identifier.','network-error');
    const authorize=new URL(declaration.authorizationEndpoint);authorize.searchParams.set('request_id',result.requestId);
    if(generation!==this.loginGeneration||signal?.aborted)throw coded('Login was canceled.','canceled');
    this.#storePending(declaration,secrets,clientId,{intent:'login',presentation});
    return {...discovered,intent:'login',state,issuer,authorizationUrl:authorize.href};
  }
  async #post(url,body,signal){try{return await this.fetcher(url,{method:'POST',credentials:'omit',redirect:'error',signal:boundedSignal(signal),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});}catch(error){if(signal?.aborted)throw error;throw coded(error?.message??'Could not reach the provider.','network-error');}}
  // Provider-owned authorization entry (`authorization-entry.v1`, reserved until
  // its wire text is published). Several transactions may be pending at once;
  // the caller cancels the ones it abandons.
  async beginAuthorization({intent='login',identity,host,requests=[],maxAge,uiLocales,colorScheme,presentation='redirect',extensions,signal,dpop:useDpop=true}={}) {
    if(!authorizationIntents.includes(intent))throw new Error('Unsupported authorization intent.');
    if(!['redirect','popup','fedcm'].includes(presentation))throw new Error('Unsupported presentation.');
    if(intent==='reauthenticate'&&(!Number.isSafeInteger(maxAge)||maxAge<0||maxAge>86400))throw new Error('Reauthentication needs a maximum age in seconds.');
    const generation=this.loginGeneration,canceled=()=>generation!==this.loginGeneration||signal?.aborted;
    let discovered,loginHint,subjectConstraint;
    if(intent==='login'){
      discovered=identity?await this.discover(identity,{signal}):await this.discoverHost(host??this.defaultHost,{signal});
      if(discovered.kind!=='provider')return discovered;
      loginHint=discovered.identity?.handle;
    } else {
      const session=this.session;if(!session)throw coded('Sign in before changing this account.','no-session');
      try{discovered=await this.discoverHost(new URL(session.issuer).host,{signal});}catch(error){if(error.code==='invalid-identity'||error.code==='no-provider')throw coded('The current provider is unavailable.','discovery-unavailable');throw error;}
      if(discovered.issuer!==session.issuer)throw coded('The current provider is unavailable.','discovery-unavailable');
      if(intent!=='select-account')subjectConstraint=session.subject;
    }
    if(canceled())throw coded('Login was canceled.','canceled');
    const declaration=discovered.declaration,issuer=declaration.issuer,capabilities=this.capabilitiesFor(issuer);
    const clientId=this.clientIdFor(issuer);if(!clientId)throw coded('This app is not connected to this provider.','unregistered-client');
    if(!capabilities.intents.includes(intent)){
      if(intent==='login'&&loginHint)return this.#identityRequest(discovered,{clientId,requests,signal,generation,presentation:presentation==='fedcm'?'redirect':presentation});
      throw intent==='login'?coded('Enter your complete handle to continue.','identity-required'):coded('This provider does not support this sign-in option.','unsupported-provider');
    }
    const secrets=await this.#challenge(),{state,challenge}=secrets;
    const locales=Array.isArray(uiLocales)?uiLocales.filter(tag=>typeof tag==='string'&&/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(tag)&&tag.length<=35).slice(0,4):[];
    // A redirect leaves this document, so its DPoP key must survive in keyStore; without one the session is memory-only.
    const key=useDpop&&capabilities.dpop&&intent!=='end-session'&&(presentation!=='redirect'||await this.#keyStoreReady())?await this.#newKey({persist:presentation==='redirect'}):null;
    const body={clientId,redirectUri:this.redirectUri,challenge,challengeMethod:'S256',state,intent,requests:intent==='end-session'?[]:requests,presentation,...loginHint?{loginHint}:{},...subjectConstraint?{subjectConstraint}:{},...intent==='reauthenticate'?{maxAge}:{},...locales.length?{uiLocales:locales}:{},...['light','dark'].includes(colorScheme)?{colorScheme}:{},...key?{dpopJkt:key.jkt}:{}};
    // Extension parameters may add fields but never override the core entry fields
    // above; key-binding members (dpopJkt, embedJkt, delivery) are never extensions.
    if(extensions!==undefined){
      if(!extensions||typeof extensions!=='object'||Array.isArray(extensions)||Object.keys(extensions).length>8)throw new Error('Invalid authorization extensions.');
      for(const [name,value] of Object.entries(extensions)){if(!/^[a-z][A-Za-z0-9_]{0,31}$/.test(name)||name in body||entryCoreKeys.has(name)||!['string','number','boolean'].includes(typeof value)||String(value).length>512)throw new Error('Invalid authorization extension.');body[name]=value;}
    }
    const response=await this.#post(declaration.features['authorization-entry'].endpoint,body,signal).catch(error=>{if(key)this.#releaseKey(key.jkt);throw error;});
    // A declared entry endpoint that is not implemented degrades the feature for this issuer (decision note §4).
    if(notImplemented(response.status)){
      this.capabilities.degrade(issuer,'authorization-entry');if(key)this.#releaseKey(key.jkt);
      if(intent==='login'&&loginHint)return this.#identityRequest(discovered,{clientId,requests,signal,generation,presentation:presentation==='fedcm'?'redirect':presentation});
      throw coded('This provider does not support this sign-in option.','unsupported-provider');
    }
    const {boundedJSON}=await tokens();
    const result=await boundedJSON(response).catch(error=>{throw coded(error.message,'network-error');});
    // Entry creation errors are generic and session-independent; never surface provider text as a reason.
    if(!response.ok||!opaqueIdentifier.test(result?.entryId??'')){if(key)this.#releaseKey(key.jkt);throw coded(response.ok?'Provider returned an invalid authorization entry.':'Could not start provider authorization.','network-error');}
    const authorize=new URL(declaration.authorizationEndpoint);authorize.searchParams.set('entry',result.entryId);
    if(canceled()){if(key)this.#releaseKey(key.jkt);throw coded('Login was canceled.','canceled');}
    this.#storePending(declaration,secrets,clientId,{intent,presentation,...key?{dpopJkt:key.jkt}:{},...subjectConstraint?{subjectConstraint}:{},...intent==='reauthenticate'?{maxAge}:{}},{memory:presentation==='fedcm'});
    return {...discovered,intent,state,issuer,entryId:result.entryId,authorizationUrl:authorize.href};
  }
  // Inputs for a provider island's `prepare` (components profile §8): fresh PKCE
  // and state for that issuer, kept in memory only. The island creates the entry.
  async prepareIslandFlow(issuer,{requests=[],dpop:useDpop=true}={}){
    const declaration=this.capabilities.declaration(issuer,{stale:true}),capabilities=this.capabilitiesFor(issuer),clientId=this.clientIdFor(issuer);
    if(!declaration||!capabilities?.identityless)throw coded('This provider does not support this sign-in option.','unsupported-provider');
    if(!clientId)throw coded('This app is not connected to this provider.','unregistered-client');
    const secrets=await this.#challenge(),key=useDpop&&capabilities.dpop?await this.#newKey({persist:false}):null;
    // embedJkt is a reserved slot: islands keep their key private, so the SDK never fills it from island data.
    this.#storePending(declaration,secrets,clientId,{intent:'login',presentation:'island',...key?{dpopJkt:key.jkt}:{},embedJkt:null},{memory:true});
    return Object.freeze({issuer,clientId,redirectUri:this.redirectUri,challenge:secrets.challenge,state:secrets.state,requests,...key?{dpopJkt:key.jkt}:{}});
  }
  // Validates the exact callback against its pending transaction and consumes it.
  #consumeCallback(callbackUrl,extraParams){
    const callback=new URL(callbackUrl),expected=new URL(this.redirectUri),state=callback.searchParams.get('state');
    const pending=this.readPending(state??undefined);if(!pending||pending.state!==state&&state!==null||['island','fedcm'].includes(pending.presentation))throw coded('There is no pending Bindle login.','invalid-callback');
    if(callback.username||callback.password||callback.origin!==expected.origin||callback.pathname!==expected.pathname||callback.hash||pending.redirectUri!==this.redirectUri||!this.#knownClient(pending)||pending.expiresAt<=this.clock())throw coded('This login callback is invalid or expired.','invalid-callback');
    const expectedParams=[...expected.searchParams];for(const[k,v]of expectedParams)if(callback.searchParams.getAll(k).length!==1||callback.searchParams.get(k)!==v)throw coded('The callback URL does not match the registered callback.','invalid-callback');
    const allowed=new Set([...expected.searchParams.keys(),'state','iss',...extraParams]);
    if([...callback.searchParams.keys()].some(k=>!allowed.has(k)||callback.searchParams.getAll(k).length!==1)||callback.searchParams.get('state')!==pending.state||callback.searchParams.get('iss')!==pending.issuer)throw coded('This login callback does not match the pending request.','invalid-callback');
    // Consume before exchanging: replay or uncertain network failures require a fresh login.
    this.#consume(pending.state);
    if(globalThis.location?.origin===callback.origin&&globalThis.location?.pathname===callback.pathname)this.history?.replaceState(null,'',expected.pathname+expected.search);
    return {pending,callback,generation:this.loginGeneration};
  }
  #knownClient(pending){return pending.clientId===this.clientIdFor(pending.issuer)||!!pending.clientId&&pending.clientId===this.clientMetadataUrl;}
  async completeLogin(callbackUrl=globalThis.location?.href,{signal}={}) {
    let state=null;try{state=new URL(callbackUrl).searchParams.get('state');}catch{}
    if(this.readPending(state??undefined)?.intent==='end-session')throw coded('This callback belongs to a provider sign-out.','invalid-callback');
    const {pending,callback,generation}=this.#consumeCallback(callbackUrl,['code','error','error_description']);
    // Every provider-side non-approval is one generic outcome (embeddable-elements §4).
    if(callback.searchParams.has('error')){if(pending.dpopJkt)this.#releaseKey(pending.dpopJkt);throw coded('The application connection was declined or could not be completed.','canceled');}
    const code=callback.searchParams.get('code');if(!opaqueIdentifier.test(code??''))throw coded('The callback does not contain a valid authorization code.','invalid-callback');
    return this.#redeem(pending,code,{signal,generation});
  }
  // A code delivered by an island port or a FedCM token: validated exactly as
  // callback parameters (state, issuer, expiry, single use) against its record.
  // `presentation` ('island' or 'fedcm', required) binds the code to the transport that created the record.
  async completeCode({code,state,iss}={},{signal,presentation}={}){
    const pending=typeof state==='string'?this.readPending(state):null;
    if(!pending||!['island','fedcm'].includes(presentation)||pending.presentation!==presentation||pending.state!==state||iss!==pending.issuer||pending.intent==='end-session'||pending.redirectUri!==this.redirectUri||!this.#knownClient(pending)||pending.expiresAt<=this.clock())throw coded('This sign-in response is invalid or expired.','invalid-callback');
    this.#consume(state);
    if(typeof code!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(code)){if(pending.dpopJkt)this.#releaseKey(pending.dpopJkt);throw coded('The response does not contain a valid authorization code.','invalid-callback');}
    return this.#redeem(pending,code,{signal,generation:this.loginGeneration});
  }
  async #redeem(pending,code,options){
    try{const validated=await (await tokens()).redeem(this,pending,code,options);this.#install(validated);return this.session;}
    catch(error){if(pending.dpopJkt)this.#releaseKey(pending.dpopJkt);throw error;}
  }
  // End-session callbacks carry only state, iss and result, so a login code can
  // never be mistaken for a sign-out result. App tokens are cleared either way.
  async completeEndSession(callbackUrl=globalThis.location?.href) {
    let state=null;try{state=new URL(callbackUrl).searchParams.get('state');}catch{}
    if(this.readPending(state??undefined)?.intent!=='end-session')throw coded('There is no pending provider sign-out.','invalid-callback');
    let callback;try{({callback}=this.#consumeCallback(callbackUrl,['result','error','error_description']));}catch(error){this.signOut();throw error;}
    const result=callback.searchParams.has('error')&&!callback.searchParams.has('result')?'canceled':callback.searchParams.get('result');
    this.signOut();
    if(!['completed','canceled'].includes(result))throw coded('The provider returned an invalid sign-out result.','invalid-callback');
    return {result};
  }
  completeCallback(callbackUrl=globalThis.location?.href,options){
    let state=null;try{state=new URL(callbackUrl).searchParams.get('state');}catch{}
    return this.readPending(state??undefined)?.intent==='end-session'?this.completeEndSession(callbackUrl):this.completeLogin(callbackUrl,options);
  }

  // ---- App sessions ----
  #install(session){
    if(this.refreshController){this.refreshController.abort();this.refreshController=null;}
    this.refreshPromise=null;this.generation++;this.session=session;this.#hold(session);
  }
  #hold(session){
    const key=`${session.issuer} ${session.subject}`,previous=this.sessions.get(key);
    this.sessions.delete(key);this.sessions.set(key,session);
    if(previous?.dpopJkt&&previous.dpopJkt!==session.dpopJkt)this.#releaseKey(previous.dpopJkt);
    while(this.sessions.size>pendingLimit){const [oldest,value]=this.sessions.entries().next().value;this.sessions.delete(oldest);if(value===this.session)this.sessions.set(oldest,value);else if(value.dpopJkt)this.#releaseKey(value.dpopJkt);}
  }
  // A held app session for exactly (issuer, subject), or null.
  heldSession(issuer,subject){const session=this.sessions.get(`${issuer} ${subject}`);return session&&(session.refresh_token?session.refreshExpiresAt:session.expiresAt)>this.clock()?session:null;}
  // Makes a held session current (an island `select`); never starts a flow.
  selectSession(issuer,subject){
    const session=this.heldSession(issuer,subject);if(!session)return false;
    if(session!==this.session){if(this.refreshController){this.refreshController.abort();this.refreshController=null;}this.refreshPromise=null;this.generation++;this.session=session;}
    return true;
  }
  // Removes one app session from this document (after revocation or sign-out of it).
  forgetSession(session){
    if(!session)return;const key=`${session.issuer} ${session.subject}`;
    if(this.sessions.get(key)===session)this.sessions.delete(key);
    if(this.session===session){this.session=null;this.generation++;if(this.refreshController){this.refreshController.abort();this.refreshController=null;}this.refreshPromise=null;}
    if(session.dpopJkt)this.#releaseKey(session.dpopJkt);
  }
  // RFC 7009 revocation of exactly that app session. Returns false when not advertised.
  async revokeSession(session=this.session,options) {const result=await (await tokens()).revoke(this,session,options);return result;}
  refresh({signal}={}) {
    if(signal?.aborted)return Promise.reject(new DOMException('The operation was canceled.','AbortError'));
    if(this.refreshPromise)return waitForRefresh(this.refreshPromise,signal);
    const generation=this.generation,session=this.session;
    if(!session?.refresh_token||session.refreshExpiresAt<=this.clock())return Promise.reject(new Error('Sign in again to renew this application session.'));
    const controller=new AbortController();this.refreshController=controller;
    const promise=(async()=>{
      try {
        const renewed=await (await tokens()).renew(this,session,controller.signal);
        if(generation!==this.generation||this.session!==session)throw new Error('Session renewal was canceled.');
        this.session=renewed;this.#hold(renewed);return renewed;
      } catch(error) {
        // Rotation may have reached the provider even if its response was lost.
        // Never replay the previous refresh token or wipe a newer login.
        if(generation===this.generation&&this.session===session)this.forgetSession(session);
        throw error;
      }
    })();
    this.refreshPromise=promise;
    const cleanup=()=>{if(this.refreshPromise===promise)this.refreshPromise=null;if(this.refreshController===controller)this.refreshController=null;};promise.then(cleanup,cleanup);return waitForRefresh(promise,signal);
  }
  async ensureSession(options={}) {
    if(options.signal?.aborted)throw new DOMException('The operation was canceled.','AbortError');
    const session=this.session;
    if(!session)throw new Error('Sign in again before accessing this resource.');
    if(session.expiresAt-this.clock()<=30000){if(session.refresh_token)return this.refresh(options);if(session.expiresAt<=this.clock())throw new Error('Sign in again before accessing this resource.');}
    return session;
  }
  async rpc({resource,contract,method,args={},tx=this.crypto.randomUUID()},{signal,token}={}) {
    const generation=this.generation,session=await this.ensureSession({signal});
    if(generation!==this.generation)throw new Error('Resource access was canceled.');
    const {response,result}=await (await tokens()).sendRPC(this,session,JSON.stringify({version:'0',tx,resource,contract,method,args}),{signal,token});
    if(generation!==this.generation||this.session?.subject!==session.subject||this.session?.issuer!==session.issuer)throw new Error('Resource access was canceled.');if(!response.ok)throw new Error(result.message??'The resource request was denied.');if(result.version!=='0'||result.tx!==tx)throw new Error('Provider returned a mismatched RPC response.');if(result.error){const error=new Error(typeof result.error.message==='string'?result.error.message:'The resource request failed.');if(typeof result.error.code==='string'&&/^[a-zA-Z0-9_.-]{1,64}$/.test(result.error.code))error.code=result.error.code;if(Number.isInteger(result.error.retryAfter)&&result.error.retryAfter>=0&&result.error.retryAfter<=86400)error.retryAfter=result.error.retryAfter;throw error;}return result;
  }
  async callResource(reference,call,options={}) {
    if(!reference||typeof reference.id!=='string'||typeof reference.token!=='string')throw new Error('A scoped resource reference is required.');
    const context={before:this.session,provenance:this.references.get(reference),generation:this.generation};
    return (await tokens()).callResource(this,reference,call,options,context);
  }
  async userMessage(reference,message={},options={}) {
    if(!message||Array.isArray(message)||typeof message!=='object'||Object.keys(message).some(key=>!['subject','body','mimeType','tags','transactionId','createdAt'].includes(key)))throw new Error('Unsupported app message fields.');
    const {subject,body,mimeType='text/plain',tags=[],transactionId=this.crypto.randomUUID(),createdAt=this.clock()}=message;
    // The host page, not a caller-supplied origin, determines browser provenance.
    const actual=globalThis.window?.location?.origin,realm=globalThis.window?.origin;
    if(!actual||realm!==actual||actual!==new URL(this.redirectUri).origin)throw new Error('App messages must originate from the registered app origin.');
    if(typeof subject!=='string'||!subject.trim()||[...subject].length>120||typeof body!=='string'||[...body].length>12000||new TextEncoder().encode(JSON.stringify({transactionId,createdAt,subject,mimeType,body,tags})).length>16384||!['text/plain','text/html'].includes(mimeType)||!Array.isArray(tags)||tags.length>31||new Set(tags).size!==tags.length||tags.some(tag=>typeof tag!=='string'||!tag||[...tag].length>64||/[\x00-\x1f\x7f]/.test(tag)||tag==='app-message')||!Number.isSafeInteger(createdAt)||createdAt<0||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transactionId))throw new Error('Provide a bounded app message and a valid transaction ID.');
    try{const response=await this.callResource(reference,{contract:'https://3sln.me/artefacts/contracts/app-messages/v1',method:'createOwn',args:{transactionId,createdAt,subject,mimeType,body,tags},tx:transactionId},options);return {transactionId,createdAt,result:response.result};}catch(error){error.transactionId=transactionId;error.createdAt=createdAt;throw error;}
  }
  async readPreferences(fragment,options) {return (await tokens()).readPreferences(this,fragment,options);}
  // App sign-out of every app session held in this document; pending logins end too.
  signOut(){
    const held=[...this.sessions.values()];this.sessions.clear();this.session=null;this.generation++;
    if(this.refreshController){this.refreshController.abort();this.refreshController=null;}this.refreshPromise=null;this.cancelLogin();
    for(const session of held)if(session.dpopJkt)this.#releaseKey(session.dpopJkt);
    return held;
  }
}

function waitForRefresh(promise,signal){if(!signal)return promise;if(signal.aborted)return Promise.reject(new DOMException('The operation was canceled.','AbortError'));return new Promise((resolve,reject)=>{const aborted=()=>reject(new DOMException('The operation was canceled.','AbortError'));signal.addEventListener('abort',aborted,{once:true});promise.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});});}
