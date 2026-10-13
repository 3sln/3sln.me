import {workerCatalogPort} from './plan-catalog.mjs';
export {PlanCatalogObject} from './plan-catalog.mjs';
import {identityBackupPort} from '../../packages/runtime/identity-backup.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import application from '../../packages/runtime/http.mjs';
import { mailTransport } from './email.mjs';
import { createPushTransport } from '../../packages/messaging/web-push.mjs';
import { createIdentityEngine, createWebAuthnAdapter } from '../../packages/identity/index.mjs';
import { createWorkerArgon2Hasher } from './password.mjs';
import { IdentityDirectory, AccountObject, AbuseGuard } from './objects.mjs';
export { IdentityDirectory, AccountObject, AbuseGuard };
export {SemanticBudgetObject} from './semantic-budget.mjs';
export {McpAuthorizationObject} from './mcp-object.mjs';
import {mcpAuthorities} from '../../packages/mcp/runtime.mjs';
import {MCP_LAYOUT} from '../../packages/mcp/service.mjs';
import {federationAuthority,FEDERATION_LAYOUT} from '../../packages/runtime/federation.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
export {FederationObject} from './federation.mjs';

// Workers Assets canonicalizes .html URLs; retain the authenticated snapshot's
// public URL while following only this exact same-origin internal canonicalization.
function assetResource(binding){return {async fetch(request){
 const response=await binding.fetch(request),url=new URL(request.url);
 if(!['GET','HEAD'].includes(request.method)||url.search||!(url.pathname==='/authorize.html'||/^\/assets\/offline-index\.[a-f0-9]{20}\.html$/.test(url.pathname))||![307,308].includes(response.status))return response;
 const location=response.headers.get('Location');if(!location)return new Response('Asset unavailable',{status:502});
 const canonical=new URL(location,url);
 if(canonical.origin!==url.origin||canonical.username||canonical.password||canonical.search||canonical.hash||canonical.pathname!==url.pathname.slice(0,-5))return new Response('Asset unavailable',{status:502});
 const terminal=await binding.fetch(new Request(canonical,request));
 return terminal.status===200&&terminal.headers.get('Content-Type')?.includes('text/html')?terminal:new Response('Asset unavailable',{status:502});
}};}

function resources(env){
 const repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});
 const devices=repository;
 const deviceRequests={create:r=>devices.createDevice(r),get:id=>devices.getDevice(id),findByUserCode:code=>devices.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>devices.compareAndSwapDevice(id,revision,r)};
 const mailer=mailTransport(env);
 const value={...env,BILLING_CATALOG:workerCatalogPort(env),ASSETS:assetResource(env.ASSETS),EMAIL_AVAILABLE:Boolean(mailer),IDENTITY_REPOSITORY:repository,ACCOUNTS:{get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))},ABUSE:{consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits)}};
 const delivery=createPushTransport(env),pushTransport=delivery?{...delivery,async register({owner,subscription}){const result=await value.ACCOUNTS.get(owner).invoke({method:'registerSignupPush',args:[owner,{subscription}]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;}}:null;
 value.PUSH_AVAILABLE=Boolean(pushTransport);value.EMAIL_SETUP_AVAILABLE=typeof mailer?.sendSetupCode==='function';
 if(env.MCP_AUTH)value.MCP_AUTHORITY=mcpAuthorities(shard=>({invoke:(method,args)=>env.MCP_AUTH.get(env.MCP_AUTH.idFromName(`${MCP_LAYOUT}-${shard}`)).invoke(shard,method,args)}));
 if(env.FEDERATION)value.FEDERATION_AUTHORITY=federationAuthority({config:env,repository,shard:owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)})});
 value.IDENTITY_ENGINE=async()=>createIdentityEngine({repository,deviceRequests,crypto,mailer,pushTransport,identityBackup:identityBackupPort({config:env,accounts:value.ACCOUNTS}),paidHandleEligibility:async owner=>{const result=await value.ACCOUNTS.get(owner).invoke({method:'paidHandleEligibility',args:[owner]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result===true;},turnstile:{verify:input=>application.turnstile(value,input)},rateLimiter:{check:input=>application.rateLimit(value,input)},webauthn:await createWebAuthnAdapter(),passwordHasher:createWorkerArgon2Hasher(),config:{requireReachability:env.SIGNUP_CONTACT_REQUIRED==='true',origin:env.APP_ORIGIN,rpID:env.RP_ID,rpName:env.BRAND_NAME||'3sln.me',termsVersion:env.TERMS_VERSION,allowInsecureLocalhost:env.LOCAL_DEVELOPMENT==='true'}});
 return value;
}
export default {
 fetch:(request,env,ctx)=>application.fetch(request,resources(env),ctx),
 scheduled:(event,env,ctx)=>application.scheduled(event,resources(env),ctx)
};
