import { Engine, Provider, Action, Query } from '../../vendor/ngin/src/index.js';
import { IdentityService } from './service.mjs';
export { IdentityService, IdentityFault } from './service.mjs';
export { createArgon2Hasher } from './crypto.mjs';
export { createWebAuthnAdapter } from './webauthn.mjs';
export { planAccountLifecycle } from './lifecycle.mjs';

const mutations = new Set(['issueOnboarding','inspectOnboarding','claimOnboarding','bootstrapSystem','setupBillingCheckout','setupBillingStatus','setupStatus','setupEmailStart','setupEmailConfirm','setupPushStart','setupPushConfirm','claimHandle','handleCertificate','signup', 'beginPasskeyRegistration', 'registerPasskey', 'setPendingPassword', 'downloadRecovery', 'confirmRecovery', 'loginPassword', 'beginPasskeyLogin', 'finishPasskeyLogin', 'recover', 'logout', 'logoutSaved', 'emailStart', 'emailConfirm', 'emailLoginStart', 'emailLoginConfirm', 'configureEmailLogin', 'credentialBegin', 'credentialFinish', 'renamePasskey', 'removePasskey', 'renameSession', 'revokeSession', 'revokeOtherSessions', 'createDeviceLogin', 'approveDeviceLogin', 'denyDeviceLogin', 'pollDeviceLogin', 'cancelDeviceLogin']);
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
export function createIdentityEngine(resources) {
  const identity = new IdentityService(resources);
  return new Engine({ providers: { identity: Provider.fromSingleton(identity) } });
}
