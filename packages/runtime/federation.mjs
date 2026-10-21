import {APP_NOTIFICATIONS} from '../federation/app-notifications.mjs';
import {RESOURCE_SCOPING,storageScopeOptions} from '../storage/scoping.mjs';
import {IdentityService} from '../identity/service.mjs';
import {normalizeHandle} from '../identity/handles.mjs';
import {digest,canonical} from '../messaging/store.mjs';
import {PROFILE,PREFERENCES} from '../federation/service.mjs';
import {objectURLAuthority} from '../storage/object-urls.mjs';
import {encryptSecret,decryptSecret} from './secrets.mjs';
import {dpopNonces} from '../federation/dpop.mjs';
import {ENTRY_INTENTS,ENTRY_SHARDS,AuthorizationEntries,entryShard,remoteShard} from '../federation/authorization-entries.mjs';
import {componentsProfile} from '../federation/components-profile.mjs';
import {ClientDirectory,CLIENT_METADATA_FEATURE,clientSite} from '../federation/client-metadata.mjs';
import {UUID_V4 as UUID} from '../core/primitives.mjs';

export const BROKERING_STORE='bindle-brokering-v1';
export const FEDERATION_LAYOUT='bindle-federation-v1';
const routed=/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function federationConfig(value,fallback){if(value===undefined||value==='')return structuredClone(fallback);return typeof value==='string'?JSON.parse(value):structuredClone(value);}
export function federationClients(config){const clients=federationConfig(config.FEDERATION_CLIENTS,[]);if(!Array.isArray(clients)||clients.length>100)throw new TypeError('At most 100 reviewed federation clients can be configured.');for(const client of clients){if(typeof client?.id!=='string'||client.id.length>200||typeof client.name!=='string'||!client.name.trim()||client.name.length>100)throw new TypeError('Reviewed clients require a URL ID of at most 200 characters and name of at most 100 characters.');}return clients;}
/** `client-id-metadata.v1` is opt-in (CLIENT_METADATA_ENABLED=true, default false) and is declared only where an
 * SSRF-safe egress port is injected as well (docs/spec/federation-implementation.md). */
export const clientMetadataEnabled=config=>config.CLIENT_METADATA_ENABLED==='true';
/** Client resolution shared by an adapter's front: reviewed clients first, then metadata documents through `fetch`
 * (the adapter's SSRF-safe egress), `limiter` (`consume`, fleet-wide where available) and `blocked(host)` (admin). */
export function federationClientDirectory(config,{fetch,limiter,blocked,clock}={}){
 const reservedHosts=[config.APP_ORIGIN,config.EMBED_ORIGIN].flatMap(value=>{try{return value?[new URL(value).hostname]:[];}catch{return [];}});
 return new ClientDirectory({clients:federationClients(config),enabled:clientMetadataEnabled(config),fetch,limiter,blocked,reservedHosts,...clock?{clock}:{}});}
export function federationAccount(accounts,owner){const native=accounts.get(owner);return new Proxy({}, {get:(_,method)=>async(...args)=>{const result=await native.invoke({method,args});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;}});}
export async function federationEpoch(account){return digest(crypto,`bindle-account-authority-v1\0${account.assignmentId??account.id}\0${account.recoveryHash??''}`);}
const unsupported=()=>{throw Object.assign(new Error('Credential operations use the identity service.'),{code:'unsupported_method'});};
/** DPoP nonce MAC key; DPoP stays unadvertised without one. */
export const federationDpopSecret=config=>config.DPOP_NONCE_KEY||config.KEY_ENCRYPTION_KEY||undefined;
/** Last credential verification of an owner session: its credential sign-in, or a later step-up (password or passkey).
 * Sessions minted without a credential (device approval, which any recent session can grant) count only from a step-up. */
export const sessionAuthTime=session=>Math.max((session?.source??'credential')==='credential'?session?.createdAt??0:0,Number.isSafeInteger(session?.stepUpAt)?session.stepUpAt:0)||undefined;

/** Domain capabilities are injected identically by Workers and Node. Owner
 * state has no fleet-wide lock; routing identifiers never grant authority. */
export function federationControllerOptions({config,repository,accounts,owner}){
 if(!UUID.test(owner))throw new TypeError('A stable UUID identity is required.');
 const issuer=config.APP_ORIGIN,subject=`${issuer}/entities/${owner}`,schemas=federationConfig(config.FEDERATION_SCHEMAS,{});
 if(!schemas||Array.isArray(schemas)||typeof schemas!=='object'||Object.keys(schemas).length>100)throw new TypeError('Invalid reviewed fragment registry.');
 const identity=new IdentityService({repository,crypto,turnstile:{verify:unsupported},rateLimiter:{check:unsupported},webauthn:{verifyRegistration:unsupported,verifyAuthentication:unsupported},passwordHasher:{hash:unsupported,verify:unsupported},config:{origin:issuer,rpID:config.RP_ID??new URL(issuer).hostname,termsVersion:config.TERMS_VERSION??'2026-10-11',allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true'}});
 const account=federationAccount(accounts,owner);
 const validateSubject=async(candidate,epoch)=>{if(candidate!==subject)return false;const current=await repository.get(owner);return current?.status==='active'&&await federationEpoch(current)===epoch;};
 return {issuer,clients:federationClients(config),routingKey:owner,crypto,objectURLs:{...objectURLAuthority({issuer,secret:config.KEY_ENCRYPTION_KEY}),seal:value=>encryptSecret(value,config.KEY_ENCRYPTION_KEY),open:record=>decryptSecret(record,config.KEY_ENCRYPTION_KEY)},enabled:config.FEDERATION_ENABLED==='true',refreshEnabled:config.FEDERATION_REFRESH_ENABLED!=='false',allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true',dpop:federationDpopSecret(config)?{secret:federationDpopSecret(config)}:undefined,embedOrigin:componentsProfile(config)?.embedOrigin,clientMetadata:clientMetadataEnabled(config),
  embedView:async candidate=>{if(candidate!==subject)fail('unauthorized','The embedded session is unavailable.');const current=await repository.get(owner),profile=await account.beamProfile(owner);if(!current||current.status!=='active')fail('unauthorized','The embedded session is unavailable.');return {handle:current.handle,name:profile.displayName||undefined,avatar:profile.avatar||null};},
  schemaHosts:Object.keys(schemas).map(url=>new URL(url).host),schemaFetcher:async url=>{if(!Object.hasOwn(schemas,url))fail('untrusted_schema_host','This fragment has not been registered with this provider.');return structuredClone(schemas[url]);},
  auth:{owner:async(context,{mutation})=>{const {account:current,session}=await identity.authorized(context,mutation);if(current.id!==owner)fail('forbidden','Sign in to the identity requested by this application.');return {subject,epoch:await federationEpoch(current),authTime:sessionAuthTime(session)};}},validateSubject,
  resourceProvider:async()=>{
   const resources=await account.resources(owner),contract='https://3sln.me/artefacts/contracts/object-storage/v1';
   const descriptors=resources.filter(r=>r.owner===owner&&r.status==='connected'&&r.contracts?.includes(contract)).map(r=>{const capabilities=r.capabilities??{},methods=['capabilities',...capabilities.read?['get']:[],...capabilities.write&&['hosted','google-drive'].includes(r.provider)?['put','delete']:[],...capabilities.read||capabilities.write?['presign']:[]];return {id:`${subject}/resources/${r.id}`,label:r.name,provider:r.provider,contracts:{[contract]:methods,[RESOURCE_SCOPING]:['describe']},generation:String(r.generation??r.id),nativePresigned:capabilities.presigned??{read:false,write:false},scoping:storageScopeOptions(capabilities),limits:{maxRequestBytes:1500000,maxResultBytes:1500000,maxObjectBytes:capabilities.maxObjectBytes??1048576,txRetentionSeconds:86400}};});
   const current=await repository.get(owner),profile=await account.beamProfile(owner);
   if(!current||current.status!=='active')fail('unauthorized','Application authorization is no longer active.');
   descriptors.push({id:`${subject}/app-messages`,label:'Messages from this app',provider:'bindle',contracts:{[APP_NOTIFICATIONS]:['createOwn']},generation:owner,limits:{maxRequestBytes:16384,maxResultBytes:1024,txRetentionSeconds:86400}});descriptors.push({id:`${subject}/profile`,label:'Identity profile',provider:'identity',alias:'@profile',contracts:{[PROFILE]:['read']},generation:owner,preview:{entity:subject,handle:current.handle,name:profile.displayName||current.handle,avatar:profile.avatar||null}});return descriptors;
  },
  dispatcher:{durableJournal:true,execute:async context=>{if(!await validateSubject(context.subject,context.epoch))fail('unauthorized','Application authorization is no longer active.');if(context.connection)await account.appConnectionCheck(owner,context.connection.id,context.connection.generation,context.clientId);if(context.resource===`${subject}/profile`&&context.contract===PROFILE&&context.method==='read'){if(Object.keys(context.args).length)fail('invalid_args','Profile read takes no arguments.');const current=await repository.get(owner),profile=await account.beamProfile(owner);return {entity:subject,handle:current.handle,name:profile.displayName||current.handle,avatar:profile.avatar||null};}return account.federationRPC({...context,authority:'bindle'});}},
  connections:{notificationCheck:(connection,clientId)=>account.appNotificationCheck(owner,connection,clientId),binding:clientId=>account.appConnectionBinding(owner,clientId),connect:(client,expected,permissions)=>account.appBindleConnect(owner,client,expected?.generation,{...permissions,expectedNotificationGeneration:expected?.notificationGeneration}),check:(connection,clientId)=>account.appConnectionCheck(owner,connection.id,connection.generation,clientId)}
 };
}

/** Pre-owner entry store for adapters. `store` is one transactional store or `shard=>store` (sharded by entry ID); a
 * host serving one shard passes `shard`. `endSession` is true only where the adapter mounts the provider
 * session-ending hook (packages/runtime/http.mjs), which is what lets the store accept and advertise end-session. */
export function federationEntries({config,store,shard,authority,endSession=false,clock,directory}){
 if(config.FEDERATION_ENTRY_ENABLED!=='true')return null;
 const schemas=federationConfig(config.FEDERATION_SCHEMAS,{});
 return new AuthorizationEntries({store,shard,issuer:config.APP_ORIGIN,clients:federationClients(config),authority,...directory?{directory}:{},clientMetadata:clientMetadataEnabled(config),embedOrigin:componentsProfile(config)?.embedOrigin,dpop:!!federationDpopSecret(config),...clock?{clock}:{},pinSchema:async url=>{if(!Object.hasOwn(schemas,url))fail('untrusted_schema_host','This fragment has not been registered with this provider.');return {digest:await digest(crypto,canonical(schemas[url]))};},endSession:endSession===true});
}

export const ENTRY_METHODS=['admit','admitHost','create','view','documentPolicy','challenge','verify','declarePlain','select','decide','endTarget','finishSession'];
/** Worker facade over the entry store, sharded by entry ID across ENTRY_SHARDS Durable Object instances (review M5).
 * Static members are computed locally so route matching and the manifest need no round trip. `invoke(shard,method,
 * args)` returns `{ok,result}` or `{ok:false,error}`. Creation first charges the caller's budgets on the caller's shard,
 * then creates on a random shard; every later call goes to the shard named by the entry ID, so retries always reach
 * the same records. `endSession` mirrors the adapter's session-ending hook. */
export function federationEntriesRemote({config,invoke,endSession=false,directory}){
 if(config.FEDERATION_ENTRY_ENABLED!=='true')return null;
 const facade={issuer:config.APP_ORIGIN,clients:new Map(federationClients(config).map(client=>[client.id,client])),directory,clientMetadata:!!directory?.enabled,embedOrigin:componentsProfile(config)?.embedOrigin,dpop:!!federationDpopSecret(config),intents:()=>ENTRY_INTENTS.filter(intent=>intent!=='end-session'||endSession===true),manifest:options=>AuthorizationEntries.prototype.manifest.call(facade,options)};
 const call=async(shard,method,args)=>{const envelope=await invoke(shard,method,args);if(!envelope.ok)throw Object.assign(new Error(envelope.error.message),envelope.error);return envelope.result;};
 facade.admit=async input=>call(await remoteShard(crypto,input?.remote),'admit',[input]);
 facade.create=async(input,context={})=>{
  const metadata=!!directory?.isMetadataId(input?.clientId),{origin,remote}=context??{};let client;
  if(typeof remote==='string'&&remote)await facade.admit({clientId:input?.clientId,remote});else if(metadata)fail('temporarily_unavailable','Application sign-in is not available.');
  // Metadata clients: the caller's and the client host's budgets are charged before the front resolves the document;
  // the shard receives only the validated snapshot.
  if(metadata){const hostShard=entryShard(await digest(crypto,`entry-client-host\0${clientSite(new URL(input.clientId).hostname)}`));await call(hostShard,'admitHost',[{clientId:input.clientId}]);try{client=await directory.resolve(input.clientId);}catch(error){if(error?.code==='rate_limited')throw error;fail('invalid_request','The authorization entry could not be created.');}}
  return call(String(crypto.getRandomValues(new Uint8Array(1))[0]%ENTRY_SHARDS).padStart(2,'0'),'create',[input,{origin,remote,admitted:true,...client?{client}:{}}]);};
 facade.documentPolicy=async(entryId,mode)=>{let shard;try{shard=entryShard(entryId);}catch{return 'same-origin';}return call(shard,'documentPolicy',[entryId,mode]);};
 for(const method of ENTRY_METHODS)facade[method]??=async(entryId,...args)=>call(entryShard(entryId),method,[entryId,...args]);
 return facade;
}
/** Alarm step shared by adapters: prune expired rows, then say when to run again (or null when nothing is left). */
export async function federationEntriesCleanup(entries,now=Date.now(),shard){const result=await entries.cleanup(shard===undefined?{}:{shard});return result.remaining?now+60000:result.pending?now+600000:null;}

/** Requests are targeted by the discovered handle; every later opaque locator
 * carries its account shard prefix. Prefixes are validated before instantiation. */
export function federationAuthority({config,repository,shard,clock=()=>Date.now(),directory}){
 const issuer=config.APP_ORIGIN,clients=federationClients(config),objectURLs=objectURLAuthority({issuer,secret:config.KEY_ENCRYPTION_KEY}),nonces=federationDpopSecret(config)?dpopNonces({secret:federationDpopSecret(config),clock}):null;
 const routedOrDenied=async id=>{try{return await controllerFor(id);}catch{fail('unauthorized','The embedded session is unavailable.');}};
 const objectController=async(url,operation)=>{const claims=await objectURLs.verify(url,operation);const current=await repository.get(claims.owner);if(!current||current.status!=='active')fail('unauthorized','This object URL is no longer active.');return {claims,controller:shard(claims.owner)};};
 const controllerFor=async id=>{const match=typeof id==='string'&&routed.exec(id);if(!match)fail('invalid_request','Invalid provider authorization identifier.');const current=await repository.get(match[1]);if(!current||current.status!=='active')fail('unauthorized','Application authorization is unavailable.');return shard(match[1]);};
 const metadataClient=id=>!!directory?.isMetadataId(id),allowed=async id=>{if(metadataClient(id))await directory.assertAllowed(id);};
 return {clients,directory,
  ready:()=>config.FEDERATION_ENABLED==='true'&&(clients.length>0||!!directory?.enabled),
  manifest:()=>({version:'0',issuer,authorization_endpoint:`${issuer}/oauth/authorize`,authorization_request_endpoint:`${issuer}/api/oauth/requests`,token_endpoint:`${issuer}/oauth/token`,rpc_endpoint:`${issuer}/bindle/rpc`,jwks_uri:`${issuer}/oauth/jwks`,preferences_contract:PREFERENCES,grant_types_supported:config.FEDERATION_REFRESH_ENABLED==='false'?['authorization_code']:['authorization_code','refresh_token'],login_presentation:['redirect'],revocation_endpoint:`${issuer}/oauth/revoke`,...nonces?{dpop_signing_alg_values_supported:['ES256']}:{},contracts:[],...directory?.enabled?{features:{[CLIENT_METADATA_FEATURE]:{}}}:{}}),
  async beginAuthorization(input){if(!input||typeof input.identity!=='string'||input.identity.length>320)fail('invalid_request','The discovered identity handle is required.');const parts=input.identity.split('@'),host=new URL(issuer).host;if(parts.length!==2||parts[1].toLowerCase()!==host)fail('invalid_request','The identity must belong to this provider.');let handle;try{handle=normalizeHandle(parts[0]);}catch{fail('invalid_request','Invalid identity handle.');}const current=await repository.findByHandle(handle);if(!current||current.status!=='active')fail('invalid_request','This identity cannot authorize an application.');const {identity,...request}=input;
   // Resolved here, never taken from the caller: the owner shard receives a validated snapshot as a separate argument.
   if(metadataClient(request.clientId))return shard(current.id).beginAuthorization(request,{client:await directory.resolve(request.clientId)});
   return shard(current.id).beginAuthorization(request);},
  inspect:async(context,id)=>(await controllerFor(id)).inspect(context,id),
  async configure(context,input){const owner=typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'';if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).configure(context,input);},
  async grants(context){const owner=typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'';if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).grants(context);},
  async preferences(context){const owner=typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'';if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).preferences(context);},
  revoke:async(context,id)=>(await controllerFor(id)).revoke(context,id),exchange:async input=>{await allowed(input?.clientId);return (await controllerFor(input.code)).exchange(input);},tokenClient:async token=>(await controllerFor(token)).tokenClient(token),rpc:async(token,envelope,transport)=>(await controllerFor(token)).rpc(token,envelope,transport),
  refresh:async input=>{await allowed(input?.clientId);return (await controllerFor(input.refreshToken)).refresh(input);},
  approve:async(context,input,options)=>(await controllerFor(input.requestId)).approve(context,input,options),
  async entryIdentity(context,owner){if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).entryIdentity(context);},
  beginEntryAuthorization:async(context,input,options)=>(await controllerFor(input.requestId)).beginEntryAuthorization(context,input,options),
  // RFC 7009: malformed, unroutable or inactive-account tokens are a silent success.
  async revokeToken(input){if(!clients.some(c=>c.id===input?.clientId)&&!metadataClient(input?.clientId))fail('invalid_client','Unregistered application.');let controller;try{controller=await controllerFor(input.token);}catch{return {};}try{return await controller.revokeToken(input);}catch(error){if(error.code==='invalid_client')throw error;return {};}},
  redeemClaim:async input=>(await routedOrDenied(input.claim)).redeemClaim(input),embedSession:async input=>(await routedOrDenied(input.credential)).embedSession(input),embedState:async input=>(await routedOrDenied(input.session)).embedState(input),embedForget:async input=>(await routedOrDenied(input.credential)).embedForget(input),
  embedAvatar:async input=>(await routedOrDenied(input.session)).embedAvatar(input),embedEvents:async input=>(await routedOrDenied(input.session)).embedEvents(input),embedEventsTick:async input=>(await routedOrDenied(input.session)).embedEventsTick(input),
  // Ending is state-reducing and answers identically for unknown, unroutable or inactive sessions.
  async embedEnd(input){let controller;try{controller=await controllerFor(input?.session);}catch{return {};}try{return await controller.embedEnd(input);}catch{return {};}},
  async dpopNonce(purpose){if(!nonces||!['token','embed'].includes(purpose))fail('temporarily_unavailable','DPoP is not configured.');return nonces.issue(purpose);},
  async inspectObjectURL(url,operation){const {claims,controller}=await objectController(url,operation);return controller.inspectObjectURL(claims);},
  async objectURL(url,operation,args){const {claims,controller}=await objectController(url,operation);return controller.objectURL({...claims,args});}
 };
}
