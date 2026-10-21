// Linked approval (docs/architecture/linked-approval.md, slice LA1): one request record for the `session` kind
// (provider-session extension) and the `app` kind (identity half of the device authorization grant), one
// HMAC-keyed user-code namespace, budgets for code guessing and approval lineage on the account record.
// The operation contract for LA2/LA4/LA5 is in linked-approval.md §10.1. New entry points are gated by
// config.deviceAuthorizationEnabled; the legacy /api/auth/device/* aliases (device-login.mjs) are not.
import { secureEqual, encode } from './crypto.mjs';

export const LINKED_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ', LINKED_CODE_SPACE = 20 ** 8;
const HOUR = 3600000, DAY = 86400000;
export const LINKED = Object.freeze({ sessionPendingMs: 300000, appPendingMs: 600000, interval: 5, maxInterval: 60, freshMs: 300000, appCapMs: 30 * DAY, appIdleMs: 7 * DAY, liveCap: 20000, slotMs: 600000, lineageLimit: 100 });
export const DEVICE_KINDS = Object.freeze({ tv: 'TV or shared screen', computer: 'Computer', phone: 'Phone or tablet' });
export const SESSION_CHOICES = Object.freeze({ '1h': HOUR, '8h': 8 * HOUR, session: Infinity }), APP_CHOICES = Object.freeze({ '1h': HOUR, '8h': 8 * HOUR, '30d': 30 * DAY });
// Charged per attempt (a superset of failures) before the code is evaluated, so an exhausted budget can never be
// passed by a correct guess. A legitimate approval spends two account units (resolve + approve).
export const RESOLVE_BUDGETS = Object.freeze({ account: [{ windowMs: 1800000, limit: 10 }, { windowMs: DAY, limit: 30 }], prefix: [{ windowMs: 900000, limit: 20 }, { windowMs: DAY, limit: 100 }], wide: { windowMs: DAY, limit: 200 }, hardAccount: { windowMs: 1800000, limit: 5 }, globalWindowMs: DAY });
const LIVE_SHARDS = 8;
export const START_LIMITS = Object.freeze({ address: { windowMs: 600000, limit: 10 }, network: { windowMs: 600000, limit: 50 } });
/** Daily typed-resolve budget G with G·L/N ≤ 0.01 expected discoveries (architecture §4.1). */
export const globalResolveBudget = live => Math.max(1, Math.floor(0.01 * LINKED_CODE_SPACE / Math.max(1, live)));
export const normalizeUserCode = value => typeof value === 'string' && value.length <= 32 ? value.toUpperCase().replace(/[\s-]/g, '') : '';
export const displayUserCode = code => `${code.slice(0, 4)}-${code.slice(4)}`;
const validCode = code => /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(code);
const requestID = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const codeParts = value => typeof value === 'string' && /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value) ? value.split('.') : null;
const pendingUntil = request => request.pendingUntil ?? request.expiresAt;
const plain = (value, max) => { try { return value !== null && typeof value === 'object' && JSON.stringify(value).length <= max; } catch { return false; } };
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** `E` and the idle bound for one approval (architecture §7.1); null for an unknown choice. */
export function linkedLifetime({ kind, choice, now, sessionExpiresAt, sessionTtlMs }) {
  const choices = kind === 'app' ? APP_CHOICES : SESSION_CHOICES; if (!Object.hasOwn(choices, choice)) return null;
  if (kind === 'app') { const expiresAt = Math.min(now + LINKED.appCapMs, now + choices[choice]); return { expiresAt, idleExpiresAt: Math.min(now + LINKED.appIdleMs, expiresAt) }; }
  return { expiresAt: Math.min(sessionExpiresAt, now + sessionTtlMs, now + choices[choice]) };
}
/** Duration options; session options that would reach the approving session's end collapse into `session`. */
export function linkedDurations({ kind, now, sessionExpiresAt, sessionTtlMs }) {
  if (kind === 'app') return Object.keys(APP_CHOICES).map(choice => ({ choice, ...linkedLifetime({ kind, choice, now }) }));
  const last = linkedLifetime({ kind, choice: 'session', now, sessionExpiresAt, sessionTtlMs }).expiresAt;
  return [...['1h', '8h'].map(choice => ({ choice, expiresAt: linkedLifetime({ kind, choice, now, sessionExpiresAt, sessionTtlMs }).expiresAt })).filter(option => option.expiresAt < last), { choice: 'session', expiresAt: last }];
}
/** Limit keys: `narrow` (IPv4 address or IPv6 /64), `wide` (/24 or /48) and `resolve` (/24 or /64). */
export function linkedNetwork(ip) {
  const unknown = { narrow: 'unknown', wide: 'unknown', resolve: 'unknown' }; if (typeof ip !== 'string' || ip.length > 64) return unknown;
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i); if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); ip = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) { const p = v4.slice(1).map(Number); if (p.some(part => part > 255)) return unknown; const net = `${p.slice(0, 3).join('.')}.0/24`; return { narrow: p.join('.'), wide: net, resolve: net }; }
  if (!/^[0-9a-f:]+$/i.test(ip) || ip.split('::').length > 2) return unknown;
  const [head, tail] = ip.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : [], fill = 8 - h.length - t.length;
  const groups = ip.includes('::') ? (fill < 1 ? null : [...h, ...Array(fill).fill('0'), ...t]) : h;
  if (!groups || groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return unknown;
  const g = groups.map(x => parseInt(x, 16).toString(16)), net64 = `${g.slice(0, 4).join(':')}::/64`;
  return { narrow: net64, wide: `${g.slice(0, 3).join(':')}::/48`, resolve: net64 };
}
/** Window counters. `consume(key,{windowMs,limit,units})` is atomic; `peek(key)` is optional. The in-memory
 * form is the non-durable poll limiter and the test double for the durable budget port. */
export class MemoryLinkedLimits {
  constructor(clock = () => Date.now()) { this.clock = clock; this.windows = new Map(); }
  async consume(key, { windowMs, limit, units = 1 }) {
    const now = this.clock(); let window = this.windows.get(key);
    if (!window || window.end <= now || window.end > now + 2 * windowMs) window = { count: 0, end: now + windowMs };
    if (window.count + units > limit) return false; window.count += units; this.windows.set(key, window);
    if (this.windows.size > 50000) for (const [name, value] of this.windows) if (value.end <= now) this.windows.delete(name);
    return true;
  }
  async peek(key) { const window = this.windows.get(key); return window && window.end > this.clock() ? window.count : 0; }
}

// Approval lineage on the account record: `linkedLineage` entries (app families approved from a session chain)
// survive natural session expiry; explicit termination moves their families to `lineageOutbox` in the same CAS.
export function pruneLineage(account, now) { if (Array.isArray(account.linkedLineage)) account.linkedLineage = account.linkedLineage.filter(entry => entry.expiresAt > now); }
export function revokeLineageWhere(account, match, now) {
  if (!Array.isArray(account.linkedLineage) || !account.linkedLineage.length) return 0;
  const keep = [], outbox = [...account.lineageOutbox ?? []];
  for (const entry of account.linkedLineage) {
    if (match(entry)) { for (const familyId of entry.families) if (!outbox.some(item => item.familyId === familyId)) outbox.push({ familyId, lineageId: entry.id, enqueuedAt: now }); }
    else keep.push(entry);
  }
  const revoked = account.linkedLineage.length - keep.length; account.linkedLineage = keep; account.lineageOutbox = outbox; return revoked;
}
/** Explicit termination of `sessionIds` (a Set, descendants included) ends every lineage whose chain touches them. */
export const revokeLineage = (account, sessionIds, now) => revokeLineageWhere(account, entry => entry.sessions.some(id => sessionIds.has(id)), now);
/** Recovery, suspension and deletion: every lineage ends, including ones whose sessions already expired. */
export const revokeAllLineage = (account, now) => revokeLineageWhere(account, () => true, now);

export class LinkedApproval {
  constructor(identity, Fault) { this.identity = identity; this.Fault = Fault; }
  fail(code, message = 'The sign-in request could not be completed.', extra = {}) { throw Object.assign(new this.Fault(code, message), extra); }
  invalid() { this.fail('invalid_code', "That code doesn't match a sign-in request. Check the code on your device."); }
  enabled() { if (this.identity.config.deviceAuthorizationEnabled !== true) this.fail('not_found', 'Linked approval is not enabled.'); }
  get repository() { const repository = this.identity.linkedApprovals; if (!repository) this.fail('device_unavailable', 'Device sign-in is not configured.'); return repository; }
  now() { return this.identity.clock(); }
  async save(request, revision) { request.revision = revision + 1; return this.repository.compareAndSwap(request.id, revision, request); }
  // The configured secret is never used directly: an HMAC derivation separates the code index from other uses.
  // A missing or short key disables code operations (fail closed). Only `linkedEphemeralKey: true` (tests,
  // single-process embeddings) opts into a per-instance random key; a Worker never may.
  key() {
    const raw = this.identity.config.linkedCodeKey, ephemeral = raw === undefined && this.identity.config.linkedEphemeralKey === true;
    if (!ephemeral && (typeof raw !== 'string' || raw.length < 16)) this.fail('device_unavailable', 'Device sign-in is not configured.');
    return this.codeKey ??= (async () => {
      const webcrypto = this.identity.crypto.crypto;
      const material = ephemeral ? webcrypto.getRandomValues(new Uint8Array(32)) : new TextEncoder().encode(raw);
      const root = await webcrypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const derived = await webcrypto.subtle.sign('HMAC', root, new TextEncoder().encode('bindle-linked-code-key-v1'));
      return webcrypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })();
  }
  async mac(purpose, value) { return encode(new Uint8Array(await this.identity.crypto.crypto.subtle.sign('HMAC', await this.key(), new TextEncoder().encode(`${purpose}\0${value}`)))); }
  newCode() {
    let code = ''; const webcrypto = this.identity.crypto.crypto;
    while (code.length < 8) for (const byte of webcrypto.getRandomValues(new Uint8Array(16))) { if (byte < 240 && code.length < 8) code += LINKED_ALPHABET[byte % 20]; }
    return code;
  }
  liveCap() { const cap = this.identity.config.linkedLiveCap; return Number.isSafeInteger(cap) && cap > 1 ? cap : LINKED.liveCap; }
  slot() { return Math.floor(this.now() / LINKED.slotMs); }
  // Live requests of both kinds: creations in the current and previous slot (≥ one request lifetime). Without a
  // counting limiter the cap is assumed, which keeps G at its smallest value.
  async live() { const limits = this.identity.linkedLimits; if (typeof limits?.peek !== 'function') return this.liveCap(); let total = 0; for (const slot of [this.slot(), this.slot() - 1]) for (let shard = 0; shard < LIVE_SHARDS; shard++) total += await limits.peek(`live:${slot}:${shard}`); return total; }
  async admit(context) {
    const limits = this.identity.linkedLimits, net = linkedNetwork(context?.remoteIP);
    // An unknown client address is never one shared bucket (that would be a service-wide lockout); such requests
    // rely on the Turnstile/client, live-cap and account limits. Adapters supply the trusted client IP.
    if (net.narrow !== 'unknown' && (!await limits.consume(`start-a:${await this.mac('limit', net.narrow)}`, START_LIMITS.address) || !await limits.consume(`start-n:${await this.mac('limit', net.wide)}`, START_LIMITS.network))) this.fail('rate_limited', 'Please wait before starting another sign-in.', { retryAfter: 600 });
    // The live cap is spread over LIVE_SHARDS counters (no single hot window); each holds cap/2/shards per slot.
    if (!await limits.consume(`live:${this.slot()}:${this.identity.crypto.crypto.getRandomValues(new Uint8Array(1))[0] % LIVE_SHARDS}`, { windowMs: 2 * LINKED.slotMs, limit: Math.ceil(this.liveCap() / 2 / LIVE_SHARDS) })) this.fail('temporarily_unavailable', 'Sign-in requests are busy. Try again in a minute.', { retryAfter: 60 });
  }
  async create(fields, context) {
    const identity = this.identity; await this.admit(context);
    const network = { trusted: context?.networkTrusted === true, ...context?.networkTrusted === true && typeof context.country === 'string' && /^[A-Z]{2}$/.test(context.country) ? { country: context.country } : {} };
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = identity.crypto.id(), deviceCode = `${id}.${identity.crypto.random()}`, code = this.newCode(), now = this.now(), pending = fields.kind === 'app' ? LINKED.appPendingMs : LINKED.sessionPendingMs;
      const request = { ...fields, id, version: 2, revision: 0, status: 'pending', userCodeHash: await this.mac('user-code', code), deviceHash: await identity.crypto.hash('device-code', deviceCode),
        createdAt: now, pendingUntil: now + pending, expiresAt: now + pending, interval: LINKED.interval, requester: { deviceKind: fields.deviceKind ?? null, network } };
      if (!await this.repository.create(request)) continue;
      // The first poll waits one interval, as before; this limiter is non-durable.
      await identity.linkedPollLimits.consume(`poll:${id}`, { windowMs: LINKED.interval * 1000, limit: 1 });
      return { request, deviceCode, code };
    }
    this.fail('conflict', 'Start sign-in again.');
  }
  /** `session` kind start. Legacy: free-text label, optional binding, `/device#request=` locator link. */
  async start(input, context, { legacy = false } = {}) {
    const identity = this.identity; if (!legacy) this.enabled(); await identity.guard('device', input, context);
    let label, deviceKind = null;
    if (legacy) { if (!text(input.label, 80)) this.fail('invalid_label', 'Give this device a name of 1–80 characters.'); label = input.label.trim(); }
    else {
      if (typeof input.deviceKind !== 'string' || !Object.hasOwn(DEVICE_KINDS, input.deviceKind)) this.fail('invalid_device_kind', 'Choose what kind of device this is.');
      if (typeof context.deviceBinding !== 'string' || context.deviceBinding.length < 32) this.fail('binding_required', 'Start sign-in again in this browser.');
      deviceKind = input.deviceKind; label = DEVICE_KINDS[deviceKind];
    }
    const bindingHash = context.deviceBinding ? await identity.crypto.hash('device-binding', context.deviceBinding) : null;
    const { request, deviceCode, code } = await this.create({ kind: 'session', ...legacy ? { legacy: true } : {}, label, deviceKind, bindingHash }, context), origin = identity.config.origin;
    if (legacy) { const verificationUri = `${origin}/device`; return { requestId: request.id, deviceCode, userCode: code, verificationUri, verificationUriComplete: `${verificationUri}#request=${request.id}`, expiresAt: request.pendingUntil, expiresIn: 300, interval: LINKED.interval }; }
    return { kind: 'session', requestId: request.id, deviceCode, userCode: displayUserCode(code), verificationUri: `${origin}/approve`, locatorUri: `${origin}/approve#r=${request.id}`, expiresAt: request.pendingUntil, expiresIn: 300, interval: LINKED.interval };
  }
  /** `app` kind start, called by the federation device endpoint (LA2) after client and request validation. */
  async startApp(input, context) {
    this.enabled(); const app = input ?? {};
    if (app.reviewed !== true) this.fail('unauthorized_client', 'This client is not eligible for device sign-in.');
    if (!text(app.clientId, 2048) || typeof app.host !== 'string' || !/^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(app.host) || (app.reviewedName !== undefined && !text(app.reviewedName, 80))
      || !Array.isArray(app.requests) || app.requests.length > 8 || !plain(app.requests, 8192) || (app.identityHint !== undefined && !text(app.identityHint, 254))
      || (app.entryId !== undefined && (typeof app.entryId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(app.entryId))) || typeof app.dpopJkt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(app.dpopJkt)) this.fail('invalid_request', 'The device authorization request is invalid.');
    const { request, deviceCode, code } = await this.create({ kind: 'app', bindingHash: null, dpopJkt: app.dpopJkt, app: { clientId: app.clientId, host: app.host, reviewedName: app.reviewedName ?? null, requests: structuredClone(app.requests), ...app.identityHint ? { identityHint: app.identityHint } : {}, ...app.entryId ? { entryId: app.entryId } : {} } }, context);
    return { kind: 'app', requestId: request.id, deviceCode, userCode: displayUserCode(code), verificationUri: `${this.identity.config.origin}/approve`, expiresAt: request.pendingUntil, expiresIn: LINKED.appPendingMs / 1000, interval: LINKED.interval };
  }
  limited(window) { this.fail('rate_limited', 'Too many codes tried. Wait before trying again.', { retryAfter: window.windowMs / 1000 }); }
  // Network budgets: /24 or /64 tiers plus an IPv6 /48 tier. An unknown address is keyed per account instead.
  async chargeNetwork(owner, context) {
    const limits = this.identity.linkedLimits, net = linkedNetwork(context?.remoteIP), base = net.resolve === 'unknown' ? `unknown:${owner}` : net.resolve, prefix = await this.mac('limit', base);
    for (const [index, window] of RESOLVE_BUDGETS.prefix.entries()) if (!await limits.consume(`resolve-p${index}:${prefix}`, window)) this.limited(window);
    if (net.wide.endsWith('/48') && !await limits.consume(`resolve-w:${await this.mac('limit', net.wide)}`, RESOLVE_BUDGETS.wide)) this.limited(RESOLVE_BUDGETS.wide);
  }
  /** Account budget always, before evaluation. Typed codes also pay the network and global budgets before
   * evaluation; locator attempts (1/N per guess) pay the network budget only when they miss (`missed`), so a
   * shared NAT cannot be locked out of QR/locator approvals by someone else's guessing. */
  async charge(owner, context, { typed, turnstileToken }) {
    const identity = this.identity, limits = identity.linkedLimits, limited = window => this.limited(window);
    for (const [index, window] of RESOLVE_BUDGETS.account.entries()) if (!await limits.consume(`resolve-a${index}:${owner}`, window)) limited(window);
    if (!typed) return;
    await this.chargeNetwork(owner, context);
    if (await limits.consume('resolve-g', { windowMs: RESOLVE_BUDGETS.globalWindowMs, limit: globalResolveBudget(await this.live()) })) return;
    // The global budget is spent: typed codes need a challenge per attempt and half the account budget, or are
    // refused by the operator; locator resolution keeps working.
    if (identity.config.linkedTypedResolution === 'refused') this.fail('typed_resolution_unavailable', "Codes can be checked only from the device's QR code or link right now.");
    if (typeof turnstileToken !== 'string' || turnstileToken.length > 4096 || !await identity.turnstile.verify({ token: turnstileToken, remoteIP: context?.remoteIP, action: 'linked-resolve', hostname: new URL(identity.config.origin).hostname })) this.fail('challenge_required', 'Complete the security check to continue.');
    if (!await limits.consume(`resolve-h:${owner}`, RESOLVE_BUDGETS.hardAccount)) limited(RESOLVE_BUDGETS.hardAccount);
  }
  /** The record the code names (by locator or the code index), whatever its state, or null. */
  async find({ code, locator }) {
    code = normalizeUserCode(code); if (!validCode(code) || (locator !== undefined && !requestID(locator))) return null;
    const userCodeHash = await this.mac('user-code', code), request = locator !== undefined ? await this.repository.get(locator) : await this.repository.findByUserCode(userCodeHash);
    return request && request.version === 2 && ['session', 'app'].includes(request.kind) && secureEqual(request.userCodeHash, userCodeHash) ? request : null;
  }
  freshSignIn(session, request) { const now = this.now(); return session.source === 'credential' && Number.isSafeInteger(session.createdAt) && session.createdAt <= now && session.createdAt >= request.createdAt && session.createdAt + LINKED.freshMs > now; }
  fresh(session, request) { return request.kind === 'app' ? this.freshSignIn(session, request) : this.identity.authAt(session) + LINKED.freshMs > this.now(); }
  async review(request, account, session, context) {
    const identity = this.identity, now = this.now(), app = request.kind === 'app', network = request.requester?.network ?? {};
    const hint = app && typeof request.app.identityHint === 'string' ? request.app.identityHint.toLowerCase().replace(/^@/, '').replace(`@${identity.config.rpID}`, '') : null;
    const sameBrowser = Boolean(request.bindingHash && typeof context?.deviceBinding === 'string' && secureEqual(request.bindingHash, await identity.crypto.hash('device-binding', context.deviceBinding)));
    return { requestId: request.id, kind: request.kind, createdAt: request.createdAt, expiresAt: pendingUntil(request), account: { id: account.id, handle: account.handle },
      requester: { deviceKind: request.deviceKind ?? null },
      ...app ? { app: { clientId: request.app.clientId, host: request.app.host, reviewedName: request.app.reviewedName ?? null, requests: structuredClone(request.app.requests), preselect: Boolean(hint && [account.handle, account.paidHandle].includes(hint)) }, idleLimitMs: LINKED.appIdleMs } : {},
      warnings: { countryMismatch: Boolean(network.trusted && network.country && context?.networkTrusted === true && typeof context.country === 'string' && context.country !== network.country), sameBrowser },
      freshness: { required: app ? 'sign-in' : 'step-up', satisfied: this.fresh(session, request) },
      durations: linkedDurations({ kind: request.kind, now, sessionExpiresAt: session.expiresAt, sessionTtlMs: identity.config.sessionTtlMs }), defaultChoice: app ? '1h' : 'session' };
  }
  /** Signed-in members only. Every miss is the same `invalid_code`; nothing is written, so the requester cannot
   * observe a resolve (pre-consent privacy). */
  async resolve(input, context, { legacy = false } = {}) {
    if (!legacy) this.enabled(); const { account, session } = await this.identity.authorized(context, true), locator = input.locator ?? input.requestId;
    await this.charge(account.id, context, { typed: locator === undefined, turnstileToken: input.turnstileToken });
    const request = await this.find({ code: input.code ?? input.userCode, locator });
    if (!request || request.status !== 'pending' || pendingUntil(request) <= this.now() || (legacy && request.kind !== 'session')) { if (locator !== undefined) await this.chargeNetwork(account.id, context); this.invalid(); }
    if (legacy) return { requestId: request.id, label: request.label, status: request.status, expiresAt: pendingUntil(request) };
    return this.review(request, account, session, context);
  }
  async decidable(input, context) {
    const { account, session } = await this.identity.authorized(context, true);
    return { account, session, check: async () => {
      await this.charge(account.id, context, { typed: false });
      if (!requestID(input.requestId)) this.invalid();
      const request = await this.find({ code: input.code ?? input.userCode, locator: input.requestId });
      if (!request || pendingUntil(request) <= this.now()) { await this.chargeNetwork(account.id, context); this.invalid(); }
      if (request.status !== 'pending') this.fail('conflict', 'This request was already decided.');
      return request;
    } };
  }
  async approve(input, context, { legacy = false } = {}) {
    if (!legacy) this.enabled(); const identity = this.identity, { account, session, check } = await this.decidable(input, context);
    if (input.approved !== true || ((legacy || input.accountHandle !== undefined) && input.accountHandle !== account.handle)) this.fail('confirmation_required', 'Confirm the account and code shown on the device you are signing in.');
    const request = await check(), app = request.kind === 'app', now = this.now();
    if (legacy && app) this.invalid();
    if (app && !this.freshSignIn(session, request)) this.fail('fresh_sign_in_required', 'Sign in with your passkey or password to approve this app.');
    if (!app && identity.authAt(session) + LINKED.freshMs <= now) this.fail('reauthentication_required', 'Confirm your password or passkey before approving this sign-in.');
    const choice = legacy ? 'session' : input.choice ?? (app ? '1h' : 'session'), lifetime = linkedLifetime({ kind: request.kind, choice, now, sessionExpiresAt: session.expiresAt, sessionTtlMs: identity.config.sessionTtlMs });
    if (!lifetime) this.fail('invalid_choice', 'Choose how long this sign-in lasts.');
    if (input.consent !== undefined && (!app || !plain(input.consent, 4096) || Array.isArray(input.consent))) this.fail('invalid_consent', 'Review the requested access again.');
    const revision = request.revision; delete request.requester?.network;
    request.status = 'approved'; request.owner = account.id;
    request.approval = { sessionId: await identity.sessionID(session), sessionHash: session.hash, sessionExpiresAt: session.expiresAt, authAt: identity.authAt(session), approvedAt: now, choice, ...lifetime, ...input.consent !== undefined ? { consent: structuredClone(input.consent) } : {} };
    if (!await this.save(request, revision)) this.fail('conflict', 'This request was already decided.');
    await this.notify(request);
    return { approved: true, requestId: request.id, kind: request.kind, ...lifetime };
  }
  // After-approval notice (architecture §8): the verified host or device kind only, never requester text; delivery
  // is the injected gated adapter and never affects the approval.
  async notify(request) {
    const identity = this.identity, notices = identity.approvalNotices; if (typeof notices?.approved !== 'function') return;
    try { await notices.approved(Object.freeze({ type: 'linked-approval', owner: request.owner, kind: request.kind, subject: Object.freeze(request.kind === 'app' ? { host: request.app.host } : { deviceKind: request.deviceKind ?? null }), approvedAt: request.approval.approvedAt, expiresAt: request.approval.expiresAt, consoleUrl: `${identity.config.origin}/` })); } catch {}
  }
  async deny(input, context, { legacy = false } = {}) {
    if (!legacy) this.enabled(); const request = await (await this.decidable(input, context)).check();
    if (legacy && request.kind !== 'session') this.invalid();
    const revision = request.revision; delete request.requester?.network; request.status = 'denied'; request.deniedAt = this.now();
    if (!await this.save(request, revision)) this.fail('conflict', 'This request was already decided.');
    return { denied: true };
  }
  async secret(input, context) {
    const identity = this.identity; identity.origin(context);
    if (!await identity.rateLimiter.check({ operation: 'device-poll', remoteIP: context.remoteIP })) this.fail('rate_limited');
    const parts = codeParts(input.deviceCode); if (!parts) this.fail('unauthorized');
    const request = await this.repository.get(parts[0]);
    if (!request || request.kind !== 'session' || !secureEqual(request.deviceHash, await identity.crypto.hash('device-code', input.deviceCode))) this.fail('unauthorized');
    if (request.bindingHash && (typeof context.deviceBinding !== 'string' || !secureEqual(request.bindingHash, await identity.crypto.hash('device-binding', context.deviceBinding)))) this.fail('unauthorized');
    return request;
  }
  // Interval enforcement in the non-durable limiter: polls never write the request (architecture §9).
  async pace(request) {
    const limits = this.identity.linkedPollLimits, slow = typeof limits.peek === 'function' ? await limits.peek(`poll-slow:${request.id}`) : 0, interval = Math.min(request.interval + 5 * slow, LINKED.maxInterval);
    if (await limits.consume(`poll:${request.id}`, { windowMs: interval * 1000, limit: 1 })) return { ok: true, interval };
    await limits.consume(`poll-slow:${request.id}`, { windowMs: 300000, limit: 1000 }); return { ok: false, interval: Math.min(interval + 5, LINKED.maxInterval) };
  }
  parent(account, request) { const now = this.now(); return account?.status === 'active' ? account.sessions.find(s => secureEqual(s.hash, request.approval?.sessionHash) && s.expiresAt > now) : undefined; }
  state(request) {
    if (request.status === 'consumed') return { status: 'expired_token' };
    if (['denied', 'cancelled'].includes(request.status)) return { status: 'access_denied' };
    if (pendingUntil(request) <= this.now()) return { status: 'expired_token' };
    return null;
  }
  /** `session` poll. An approved request answers `confirm` without consuming; `accept` consumes (LA-15). A
   * legacy request keeps the one-step consume until LA5 ships the confirmation screen. */
  async poll(input, context, { legacy = false } = {}) {
    if (!legacy) this.enabled(); const request = await this.secret(input, context), closed = this.state(request); if (closed) return closed;
    const pace = await this.pace(request); if (!pace.ok) return { status: 'slow_down', interval: pace.interval };
    if (request.status !== 'approved') return { status: 'authorization_pending', interval: pace.interval };
    if (request.legacy) return this.consume(request);
    const account = await this.identity.repository.get(request.owner), parent = this.parent(account, request); if (!parent) return { status: 'access_denied' };
    return { status: 'confirm', account: { handle: account.handle }, expiresAt: Math.min(parent.expiresAt, request.approval.expiresAt) };
  }
  async accept(input, context) {
    this.enabled(); const request = await this.secret(input, context); if (request.legacy) this.fail('unauthorized');
    const closed = this.state(request); if (closed) return closed;
    if (request.status !== 'approved') return { status: 'authorization_pending', interval: request.interval };
    return this.consume(request);
  }
  // Prepare against one pre-consume account revision. Cancellation advances that revision even when this session
  // has not reached account storage yet (device-login-cancellation-review.md).
  async consume(request) {
    const identity = this.identity, revision = request.revision, account = await identity.repository.get(request.owner), parent = this.parent(account, request);
    if (!parent) return { status: 'access_denied' };
    const accountRevision = account.revision, now = this.now();
    const result = await identity.session(account, { label: request.label, source: request.legacy ? 'device-approval' : 'linked-approval', parentSessionId: await identity.sessionID(parent), expiresAt: Math.min(parent.expiresAt, request.approval.expiresAt) });
    const issued = account.sessions.at(-1); issued.deviceRequestId = request.id;
    request.issuedSessionHash = issued.hash; request.issuedSessionId = issued.id; request.status = 'consumed'; request.consumedAt = now;
    request.expiresAt = Math.max(request.expiresAt, issued.expiresAt); // kept until E so cancellation can still revoke
    if (pendingUntil(request) <= now || !await this.save(request, revision)) return { status: 'expired_token' };
    identity.audit(account, request.legacy ? 'device-login-approved' : 'linked-session-approved');
    // Never reload/retry this prepared session after a failed account CAS.
    await identity.save(account, accountRevision);
    const current = await this.repository.get(request.id);
    if (!current || current.status !== 'consumed' || current.issuedSessionHash !== request.issuedSessionHash) { await this.revokeIssued(request); return { status: 'access_denied' }; }
    return { status: 'authorized', ...result };
  }
  async cancel(input, context) {
    const original = await this.secret(input, context);
    for (let attempt = 0, request = original; attempt < 4; attempt++) {
      if (!request || request.id !== original.id || request.deviceHash !== original.deviceHash || request.bindingHash !== original.bindingHash || (original.owner && request.owner !== original.owner)) this.fail('unauthorized');
      if (request.status === 'denied') return { cancelled: false, reason: 'denied' };
      // Older consumed records cannot identify their session. Never guess by label/source or revoke unrelated
      // sessions to claim cancellation worked.
      if ((request.status === 'consumed' || request.consumedAt !== undefined) && !request.issuedSessionHash) return { cancelled: false, reason: 'session_not_linked' };
      if (!['pending', 'approved', 'consumed', 'cancelled'].includes(request.status)) this.fail('conflict');
      if (request.status !== 'cancelled') {
        const revision = request.revision; request.status = 'cancelled'; delete request.requester?.network;
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
      await identity.pruneSessions(account, session => secureEqual(session.hash, request.issuedSessionHash));
      // Even if absent, advance the account revision to fence the poll's sole prepared save. Reload/retry is
      // allowed for cleanup, never for issuance.
      identity.audit(account, 'device-login-cancelled');
      try { await identity.save(account, revision); return; }
      catch (error) { if (error.code !== 'conflict') throw error; }
    }
    this.fail('conflict', 'Cancellation could not be confirmed. Try cancelling again.');
  }
  // ---- `app` kind, called by the federation engine (LA2) after DPoP verification; never routed directly.
  async appRequest(input) {
    const parts = codeParts(input?.deviceCode); if (!parts) return { failure: 'invalid_grant' };
    const request = await this.repository.get(parts[0]);
    if (!request || request.kind !== 'app' || !secureEqual(request.deviceHash, await this.identity.crypto.hash('device-code', input.deviceCode))) return { failure: 'invalid_grant' };
    if (typeof input.dpopJkt !== 'string' || !secureEqual(request.dpopJkt, input.dpopJkt)) return { failure: 'invalid_dpop_proof' };
    if (input.clientId !== request.app.clientId) return { failure: 'invalid_grant' };
    return { request };
  }
  /** Device-code redemption: RFC 8628 statuses, or `approved` with a reserved family and lineage. Order: single
   * consume (request CAS) → lineage reservation (account CAS, approving session live) → LA2 writes the family →
   * LA2 re-checks `lineageLive` and revokes the family if the lineage ended meanwhile. */
  async redeem(input, context) {
    this.enabled(); const identity = this.identity;
    if (!await identity.rateLimiter.check({ operation: 'device-poll', remoteIP: context?.remoteIP })) return { status: 'slow_down', interval: LINKED.interval + 5 };
    const { request, failure } = await this.appRequest(input); if (failure) return { status: failure };
    if (request.status === 'consumed') return { status: 'invalid_grant' };
    if (['denied', 'cancelled'].includes(request.status)) return { status: 'access_denied' };
    if (pendingUntil(request) <= this.now()) return { status: 'expired_token' };
    const pace = await this.pace(request); if (!pace.ok) return { status: 'slow_down', interval: pace.interval };
    if (request.status !== 'approved') return { status: 'authorization_pending', interval: pace.interval };
    const holder = await identity.repository.get(request.owner); pruneLineage(holder ?? {}, this.now());
    if (!this.parent(holder, request) || (holder.linkedLineage ?? []).length >= LINKED.lineageLimit) return { status: 'access_denied' }; // checked before the consume
    const revision = request.revision; request.status = 'consumed'; request.consumedAt = this.now(); request.issuedFamilyId = identity.crypto.random(); request.lineageId = identity.crypto.id(); delete request.requester?.network;
    if (!await this.save(request, revision)) return { status: 'invalid_grant' };
    // A reservation that cannot commit closes the request; the client sees only RFC 8628 statuses.
    let reserved = false; try { reserved = await this.reserve(request); } catch (error) { if (!['temporarily_unavailable', 'conflict'].includes(error.code)) throw error; }
    if (!reserved) return { status: 'access_denied' };
    const { approval, app } = request;
    return { status: 'approved', owner: request.owner, clientId: app.clientId, host: app.host, requests: structuredClone(app.requests), ...app.entryId ? { entryId: app.entryId } : {}, ...approval.consent ? { consent: structuredClone(approval.consent) } : {},
      familyId: request.issuedFamilyId, lineageId: request.lineageId, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt, idleExpiresAt: approval.idleExpiresAt, idleMs: LINKED.appIdleMs };
  }
  async reserve(request) {
    const identity = this.identity;
    for (let attempt = 0; attempt < 4; attempt++) {
      const account = await identity.repository.get(request.owner), now = this.now();
      if (account?.linkedLineage?.some(entry => entry.id === request.lineageId)) return true; // an earlier attempt committed
      const parent = this.parent(account, request); if (!parent) return false;
      const revision = account.revision, sessions = [await identity.sessionID(parent)];
      for (let id = parent.parentSessionId; id && !sessions.includes(id) && sessions.length < 16; id = account.sessions.find(s => s.id === id)?.parentSessionId) sessions.push(id);
      pruneLineage(account, now);
      if ((account.linkedLineage ?? []).length >= LINKED.lineageLimit) this.fail('temporarily_unavailable', 'Too many apps are signed in from this account. Sign out of some apps first.');
      account.linkedLineage = [...account.linkedLineage ?? [], { id: request.lineageId, sessions, sessionExpiresAt: parent.expiresAt, families: [request.issuedFamilyId], clientId: request.app.clientId, host: request.app.host, createdAt: now, expiresAt: request.approval.expiresAt }];
      parent.derivedFamilies = [...parent.derivedFamilies ?? [], request.issuedFamilyId];
      identity.audit(account, 'linked-app-approved');
      try { await identity.save(account, revision); return true; }
      catch (error) { if (error.code !== 'conflict') throw error; }
    }
    this.fail('conflict', 'The account changed; start sign-in again.');
  }
  /** Refresh-time backstop: false once the lineage was revoked, the approving chain was explicitly ended or the
   * account is not active. Natural expiry of the approving session does not end it. Never throws for a disabled
   * feature, so a refresh fails closed. */
  async lineageLive({ owner, lineageId, familyId } = {}) {
    if (this.identity.config.deviceAuthorizationEnabled !== true || !requestID(owner) || typeof lineageId !== 'string' || typeof familyId !== 'string') return false;
    const account = await this.identity.repository.get(owner), now = this.now(); if (!account || account.status !== 'active') return false;
    const entry = account.linkedLineage?.find(item => item.id === lineageId); if (!entry || !entry.families.includes(familyId) || entry.expiresAt <= now) return false;
    // Before its natural end the approving session must still exist: catches any removal path that bypassed lineage.
    if (now < entry.sessionExpiresAt && !account.sessions.some(s => s.id === entry.sessions[0] && s.expiresAt > now)) return false;
    return true;
  }
  async withAccount(owner, change) {
    if (!requestID(owner)) this.fail('not_found');
    for (let attempt = 0; attempt < 4; attempt++) {
      const account = await this.identity.repository.get(owner); if (!account) return null;
      const revision = account.revision, result = await change(account); if (result === undefined) return null;
      try { await this.identity.save(account, revision); return result; } catch (error) { if (error.code !== 'conflict') throw error; }
    }
    this.fail('conflict');
  }
  /** Explicit app revocation (connected apps, client cancel): the lineage ends and its families enter the outbox. */
  async lineageRevoke({ owner, lineageId } = {}) {
    return await this.withAccount(owner, account => revokeLineageWhere(account, entry => entry.id === lineageId, this.now()) ? { revoked: true } : undefined) ?? { revoked: false };
  }
  async outbox({ owner } = {}) { if (!requestID(owner)) return []; const account = await this.identity.repository.get(owner); return structuredClone(account?.lineageOutbox ?? []); }
  async outboxAck({ owner, familyIds } = {}) {
    if (!Array.isArray(familyIds) || familyIds.length > 200 || familyIds.some(id => typeof id !== 'string')) this.fail('invalid_request');
    return await this.withAccount(owner, account => { const before = account.lineageOutbox?.length ?? 0; if (!before) return undefined; account.lineageOutbox = account.lineageOutbox.filter(item => !familyIds.includes(item.familyId)); return account.lineageOutbox.length === before ? undefined : { acknowledged: before - account.lineageOutbox.length }; }) ?? { acknowledged: 0 };
  }
  /** Client cancellation of an `app` request (DPoP verified by LA2). After redemption it revokes the lineage. */
  async cancelApp(input) {
    this.enabled(); const { request, failure } = await this.appRequest(input); if (failure) this.fail(failure === 'invalid_dpop_proof' ? 'invalid_dpop_proof' : 'invalid_grant');
    for (let attempt = 0, current = request; attempt < 4; attempt++) {
      if (!current || current.id !== request.id) this.fail('invalid_grant');
      if (current.status === 'denied') return { cancelled: false, reason: 'denied' };
      if (current.status === 'consumed') { await this.lineageRevoke({ owner: current.owner, lineageId: current.lineageId }); return { cancelled: true }; }
      if (current.status === 'cancelled') return { cancelled: true };
      const revision = current.revision; current.status = 'cancelled'; delete current.requester?.network;
      if (await this.save(current, revision)) return { cancelled: true };
      current = await this.repository.get(request.id);
    }
    this.fail('conflict', 'Cancellation could not be confirmed. Try cancelling again.');
  }
}
