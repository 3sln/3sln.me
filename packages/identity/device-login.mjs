import { secureEqual } from './crypto.mjs';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const requestID = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const codeParts = value => typeof value === 'string' && /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value) ? value.split('.') : null;
const code = value => typeof value === 'string' ? value.toUpperCase().replaceAll('-', '').replaceAll(' ', '') : '';
const publicRequest = request => ({ requestId: request.id, userCode: request.userCode, label: request.label, status: request.status, expiresAt: request.expiresAt });

export class DeviceLogin {
  constructor(identity, Fault) { this.identity = identity; this.Fault = Fault; }
  fail(code, message = 'Device sign-in could not be completed.') { throw new this.Fault(code, message); }
  get repository() {
    if (!this.identity.deviceRequests) this.fail('device_unavailable', 'Device sign-in is not configured.');
    return this.identity.deviceRequests;
  }
  async save(request, revision) {
    request.revision = revision + 1;
    return this.repository.compareAndSwap(request.id, revision, request);
  }
  async create(input, context) {
    const identity = this.identity; const repository = this.repository;
    await identity.guard('device', input, context);
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\u0000-\u001f\u007f]/.test(input.label)) this.fail('invalid_label', 'Give this device a name of 1–80 characters.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = identity.crypto.id(); const deviceCode = `${id}.${identity.crypto.random()}`;
      const userCode = [...identity.crypto.crypto.getRandomValues(new Uint8Array(8))].map(byte => alphabet[byte & 31]).join('');
      const request = { id, userCode, label: input.label.trim(), revision: 0, status: 'pending',
        createdAt: identity.clock(), expiresAt: identity.clock() + 300000, interval: 5,
        nextPollAt: identity.clock() + 5000, deviceHash: await identity.crypto.hash('device-code', deviceCode),
        bindingHash: context.deviceBinding ? await identity.crypto.hash('device-binding', context.deviceBinding) : null };
      if (!await repository.create(request)) continue;
      const verificationUri = `${identity.config.origin}/device`;
      return { requestId: id, deviceCode, userCode, verificationUri,
        verificationUriComplete: `${verificationUri}#request=${id}&code=${userCode}`, expiresAt: request.expiresAt, expiresIn: 300, interval: 5 };
    }
    this.fail('conflict', 'Start device sign-in again.');
  }
  async lookup(input, context) {
    const identity = this.identity; identity.origin(context);
    if (!await identity.rateLimiter.check({ operation: 'device-code', remoteIP: context.remoteIP })) this.fail('rate_limited');
    const userCode = code(input.userCode);
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(userCode)) this.fail('invalid_device_request', 'Check the code shown on your device.');
    let request;
    if (input.requestId !== undefined) {
      if (!requestID(input.requestId)) this.fail('invalid_device_request');
      request = await this.repository.get(input.requestId);
    } else request = await this.repository.findByUserCode(userCode);
    if (!request || !secureEqual(request.userCode, userCode) || request.expiresAt <= identity.clock() || ['consumed', 'cancelled'].includes(request.status)) this.fail('invalid_device_request', 'This code is invalid or expired. Start again on your device.');
    return request;
  }
  async inspect(input, context) { return publicRequest(await this.lookup(input, context)); }
  async approve(input, context) {
    const identity = this.identity; const { account, session } = await identity.recent(context);
    if (input.approved !== true || input.accountHandle !== account.handle) this.fail('confirmation_required', 'Confirm the account and code shown on the device you are signing in.');
    const request = await this.lookup(input, context); const revision = request.revision;
    if (request.status !== 'pending') this.fail('conflict', 'This device request has already been decided.');
    request.status = 'approved'; request.owner = account.id; request.approvalSessionHash = session.hash; request.approvedAt = identity.clock();
    if (!await this.save(request, revision)) this.fail('conflict');
    return { approved: true, requestId: request.id };
  }
  async deny(input, context) {
    await this.identity.recent(context); const request = await this.lookup(input, context); const revision = request.revision;
    if (request.status !== 'pending') this.fail('conflict');
    request.status = 'denied';
    if (!await this.save(request, revision)) this.fail('conflict');
    return { denied: true };
  }
  async secret(input, context) {
    const identity = this.identity; identity.origin(context);
    if (!await identity.rateLimiter.check({ operation: 'device-poll', remoteIP: context.remoteIP })) this.fail('rate_limited');
    const parts = codeParts(input.deviceCode); if (!parts) this.fail('unauthorized');
    const request = await this.repository.get(parts[0]);
    if (!request || !secureEqual(request.deviceHash, await identity.crypto.hash('device-code', input.deviceCode))) this.fail('unauthorized');
    if (request.bindingHash && (typeof context.deviceBinding !== 'string' || !secureEqual(request.bindingHash, await identity.crypto.hash('device-binding', context.deviceBinding)))) this.fail('unauthorized');
    return request;
  }
  async cancel(input, context) {
    const original = await this.secret(input, context);
    for (let attempt = 0, request = original; attempt < 4; attempt++) {
      if (!request || request.id !== original.id || request.deviceHash !== original.deviceHash || request.bindingHash !== original.bindingHash || (original.owner && request.owner !== original.owner)) this.fail('unauthorized');
      if (request.status === 'denied') return { cancelled: false, reason: 'denied' };
      // Older consumed records cannot identify their session. Never guess by
      // label/source or revoke unrelated sessions to claim cancellation worked.
      if ((request.status === 'consumed' || request.consumedAt !== undefined) && !request.issuedSessionHash) return { cancelled: false, reason: 'session_not_linked' };
      if (!['pending', 'approved', 'consumed', 'cancelled'].includes(request.status)) this.fail('conflict');
      if (request.status !== 'cancelled') {
        const revision = request.revision; request.status = 'cancelled';
        if (!await this.save(request, revision)) { request = await this.repository.get(original.id); continue; }
      }
      if (request.issuedSessionHash) await this.revokeIssued(request);
      return { cancelled: true };
    }
    this.fail('conflict', 'Cancellation could not be confirmed. Try cancelling again.');
  }
  async revokeIssued(request) {
    if (!requestID(request.owner) || !requestID(request.issuedSessionId) || typeof request.issuedSessionHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.issuedSessionHash)) this.fail('conflict');
    const identity = this.identity;
    for (let attempt = 0; attempt < 4; attempt++) {
      const account = await identity.repository.get(request.owner);
      if (!account) return; // A stale CAS cannot recreate a deleted account.
      const revision = account.revision;
      account.sessions = account.sessions.filter(session => !secureEqual(session.hash, request.issuedSessionHash));
      // Even if absent, advance the account revision to fence the poll's sole
      // prepared save. Reload/retry is allowed for cleanup, never for issuance.
      identity.audit(account, 'device-login-cancelled');
      try { await identity.save(account, revision); return; }
      catch (error) { if (error.code !== 'conflict') throw error; }
    }
    this.fail('conflict', 'Cancellation could not be confirmed. Try cancelling again.');
  }
  async poll(input, context) {
    const identity = this.identity; const request = await this.secret(input, context); const revision = request.revision;
    if (request.expiresAt <= identity.clock() || request.status === 'consumed') return { status: 'expired_token' };
    if (['denied', 'cancelled'].includes(request.status)) return { status: 'access_denied' };
    if (request.nextPollAt > identity.clock()) {
      request.interval = Math.min(request.interval + 5, 60); request.nextPollAt = identity.clock() + request.interval * 1000;
      if (!await this.save(request, revision)) return { status: 'slow_down', interval: request.interval };
      return { status: 'slow_down', interval: request.interval };
    }
    if (request.status !== 'approved') {
      request.nextPollAt = identity.clock() + request.interval * 1000;
      if (!await this.save(request, revision)) return { status: 'slow_down', interval: request.interval + 5 };
      return { status: 'authorization_pending', interval: request.interval };
    }
    // Prepare against one pre-consume account revision. Cancellation advances
    // that revision even when this session has not reached account storage yet.
    const account = await identity.repository.get(request.owner);
    if (!account || account.status !== 'active' || !account.sessions.some(session => secureEqual(session.hash, request.approvalSessionHash) && session.expiresAt > identity.clock())) return { status: 'access_denied' };
    const accountRevision = account.revision;
    const result = await identity.session(account, { label: request.label, source: 'device-approval' });
    const issued = account.sessions.at(-1); issued.deviceRequestId = request.id;
    request.issuedSessionHash = issued.hash; request.issuedSessionId = issued.id;
    request.status = 'consumed'; request.consumedAt = identity.clock();
    if (request.expiresAt <= identity.clock() || !await this.save(request, revision)) return { status: 'expired_token' };
    identity.audit(account, 'device-login-approved');
    // Never reload/retry this prepared session after a failed account CAS.
    await identity.save(account, accountRevision);
    const current = await this.repository.get(request.id);
    if (!current || current.status !== 'consumed' || current.issuedSessionHash !== request.issuedSessionHash) {
      await this.revokeIssued(request);
      return { status: 'access_denied' };
    }
    return { status: 'authorized', ...result };
  }
}
