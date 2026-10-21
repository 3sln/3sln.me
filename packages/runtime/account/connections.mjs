// AccountController slice EXT-X4, connections (docs/architecture/extensibility-design.md §10 X4; docs/spec/integrations.md
// §3, §7; docs/spec/extensions.md §3, §5). `methods` are installed on AccountController.prototype (`this` is the
// controller); `rpc` lists what `invoke` accepts (packages/runtime/account/index.mjs).
//
// Everything new answers `not_found` unless INTEGRATIONS_ENABLED is on. Entry points:
//   connectionsOwner(owner, {operation, id, input}, {authTime})  owner operations (CONNECTION_OWNER_OPERATIONS); the
//       trusted route adapter passes the session's authentication time, never the request body.
//   connectionsSystem(owner, {operation, input})  internal (no `rpc`): federation consent, X3 revalidation, X6/X7, C1b.
//   linkSlotOccupant / delegationSlotOccupant({owner, slot})  the occupancy ports packages/runtime/account/links.mjs
//       (LINK_SLOT_OCCUPANT) and identity.mjs (DELEGATION_SLOT_OCCUPANT) fall back to when the flag is on and no port
//       is configured explicitly. Exclusive slots only; anything else is null (fail closed).
//   connectionsSeverAccount(owner, {reason})  internal hook for suspension, recovery and deletion (review KD-4).
//   connectionsDrain(owner)  internal: applies durable cascade rows (key-delegation revocation and reconciliation).
//
// KD-4 wiring: every disconnect, suspend, manifest invalidation, vacate or replacement of a messaging-ingress occupant
// writes a cascade row in its own commit; the row is drained right after (and retried by every later connections call).
// Account suspension is severed three ways: this hook (for the lifecycle and admin paths that can call it), the
// identity-directory status seen by the occupancy port, and the lifecycle capability epoch recorded in each connection,
// which detects a suspension that ended before anyone looked. Until a cascade drains, the ports already answer null,
// so the delegation status endpoint persists the revocation on first observation (KD-1).
import {createAppEngine,perform,read,operations,AppQuery} from '../../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../../app/providers.mjs';
import {AppConnections,recognizedSlots} from '../../apps/connections.mjs';
import {connectionsProvider,integrationsEnabled,CONNECTION_OPERATIONS,CONNECTION_OWNER_OPERATIONS,SlotOccupant,SeverAccountConnections,ConnectionCascades,ConnectionCascadeDone} from '../../app/domains/connections.mjs';
import {StorageError} from '../../storage/policy.mjs';
import {CLASSIFIER_INTEGRATION} from './classifier.mjs'; // EXT-X10 registry entry
import {GOOGLE_DRIVE_INTEGRATION} from '../../storage/google-drive-integration.mjs'; // EXT-X10 registry entry

export const CONNECTION_ENGINE_OPERATIONS=operations(...CONNECTION_OPERATIONS);
// Provider-authored built-in integrations by id -> {name, manifest}; append-only (X10 adds Drive and the classifier).
export const BUILT_IN_INTEGRATIONS=Object.freeze({
 classifier:CLASSIFIER_INTEGRATION, // EXT-X10: offered only; never connected or assigned automatically
 'google-drive':GOOGLE_DRIVE_INTEGRATION, // EXT-X10: upstream connector remains unchanged
});
const engines=new WeakMap();
function connectionsEngine(c){
 let engine=engines.get(c);
 if(!engine){
  const connections=new AppConnections({metadata:c.metadata,origin:c.config.APP_ORIGIN,builtins:c.config.BUILT_IN_INTEGRATIONS??BUILT_IN_INTEGRATIONS,slots:c.config.CONNECTION_SLOTS??recognizedSlots(c.config)});
  engine=createAppEngine({providers:{clock:systemClock,random:cryptoRandom,audit:nullAudit,connections:connectionsProvider({connections,enabled:integrationsEnabled(c.config),account:typeof c.config.IDENTITY_ACCOUNT==='function'?owner=>c.config.IDENTITY_ACCOUNT(owner):undefined})}});
  engines.set(c,engine);
 }
 return engine;
}
const run=(c,Operation,params)=>{const operation=new Operation(params);return operation instanceof AppQuery?read(connectionsEngine(c),operation):perform(connectionsEngine(c),operation);};
const shape=value=>{if(value!==undefined&&(value===null||typeof value!=='object'||Array.isArray(value)))throw new StorageError('invalid_request','Unsupported connections request.');return value===undefined?undefined:structuredClone(value);};
const UUID=/^[a-f0-9-]{36}$/;
async function bound(c,owner){return typeof owner==='string'&&UUID.test(owner)&&await c.metadata.get('owner')===owner;}

// The one port core. `null` when there is no single available occupant; a severed account answers null after the
// severance commits; a failing identity directory rejects (delegation then answers 503, links fail closed).
// Re-entrancy guard (X4-R1): a port read made by a drain (reconcile -> occupancy) never severs or drains again.
const draining=new WeakMap();const busy=(c,owner)=>draining.get(c)?.has(owner)===true;
async function exclusiveOccupant(c,{owner,slot}={}){
 if(!integrationsEnabled(c.config)||!await bound(c,owner)||typeof slot!=='string')return null;
 let found;try{found=await run(c,SlotOccupant,{actor:{kind:'system',owner},input:{slot}});}catch(error){if(['unsupported_slot','not_found'].includes(error?.code))return null;throw error;}
 if(found.sever){if(!busy(c,owner))await c.connectionsSeverAccount(owner,{reason:found.reason});return null;}
 return found.selection==='exclusive'&&found.occupants.length===1?found.occupants[0]:null;
}

export const methods={
  async connectionClientAuth(owner,clientId){if(!integrationsEnabled(this.config)||!await bound(this,owner))return null;const binding=await this.apps.binding(owner,clientId);return binding?.id?this.brokeredIntegrationAuth(owner,{connection:binding.id}):null;},
  async connectionsSetupComplete(owner,input){return this.connectionsSystem(owner,{operation:'connections.configured',input});},
  async connectionsOwner(owner,{operation,id,input}={},{authTime}={}){
   const Operation=typeof operation==='string'&&CONNECTION_OWNER_OPERATIONS.includes(operation)?CONNECTION_ENGINE_OPERATIONS[operation]:null;
   if(!integrationsEnabled(this.config)||!Operation)throw new StorageError('not_found','Not found.',404);
   await this.warm(owner);await this.connectionsDrain(owner);
   const result=await run(this,Operation,{actor:{kind:'owner',owner,...Number.isSafeInteger(authTime)?{authTime}:{}},...id===undefined?{}:{id},...input===undefined?{}:{input:shape(input)}});
   await this.connectionsDrain(owner);if(!(Operation.prototype instanceof AppQuery))await this.integrationEventsKick(owner);return result;
  },
  async connectionsSystem(owner,{operation,input}={}){
   const Operation=typeof operation==='string'&&Object.hasOwn(CONNECTION_ENGINE_OPERATIONS,operation)?CONNECTION_ENGINE_OPERATIONS[operation]:null;
   if(!integrationsEnabled(this.config)||!Operation)throw new StorageError('not_found','Not found.',404);
   await this.warm(owner);
   const result=await run(this,Operation,{actor:{kind:'system',owner},...input===undefined?{}:{input:shape(input)}});
   if(!['connections.cascades','connections.cascade-done','connections.outbox','connections.occupant'].includes(operation))await this.connectionsDrain(owner);
   if(!(Operation.prototype instanceof AppQuery))await this.integrationEventsKick(owner);return result;
  },
  // LINK_SLOT_OCCUPANT ({owner, slot}) -> {clientId, generation, cnx} | null (packages/links/engine.mjs).
  async linkSlotOccupant(query){const o=await exclusiveOccupant(this,query);return o&&{clientId:o.clientId,connection:o.connection,generation:o.generation,cnx:o.cnx};},
  // DELEGATION_SLOT_OCCUPANT ({owner, slot}) -> {clientId, origin, ingress, cnx, purposes} | null (packages/identity/delegation.mjs).
  // `cnx` names the seat incarnation: a new seat, generation (suspend/resume, reconnect) or occupant changes it (KD-1).
  async delegationSlotOccupant(query){const o=await exclusiveOccupant(this,query);return o&&{clientId:o.clientId,origin:o.origin,ingress:o.ingress,cnx:o.cnx,purposes:o.purposes};},
  // Suspension, recovery and deletion hook (KD-4). Idempotent; severs every connection and revokes every delegation.
  async connectionsSeverAccount(owner,{reason='suspended'}={}){
   if(!integrationsEnabled(this.config)||!await bound(this,owner))return {severed:0};
   const result=await run(this,SeverAccountConnections,{actor:{kind:'system',owner},input:{reason}});
   await this.connectionsDrain(owner);await this.integrationEventsKick(owner);return result;
  },
  // Applies pending cascade rows in order; stops at the first failure, which stays durable for the next call.
  async connectionsDrain(owner){
   if(!integrationsEnabled(this.config)||!await bound(this,owner)||busy(this,owner))return {drained:0,pending:0};
   if(!draining.has(this))draining.set(this,new Set());const set=draining.get(this);set.add(owner);
   try{
   const rows=await run(this,ConnectionCascades,{actor:{kind:'system',owner}});let drained=0;
   for(const row of rows){
    try{
     if(row.kind==='delegations')await this.revokeDelegationsFor(owner,row.all?{reason:row.reason}:{clientId:row.clientId,reason:row.reason});
     else if(row.kind==='reconcile')await this.reconcileDelegations(owner);
    }catch(error){if(error?.code!=='not_found')return {drained,pending:rows.length-drained};}// not_found: delegation disabled, nothing certified.
    await run(this,ConnectionCascadeDone,{actor:{kind:'system',owner},input:{key:row.key}});drained++;
   }
   return {drained,pending:0};
   }finally{set.delete(owner);}
  },
};

export const rpc={
 connectionClientAuth:{gate:'none'},connectionsOwner:{warm:true},connectionsSetupComplete:{warm:true},connectionsSeverAccount:{lifecycle:'purging'},
};
