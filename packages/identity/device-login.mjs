// One-release alias of the legacy /api/auth/device/* operations over LinkedApproval (`session` kind; architecture
// §11–§12). It applies the new rules: base-20 codes in the HMAC index, the typed code re-matched with the locator,
// 5-minute credential freshness, resolve budgets and no anonymous inspect. Only the free-text label, the optional
// binding, the `/device#request=` locator link and the one-step poll consume remain until LA4/LA5 replace them.
// Not gated by DEVICE_AUTHORIZATION_ENABLED: existing QR sign-in keeps working.
import { LinkedApproval } from './linked-approval.mjs';

const legacyCode = error => { if (error?.code === 'invalid_code') { error.code = 'invalid_device_request'; error.message = 'This code is invalid or expired. Start again on your device.'; } throw error; };
export class DeviceLogin {
  constructor(identity, Fault) { this.flow = typeof identity.linkedFlow === 'function' ? identity.linkedFlow() : new LinkedApproval(identity, Fault); }
  create(input, context) { return this.flow.start(input, context, { legacy: true }); }
  inspect(input, context) { return this.flow.resolve(input, context, { legacy: true }).catch(legacyCode); }
  approve(input, context) { return this.flow.approve(input, context, { legacy: true }).catch(legacyCode); }
  deny(input, context) { return this.flow.deny(input, context, { legacy: true }).catch(legacyCode); }
  poll(input, context) { return this.flow.poll(input, context, { legacy: true }); }
  cancel(input, context) { return this.flow.cancel(input, context); }
}
