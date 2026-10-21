// AccountController slice registry (docs/architecture/app-engine.md §12).
//
// Each slice module exports `methods`, installed on AccountController.prototype (`this` is the controller),
// and `rpc`: the methods `AccountController.invoke` accepts, each with the placement policy invoke applies.
// The policy uses the engine operation vocabulary (`operationPolicy`, packages/app/engine.mjs) plus `warm`:
//   lifecycle  'active' (default) | 'suspended' (allowed while suspended) | 'purging' (also while purging)
//   gate       'account' (default: inside the single-writer gate) | 'none' (cross-account fanout and lookups
//              a peer account may call while holding its own gate)
//   activity   'owner-return' | 'resource-use': resets the inactivity clock after success
//   warm       true: warm the account (owner binding, restore) inside the gate before the method runs
// A method that is missing from every `rpc` is internal: it is never reachable through `invoke`.
//
// Append-only: one import and one entry per slice. A slice edits only its own module.
import {LIFECYCLE_POLICIES,GATE_POLICIES,ACTIVITY_POLICIES} from '../../app/engine.mjs';
import * as views from './views.mjs';
import * as messages from './messages.mjs';
import * as contacts from './contacts.mjs';
import * as delivery from './delivery.mjs';
import * as conversations from './conversations.mjs';
import * as storage from './storage.mjs';
import * as billing from './billing.mjs';
import * as search from './search.mjs';
import * as lifecycle from './lifecycle.mjs';
import * as notifications from './notifications.mjs';
import * as beams from './beams.mjs';
import * as automation from './automation.mjs';
import * as identity from './identity.mjs';
import * as links from './links.mjs';
import * as connections from './connections.mjs';

export const ACCOUNT_SLICES=Object.freeze({views,messages,contacts,delivery,conversations,storage,billing,search,lifecycle,notifications,beams,automation,identity,links,connections});

/** Installs every slice's methods; a name defined twice (by two slices, or by a slice and the core) is a programming error. */
export function installAccountMethods(prototype,slices=ACCOUNT_SLICES){
 for(const [slice,{methods}]of Object.entries(slices))for(const [name,value]of Object.entries(methods)){
  if(name in prototype)throw new TypeError(`Account method ${name} (slice ${slice}) is already defined`);
  Object.defineProperty(prototype,name,{value,writable:true,configurable:true});
 }
}

/** The frozen `invoke` allowlist: method name to placement policy. `core` holds the controller's own RPC methods. */
export function accountRPC(core,slices=ACCOUNT_SLICES){
 const registry={};
 for(const [slice,{rpc}]of Object.entries({core:{rpc:core},...slices}))for(const [name,policy]of Object.entries(rpc)){
  if(Object.hasOwn(registry,name))throw new TypeError(`Account RPC ${name} (slice ${slice}) is already registered`);
  if(Object.keys(policy).some(key=>!['lifecycle','gate','activity','warm'].includes(key))||![undefined,...LIFECYCLE_POLICIES].includes(policy.lifecycle)||![undefined,...GATE_POLICIES].includes(policy.gate)||![undefined,...ACTIVITY_POLICIES].includes(policy.activity)||![undefined,true].includes(policy.warm))throw new TypeError(`Account RPC ${name} (slice ${slice}) declares an unknown policy`);
  registry[name]=Object.freeze({...policy});
 }
 return Object.freeze(registry);
}
