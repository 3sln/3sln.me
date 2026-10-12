import {FederationService} from './service.mjs';
import {fail} from './schema.mjs';
import {canonical,digest} from '../messaging/store.mjs';
const readMethods=new Set(['get','list','read','describe']);
const faultResult=(code,message)=>({__federationError:{code,message}});
/** Portable composition boundary. Both hosted and self-hosted runtimes inject
 * metadata, live owner authentication and actual contract adapters here. */
export class FederationController {
  constructor({metadata,auth,issuer,clients=[],schemaFetcher,schemaHosts=[],dispatcher,crypto=globalThis.crypto,clock=()=>Date.now(),allowInsecureLocalhost=false,enabled=true}){
    if(!metadata?.transaction||!auth?.owner)throw new TypeError('Transactional metadata and authenticated owner resource required');
    Object.assign(this,{metadata,auth,issuer,clients,dispatcher,clock,enabled,allowInsecureLocalhost});
    this.service=new FederationService({store:metadata,issuer,clients,crypto,clock,schemaFetcher,schemaHosts,allowInsecureLocalhost,authenticateOwner:(authority)=>auth.owner(authority.context,{mutation:authority.mutation}),dispatchCapability:ctx=>this.dispatch(ctx,crypto)});
  }
  ready(){return this.enabled&&this.clients.length>0&&typeof this.service.schemaFetcher==='function'&&(typeof this.dispatcher==='function'||typeof this.dispatcher?.execute==='function');}
  requireReady(){if(!this.ready())fail('temporarily_unavailable','Federation is not configured and release enabled.');}
  manifest(){this.requireReady();return {version:'0',issuer:this.issuer,authorization_endpoint:`${this.issuer}/oauth/authorize`,token_endpoint:`${this.issuer}/oauth/token`,rpc_endpoint:`${this.issuer}/bindle/rpc`,jwks_uri:`${this.issuer}/oauth/jwks`,login_presentation:['redirect'],contracts:[]};}
  authority(context,mutation){return {context,mutation};}
  beginAuthorization(input){this.requireReady();return this.service.beginAuthorization(input);}
  inspect(context,id){this.requireReady();return this.service.inspect(id,context?.sessionToken?this.authority(context,false):undefined);}
  approve(context,input){this.requireReady();return this.service.approve(this.authority(context,true),input);}
  configure(context,input){this.requireReady();return this.service.configure(this.authority(context,true),input);}
  registerResource(context,input){this.requireReady();return this.service.registerResource(this.authority(context,true),input);}
  revoke(context,id){this.requireReady();return this.service.revoke(this.authority(context,true),id);}
  exchange(input){this.requireReady();return this.service.exchange(input);}
  async tokenClient(bearer){this.requireReady();return this.metadata.transaction(async tx=>(await this.service.token(tx,bearer)).token.clientId);}
  async rpc(token,envelope){this.requireReady();const response=await this.service.rpc(token,envelope);if(response.result?.__federationError){const {result,...rest}=response;return {...rest,error:result.__federationError};}return response;}
  async dispatch(ctx,crypto){
    const writing=!readMethods.has(ctx.method),adapter=this.dispatcher;
    // A remote adapter must itself reserve/deduplicate durably before upstream
    // side effects. This transaction cannot make external requests atomic.
    if(writing&&adapter?.transactional!==true&&adapter?.durableJournal!==true)fail('temporarily_unavailable','This adapter has no verified durable mutation journal.');
    const journalKey=`federation/journal/${encodeURIComponent(ctx.subject)}/${encodeURIComponent(ctx.clientId)}/${ctx.tx}`;
    const fingerprint=await digest(crypto,canonical({resource:ctx.resource,contract:ctx.contract,method:ctx.method,args:ctx.args}));
    const prior=await ctx.transaction.get(journalKey);
    if(prior&&prior.expiresAt>this.clock()){if(prior.fingerprint!==fingerprint)fail('tx_conflict','Transaction identifier was reused with different arguments.');if(prior.status==='complete')return prior.result;return faultResult('indeterminate','The previous operation outcome is unknown. Reconcile through a fresh read.');}
    await ctx.transaction.set(journalKey,{fingerprint,status:'reserved',expiresAt:this.clock()+86400000});
    let result;try{result=await (typeof adapter==='function'?adapter(ctx):adapter.execute(ctx));}
    catch(error){if(['invalid_args','unsupported_contract','unsupported_method','not_found','forbidden','conflict','quota_exceeded','rate_limited','tx_conflict'].includes(error.code)){result=faultResult(error.code,'The requested operation could not be completed.');await ctx.transaction.set(journalKey,{fingerprint,status:'complete',result,expiresAt:this.clock()+86400000});return result;}if(writing){result=faultResult('indeterminate','The operation outcome is unknown. Reconcile through a fresh read.');await ctx.transaction.set(journalKey,{fingerprint,status:'indeterminate',expiresAt:this.clock()+86400000});return result;}throw error;}
    await ctx.transaction.set(journalKey,{fingerprint,status:'complete',result,expiresAt:this.clock()+86400000});return result;
  }
}

/** Adapt native durable/SQLite get/put/list(Map) metadata into the domain store. */
export function federationMetadata(storage){return {transaction:operation=>storage.transaction(async native=>operation({get:key=>native.get(key),set:(key,value)=>native.put(key,value),delete:key=>native.delete(key),list:async prefix=>[...await native.list({prefix})].map(([key,value])=>({key,value}))}))};}

/** Preserve typed faults across runtimes whose RPC serialization drops Error properties. */
export function federationRemote(stub){const facade={};for(const method of ['ready','manifest','beginAuthorization','inspect','approve','configure','registerResource','revoke','exchange','rpc','tokenClient'])facade[method]=async(...args)=>{const envelope=await stub.invoke(method,args);if(!envelope.ok)throw Object.assign(new Error(envelope.error.message),{code:envelope.error.code});return envelope.result;};return facade;}
