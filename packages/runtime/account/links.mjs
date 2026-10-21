// AccountController slice BB-C1a, core links (docs/architecture/messaging-extraction.md C1): the links-contract
// service and its engine over this account's store. `methods` are installed on AccountController.prototype (`this`
// is the controller); `rpc` lists what `invoke` accepts (packages/runtime/account/index.mjs).
//
// Everything new is refused with `not_found` unless BINDLEBOX_ENABLED is on. The app-actor entry (`linkOperation`)
// is internal (no `rpc` entry): C1b reaches it from the links contract resource method once slot handoff exists,
// building the actor from the verified app grant, never from the request. `config.LINK_SLOT_OCCUPANT`
// ({owner, slot}) -> {clientId, generation} | null is that slot binding; until it is configured no app is an
// occupant, so app issuance fails closed.
import {createAppEngine,perform,read,operations} from '../../app/engine.mjs';
import {AppQuery} from '../../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../../app/providers.mjs';
import {LinkService} from '../../links/issuance.mjs';
import {linksProvider,LINK_OPERATIONS,LinkList,LinkChanges,RevokeLink} from '../../links/engine.mjs';
import {decideLinkAudience} from '../../links/audience.mjs';
import {linkPolicyRegistry} from '../../links/policies.mjs';
import {StorageError} from '../../storage/policy.mjs';

export const LINK_ENGINE_OPERATIONS=operations(...LINK_OPERATIONS);
const engines=new WeakMap();
export const linksEnabled=config=>config?.BINDLEBOX_ENABLED==='true'||config?.BINDLEBOX_ENABLED===true;
/** The controller's LinkService: current-key minting through `signingKey`, verification through the registry history. */
export function linkService(c){
 return new LinkService({store:c.store,issuer:c.config.APP_ORIGIN,keys:c.tokens.keys,signingKey:owner=>c.signingKey(owner),decide:input=>decideLinkAudience(c,input),policies:linkPolicyRegistry(c.config)});
}
function linksEngine(c){
 let engine=engines.get(c);
 if(!engine){engine=createAppEngine({providers:{clock:systemClock,random:cryptoRandom,audit:nullAudit,links:linksProvider({service:linkService(c),enabled:linksEnabled(c.config),occupant:typeof c.config.LINK_SLOT_OCCUPANT==='function'?c.config.LINK_SLOT_OCCUPANT:undefined})}});engines.set(c,engine);}
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
   return run(this,Operation,{actor:{kind:actor.kind,owner,...actor.kind==='app'?{clientId:actor.clientId,handle:actor.handle}:{}},...id===undefined?{}:{id},...input===undefined?{}:{input:structuredClone(input)}});
  },
};

export const rpc={
 listLinks:{},
 linkChanges:{},
 revokeLink:{},
};
