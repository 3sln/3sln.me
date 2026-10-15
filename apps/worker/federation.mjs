import {DurableObject} from 'cloudflare:workers';
import {FederationController,federationMetadata} from '../../packages/federation/runtime.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import {federationControllerOptions,federationEntries,federationAuthority,federationEntriesCleanup,ENTRY_METHODS,FEDERATION_LAYOUT} from '../../packages/runtime/federation.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
export {federationMetadata,federationRemote} from '../../packages/federation/runtime.mjs';
const METHODS=['ready','manifest','beginAuthorization','inspect','approve','configure','registerResource','revoke','exchange','rpc','tokenClient','grants','preferences','refresh','cleanup','inspectObjectURL','objectURL','entryIdentity','beginEntryAuthorization','revokeToken','redeemClaim','embedSession','embedState','embedForget','embedAvatar','embedEvents','embedEventsTick','embedEnd','dpopNonce'];
/** Each UUID addresses independent permanent preferences, grants and journals.
 * The UUID is a locator, never an authorization credential. One further instance, named FEDERATION_ENTRIES_NAME,
 * holds the deployment's single pre-owner authorization-entry store; the two roles never share an instance. */
export const FEDERATION_ENTRIES_NAME=`${FEDERATION_LAYOUT}/authorization-entries`;
export class FederationObject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.env=env;this.storage=ctx.storage;}
 async invoke(method,args=[],owner){
  if(!METHODS.includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported federation operation.'}};
  try{
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner)||this.owner&&this.owner!==owner||this.entriesPromise)throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});
   if(!this.controllerPromise){const persisted=await this.storage.get('@federation-owner');if(persisted&&persisted!==owner||await this.storage.get('@federation-entries'))throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});this.owner=owner;if(!persisted)await this.storage.put('@federation-owner',owner);this.controllerPromise=this.compose(owner);}
   const result=await(await this.controllerPromise)[method](...args);if(method!=='cleanup'&&!['ready','manifest'].includes(method)&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'Federation operation could not be completed.',status:error.status,retryAfter:error.retryAfter}};}
 }
 /** Pre-owner entry operations; serialized by this single instance's transactional storage. */
 async entries(method,args=[]){
  if(!ENTRY_METHODS.includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported authorization entry operation.'}};
  try{
   if(this.owner||await this.storage.get('@federation-owner'))throw Object.assign(new Error('Invalid authorization entry store.'),{code:'forbidden'});
   if(!this.entriesPromise){if(!await this.storage.get('@federation-entries'))await this.storage.put('@federation-entries',true);this.entriesPromise=Promise.resolve(this.composeEntries());}
   const entries=await this.entriesPromise;if(!entries)throw Object.assign(new Error('Application sign-in is not available.'),{code:'temporarily_unavailable'});
   const result=await entries[method](...args);if(method==='create'&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'The sign-in request could not be completed.',status:error.status,retryAfter:error.retryAfter}};}
 }
 composeEntries(){
  const env=this.env,repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});
  const authority=federationAuthority({config:env,repository,shard:owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)})});
  // End-session has no Worker session-ending hook yet; the facade never offers it.
  return federationEntries({config:{...env,FEDERATION_END_SESSION_ENABLED:'false'},store:federationMetadata(this.storage),authority});
 }
 async alarm(){
  if(await this.storage.get('@federation-entries')){if(!this.entriesPromise)this.entriesPromise=Promise.resolve(this.composeEntries());const entries=await this.entriesPromise;if(!entries)return;const next=await federationEntriesCleanup(entries);if(next)await this.storage.setAlarm(next);return;}
  const owner=await this.storage.get('@federation-owner');if(!owner)return;
  if(!this.controllerPromise){this.owner=owner;this.controllerPromise=this.compose(owner);}
  const result=await(await this.controllerPromise).cleanup();if(result.remaining)await this.storage.setAlarm(result.nextAlarmAt);
 }
 async compose(owner){
  const env=this.env,repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});
  const accounts={get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))};
  return new FederationController({...await federationControllerOptions({config:env,repository,accounts,owner}),metadata:federationMetadata(this.storage),routingKey:owner});
 }
}
