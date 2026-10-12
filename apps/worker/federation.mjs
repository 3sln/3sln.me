import {DurableObject} from 'cloudflare:workers';
import {FederationController,federationMetadata} from '../../packages/federation/runtime.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import {federationControllerOptions} from '../../packages/runtime/federation.mjs';
export {federationMetadata,federationRemote} from '../../packages/federation/runtime.mjs';
const METHODS=['ready','manifest','beginAuthorization','inspect','approve','configure','registerResource','revoke','exchange','rpc','tokenClient','grants','preferences','refresh','cleanup','inspectObjectURL','objectURL'];
/** Each UUID addresses independent permanent preferences, grants and journals.
 * The UUID is a locator, never an authorization credential. */
export class FederationObject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.env=env;this.storage=ctx.storage;}
 async invoke(method,args=[],owner){
  if(!METHODS.includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported federation operation.'}};
  try{
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner)||this.owner&&this.owner!==owner)throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});
   if(!this.controllerPromise){const persisted=await this.storage.get('@federation-owner');if(persisted&&persisted!==owner)throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});this.owner=owner;if(!persisted)await this.storage.put('@federation-owner',owner);this.controllerPromise=this.compose(owner);}
   const result=await(await this.controllerPromise)[method](...args);if(method!=='cleanup'&&!['ready','manifest'].includes(method)&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'Federation operation could not be completed.',status:error.status,retryAfter:error.retryAfter}};}
 }
 async alarm(){
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
