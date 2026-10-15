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
import { createIdentityEngine, createWebAuthnAdapter } from '../../packages/identity/index.mjs';
import { createWorkerArgon2Hasher } from './password.mjs';
import { IdentityDirectory, AccountObject, AbuseGuard, AdminAuthority } from './objects.mjs';
export { IdentityDirectory, AccountObject, AbuseGuard, AdminAuthority };
export {SemanticBudgetObject} from './semantic-budget.mjs';
export {McpAuthorizationObject} from './mcp-object.mjs';
import {mcpAuthorities} from '../../packages/mcp/runtime.mjs';
import {MCP_LAYOUT} from '../../packages/mcp/service.mjs';
import {federationAuthority,federationEntriesRemote,FEDERATION_LAYOUT} from '../../packages/runtime/federation.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
export {FederationObject} from './federation.mjs';
import {FEDERATION_ENTRIES_NAME} from './federation.mjs';

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

function resources(env,resolveIdentityBadges){
 const repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT,config:env});
 const devices=repository;
 const deviceRequests={create:r=>devices.createDevice(r),get:id=>devices.getDevice(id),findByUserCode:code=>devices.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>devices.compareAndSwapDevice(id,revision,r)};
 const mailer=mailTransport(env);
 const value={...env,DEVELOPER_CONTACT_POPULATION:workerActivePopulation(env),BILLING_CATALOG:workerCatalogPort(env),ASSETS:assetResource(env.ASSETS),EMAIL_AVAILABLE:Boolean(mailer),WAITLIST_MAIL_AVAILABLE:typeof mailer?.sendWaitlistConfirmation==='function',WAITLIST_MAILER:mailer,IDENTITY_REPOSITORY:repository,ACCOUNTS:{get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))},SIGNUP_STATUS_CACHE_KEY:env.ABUSE,ABUSE:{waitlist:(method,input)=>env.ABUSE.get(env.ABUSE.idFromName('signup:waitlist:v1')).waitlistAction(method,input),consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits),consumeSignup:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consumeSignup(limits),signupStatus:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).signupStatus(limits)}};
 const delivery=createPushTransport(env),pushTransport=delivery?{...delivery,async register({owner,subscription}){const result=await value.ACCOUNTS.get(owner).invoke({method:'registerSignupPush',args:[owner,{subscription}]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;}}:null;
 // Island avatar sources on operator-approved origins (EMBED_AVATAR_ORIGINS) use the global fetch, which
 // global_fetch_strictly_public keeps off private and internal addresses. Node has no equivalent guard, so it injects none.
 value.EMBED_AVATAR_FETCH=(input,init)=>fetch(input,init);
 value.PUSH_AVAILABLE=Boolean(pushTransport);value.EMAIL_SETUP_AVAILABLE=typeof mailer?.sendSetupCode==='function';
 if(env.MCP_AUTH)value.MCP_AUTHORITY=mcpAuthorities(shard=>({invoke:(method,args)=>env.MCP_AUTH.get(env.MCP_AUTH.idFromName(`${MCP_LAYOUT}-${shard}`)).invoke(shard,method,args)}));
 // One global entry store (a single FederationObject instance); null unless FEDERATION_ENTRY_ENABLED.
 if(env.FEDERATION)value.FEDERATION_ENTRIES=federationEntriesRemote({config:env,invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(FEDERATION_ENTRIES_NAME)).entries(method,args)});
 if(env.FEDERATION)value.FEDERATION_AUTHORITY=federationAuthority({config:env,repository,shard:owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)})});
 // Administration is mounted only once boot is configured (BOOTSTRAP_TOKEN_SHA256) or the operator keeps it on
 // afterwards with ADMIN_ENABLED=true. One identity resource set serves the engine and the host administration service (docs/architecture/boot-and-admin.md).
 let identityResources,adminService;const admin=env.ADMIN_AUTHORITY&&(bootConfigured(env)||env.ADMIN_ENABLED==='true')?()=>adminService??=sharedIdentity().then(shared=>new AdminService({store:remoteAdminStore((method,args)=>env.ADMIN_AUTHORITY.get(env.ADMIN_AUTHORITY.idFromName('admin-v1')).invoke(method,args)),identity:new IdentityService(shared),onboarding:shared.onboarding,webauthn:shared.webauthn,passwordHasher:shared.passwordHasher,rateLimiter:shared.rateLimiter,config:env})):null;
 const sharedIdentity=()=>identityResources??=(async()=>({repository,deviceRequests,crypto,mailer,pushTransport,resolveIdentityBadges,...admin?{reservedHandle:async name=>(await admin()).isReserved(name)}:{},onboarding:onboardingPort({config:env,repository,authority:value.ABUSE,...admin?{runtimeName:async(name,digest)=>(await admin()).runtimeName(name,digest)}:{}}),systemBootstrap:systemBootstrapPort({config:env,repository:repository,authority:value.ABUSE}),setupBilling:setupBillingPort(value.ACCOUNTS),identityBackup:identityBackupPort({config:env,accounts:value.ACCOUNTS}),paidHandleEligibility:async owner=>{const result=await value.ACCOUNTS.get(owner).invoke({method:'paidHandleEligibility',args:[owner]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result===true;},turnstile:{verify:input=>application.turnstile(value,input)},rateLimiter:{check:input=>application.rateLimit(value,input)},webauthn:await createWebAuthnAdapter(),passwordHasher:createWorkerArgon2Hasher(),config:{BADGE_DEFINITIONS:env.BADGE_DEFINITIONS,HOST_NAME_POLICY:env.HOST_NAME_POLICY,ONBOARDING_NAMES:env.ONBOARDING_NAMES,paidSignupEnabled:paidSignupEnabled(env),requireReachability:env.SIGNUP_CONTACT_REQUIRED==='true',origin:env.APP_ORIGIN,rpID:env.RP_ID,rpName:env.BRAND_NAME||'3sln.me',termsVersion:env.TERMS_VERSION,allowInsecureLocalhost:env.LOCAL_DEVELOPMENT==='true'}}))();
 if(admin){value.ADMIN_SERVICE=admin;value.ADMIN_CLAIMS_ENABLED=onboardingKeyReady(env);}
 value.IDENTITY_ENGINE=async()=>createIdentityEngine(await sharedIdentity());
 return value;
}
export function createWorker({resolveIdentityBadges}={}){if(resolveIdentityBadges!==undefined&&typeof resolveIdentityBadges!=='function')throw new TypeError('Badge resolver must be injected code.');return {fetch:(request,env,ctx)=>application.fetch(request,resources(env,resolveIdentityBadges),ctx),scheduled:(event,env,ctx)=>application.scheduled(event,resources(env,resolveIdentityBadges),ctx)};}
export default createWorker();
