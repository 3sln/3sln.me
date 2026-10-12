import {DurableObject} from 'cloudflare:workers';
import {FederationController,federationMetadata} from '../../packages/federation/runtime.mjs';
export {federationMetadata,federationRemote} from '../../packages/federation/runtime.mjs';
import {IdentityService} from '../../packages/identity/service.mjs';
/** Explicit native metadata adapter. Domain code never imports Cloudflare. */

const parsed=(value,fallback)=>{if(value===undefined||value==='')return fallback;return typeof value==='string'?JSON.parse(value):value;};
const unsupported=()=>{throw Object.assign(new Error('Unsupported authentication operation in the federation adapter.'),{code:'unsupported_method'});};
export class FederationObject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.env=env;this.storage=ctx.storage;this.controllerPromise=this.compose();}
 async invoke(method,args=[]){if(!['ready','manifest','beginAuthorization','inspect','approve','configure','registerResource','revoke','exchange','rpc','tokenClient'].includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported federation operation.'}};try{return {ok:true,result:await(await this.controllerPromise)[method](...args)};}catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'Federation operation could not be completed.'}};}}
 async compose(){
  const env=this.env,issuer=env.APP_ORIGIN;
  // Only .authorized() is exposed here. Credential enrollment/login remain in
  // the actual shared IdentityService and are never replaced by stubs.
  const repository=env.IDENTITY_REPOSITORY??env.IDENTITIES.get(env.IDENTITIES.idFromName('directory-v1'));
  const identity=new IdentityService({repository,crypto,turnstile:{verify:unsupported},rateLimiter:{check:unsupported},webauthn:{verifyRegistration:unsupported,verifyAuthentication:unsupported},passwordHasher:{hash:unsupported,verify:unsupported},config:{origin:issuer,rpID:env.RP_ID??new URL(issuer).hostname,termsVersion:env.TERMS_VERSION??'2026-10-11',allowInsecureLocalhost:env.LOCAL_DEVELOPMENT==='true'}});
  const schemas=parsed(env.FEDERATION_SCHEMAS,{}),clients=parsed(env.FEDERATION_CLIENTS,[]);
  const dispatcher=env.FEDERATION_DISPATCHER??(env.FEDERATION_DISPATCHER_MODE==='account-journal-v1'?{durableJournal:true,execute:ctx=>{const id=new URL(ctx.subject).pathname.split('/').at(-1);return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id)).federationRPC({subject:ctx.subject,clientId:ctx.clientId,resource:ctx.resource,contract:ctx.contract,method:ctx.method,args:ctx.args,tx:ctx.tx});}}:undefined);
  return new FederationController({metadata:federationMetadata(this.storage),issuer,clients,crypto,allowInsecureLocalhost:env.LOCAL_DEVELOPMENT==='true',enabled:env.FEDERATION_ENABLED==='true',schemaHosts:parsed(env.FEDERATION_SCHEMA_HOSTS,Object.keys(schemas).map(url=>new URL(url).host)),schemaFetcher:async url=>{if(!Object.hasOwn(schemas,url))throw Object.assign(new Error('Fragment is not in the operator-reviewed immutable registry.'),{code:'untrusted_schema_host'});return structuredClone(schemas[url]);},auth:{owner:async(context,{mutation})=>{const {account}=await identity.authorized(context,mutation);return {subject:`${issuer}/entities/${account.id}`};}},dispatcher});
 }
}
for(const method of Object.getOwnPropertyNames(FederationController.prototype))if(method!=='constructor'&&!['dispatch','authority'].includes(method))Object.defineProperty(FederationObject.prototype,method,{value:async function(...args){return(await this.controllerPromise)[method](...args);},writable:true,configurable:true});
