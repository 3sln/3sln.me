import {APP_NOTIFICATIONS} from '../federation/app-notifications.mjs';
import {RESOURCE_SCOPING,storageScopeOptions} from '../storage/scoping.mjs';
import {IdentityService} from '../identity/service.mjs';
import {normalizeHandle} from '../identity/handles.mjs';
import {digest} from '../messaging/store.mjs';
import {PROFILE,PREFERENCES} from '../federation/service.mjs';
import {objectURLAuthority} from '../storage/object-urls.mjs';
import {encryptSecret,decryptSecret} from './secrets.mjs';

export const FEDERATION_LAYOUT='bindle-federation-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const routed=/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function federationConfig(value,fallback){if(value===undefined||value==='')return structuredClone(fallback);return typeof value==='string'?JSON.parse(value):structuredClone(value);}
export function federationClients(config){const clients=federationConfig(config.FEDERATION_CLIENTS,[]);if(!Array.isArray(clients)||clients.length>100)throw new TypeError('At most 100 reviewed federation clients can be configured.');for(const client of clients){if(typeof client?.id!=='string'||client.id.length>200||typeof client.name!=='string'||!client.name.trim()||client.name.length>100)throw new TypeError('Reviewed clients require a URL ID of at most 200 characters and name of at most 100 characters.');}return clients;}
export function federationAccount(accounts,owner){const native=accounts.get(owner);return new Proxy({}, {get:(_,method)=>async(...args)=>{const result=await native.invoke({method,args});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;}});}
export async function federationEpoch(account){return digest(crypto,`bindle-account-authority-v1\0${account.assignmentId??account.id}\0${account.recoveryHash??''}`);}
const unsupported=()=>{throw Object.assign(new Error('Credential operations use the identity service.'),{code:'unsupported_method'});};

/** Domain capabilities are injected identically by Workers and Node. Owner
 * state has no fleet-wide lock; routing identifiers never grant authority. */
export function federationControllerOptions({config,repository,accounts,owner}){
 if(!UUID.test(owner))throw new TypeError('A stable UUID identity is required.');
 const issuer=config.APP_ORIGIN,subject=`${issuer}/entities/${owner}`,schemas=federationConfig(config.FEDERATION_SCHEMAS,{});
 if(!schemas||Array.isArray(schemas)||typeof schemas!=='object'||Object.keys(schemas).length>100)throw new TypeError('Invalid reviewed fragment registry.');
 const identity=new IdentityService({repository,crypto,turnstile:{verify:unsupported},rateLimiter:{check:unsupported},webauthn:{verifyRegistration:unsupported,verifyAuthentication:unsupported},passwordHasher:{hash:unsupported,verify:unsupported},config:{origin:issuer,rpID:config.RP_ID??new URL(issuer).hostname,termsVersion:config.TERMS_VERSION??'2026-10-11',allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true'}});
 const account=federationAccount(accounts,owner);
 const validateSubject=async(candidate,epoch)=>{if(candidate!==subject)return false;const current=await repository.get(owner);return current?.status==='active'&&await federationEpoch(current)===epoch;};
 return {issuer,clients:federationClients(config),routingKey:owner,crypto,objectURLs:{...objectURLAuthority({issuer,secret:config.KEY_ENCRYPTION_KEY}),seal:value=>encryptSecret(value,config.KEY_ENCRYPTION_KEY),open:record=>decryptSecret(record,config.KEY_ENCRYPTION_KEY)},enabled:config.FEDERATION_ENABLED==='true',refreshEnabled:config.FEDERATION_REFRESH_ENABLED!=='false',allowInsecureLocalhost:config.LOCAL_DEVELOPMENT==='true',
  schemaHosts:Object.keys(schemas).map(url=>new URL(url).host),schemaFetcher:async url=>{if(!Object.hasOwn(schemas,url))fail('untrusted_schema_host','This fragment has not been registered with this provider.');return structuredClone(schemas[url]);},
  auth:{owner:async(context,{mutation})=>{const {account:current}=await identity.authorized(context,mutation);if(current.id!==owner)fail('forbidden','Sign in to the identity requested by this application.');return {subject,epoch:await federationEpoch(current)};}},validateSubject,
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

/** Requests are targeted by the discovered handle; every later opaque locator
 * carries its account shard prefix. Prefixes are validated before instantiation. */
export function federationAuthority({config,repository,shard}){
 const issuer=config.APP_ORIGIN,clients=federationClients(config),objectURLs=objectURLAuthority({issuer,secret:config.KEY_ENCRYPTION_KEY});
 const objectController=async(url,operation)=>{const claims=await objectURLs.verify(url,operation);const current=await repository.get(claims.owner);if(!current||current.status!=='active')fail('unauthorized','This object URL is no longer active.');return {claims,controller:shard(claims.owner)};};
 const controllerFor=async id=>{const match=typeof id==='string'&&routed.exec(id);if(!match)fail('invalid_request','Invalid provider authorization identifier.');const current=await repository.get(match[1]);if(!current||current.status!=='active')fail('unauthorized','Application authorization is unavailable.');return shard(match[1]);};
 return {clients,
  ready:()=>config.FEDERATION_ENABLED==='true'&&clients.length>0,
  manifest:()=>({version:'0',issuer,authorization_endpoint:`${issuer}/oauth/authorize`,authorization_request_endpoint:`${issuer}/api/oauth/requests`,token_endpoint:`${issuer}/oauth/token`,rpc_endpoint:`${issuer}/bindle/rpc`,jwks_uri:`${issuer}/oauth/jwks`,preferences_contract:PREFERENCES,grant_types_supported:config.FEDERATION_REFRESH_ENABLED==='false'?['authorization_code']:['authorization_code','refresh_token'],login_presentation:['redirect'],contracts:[]}),
  async beginAuthorization(input){if(!input||typeof input.identity!=='string'||input.identity.length>320)fail('invalid_request','The discovered identity handle is required.');const parts=input.identity.split('@'),host=new URL(issuer).host;if(parts.length!==2||parts[1].toLowerCase()!==host)fail('invalid_request','The identity must belong to this provider.');let handle;try{handle=normalizeHandle(parts[0]);}catch{fail('invalid_request','Invalid identity handle.');}const current=await repository.findByHandle(handle);if(!current||current.status!=='active')fail('invalid_request','This identity cannot authorize an application.');const {identity,...request}=input;return shard(current.id).beginAuthorization(request);},
  inspect:async(context,id)=>(await controllerFor(id)).inspect(context,id),approve:async(context,input)=>(await controllerFor(input.requestId)).approve(context,input),
  async configure(context,input){const owner=typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'';if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).configure(context,input);},
  async grants(context){const owner=typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'';if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).grants(context);},
  async preferences(context){const owner=typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'';if(!UUID.test(owner))fail('unauthorized','Sign in to continue.');const current=await repository.get(owner);if(!current||current.status!=='active')fail('unauthorized','Sign in to continue.');return shard(owner).preferences(context);},
  revoke:async(context,id)=>(await controllerFor(id)).revoke(context,id),exchange:async input=>(await controllerFor(input.code)).exchange(input),tokenClient:async token=>(await controllerFor(token)).tokenClient(token),rpc:async(token,envelope,transport)=>(await controllerFor(token)).rpc(token,envelope,transport),
  refresh:async input=>(await controllerFor(input.refreshToken)).refresh(input),
  async inspectObjectURL(url,operation){const {claims,controller}=await objectController(url,operation);return controller.inspectObjectURL(claims);},
  async objectURL(url,operation,args){const {claims,controller}=await objectController(url,operation);return controller.objectURL({...claims,args});}
 };
}
