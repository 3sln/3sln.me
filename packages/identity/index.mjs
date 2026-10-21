import { Engine, Provider, Action, Query } from '../../vendor/ngin/src/index.js';
import { IdentityService } from './service.mjs';
export { IdentityService, IdentityFault } from './service.mjs';
export { createArgon2Hasher } from './crypto.mjs';
export { createWebAuthnAdapter } from './webauthn.mjs';
export { planAccountLifecycle } from './lifecycle.mjs';

const mutations = new Set(['stepUp','stepUpBegin','issueOnboarding','inspectOnboarding','claimOnboarding','bootstrapSystem','setupBillingCheckout','setupBillingStatus','setupStatus','setupEmailStart','setupEmailConfirm','setupPushStart','setupPushConfirm','claimHandle','handleCertificate','signup', 'beginPasskeyRegistration', 'registerPasskey', 'setPendingPassword', 'downloadRecovery', 'confirmRecovery', 'loginPassword', 'beginPasskeyLogin', 'finishPasskeyLogin', 'recover', 'logout', 'logoutSaved', 'emailStart', 'emailConfirm', 'emailLoginStart', 'emailLoginConfirm', 'configureEmailLogin', 'credentialBegin', 'credentialFinish', 'renamePasskey', 'removePasskey', 'renameSession', 'revokeSession', 'revokeOtherSessions', 'createDeviceLogin', 'approveDeviceLogin', 'denyDeviceLogin', 'pollDeviceLogin', 'cancelDeviceLogin']);
export class IdentityAction extends Action {
  static deps = ['identity'];
  constructor(method, input, context) { super(); if (!mutations.has(method)) throw new TypeError('Unknown identity action'); this.method = method; this.input = input; this.context = context; }
  async execute({ identity }, { dispatchFeed, engineFeed }) {
    const result = await identity[this.method](this.input, this.context);
    dispatchFeed.dispatchEvent(new CustomEvent('result', { detail: result }));
    engineFeed.dispatchEvent(new Event('identity-updated'));
  }
}
export class OwnerQuery extends Query {
  static deps = ['identity'];
  constructor(context) { super(); this.context = context; }
  async fetch({ identity }) { return identity.owner({}, this.context); }
}
export class DeviceRequestQuery extends Query {
  static deps = ['identity'];
  constructor(input, context) { super(); this.input = input; this.context = context; }
  async fetch({ identity }) { return identity.deviceRequest(this.input, this.context); }
}
// Linked approval (contract: docs/architecture/linked-approval.md §10.1), all gated by DEVICE_AUTHORIZATION_ENABLED.
// Browser-facing operations, for the LA3 routes (/approve page and the requesting screen):
const linkedBrowser = new Set(['linkedStart', 'linkedApprove', 'linkedDeny', 'linkedPoll', 'linkedAccept', 'linkedCancel']);
// System operations for the federation engine (LA2 device endpoint, token endpoint, lineage drain). Never routed.
const linkedSystem = new Set(['linkedStartApp', 'linkedRedeem', 'linkedCancelApp', 'linkedLineageRevoke', 'linkedOutboxAck']);
class LinkedAction extends Action {
  static deps = ['identity'];
  constructor(allowed, method, input, context) { super(); if (!allowed.has(method)) throw new TypeError('Unknown linked approval action'); this.method = method; this.input = input; this.context = context; }
  async execute({ identity }, { dispatchFeed, engineFeed }) {
    const result = await identity[this.method](this.input, this.context);
    dispatchFeed.dispatchEvent(new CustomEvent('result', { detail: result }));
    engineFeed.dispatchEvent(new Event('identity-updated'));
  }
}
export class LinkedApprovalAction extends LinkedAction { constructor(method, input, context) { super(linkedBrowser, method, input, context); } }
export class LinkedSystemAction extends LinkedAction { constructor(method, input, context) { super(linkedSystem, method, input, context); } }
/** Code resolve for a signed-in member: the review view, or `invalid_code`. Charges the guess budgets; no writes. */
export class LinkedResolveQuery extends Query {
  static deps = ['identity'];
  constructor(input, context) { super(); this.input = input; this.context = context; }
  async fetch({ identity }) { return identity.linkedResolve(this.input, this.context); }
}
/** Refresh-time lineage backstop (system): true only while the approval lineage is live. */
export class LinkedLineageQuery extends Query {
  static deps = ['identity'];
  constructor(input) { super(); this.input = input; }
  async fetch({ identity }) { return identity.linkedLineageLive(this.input); }
}
/** Pending lineage revocations of one account (system outbox drain). */
export class LinkedOutboxQuery extends Query {
  static deps = ['identity'];
  constructor(input) { super(); this.input = input; }
  async fetch({ identity }) { return identity.linkedOutbox(this.input); }
}
export { LinkedApproval, MemoryLinkedLimits, linkedLifetime, linkedDurations, linkedNetwork, globalResolveBudget, revokeAllLineage, LINKED, DEVICE_KINDS } from './linked-approval.mjs';
export function createIdentityEngine(resources) {
  const identity = new IdentityService(resources);
  return new Engine({ providers: { identity: Provider.fromSingleton(identity) } });
}
