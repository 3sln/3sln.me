// Connections domain, EXT-X4 (docs/spec/integrations.md §1, §3, §7; docs/spec/extensions.md §3, §5;
// docs/architecture/extensibility-design.md EX-5). Engine-first: AppConnections (packages/apps/connections.mjs) is the
// provider resource over the account store; the Actions/Queries below are the operations. Everything is refused with
// `not_found` unless INTEGRATIONS_ENABLED is on, so existing app connections behave exactly as before with the flag off.
//
// Actors (built by trusted adapters only, never from a request body; packages/runtime/account/connections.mjs):
//   {kind:'owner', owner, authTime?}  list, slots, built-in connect, suspend, resume, disconnect, approve a staged
//                                     manifest, occupy, vacate, reorder, configure a seat. `authTime` (ms) is the
//                                     owner's last authentication, needed to replace an exclusive provider-consumed
//                                     occupant (extensions §3.4).
//   {kind:'system', owner}            connect from an approved manifest snapshot (federation consent), setup complete,
//                                     health, X3 revalidation results, ingress from `describe` (C1b), account severance
//                                     (suspension, recovery, deletion), the occupancy port, the outbox and cascades.
// Lifecycle: configuring | active | degraded | manifest-invalid | suspended | disconnected. Every change that removes
// authority (suspend, manifest-invalid, disconnect) increments the generation in the same commit that enqueues its
// events; resuming or approving increments it again, so nothing minted for an earlier generation is ever current.
import { Provider } from '../../../vendor/ngin/index.js';
import { AppAction, AppQuery } from '../engine.mjs';
import { AppFault } from '../faults.mjs';
import { UUID } from '../../core/primitives.mjs';

const unauthorized = () => { throw new AppFault('unauthorized', 'Sign in to continue.', 401); };
const forbidden = () => { throw new AppFault('forbidden', 'This operation is not available to this caller.', 403); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const input = (value, names) => { if (value === undefined) return {}; if (!plain(value) || Object.keys(value).some(name => !names.includes(name))) throw new AppFault('invalid_request', 'Unsupported connections request.', 400); return value; };
export const integrationsEnabled = config => config?.INTEGRATIONS_ENABLED === true || config?.INTEGRATIONS_ENABLED === 'true';

/** The `connections` provider class for createAppEngine. `connections`: an AppConnections over the account store.
 * `enabled`: INTEGRATIONS_ENABLED, from configuration. `account(owner)` -> {status} | null: the identity directory
 * status (IDENTITY_ACCOUNT); a non-active account is severed when the occupancy port observes it. */
export function connectionsProvider({ connections, enabled = false, account } = {}) {
  return class extends ConnectionsProvider { static deps = []; constructor() { super(); Object.assign(this, { connections, enabled: enabled === true, account }); } };
}
export class ConnectionsProvider extends Provider {
  async obtain({ actor } = {}) {
    if (!this.enabled || !this.connections) throw new AppFault('not_found', 'Not found.', 404);
    if (!UUID.test(actor?.owner ?? '') || !['owner', 'system'].includes(actor?.kind)) unauthorized();
    // The account store's bound owner must be the actor's, whoever dispatched.
    const bound = await this.connections.metadata.get('owner'); if (bound !== undefined && bound !== actor.owner) throw new AppFault('forbidden', 'Account owner mismatch.', 403);
    return Object.freeze(scope(this.connections, actor, this.account));
  }
  release() {}
}
// The owner-scoped handle: methods take no owner argument, so an operation never holds an ID it could swap.
function scope(service, actor, account) {
  const owner = actor.owner, system = actor.kind === 'system', ownerOnly = () => { if (system) forbidden(); }, systemOnly = () => { if (!system) forbidden(); };
  return {
    list: async () => ({ connections: await service.list(owner), slots: await service.slots(owner) }),
    slots: () => service.slots(owner),
    connect: value => { systemOnly(); const v = input(value, ['client', 'snapshot', 'expectedGeneration']); return service.connect(owner, v); },
    connectBuiltIn: value => { ownerOnly(); return service.connectBuiltIn(owner, input(value, ['integration'])); },
    transition: (op, value) => {
      const v = input(value, ['connection', 'expectedGeneration', 'configured', 'degraded', 'stagedRevision']);
      if (['suspend', 'resume', 'approve'].includes(op)) ownerOnly(); else systemOnly();
      // W5-S3: approving a staged change (possibly a replaced key set) needs a recent owner verification, like occupy.
      const { connection, ...rest } = v; return service.transition(owner, connection, op, rest, op === 'approve' ? { authTime: actor.authTime } : {});
    },
    disconnect: value => { const v = input(value, ['connection', 'expectedGeneration']); return service.disconnect(owner, typeof v.connection === 'string' ? v.connection : '', { reason: system ? 'system' : 'uninstalled', expectedGeneration: v.expectedGeneration }); },
    revalidated: value => { systemOnly(); const v = input(value, ['connection', 'expectedGeneration', 'result']); return service.revalidated(owner, v.connection, v); },
    severAll: value => { systemOnly(); return service.severAll(owner, input(value, ['reason'])); },
    occupy: value => { ownerOnly(); return service.occupy(owner, value, { authTime: actor.authTime }); },
    vacate: value => { ownerOnly(); return service.vacate(owner, value); },
    reorder: value => { ownerOnly(); return service.reorder(owner, value); },
    configureSeat: value => { ownerOnly(); return service.configureSeat(owner, value); },
    setIngress: value => { systemOnly(); return service.setIngress(owner, value); },
    // The occupancy port: available occupants plus the account fence, which also consults the identity directory.
    occupant: async value => {
      systemOnly(); const v = input(value, ['slot']), found = await service.occupant(owner, v.slot);
      if (found.sever) return { ...found, reason: 'suspended' };
      if (!found.occupants.length) return found;
      if (typeof account !== 'function') return { ...found, occupants: [] };
      const status = (await account(owner))?.status; // A failing directory throws: the port reports an error, never an occupant.
      if (status === 'active') return found;
      return { ...found, occupants: [], sever: Boolean(status), reason: status === 'deleted' ? 'deleted' : status === 'suspended' ? 'suspended' : 'system' };
    },
    slotOperation: value => { const v = input(value, ['slot', 'consumer', 'featureEnabled']); return service.slotOperation(owner, v.slot, { consumer: v.consumer, featureEnabled: v.featureEnabled }); },
    outbox: value => { systemOnly(); return service.outbox(owner, input(value, ['after', 'limit'])); },
    ack: value => { systemOnly(); return service.ack(owner, input(value, ['through'])); },
    cascades: () => { systemOnly(); return service.cascades(owner); },
    cascadeDone: value => { systemOnly(); return service.cascadeDone(owner, input(value, ['key']).key); },
  };
}

const CHANGED = 'connections-changed';
export class ConnectionList extends AppQuery { static operation = 'connections.list'; static deps = ['connections']; static refreshOn = [CHANGED]; fetch({ connections }) { return connections.list(); } }
export class SlotList extends AppQuery { static operation = 'connections.slots'; static deps = ['connections']; static refreshOn = [CHANGED]; fetch({ connections }) { return connections.slots(); } }
/** System. `input`: {client:{id, name, origin?}, snapshot, expectedGeneration?}: the snapshot X3's integrationSnapshot pinned at approval. */
export class ConnectIntegration extends AppAction { static operation = 'connections.connect'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.connect(this.input); } }
/** Owner. `input`: {integration}: a provider-authored built-in integration id. */
export class ConnectBuiltIn extends AppAction { static operation = 'connections.connect-built-in'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.connectBuiltIn(this.input); } }
/** Owner. `input`: {connection, expectedGeneration?}. */
export class SuspendConnection extends AppAction { static operation = 'connections.suspend'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.transition('suspend', this.input); } }
/** Owner. `input`: {connection, expectedGeneration} (required: a resume is never applied to an unseen generation). */
export class ResumeConnection extends AppAction { static operation = 'connections.resume'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.transition('resume', this.input); } }
/** Owner. `input`: {connection, expectedGeneration}: approve the staged manifest change. */
export class ApproveConnectionChange extends AppAction { static operation = 'connections.approve'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.transition('approve', this.input); } }
/** System. `input`: {connection, expectedGeneration, configured}: every required setup fragment and slot is approved, or no longer is. */
export class ConnectionConfigured extends AppAction { static operation = 'connections.configured'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.transition('configured', this.input); } }
/** System. `input`: {connection, expectedGeneration, degraded}: X6 delivery or X7 discovery health. */
export class ConnectionHealth extends AppAction { static operation = 'connections.health'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.transition('health', this.input); } }
/** Owner or system. `input`: {connection, expectedGeneration?}. */
export class DisconnectConnection extends AppAction { static operation = 'connections.disconnect'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.disconnect(this.input); } }
/** System. `input`: {connection, expectedGeneration, result}: a classifyIntegrationChange result for the pinned snapshot. */
export class ConnectionRevalidated extends AppAction { static operation = 'connections.revalidated'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.revalidated(this.input); } }
/** System. `input`: {reason: 'suspended'|'deleted'|'system'}: account suspension, recovery or deletion. */
export class SeverAccountConnections extends AppAction { static operation = 'connections.sever-account'; static deps = ['connections']; static changes = CHANGED; static lifecycle = 'purging'; run({ connections }) { return connections.severAll(this.input); } }
/** Owner. `input`: {slot, connection, resource?, position?, replace?, purposes?, expectedRevision?}. */
export class OccupySlot extends AppAction { static operation = 'connections.occupy'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.occupy(this.input); } }
/** Owner. `input`: {slot, seat, expectedRevision?}. */
export class VacateSlot extends AppAction { static operation = 'connections.vacate'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.vacate(this.input); } }
/** Owner. `input`: {slot, seats, expectedRevision?}. */
export class ReorderSlot extends AppAction { static operation = 'connections.reorder'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.reorder(this.input); } }
/** Owner. `input`: {slot, seat, purposes}. */
export class ConfigureSeat extends AppAction { static operation = 'connections.configure-seat'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.configureSeat(this.input); } }
/** System. `input`: {slot, seat, generation, ingress}. */
export class SetSeatIngress extends AppAction { static operation = 'connections.set-ingress'; static deps = ['connections']; static changes = CHANGED; run({ connections }) { return connections.setIngress(this.input); } }
/** System, the occupancy port. `input`: {slot}. Returns {slot, selection, occupants, sever, reason?}. */
export class SlotOccupant extends AppQuery { static operation = 'connections.occupant'; static deps = ['connections']; static lifecycle = 'purging'; static gate = 'none'; fetch({ connections }) { return connections.occupant(this.input); } }
/** `input`: {slot, consumer?, featureEnabled?}: a createSlotOperation state over the current occupancy. */
export class SlotOperation extends AppQuery { static operation = 'connections.slot-operation'; static deps = ['connections']; fetch({ connections }) { return connections.slotOperation(this.input); } }
/** System (X6). `input`: {after?, limit?}. */
export class ConnectionOutbox extends AppQuery { static operation = 'connections.outbox'; static deps = ['connections']; fetch({ connections }) { return connections.outbox(this.input); } }
/** System (X6). `input`: {through}. */
export class AckConnectionOutbox extends AppAction { static operation = 'connections.ack'; static deps = ['connections']; run({ connections }) { return connections.ack(this.input); } }
export class ConnectionCascades extends AppQuery { static operation = 'connections.cascades'; static deps = ['connections']; fetch({ connections }) { return connections.cascades(); } }
export class ConnectionCascadeDone extends AppAction { static operation = 'connections.cascade-done'; static deps = ['connections']; run({ connections }) { return connections.cascadeDone(this.input); } }

export const CONNECTION_OPERATIONS = Object.freeze([ConnectionList, SlotList, ConnectIntegration, ConnectBuiltIn, SuspendConnection, ResumeConnection, ApproveConnectionChange, ConnectionConfigured, ConnectionHealth, DisconnectConnection, ConnectionRevalidated, SeverAccountConnections, OccupySlot, VacateSlot, ReorderSlot, ConfigureSeat, SetSeatIngress, SlotOccupant, SlotOperation, ConnectionOutbox, AckConnectionOutbox, ConnectionCascades, ConnectionCascadeDone]);
export const CONNECTION_OWNER_OPERATIONS = Object.freeze(['connections.list', 'connections.slots', 'connections.connect-built-in', 'connections.suspend', 'connections.resume', 'connections.approve', 'connections.disconnect', 'connections.occupy', 'connections.vacate', 'connections.reorder', 'connections.configure-seat', 'connections.slot-operation']);
