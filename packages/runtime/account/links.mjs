// AccountController slice BB-C1a, core links (docs/architecture/messaging-extraction.md C1): the links-contract
// service and its engine over this account's store. `methods` are installed on AccountController.prototype (`this`
// is the controller); `rpc` lists what `invoke` accepts (packages/runtime/account/index.mjs).
//
// Everything new is refused with `not_found` unless BINDLEBOX_ENABLED is on. The app-actor entry (`linkOperation`)
// is internal (no `rpc` entry): C1b reaches it from the links contract resource method once slot handoff exists,
// building the actor from the verified app grant, never from the request. `config.LINK_SLOT_OCCUPANT`
// ({owner, slot}) -> {clientId, generation} | null is that slot binding; until it is configured no app is an
// occupant, so app issuance fails closed.
//
// BB-C1b additions (descriptor and slot handoff):
//   - `evaluate` requires the author proof (links/author-proof.mjs). The host resolves the author's identity key
//     (same-host principals through `identityKey`; any other issuer is unverifiable until the directory profile
//     exists) and the delegation status (`delegationStatus`, same account or through CONVERSATION_ACCOUNT).
//   - `linkDescriptor(owner, url)`: the `messaging-address` handoff (links/handoff.mjs), reached by the public
//     descriptor route in routes/links.mjs with gate 'none' (it calls the occupancy and describe ports, never inside
//     the account gate). `config.MESSAGING_DESCRIBE({owner, slot, occupant})` is the provider's consumer call to the
//     occupant's `describe` (brokered RPC, EXT-X7); until it is configured every descriptor is recipient_unavailable.
//   - `linksResourceMethod(c, owner, context)`: the links contract (`…/contracts/links/v1`) as a federation resource
//     method (account/storage.mjs RESOURCE_METHOD_HANDLERS). The app actor is built only from the verified context:
//     live federation epoch, the active app connection and its generation, the occupancy port's seat for that client
//     and generation, and the owner's handle from the identity directory (review findings 4 and 5), never the body.
//     Writes are journaled per (client, tx) for 24 h, so a retried tx returns the first result.
import {createAppEngine,perform,read,operations} from '../../app/engine.mjs';
import {AppQuery} from '../../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../../app/providers.mjs';
import {LinkService} from '../../links/issuance.mjs';
import {linksProvider,LINK_OPERATIONS,LinkList,LinkChanges,RevokeLink} from '../../links/engine.mjs';
import {decideLinkAudience} from '../../links/audience.mjs';
import {linkPolicyRegistry} from '../../links/policies.mjs';
import {StorageError} from '../../storage/policy.mjs';
import {integrationsEnabled} from '../../app/domains/connections.mjs';
import {verifyAuthorProof} from '../../links/author-proof.mjs';
import {LinkHandoff} from '../../links/handoff.mjs';
import {LINKS_CONTRACT,LINK_SLOT_TABLE} from '../../links/types.mjs';
import {bridgeConfig} from '../../email-bridge/engine.mjs';
import {bridgeKey} from '../../email-bridge/keys.mjs';
import {ownerOperation} from '../../email-bridge/owner.mjs';
import {canonical,digest} from '../../core/records.mjs';

export const LINK_ENGINE_OPERATIONS=operations(...LINK_OPERATIONS);
const engines=new WeakMap();
export const linksEnabled=config=>config?.BINDLEBOX_ENABLED==='true'||config?.BINDLEBOX_ENABLED===true;
/** The controller's LinkService: current-key minting through `signingKey`, verification through the registry history. */
export function linkService(c){
 return new LinkService({store:c.store,issuer:c.config.APP_ORIGIN,keys:c.tokens.keys,signingKey:owner=>c.signingKey(owner),decide:input=>decideLinkAudience(c,input),verifyAuthor:input=>verifyAuthorProof(input.proof,{...input,...authorPorts(c)}),policies:linkPolicyRegistry(c.config)});
}
// Host ports for author proofs. Same-host principals only: an active account and its CURRENT signing key (a key
// rotation revokes delegations, so a certificate under a retired key proves nothing). Status from the author's own
// account; a missing or failing route throws (unavailable), never `active`.
export function authorPorts(c){
 const local=subject=>c.metadata.get('owner').then(owner=>owner===subject);
 return {
  resolveKey:async({issuer,subject,kid})=>{if(issuer!==c.config.APP_ORIGIN)return null;const record=await c.identityKey(subject,kid);return record&&record.purpose==='signing'&&record.active===true&&record.accountActive===true&&record.alg==='ES256'?{alg:'ES256',publicJwk:record.publicJwk}:null;},
  status:async({issuer,subject,jkt})=>{if(issuer!==c.config.APP_ORIGIN)throw new Error('unverifiable');if(await local(subject))return c.delegationStatus(subject,jkt);const remote=c.config.CONVERSATION_ACCOUNT?.(subject);if(!remote)throw new Error('unavailable');const result=await remote.invoke({method:'delegationStatus',args:[subject,jkt]});if(result?.$fault)throw new Error('unavailable');return result;},
 };
}
const occupantPort=c=>typeof c.config.LINK_SLOT_OCCUPANT==='function'?c.config.LINK_SLOT_OCCUPANT:integrationsEnabled(c.config)?query=>c.linkSlotOccupant(query):undefined;
// The descriptor's occupant: the link seat plus the occupant origin (the ingress must be on it) when known.
const handoffOccupant=c=>{const seat=occupantPort(c);if(!seat)return undefined;return async query=>{const found=await seat(query);if(!found)return null;if(typeof found.origin==='string'||typeof c.config.LINK_SLOT_OCCUPANT==='function')return found;const d=await c.delegationSlotOccupant(query);return d?.clientId===found.clientId?{...found,origin:d.origin}:found;};};
const handoffs=new WeakMap();
export function linkHandoff(c){let h=handoffs.get(c);if(!h){h=new LinkHandoff({service:linkService(c),occupant:handoffOccupant(c),describe:typeof c.config.MESSAGING_DESCRIBE==='function'?c.config.MESSAGING_DESCRIBE:undefined,allowLoopback:c.config.LOCAL_DEVELOPMENT==='true'});handoffs.set(c,h);}return h;}
function linksEngine(c){
 let engine=engines.get(c);
 if(!engine){engine=createAppEngine({providers:{clock:systemClock,random:cryptoRandom,audit:nullAudit,links:linksProvider({service:linkService(c),enabled:linksEnabled(c.config),occupant:occupantPort(c)})}});engines.set(c,engine);}
 return engine;
}
const run=(c,Operation,params)=>{const operation=new Operation(params);return operation instanceof AppQuery?read(linksEngine(c),operation):perform(linksEngine(c),operation);};
const owned=(owner,input)=>{if(input!==undefined&&(input===null||typeof input!=='object'||Array.isArray(input)))throw new StorageError('invalid_request','Unsupported link request.');return {actor:{kind:'owner',owner},...input===undefined?{}:{input}};};

export const methods={
  // Owner views and revocation of app-issued links (bindlebox §4.2 occupant replacement: show and revoke).
  async listLinks(owner,input){await this.warm(owner);return run(this,LinkList,owned(owner,input));},
  async linkChanges(owner,input){await this.warm(owner);return run(this,LinkChanges,owned(owner,input));},
  async revokeLink(owner,jti){await this.warm(owner);return run(this,RevokeLink,{actor:{kind:'owner',owner},id:jti});},
  // Internal app-actor entry: `actor` is built by the trusted links-contract adapter for this account's owner.
  async linkOperation(owner,{actor,operation,id,input}={}){
   if(actor?.owner!==owner||!['owner','app'].includes(actor?.kind))throw new StorageError('forbidden','Account owner mismatch.',403);
   const Operation=typeof operation==='string'&&Object.hasOwn(LINK_ENGINE_OPERATIONS,operation)?LINK_ENGINE_OPERATIONS[operation]:null;
   if(!Operation)throw new StorageError('unsupported_method','Unsupported link operation.',400);
   await this.warm(owner);
   return run(this,Operation,{actor:{kind:actor.kind,owner,...actor.kind==='app'?{clientId:actor.clientId,handle:actor.handle,...actor.generation===undefined?{}:{generation:actor.generation,connection:actor.connection}}:{}},...id===undefined?{}:{id},...input===undefined?{}:{input:structuredClone(input)}});
  },
  // Public messaging-address handoff (bindlebox §2.3): the descriptor for one of this owner's verified links.
  async linkDescriptor(owner,url){
   if(!linksEnabled(this.config))throw new StorageError('not_found','Not found.',404);
   if(await this.metadata.get('owner')!==owner)throw new StorageError('recipient_unavailable','The recipient is unavailable.',503);
   try{return await linkHandoff(this).descriptor(url);}
   catch(error){throw error?.code==='link_malformed'?new StorageError('link_malformed','The link is malformed.',400):error?.code==='link_invalid'?new StorageError('link_invalid','The link is not valid.',401):new StorageError('recipient_unavailable','The recipient is unavailable.',503);}
  },
};

// Links contract resource method (RESOURCE_METHOD_HANDLERS). `context` is the verified federation RPC context.
const LINK_METHODS=Object.freeze({issue:'links.issue',revoke:'links.revoke',rotate:'links.rotate',evaluate:'links.evaluate',list:'links.list',changes:'links.changes',consumerKey:'bridge.key',accepted:'bridge.accepted'});
const WRITES=['issue','revoke','rotate'];
const denied=()=>{throw new StorageError('forbidden','Link access denied.',403);};
export async function linksResourceMethod(c,owner,context){
 if(!linksEnabled(c.config))throw new StorageError('not_found','Not found.',404);
 if(typeof context?.method!=='string'||!Object.hasOwn(LINK_METHODS,context.method))throw new StorageError('unsupported_method','Unsupported link method.',400);
 const args=context.args;if(args===null||typeof args!=='object'||Array.isArray(args))throw new StorageError('invalid_args','Unsupported link request.',400);
 if(context.authority!=='bindle'||context.resource!==`${c.config.APP_ORIGIN}/entities/${owner}/links`||context.resourceGeneration!==owner||context.contract!==LINKS_CONTRACT)denied();
 if(typeof context.clientId!=='string'||!context.connection||typeof context.connection.id!=='string'||!Number.isSafeInteger(context.connection.generation))denied();
 await c.warm(owner);
 if(!context.epoch||typeof c.config.FEDERATION_IDENTITY_CHECK!=='function'||await c.config.FEDERATION_IDENTITY_CHECK(owner,context.epoch)!==true)throw new StorageError('unauthorized','Application authorization is no longer active.',401);
 await c.apps.check(owner,context.connection.id,context.connection.generation,context.clientId);
 // Handle from the owner's identity record (finding 5); an inactive account issues nothing.
 const account=typeof c.config.IDENTITY_ACCOUNT==='function'?await c.config.IDENTITY_ACCOUNT(owner):null;
 if(!account||account.status!=='active'||typeof account.handle!=='string')denied();
 // BRIDGE methods are advertised only with the bridge flags. The live intake seat is checked for acceptance;
 // keys are public, but the caller still needs this resource's ordinary authenticated grant.
 if(['consumerKey','accepted'].includes(context.method)){
  if(!bridgeConfig(c.config).enabled)throw new StorageError('not_found','Not found.',404);
  if(context.method==='consumerKey'){if(Object.keys(args).some(k=>!['consumer','keyId'].includes(k)))denied();const key=await bridgeKey(c.config);return key&&args.consumer===c.config.APP_ORIGIN&&args.keyId===key.keyId?{keyId:key.keyId,publicJwk:key.publicJwk}:null;}
  if(Object.keys(args).some(k=>k!=='jti')||typeof args.jti!=='string'||!args.jti||args.jti.length>128)denied();
  const seat=await c.integrationsIntakeSeat(owner);if(!seat||seat.clientId!==context.clientId||seat.connection!==context.connection.id||seat.generation!==context.connection.generation)denied();
  return ownerOperation(c.config,owner,'bridge.accepted',{jti:args.jti});
 }
 const actor={kind:'app',owner,clientId:context.clientId,handle:account.handle,generation:context.connection.generation,connection:context.connection.id};
 const operation=LINK_METHODS[context.method],id=['revoke','rotate'].includes(context.method)?args.jti:undefined;
 if(id!==undefined&&Object.keys(args).some(name=>name!=='jti'))throw new StorageError('invalid_args','Unsupported link request.',400);
 const params={actor,operation,...id===undefined?{input:args}:{id}};
 // Occupancy before any journal read or write (review LH-2, LH-8): an app holding no bound seat at this exact
 // generation can neither fill the journal nor replay a cached result.
 const port=occupantPort(c);let seated=false;
 if(port)for(const slot of new Set(LINK_SLOT_TABLE.map(row=>row.slot))){let found=null;try{found=await port({owner,slot});}catch{found=null;}if(found?.clientId===context.clientId&&found.generation===context.connection.generation&&found.connection===context.connection.id){seated=true;break;}}
 if(!seated)denied();
 if(!WRITES.includes(context.method))return c.linkOperation(owner,params);
 if(typeof context.tx!=='string'||!/^[a-f0-9-]{36}$/.test(context.tx))throw new StorageError('invalid_args','A transaction UUID is required.',400);
 // Write journal: a retried tx returns its first result; reuse with other arguments is a conflict; an unfinished
 // entry is indeterminate (never repeated blindly). Bounded to 256 live entries per account.
 const now=Date.now(),journal=`links-rpc/${encodeURIComponent(context.clientId)}/${context.tx}`,fingerprint=await digest(crypto,canonical({method:context.method,args,connection:context.connection.id,generation:context.connection.generation}));
 const prior=await c.metadata.get(journal);
 if(prior&&prior.createdAt+86400000>now){if(prior.fingerprint!==fingerprint)throw new StorageError('tx_conflict','Transaction identifier was reused with different arguments.',409);if(prior.state!=='done')throw new StorageError('indeterminate','The earlier operation must be reconciled before retrying.',503);if(prior.error)throw new StorageError(prior.error.code,prior.error.message,prior.error.status);return structuredClone(prior.result);}
 let live=0,mine=0;const own=`links-rpc/${encodeURIComponent(context.clientId)}/`;for(const [path,row] of await c.metadata.list({prefix:'links-rpc/',limit:257})){if(!(row?.createdAt+86400000>now))await c.metadata.delete(path);else{live++;if(path.startsWith(own))mine++;}}
 if(live>=256||mine>=128)throw new StorageError('rate_limited','Too many recent link operations.',429);
 await c.metadata.put(journal,{fingerprint,state:'reserved',createdAt:now});
 try{const result=await c.linkOperation(owner,params);await c.metadata.put(journal,{fingerprint,state:'done',result,createdAt:now});return result;}
 catch(error){if(typeof error?.code==='string'&&Number.isSafeInteger(error.status)&&error.status<500&&!['forbidden','unauthorized'].includes(error.code))await c.metadata.put(journal,{fingerprint,state:'done',error:{code:error.code,message:error.message,status:error.status},createdAt:now});throw error;}
}

export const rpc={
 listLinks:{},
 linkChanges:{},
 revokeLink:{},
 linkDescriptor:{gate:'none'},
};
