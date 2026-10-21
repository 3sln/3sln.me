import {onboardingPort,onboardingKeyReady} from '../../packages/identity/onboarding.mjs';
import {AdminService} from '../../packages/identity/admin.mjs';
import {bootConfigured} from '../../packages/identity/boot.mjs';
import {remoteAdminStore} from '../../packages/identity/admin-store.mjs';
import {IdentityService} from '../../packages/identity/service.mjs';
import {workerActivePopulation} from './active-population.mjs';
import {systemBootstrapPort} from '../../packages/identity/system-bootstrap.mjs';
import {paidSignupEnabled,setupBillingPort} from '../../packages/billing/signup.mjs';
import {workerCatalogPort} from './plan-catalog.mjs';
export {PlanCatalogObject} from './plan-catalog.mjs';
import {identityBackupPort} from '../../packages/runtime/identity-backup.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import application from '../../packages/runtime/http.mjs';
import { mailTransport } from './email.mjs';
import { createPushTransport } from '../../packages/messaging/web-push.mjs';
import { createIdentityEngine, createWebAuthnAdapter, MemoryLinkedLimits } from '../../packages/identity/index.mjs';
// Linked approval poll intervals live in this isolate's non-durable limiter (architecture §9).
const linkedPollLimits=new MemoryLinkedLimits();
// Device grant (LA3): token-endpoint DPoP jti claims are isolate-scoped (non-durable, spec §6.1).
const deviceJti=new MemoryJtiCache();
import { createWorkerArgon2Hasher } from './password.mjs';
import { IdentityDirectory, AccountObject, AbuseGuard, AdminAuthority } from './objects.mjs';
export { IdentityDirectory, AccountObject, AbuseGuard, AdminAuthority };
export {SemanticBudgetObject} from './semantic-budget.mjs';
export {McpAuthorizationObject} from './mcp-object.mjs';
import {mcpAuthorities} from '../../packages/mcp/runtime.mjs';
import {MCP_LAYOUT} from '../../packages/mcp/service.mjs';
import {federationAuthority,federationEntriesRemote,BROKERING_STORE,FEDERATION_LAYOUT,federationClientDirectory,clientMetadataEnabled} from '../../packages/runtime/federation.mjs';
import {createWorkerClientMetadataFetch} from './client-metadata-fetch.mjs';
import {adminClientBlocked} from '../../packages/identity/admin.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
import {FederationObject as FederationBase} from './federation.mjs';
import {deviceGrantMountable,deviceGrantRunner,engineLinkedPort,localDeviceGrant,remoteDeviceGrant,deviceLimits,MemoryJtiCache} from '../../packages/runtime/device-grant.mjs';
import {attachAppSessions} from '../../packages/federation/device-authorization.mjs';
import {UUID_V4} from '../../packages/core/primitives.mjs';
export {LifecycleScheduler} from './lifecycle.mjs';
import {LIFECYCLE_SCHEDULER_NAME} from './lifecycle.mjs';
import {lifecycleMode} from '../../packages/runtime/lifecycle-runner.mjs';
import {entryStoreName} from './federation.mjs';

// Workers Assets canonicalizes .html URLs; retain the authenticated snapshot's
// public URL while following only this exact same-origin internal canonicalization.
function assetResource(binding){return {async fetch(request){
 const response=await binding.fetch(request),url=new URL(request.url);
 if(!['GET','HEAD'].includes(request.method)||url.search||!(['/authorize.html','/console.html','/index.es.html','/artefacts/contracts/index.html','/embed/shell.html'].includes(url.pathname)||/^\/assets\/offline-(?:index|console|landing-(?:en|es))\.[a-f0-9]{20}\.html$/.test(url.pathname))||![307,308].includes(response.status))return response;
 const location=response.headers.get('Location');if(!location)return new Response('Asset unavailable',{status:502});
 const canonical=new URL(location,url);
 const expected=url.pathname==='/artefacts/contracts/index.html'?'/artefacts/contracts/':url.pathname.slice(0,-5);
 if(canonical.origin!==url.origin||canonical.username||canonical.password||canonical.search||canonical.hash||canonical.pathname!==expected)return new Response('Asset unavailable',{status:502});
 const terminal=await binding.fetch(new Request(canonical,request));
 return terminal.status===200&&terminal.headers.get('Content-Type')?.includes('text/html')?terminal:new Response('Asset unavailable',{status:502});
}};}

// client-id-metadata.v1 resolution is isolate-scoped so its document and block caches outlive one request; budgets
// use the fleet-wide ABUSE objects and blocks the admin authority. Off unless CLIENT_METADATA_ENABLED=true.
let clientDirectory,clientDirectoryEnv;
function workerClientDirectory(env,limiter){
 if(clientDirectoryEnv===env&&clientDirectory)return clientDirectory;
 // Without the admin authority there is no block list, so the feature stays off (fails closed).
 const enabled=clientMetadataEnabled(env)&&Boolean(env.ADMIN_AUTHORITY),store=env.ADMIN_AUTHORITY?remoteAdminStore((method,args)=>env.ADMIN_AUTHORITY.get(env.ADMIN_AUTHORITY.idFromName('admin-v1')).invoke(method,args)):null;
 clientDirectory=federationClientDirectory(env,enabled?{fetch:createWorkerClientMetadataFetch({publicRouting:true}),limiter,blocked:store?host=>adminClientBlocked(store,host):undefined}:{});clientDirectoryEnv=env;return clientDirectory;
}
function resources(env,resolveIdentityBadges){
 const repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT,config:env});
 const devices=repository;
 const deviceRequests={create:r=>devices.createDevice(r),get:id=>devices.getDevice(id),findByUserCode:code=>devices.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>devices.compareAndSwapDevice(id,revision,r)};
 // Linked approval: `deviceRequests` is the `linkedApprovals` repository; guess budgets and start admission use the durable abuse windows.
 const linkedLimits={consume:(key,window)=>env.ABUSE.get(env.ABUSE.idFromName('linked-v1:'+key)).consume(window)};
 const mailer=mailTransport(env);
 const value={...env,DEVELOPER_CONTACT_POPULATION:workerActivePopulation(env),BILLING_CATALOG:workerCatalogPort(env),ASSETS:assetResource(env.ASSETS),EMAIL_AVAILABLE:Boolean(mailer),WAITLIST_MAIL_AVAILABLE:typeof mailer?.sendWaitlistConfirmation==='function',WAITLIST_MAILER:mailer,IDENTITY_REPOSITORY:repository,ACCOUNTS:{get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))},SIGNUP_STATUS_CACHE_KEY:env.ABUSE,ABUSE:{waitlist:(method,input)=>env.ABUSE.get(env.ABUSE.idFromName('signup:waitlist:v1')).waitlistAction(method,input),consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits),consumeSignup:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consumeSignup(limits),signupStatus:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).signupStatus(limits)}};
 const delivery=createPushTransport(env),pushTransport=delivery?{...delivery,async register({owner,subscription}){const result=await value.ACCOUNTS.get(owner).invoke({method:'registerSignupPush',args:[owner,{subscription}]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;}}:null;
 // Island avatar sources on operator-approved origins (EMBED_AVATAR_ORIGINS) use the global fetch, which
 // global_fetch_strictly_public keeps off private and internal addresses. Node has no equivalent guard, so it injects none.
 value.EMBED_AVATAR_FETCH=(input,init)=>fetch(input,init);
 if(env.LIFECYCLE_SCHEDULER&&lifecycleMode(env)!=='off')value.LIFECYCLE_SWEEP={run:input=>env.LIFECYCLE_SCHEDULER.get(env.LIFECYCLE_SCHEDULER.idFromName(LIFECYCLE_SCHEDULER_NAME)).run(input)};
 value.PUSH_AVAILABLE=Boolean(pushTransport);value.EMAIL_SETUP_AVAILABLE=typeof mailer?.sendSetupCode==='function';
 if(env.MCP_AUTH)value.MCP_AUTHORITY=mcpAuthorities(shard=>({invoke:(method,args)=>env.MCP_AUTH.get(env.MCP_AUTH.idFromName(`${MCP_LAYOUT}-${shard}`)).invoke(shard,method,args)}));
 // The entry store, sharded by entry ID over FederationObject instances (review M5); null unless FEDERATION_ENTRY_ENABLED.
 // packages/runtime/http.mjs always mounts the provider session-ending hook here, so end-session is offered.
 const directory=env.FEDERATION?workerClientDirectory(env,value.ABUSE):undefined;
 if(env.FEDERATION)value.FEDERATION_ENTRIES=federationEntriesRemote({config:env,endSession:true,directory,invoke:(shard,method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(entryStoreName(shard))).entries(method,args,shard)});
 if(env.FEDERATION&&env.BROKERING_ENABLED==='true')value.FEDERATION_BROKERING={enabled:true,jwks:()=>env.FEDERATION.get(env.FEDERATION.idFromName(BROKERING_STORE)).brokeringJwks()};
 // Device grant (LA3): mounted, and so declared, only with the flag and every dependency of the declared members.
 const deviceMounted=Boolean(env.FEDERATION)&&deviceGrantMountable(env);
 if(env.FEDERATION)value.FEDERATION_AUTHORITY=federationAuthority({config:env,repository,directory,manifestMounts:{deviceAuthorization:deviceMounted},shard:owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)})});
 if(deviceMounted){
  const remote=async(owner,method,args)=>{const envelope=await env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).device(method,args,owner);if(!envelope.ok)throw Object.assign(new Error(envelope.error.message),envelope.error);return envelope.result;};
  value.DEVICE_GRANT=deviceGrantRunner({config:env,deviceGrant:remoteDeviceGrant({config:env,linked:engineLinkedPort(()=>value.IDENTITY_ENGINE()),limits:deviceLimits(value.ABUSE),pollLimits:linkedPollLimits,jti:deviceJti,remote,active:async owner=>(await repository.get(owner))?.status==='active'})});
 }
 // Administration is mounted only once boot is configured (BOOTSTRAP_TOKEN_SHA256) or the operator keeps it on
 // afterwards with ADMIN_ENABLED=true. One identity resource set serves the engine and the host administration service (docs/architecture/boot-and-admin.md).
 let identityResources,adminService;const admin=env.ADMIN_AUTHORITY&&(bootConfigured(env)||env.ADMIN_ENABLED==='true')?()=>adminService??=sharedIdentity().then(shared=>new AdminService({connectionsSeverAccount:async(owner,input)=>{const result=await value.ACCOUNTS.get(owner).invoke({method:'connectionsSeverAccount',args:[owner,input]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;},store:remoteAdminStore((method,args)=>env.ADMIN_AUTHORITY.get(env.ADMIN_AUTHORITY.idFromName('admin-v1')).invoke(method,args)),identity:new IdentityService(shared),onboarding:shared.onboarding,webauthn:shared.webauthn,passwordHasher:shared.passwordHasher,rateLimiter:shared.rateLimiter,config:env})):null;
 const sharedIdentity=()=>identityResources??=(async()=>({repository,deviceRequests,linkedApprovals:deviceRequests,linkedLimits,linkedPollLimits,crypto,mailer,pushTransport,resolveIdentityBadges,...admin?{reservedHandle:async name=>(await admin()).isReserved(name)}:{},onboarding:onboardingPort({config:env,repository,authority:value.ABUSE,...admin?{runtimeName:async(name,digest)=>(await admin()).runtimeName(name,digest),redeemName:async(name,digest)=>(await admin()).redeemName(name,digest)}:{}}),systemBootstrap:systemBootstrapPort({config:env,repository:repository,authority:value.ABUSE}),setupBilling:setupBillingPort(value.ACCOUNTS),identityBackup:identityBackupPort({config:env,accounts:value.ACCOUNTS}),paidHandleEligibility:async owner=>{const result=await value.ACCOUNTS.get(owner).invoke({method:'paidHandleEligibility',args:[owner]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result===true;},turnstile:{verify:input=>application.turnstile(value,input)},rateLimiter:{check:input=>application.rateLimit(value,input)},webauthn:await createWebAuthnAdapter(),passwordHasher:createWorkerArgon2Hasher(),config:{BADGE_DEFINITIONS:env.BADGE_DEFINITIONS,HOST_NAME_POLICY:env.HOST_NAME_POLICY,ONBOARDING_NAMES:env.ONBOARDING_NAMES,paidSignupEnabled:paidSignupEnabled(env),requireReachability:env.SIGNUP_CONTACT_REQUIRED==='true',origin:env.APP_ORIGIN,rpID:env.RP_ID,rpName:env.BRAND_NAME||'3sln.me',termsVersion:env.TERMS_VERSION,allowInsecureLocalhost:env.LOCAL_DEVELOPMENT==='true',linkedCodeKey:env.LINKED_CODE_KEY||env.KEY_ENCRYPTION_KEY||null,deviceAuthorizationEnabled:env.DEVICE_AUTHORIZATION_ENABLED==='true'}}))();
 if(admin){value.ADMIN_SERVICE=admin;value.ADMIN_CLAIMS_ENABLED=onboardingKeyReady(env);}
 value.IDENTITY_ENGINE=async()=>createIdentityEngine(await sharedIdentity());
 return value;
}
const DEVICE_METHODS=['issue','review','approve','rpc','drain'];
/** Owner shard with the device grant (LA3): every owner FederationService gets the host app-session policy and the
 * lineage port when composed, the front's owner-shard steps run here on the same provider, and the alarm drains the
 * account's lineage outbox. Without the mount this is exactly the base object. */
export class FederationObject extends FederationBase {
 deviceLinked(){return this.linkedPort??=engineLinkedPort(()=>resources(this.env).IDENTITY_ENGINE());}
 async compose(owner){const controller=await super.compose(owner);if(deviceGrantMountable(this.env))attachAppSessions(controller.service,{linked:this.deviceLinked(),config:this.env});return controller;}
 async device(method,args=[],owner){
  if(!DEVICE_METHODS.includes(method)||!deviceGrantMountable(this.env))return {ok:false,error:{code:'not_found',message:'Device authorization is not enabled.'}};
  try{
   if(!UUID_V4.test(owner))throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});
   const ready=await this.invoke('ready',[],owner);if(!ready.ok)return ready;
   const controller=await this.controllerPromise;
   if(!this.deviceGrant){const env=this.env,abuse={consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits)};const provider=localDeviceGrant({config:env,linked:this.deviceLinked(),limits:deviceLimits(abuse),pollLimits:new MemoryLinkedLimits(),shard:candidate=>{if(candidate!==owner)throw Object.assign(new Error('Sign in to the account that approved this request.'),{code:'forbidden'});return controller;}});this.deviceGrant={provider,runner:deviceGrantRunner({config:env,deviceGrant:provider})};}
   const result=method==='issue'?await this.deviceGrant.provider.issue(...args):await this.deviceGrant.runner[method](...args);
   if(method!=='drain'&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'Device sign-in could not be completed.',status:error.status,retryAfter:error.retryAfter,interval:error.interval}};}
 }
 /** Lineage drain on the owner alarm (architecture §7.4): revoke queued families, then acknowledge them; retried while
  * items remain. RPC and refresh already fail closed on the lineage, so the drain is cleanup, never the control. */
 async alarm(){
  await super.alarm();const owner=await this.storage.get('@federation-owner');if(!owner||!deviceGrantMountable(this.env))return;
  let pending=false;try{await this.device('drain',[{owner}],owner);pending=(await this.deviceLinked().outbox({owner})).length>0;}catch{pending=true;}
  if(pending&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);
 }
}
export function createWorker({resolveIdentityBadges}={}){if(resolveIdentityBadges!==undefined&&typeof resolveIdentityBadges!=='function')throw new TypeError('Badge resolver must be injected code.');return {fetch:(request,env,ctx)=>application.fetch(request,resources(env,resolveIdentityBadges),ctx),scheduled:(event,env,ctx)=>application.scheduled(event,resources(env,resolveIdentityBadges),ctx)};}
export default createWorker();
