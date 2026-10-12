import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import application from '../../packages/runtime/http.mjs';
import { mailTransport } from './email.mjs';
import { createIdentityEngine, createWebAuthnAdapter } from '../../packages/identity/index.mjs';
import { createWorkerArgon2Hasher } from './password.mjs';
import { IdentityDirectory, AccountObject, AbuseGuard } from './objects.mjs';
export { IdentityDirectory, AccountObject, AbuseGuard };
export {SemanticBudgetObject} from './semantic-budget.mjs';
export {McpAuthorizationObject} from './mcp-object.mjs';
import {mcpAuthorities} from '../../packages/mcp/runtime.mjs';
import {MCP_LAYOUT} from '../../packages/mcp/service.mjs';

function resources(env){
 const repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});
 const devices=repository;
 const deviceRequests={create:r=>devices.createDevice(r),get:id=>devices.getDevice(id),findByUserCode:code=>devices.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>devices.compareAndSwapDevice(id,revision,r)};
 const mailer=mailTransport(env);
 const value={...env,EMAIL_AVAILABLE:Boolean(mailer),IDENTITY_REPOSITORY:repository,ACCOUNTS:{get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))},ABUSE:{consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits)}};
 if(env.MCP_AUTH)value.MCP_AUTHORITY=mcpAuthorities(shard=>({invoke:(method,args)=>env.MCP_AUTH.get(env.MCP_AUTH.idFromName(`${MCP_LAYOUT}-${shard}`)).invoke(shard,method,args)}));
 value.IDENTITY_ENGINE=async()=>createIdentityEngine({repository,deviceRequests,crypto,mailer,turnstile:{verify:input=>application.turnstile(value,input)},rateLimiter:{check:input=>application.rateLimit(value,input)},webauthn:await createWebAuthnAdapter(),passwordHasher:createWorkerArgon2Hasher(),config:{origin:env.APP_ORIGIN,rpID:env.RP_ID,rpName:env.BRAND_NAME||'3sln.me',termsVersion:env.TERMS_VERSION,allowInsecureLocalhost:env.LOCAL_DEVELOPMENT==='true'}});
 return value;
}
export default {
 fetch:(request,env,ctx)=>application.fetch(request,resources(env),ctx),
 scheduled:(event,env,ctx)=>application.scheduled(event,resources(env),ctx)
};
