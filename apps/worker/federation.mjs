import {workerIntegrationPorts} from './integration-ports.mjs';
import {federationIncremental,incrementalMountable,incrementalRemote,INCREMENTAL_STORE,INCREMENTAL_METHODS} from '../../packages/runtime/incremental-authorization.mjs';
import {brokeringKeys,brokeringEnabled,mintAccessToken} from '../../packages/federation/signing.mjs';
import {DurableObject} from 'cloudflare:workers';
import {FederationController,federationMetadata} from '../../packages/federation/runtime.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import {messagingAddressMounted,federationControllerOptions,federationEntries,federationAuthority,federationEntriesCleanup,ENTRY_METHODS,FEDERATION_LAYOUT} from '../../packages/runtime/federation.mjs';
import {ENTRY_SHARDS} from '../../packages/federation/authorization-entries.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
import {UUID_V4} from '../../packages/core/primitives.mjs';
export {federationMetadata,federationRemote} from '../../packages/federation/runtime.mjs';
const METHODS=['ready','manifest','beginAuthorization','inspect','approve','configure','registerResource','revoke','exchange','rpc','tokenClient','grants','preferences','refresh','cleanup','inspectObjectURL','objectURL','entryIdentity','beginEntryAuthorization','revokeToken','redeemClaim','embedSession','embedState','embedForget','embedAvatar','embedEvents','embedEventsTick','embedEnd','dpopNonce','incrementalPort','appSessions','eventDoorbellGrant','integrationSnapshot','brokeredGrantLive','integrationClientAuth'];
/** Each UUID addresses independent permanent preferences, grants and journals.
 * The UUID is a locator, never an authorization credential. Further instances, named entryStoreName(shard), hold
 * the pre-owner authorization-entry store, sharded by entry ID (review M5); the two roles never share an instance.
 * FEDERATION_ENTRIES_NAME alone is the former single global store, which only drains its expired rows. */
export const FEDERATION_ENTRIES_NAME=`${FEDERATION_LAYOUT}/authorization-entries`;
export const entryStoreName=shard=>`${FEDERATION_ENTRIES_NAME}/${shard}`;
const SHARD=/^\d{2}$/;
export class FederationObject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.env=env;this.storage=ctx.storage;}
 async invoke(method,args=[],owner){
  if(!METHODS.includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported federation operation.'}};
  try{
   if(!UUID_V4.test(owner)||this.owner&&this.owner!==owner||this.entriesPromise||this.brokering)throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});
   if(!this.controllerPromise){const persisted=await this.storage.get('@federation-owner');if(persisted&&persisted!==owner||await this.storage.get('@federation-entries')||await this.storage.get('@federation-brokering'))throw Object.assign(new Error('Invalid federation account locator.'),{code:'forbidden'});this.owner=owner;if(!persisted)await this.storage.put('@federation-owner',owner);this.controllerPromise=this.compose(owner);}
   const result=await(await this.controllerPromise)[method](...args);if(method!=='cleanup'&&!['ready','manifest'].includes(method)&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'Federation operation could not be completed.',status:error.status,retryAfter:error.retryAfter,ownerReviewUri:error.ownerReviewUri}};}
 }
 /** Provider-wide brokering keys use their own durable instance, separate from owner and entry stores. */
 async brokeringVerify(token,options){return (await this.brokeringStore()).verify(token,options);}
 async brokeringJwks(){return (await this.brokeringStore()).jwks();}
 async brokeringSign(purpose,claims){if(purpose!=='event')throw new TypeError('Unsupported signing purpose.');return (await this.brokeringStore()).sign(purpose,claims);}
 async brokeringMint(claims){return mintAccessToken(await this.brokeringStore(),claims);}
 async brokeringStore(){
  if(!brokeringEnabled(this.env)||this.owner||this.entriesPromise||this.incrementalRunner||await this.storage.get('@incremental')||await this.storage.get('@federation-owner')||await this.storage.get('@federation-entries')!==undefined)throw new Error('Brokering keys unavailable.');
  if(!await this.storage.get('@federation-brokering'))await this.storage.put('@federation-brokering',true);this.brokering??=brokeringKeys({issuer:this.env.APP_ORIGIN,secret:this.env.KEY_ENCRYPTION_KEY,metadata:federationMetadata(this.storage)});return this.brokering;
 }
 /** Pre-owner entry operations for one shard; serialized by this instance's transactional storage. */
 async entries(method,args=[],shard){
  if(!ENTRY_METHODS.includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported authorization entry operation.'}};
  try{
   if(typeof shard!=='string'||!SHARD.test(shard)||Number(shard)>=ENTRY_SHARDS||this.owner||this.brokering||await this.storage.get('@federation-owner')||await this.storage.get('@federation-brokering'))throw Object.assign(new Error('Invalid authorization entry store.'),{code:'forbidden'});
   const marker=await this.storage.get('@federation-entries');if(marker!==undefined&&marker!==shard)throw Object.assign(new Error('Invalid authorization entry store.'),{code:'forbidden'});
   if(!this.entriesPromise){if(marker===undefined)await this.storage.put('@federation-entries',shard);this.entriesPromise=Promise.resolve(this.composeEntries(shard));}
   const entries=await this.entriesPromise;if(!entries)throw Object.assign(new Error('Application sign-in is not available.'),{code:'temporarily_unavailable'});
   const result=await entries[method](...args);if(['admit','create'].includes(method)&&await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'The sign-in request could not be completed.',status:error.status,retryAfter:error.retryAfter,ownerReviewUri:error.ownerReviewUri}};}
 }
 /** The shard's entry store. The former global instance (marker `true`) composes unpinned, only to drain. */
 composeEntries(shard){
  const env=this.env,repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});
  const authority=federationAuthority({config:env,repository,shard:owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)})});
  const incremental=incrementalMountable(env)?incrementalRemote((method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(INCREMENTAL_STORE)).incremental(method,args)):null;
  // The Worker always mounts the provider session-ending hook (packages/runtime/http.mjs), so end-session is offered.
  return federationEntries({config:env,store:federationMetadata(this.storage),...typeof shard==='string'?{shard}:{},authority,endSession:true,incremental});
 }
 async incremental(method,args=[]){
  if(!incrementalMountable(this.env)||!INCREMENTAL_METHODS.includes(method)||this.owner||this.entriesPromise||this.brokering)return {ok:false,error:{code:'not_found',message:'Not found.'}};
  try{if(await this.storage.get('@federation-owner')||await this.storage.get('@federation-entries')!==undefined||await this.storage.get('@federation-brokering'))throw new Error();
   await this.storage.put('@incremental',true);const env=this.env;this.incrementalRunner??=federationIncremental({config:env,store:federationMetadata(this.storage),shard:owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)})});
   const result=await this.incrementalRunner[method](...args);if(await this.storage.getAlarm()===null)await this.storage.setAlarm(Date.now()+600000);return {ok:true,result};
  }catch(error){return {ok:false,error:{code:error.code??'temporarily_unavailable',message:error.code?error.message:'Request unavailable.',status:error.status,retryAfter:error.retryAfter,ownerReviewUri:error.ownerReviewUri}};}
 }
 async alarm(){
  if(await this.storage.get('@incremental')){const cleaned=await this.incremental('cleanup');if(!cleaned.ok)throw Object.assign(new Error(cleaned.error.message),cleaned.error);return;}
  const marker=await this.storage.get('@federation-entries');if(marker!==undefined){if(!this.entriesPromise)this.entriesPromise=Promise.resolve(this.composeEntries(marker));const entries=await this.entriesPromise;if(!entries)return;const next=await federationEntriesCleanup(entries);if(next)await this.storage.setAlarm(next);return;}
  const owner=await this.storage.get('@federation-owner');if(!owner)return;
  if(!this.controllerPromise){this.owner=owner;this.controllerPromise=this.compose(owner);}
  const result=await(await this.controllerPromise).cleanup();if(result.remaining)await this.storage.setAlarm(result.nextAlarmAt);
 }
 async compose(owner){
  const env=this.env,config={...env,...workerIntegrationPorts(env)},repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});
  const accounts={get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))};
  return new FederationController({...await federationControllerOptions({config,repository,accounts,owner,incremental:incrementalMountable(env)?incrementalRemote((method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(INCREMENTAL_STORE)).incremental(method,args)):undefined,manifestMounts:{messagingAddress:messagingAddressMounted(config)}}),metadata:federationMetadata(this.storage),routingKey:owner});
 }
}
