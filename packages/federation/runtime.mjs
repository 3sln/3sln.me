import {FederationService} from './service.mjs';
import {fail} from './schema.mjs';
import {canonical,digest} from '../messaging/store.mjs';
const readMethods=new Set(['get','list','read','describe','capabilities','presign']);
const faultResult=(code,message,error={})=>({__federationError:{code,message,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0&&error.retryAfter<=2678400?{retryAfter:error.retryAfter}:{}}});
/** Portable composition boundary. Both hosted and self-hosted runtimes inject
 * metadata, live owner authentication and actual contract adapters here. */
export class FederationController {
  constructor({metadata,auth,issuer,clients=[],schemaFetcher,schemaHosts=[],dispatcher,crypto=globalThis.crypto,clock=()=>Date.now(),allowInsecureLocalhost=false,enabled=true,routingKey,validateSubject,resourceProvider,connections,refreshEnabled=false,objectURLs}){
    if(!metadata?.transaction||!auth?.owner)throw new TypeError('Transactional metadata and authenticated owner resource required');
    Object.assign(this,{metadata,auth,issuer,clients,dispatcher,clock,enabled,allowInsecureLocalhost});
    this.service=new FederationService({store:metadata,issuer,clients,crypto,clock,schemaFetcher,schemaHosts,allowInsecureLocalhost,routingKey,validateSubject,resourceProvider,connections,refreshEnabled,objectURLs,authenticateOwner:(authority)=>auth.owner(authority.context,{mutation:authority.mutation}),dispatchCapability:ctx=>this.dispatch(ctx,crypto)});
  }
  ready(){return this.enabled&&this.clients.length>0&&typeof this.service.schemaFetcher==='function'&&(typeof this.dispatcher==='function'||typeof this.dispatcher?.execute==='function');}
  requireReady(){if(!this.ready())fail('temporarily_unavailable','Federation is not configured and release enabled.');}
  manifest(){this.requireReady();return {version:'0',issuer:this.issuer,grant_types_supported:['authorization_code',...this.service.refreshEnabled?['refresh_token']:[]],authorization_request_endpoint:`${this.issuer}/api/oauth/requests`,preferences_contract:'https://3sln.me/artefacts/contracts/preferences/v1',authorization_endpoint:`${this.issuer}/oauth/authorize`,token_endpoint:`${this.issuer}/oauth/token`,rpc_endpoint:`${this.issuer}/bindle/rpc`,jwks_uri:`${this.issuer}/oauth/jwks`,login_presentation:['redirect'],contracts:[]};}
  authority(context,mutation){return {context,mutation};}
  beginAuthorization(input){this.requireReady();return this.service.beginAuthorization(input);}
  inspect(context,id){this.requireReady();return this.service.inspect(id,context?.sessionToken?this.authority(context,false):undefined);}
  approve(context,input){this.requireReady();return this.service.approve(this.authority(context,true),input);}
  configure(context,input){this.requireReady();return this.service.configure(this.authority(context,true),input);}
  registerResource(context,input){this.requireReady();return this.service.registerResource(this.authority(context,true),input);}
  cleanup(input){return this.service.cleanup(input);}
  preferences(context){this.requireReady();return this.service.preferences(this.authority(context,false));}
  grants(context){this.requireReady();return this.service.grants(this.authority(context,false));}
  revoke(context,id){this.requireReady();return this.service.revoke(this.authority(context,true),id);}
  exchange(input){this.requireReady();return this.service.exchange(input);}
  inspectObjectURL(input){this.requireReady();return this.service.inspectObjectURL(input);}
  objectURL(input){this.requireReady();return this.service.objectURL(input);}
  refresh(input){this.requireReady();return this.service.refresh(input);}
  async tokenClient(bearer){this.requireReady();return this.metadata.transaction(async tx=>(await this.service.token(tx,bearer)).token.clientId);}
  async rpc(token,envelope){this.requireReady();const response=await this.service.rpc(token,envelope);if(response.result?.__federationError){const {result,...rest}=response;return {...rest,error:result.__federationError};}return response;}
  async dispatch(ctx,crypto){
    const writing=!readMethods.has(ctx.method),adapter=this.dispatcher;if(writing)await ctx.reauthorize?.();
    const transact=operation=>ctx.transaction?operation(ctx.transaction):this.metadata.transaction(operation);
    const execute=async()=>{await ctx.reauthorize?.();const call=transaction=>{const {reauthorize,...safe}=ctx;const input=transaction?{...safe,transaction}:safe;return typeof adapter==='function'?adapter(input):adapter.execute(input);};return adapter?.transactional===true?transact(call):call();};
    // A remote adapter must itself reserve/deduplicate durably before upstream
    // side effects. This transaction cannot make external requests atomic.
    if(writing&&adapter?.transactional!==true&&adapter?.durableJournal!==true)fail('temporarily_unavailable','This adapter has no verified durable mutation journal.');
    // Reads have no effects to replay. Re-authorize through the service and
    // fetch fresh data without creating fleet-wide per-transaction records.
    if(!writing){try{return await execute();}catch(error){if(['invalid_args','unsupported_contract','unsupported_method','not_found','forbidden','conflict','quota_exceeded','rate_limited','storage_write_unavailable','tx_conflict'].includes(error.code))return faultResult(error.code,'The requested operation could not be completed.',error);throw error;}}
    const journalKey=`federation/journal/${encodeURIComponent(ctx.subject)}/${encodeURIComponent(ctx.clientId)}/${ctx.tx}`;
    const fingerprint=await digest(crypto,canonical({resource:ctx.resource,addressedResource:ctx.addressedResource??ctx.resource,contract:ctx.contract,method:ctx.method,args:ctx.args,scope:ctx.scope??{},epoch:ctx.epoch??null,resourceGeneration:ctx.resourceGeneration??null,connectionGeneration:ctx.connection?.generation??null}));
    const prior=await transact(async tx=>{const previous=await tx.get(journalKey);if(previous&&previous.expiresAt>this.clock()){if(previous.fingerprint!==fingerprint)fail('tx_conflict','Transaction identifier was reused with different arguments.');return previous;}const rows=await tx.list('federation/journal/');let live=0;for(const row of rows){if(row.value.expiresAt<=this.clock())await tx.delete(row.key);else live++;}if(live>=256)fail('rate_limited','This account has reached its outstanding transaction limit.');await tx.set(journalKey,{fingerprint,status:'reserved',expiresAt:this.clock()+86400000});return null;});
    if(prior){if(prior.status==='complete'){await ctx.reauthorize?.();return prior.result;}return faultResult('indeterminate','The previous operation outcome is unknown. Reconcile through a fresh read.');}
    const save=record=>transact(tx=>tx.set(journalKey,record));
    let result;try{result=await execute();}
    catch(error){if(['invalid_args','unsupported_contract','unsupported_method','not_found','forbidden','conflict','quota_exceeded','rate_limited','storage_write_unavailable','tx_conflict'].includes(error.code)){result=faultResult(error.code,'The requested operation could not be completed.',error);await save({fingerprint,status:'complete',result,expiresAt:this.clock()+86400000});return result;}if(writing){result=faultResult('indeterminate','The operation outcome is unknown. Reconcile through a fresh read.');await save({fingerprint,status:'indeterminate',expiresAt:this.clock()+86400000});return result;}throw error;}
    await save({fingerprint,status:'complete',result,expiresAt:this.clock()+86400000});return result;
  }
}

/** Adapt native durable/SQLite get/put/list(Map) metadata into the domain store. */
export function federationMetadata(storage){return {transaction:operation=>storage.transaction(async native=>operation({get:key=>native.get(key),set:(key,value)=>native.put(key,value),delete:key=>native.delete(key),list:async prefix=>[...await native.list({prefix})].map(([key,value])=>({key,value}))}))};}

/** Preserve typed faults across runtimes whose RPC serialization drops Error properties. */
export function federationRemote(stub){const facade={};for(const method of ['ready','manifest','beginAuthorization','inspect','approve','configure','registerResource','revoke','exchange','rpc','tokenClient','grants','preferences','refresh','cleanup','inspectObjectURL','objectURL'])facade[method]=async(...args)=>{const envelope=await stub.invoke(method,args);if(!envelope.ok)throw Object.assign(new Error(envelope.error.message),envelope.error);return envelope.result;};return facade;}
