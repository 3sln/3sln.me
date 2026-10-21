// Core feature key-delegation.v1, provider side (docs/spec/bindlebox.md §3.2–§3.4; messaging-extraction.md slice C3;
// messaging-app.md §4). The provider certifies an app-held per-user P-256 delegate key with a short-lived compact JWS
// signed by the owner's current identity signing key (packages/identity/keys.mjs). Engine-first: DelegationRegistry is
// the provider resource, and the Actions/Queries below are the operations over it. Everything is refused with
// `not_found` unless BINDLEBOX_ENABLED is on.
//
// Core may not import BindleBox (tests/bindlebox/import-boundary.test.mjs), so the certificate encoding is written
// here against packages/bindlebox-protocol/certificate.mjs (parseDelegation/verifyDelegation) and pinned to it by the
// cross-test in tests/key-delegation.test.mjs: header exactly {alg:'ES256', kid, typ:'bindle-key-delegation+jwt'},
// payload exactly {bindle, v, iss, sub, delegate, jkt, purposes, client, cnx, since, jti, iat, exp}.
//
// Rules (spec §3.2):
//   - Only the current messaging-ingress occupant, as reported by the `occupant({owner, slot})` port ->
//     {clientId, origin, ingress, cnx, purposes} | null, is certified, and only for purposes it reports as consented
//     that this provider recognizes (author, receipt, archive). No port, a failing port, or another occupant means
//     `forbidden`; occupancy is re-read before signing and again before commit. `client` and `cnx` come from the port,
//     never from the request. EXT-X4 connections and C1b slot handoff supply the real port later.
//   - The app proves possession of the delegate private key (`proof`, below), and a key that is (or was) one of the
//     owner's identity keys is refused, so identity and delegate keys never alias.
//   - Lifetime: host-configured seconds (`DELEGATION_CERTIFICATE_SECONDS`, default and maximum 86400, minimum 300);
//     an app may ask for less. The 24 h value is a provisional default pending the user's answer (DEVLOG 2026-10-20).
//   - Certifying a new jkt revokes every other active jkt of the owner in the same transaction (all certified
//     purposes are BindleBox purposes), so at most one delegate key signs for a principal. A revoked jkt is never
//     certified again, and an active jkt never moves to another client or connection incarnation.
//   - Renewal re-certifies the same active jkt with the same `since`; while the stored certificate has at least half
//     its lifetime left and nothing it names changed, the stored one is returned without signing.
//   - Revocation: by jkt (owner, or the app for its own keys), by client_id (owner or system: a breached app or an
//     uninstall), or all (owner or system: suspension). `reconcile` persists what the status check already reports
//     when the occupant changed.
//
// Status (spec §3.4, public): {status:'active'} only for an active jkt whose client and cnx are the current occupant's;
// a persisted revocation answers {status:'revoked', revokedHour} (Unix hours, floored); an unknown or pruned jkt and
// an unknown or inactive subject answer exactly {status:'revoked'}, so nothing distinguishes accounts or keys the
// caller does not already hold a certificate for. The first observed occupant or consent mismatch is persisted as a
// revocation (review KD-1/KD-2), so a returning occupant never revives a key. A failing occupant port is 503
// (receivers then refuse with Retry-After), never `active`. Client/all revocations bump a fencing epoch that an
// issuance captured before signing must still see at commit (KD-3).
//
// Proof of possession: `proof = {iat, signature}`, where `signature` is the base64url raw (64-byte) ES256 signature
// by the delegate key over UTF-8 `bindle-key-delegation-pop-v1\n` followed by the JSON text
// `{"aud":<issuer>,"client_id":<occupant clientId>,"iat":<iat>,"jkt":<jkt>,"sub":<owner>}` (members in this order,
// JSON.stringify escaping), with `iat` (Unix seconds) within 120 s of the provider clock. The prefix differs from every
// bindlebox-* signing domain and from JWS input, so a PoP is never a valid envelope, receipt or certificate.
//
// Records (the owner's account store): `key-delegation/<owner>/<jkt>/`, history bounded at DELEGATION_HISTORY_LIMIT
// (oldest revoked pruned first; a pruned jkt keeps a permanent tombstone so it is never certified again); a bounded audit ring
// `key-delegation-audit/<owner>/<seq>/`; and `key-delegation-meta/<owner>/` (sequences, new-key rate window).
import { Provider } from '../../vendor/ngin/index.js';
import { AppAction, AppQuery } from '../app/engine.mjs';
import { AppFault } from '../app/faults.mjs';
import { key, base64url, fromBase64url, textEncoder } from '../core/records.mjs';
import { UUID } from '../core/primitives.mjs';
import { keyState } from './keys.mjs';
import { MESSAGING_INGRESS_SLOT } from '../links/types.mjs';

// Placeholder identifiers under spec.bindle.example, equal to bindlebox-protocol PURPOSES (cross-tested).
const SPEC = 'https://spec.bindle.example/bindlebox/v1';
export const DELEGATION_PURPOSES = Object.freeze({ author: `${SPEC}/purposes/author`, receipt: `${SPEC}/purposes/receipt`, archive: `${SPEC}/purposes/archive` });
export const DELEGATION_TYP = 'bindle-key-delegation+jwt';
export const POP_DOMAIN = 'bindle-key-delegation-pop-v1\n';
export const DELEGATION_MAX_SECONDS = 86400, DELEGATION_MIN_SECONDS = 300, POP_SKEW_SECONDS = 120;
export const DELEGATION_HISTORY_LIMIT = 32, DELEGATION_AUDIT_LIMIT = 256, DELEGATION_NEW_KEYS_PER_DAY = 16;
export const STATUS_CACHE_SECONDS = 300, REVOKED_CACHE_SECONDS = 86400;
const KNOWN = Object.values(DELEGATION_PURPOSES);
const RECORD = 'key-delegation', AUDIT = 'key-delegation-audit', META = 'key-delegation-meta', PRUNED = 'key-delegation-pruned';
const SIGNING_POINTER = 'signing-key', SIGNING_RECORD = 'contact-key'; // packages/identity/keys.mjs layout
const ES256 = { name: 'ECDSA', hash: 'SHA-256' }, P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const JKT = /^[A-Za-z0-9_-]{43}$/, B64 = /^[A-Za-z0-9_-]+$/;

const fault = (code, message, status) => { throw new AppFault(code, message, status); };
const forbidden = () => fault('forbidden', 'This app cannot hold delegated signing keys for this account.', 403);
const invalid = message => fault('invalid_request', message ?? 'Unsupported delegation request.', 400);
const unavailable = () => fault('delegation_unavailable', 'Delegated signing is unavailable right now.', 503);
const enabledFlag = value => value === true || value === 'true';
export const delegationsEnabled = config => enabledFlag(config?.BINDLEBOX_ENABLED);
const CLIENT = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.isWellFormed() && !/[\p{Cc}\p{Bidi_Control}\u2028\u2029\u200b\ufeff]/u.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const only = (value, names) => plain(value) && Object.keys(value).every(name => names.includes(name));

/** Host lifetime setting -> seconds, clamped to the 24 h maximum; unusable values (non-integers, below the minimum)
 * yield null, which refuses issuance rather than guessing. */
export function delegationLifetime(value) {
  if (value === undefined || value === null || value === '') return DELEGATION_MAX_SECONDS;
  const seconds = typeof value === 'number' ? value : /^\d{1,9}$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < DELEGATION_MIN_SECONDS) return null;
  return Math.min(seconds, DELEGATION_MAX_SECONDS);
}
export const delegationStatusPath = (subject, jkt) => `/identity/${subject}/delegations/${jkt}`;
export const isJkt = value => typeof value === 'string' && JKT.test(value) && (() => { try { return fromBase64url(value).length === 32 && base64url(fromBase64url(value)) === value; } catch { return false; } })();
/** Cache-Control for a status answer: a persisted revocation is final; everything else is bounded by the 5-minute
 * status window of spec §3.4 (shared caches must honor Age, so the end-to-end bound stays 300 s). */
export const statusCacheControl = result => result?.final ? `public, max-age=${REVOKED_CACHE_SECONDS}, immutable` : `public, max-age=${STATUS_CACHE_SECONDS}`;

// Exact canonical URL checks equal to the protocol's originValue/endpointValue, so issued claims always parse.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
function url(value, loopback) {
  if (typeof value !== 'string' || value.length > 2048) return null; let u; try { u = new URL(value); } catch { return null; }
  const local = loopback === true && LOOPBACK.includes(u.hostname);
  if (!(u.protocol === 'https:' || (local && u.protocol === 'http:'))) return null;
  if (!local && (u.hostname.endsWith('.') || u.hostname.startsWith('[') || /^[0-9.]+$/.test(u.hostname) || /(^|\.)localhost$/.test(u.hostname) || !u.hostname.includes('.'))) return null;
  return u.username || u.password || u.hash || value.includes('#') || u.href !== value ? null : u;
}
export const originValid = (value, loopback) => { const u = url(`${value}/`, loopback); return Boolean(u && u.origin === value && u.pathname === '/' && !u.search); };
export const endpointValid = (value, loopback) => { const u = url(value, loopback); return Boolean(u && !u.search && !value.includes('?')); };

/** Exactly {kty:'EC', crv:'P-256', x, y} with canonical 32-byte coordinates on the curve; anything else is refused. */
export async function delegatePublicJwk(jwk, crypto = globalThis.crypto) {
  if (!plain(jwk) || Object.keys(jwk).length !== 4 || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  for (const name of ['x', 'y']) { const v = jwk[name]; if (typeof v !== 'string' || v.length !== 43 || !B64.test(v)) return null; try { const bytes = fromBase64url(v); if (bytes.length !== 32 || base64url(bytes) !== v) return null; } catch { return null; } }
  const clean = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  try { return { jwk: clean, key: await crypto.subtle.importKey('jwk', clean, P256, false, ['verify']) }; } catch { return null; }
}
/** RFC 7638 SHA-256 thumbprint of a P-256 public JWK (canonical unpadded base64url). */
export const jwkThumbprint = async ({ x, y }, crypto = globalThis.crypto) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`))));
export const popInput = ({ issuer, clientId, iat, jkt, subject }) => textEncoder.encode(POP_DOMAIN + JSON.stringify({ aud: issuer, client_id: clientId, iat, jkt, sub: subject }));
/** Test and app helper: the PoP an app sends with an issue/renew request. */
export async function signDelegationPop({ privateKey, issuer, clientId, jkt, subject, iat }, crypto = globalThis.crypto) {
  return { iat, signature: base64url(new Uint8Array(await crypto.subtle.sign(ES256, privateKey, popInput({ issuer, clientId, iat, jkt, subject })))) };
}
/** The compact JWS: received-bytes signing input over JSON in the table's member order. */
export async function encodeDelegationCertificate(claims, { kid, privateKey }, crypto = globalThis.crypto) {
  const encode = value => base64url(textEncoder.encode(JSON.stringify(value)));
  const head = `${encode({ alg: 'ES256', kid, typ: DELEGATION_TYP })}.${encode(claims)}`;
  return `${head}.${base64url(new Uint8Array(await crypto.subtle.sign(ES256, privateKey, textEncoder.encode(head))))}`;
}

const purposesOf = value => Array.isArray(value) && value.length > 0 && value.length <= KNOWN.length && value.every((p, i) => KNOWN.includes(p) && (i === 0 || value[i - 1] < p)) ? value : null;
const samePurposes = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);
const sameClient = (record, occupant) => record.client.client_id === occupant.clientId && record.client.origin === occupant.origin && record.client.ingress === occupant.ingress && record.cnx === occupant.cnx;
// A record still matches the occupant only while every certified purpose remains consented (review KD-2).
const matches = (record, occupant) => sameClient(record, occupant) && record.purposes.every(p => occupant.purposes.includes(p));
const mismatchReason = (found, record) => found.state === 'ok' && sameClient(record, found.value) ? 'consent-withdrawn' : 'occupant-changed';
const hour = ms => Math.floor(ms / 3600000);
// The owner-facing view: no certificate bytes.
const view = record => ({ jkt: record.jkt, state: record.state, purposes: [...record.purposes], client: { ...record.client }, cnx: record.cnx, since: record.since, createdAt: record.createdAt, issued: record.issued, lastIssuedAt: record.last ? record.last.iat * 1000 : null, lastExpiresAt: record.last ? record.last.exp * 1000 : null, revokedAt: record.revokedAt ?? null, reason: record.reason ?? null });

export class DelegationRegistry {
  /** `store`: the serializable transaction contract. `signer(owner)` -> {kid, privateKey}: the owner's current identity
   * signing key (ensured). `occupant({owner, slot})`: see the header. `account(owner)` -> {status} | null. `issuer`:
   * this provider's origin. `lifetime`: host seconds (see delegationLifetime). */
  constructor({ store, issuer, signer, occupant, account, clock = () => Date.now(), crypto = globalThis.crypto, uuid, lifetime, allowLoopback = false, historyLimit = DELEGATION_HISTORY_LIMIT, auditLimit = DELEGATION_AUDIT_LIMIT, newKeysPerDay = DELEGATION_NEW_KEYS_PER_DAY }) {
    if (!store?.transaction || !Number.isSafeInteger(historyLimit) || historyLimit < 2) throw new TypeError('Invalid delegation registry');
    Object.assign(this, { store, issuer, signer, occupant, account, clock, crypto, uuid: uuid ?? (() => crypto.randomUUID()), lifetime: delegationLifetime(lifetime), allowLoopback: allowLoopback === true, historyLimit, auditLimit, newKeysPerDay });
  }
  /** {state:'ok', value} | {state:'none'} | {state:'error'}; a malformed answer is 'none' (fail closed). */
  async occupancy(owner) {
    if (typeof this.occupant !== 'function') return { state: 'none' };
    let found; try { found = await this.occupant({ owner, slot: MESSAGING_INGRESS_SLOT }); } catch { return { state: 'error' }; }
    if (!found) return { state: 'none' };
    const cnx = typeof found.cnx === 'string' ? found.cnx : Number.isSafeInteger(found.generation) ? String(found.generation) : found.generation;
    const consented = Array.isArray(found.purposes) ? found.purposes.filter(p => KNOWN.includes(p)) : [];
    if (!CLIENT(found.clientId) || !originValid(found.origin, this.allowLoopback) || !endpointValid(found.ingress, this.allowLoopback) || typeof cnx !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(cnx)) return { state: 'none' };
    return { state: 'ok', value: { clientId: found.clientId, origin: found.origin, ingress: found.ingress, cnx, purposes: [...new Set(consented)].sort() } };
  }
  async #meta(tx, owner) { return await tx.get(key(META, owner)) ?? { seq: 0, auditSeq: 0, tombstoneSeq: 0, epoch: 0, newKeys: [] }; }
  async #records(tx, owner) { return (await tx.list(key(RECORD, owner))).map(row => row.value).filter(record => record?.owner === owner).sort((a, b) => a.seq - b.seq); }
  async #audit(tx, owner, meta, entry) {
    meta.auditSeq += 1; await tx.set(key(AUDIT, owner, String(meta.auditSeq).padStart(12, '0')), { at: this.clock(), ...entry });
    if (meta.auditSeq > this.auditLimit) await tx.delete(key(AUDIT, owner, String(meta.auditSeq - this.auditLimit).padStart(12, '0')));
  }
  async #revokeRecord(tx, owner, meta, record, reason, actor) {
    if (record.state === 'revoked') return false;
    await tx.set(key(RECORD, owner, record.jkt), { ...record, state: 'revoked', revokedAt: this.clock(), reason });
    await this.#audit(tx, owner, meta, { event: 'revoked', jkt: record.jkt, clientId: record.client.client_id, reason, actor });
    return true;
  }
  // Bounded history: the oldest revoked records go first, each leaving a tombstone that is never evicted (review KD-5;
  // the new-key rate bounds tombstone growth to DELEGATION_NEW_KEYS_PER_DAY small rows a day).
  async #prune(tx, owner, meta) {
    const records = await this.#records(tx, owner);
    for (const victim of records.filter(record => record.state === 'revoked').slice(0, Math.max(0, records.length - this.historyLimit))) {
      meta.tombstoneSeq += 1; await tx.set(key(PRUNED, owner, victim.jkt), { jkt: victim.jkt, seq: meta.tombstoneSeq, revokedAt: victim.revokedAt });
      await tx.delete(key(RECORD, owner, victim.jkt));
    }
  }
  async #currentKid(tx, owner) { const pointer = await tx.get(SIGNING_POINTER); if (!pointer || (pointer.owner !== undefined && pointer.owner !== owner)) return null; return keyState(await tx.get(key(SIGNING_RECORD, owner, pointer.kid))) === 'active' ? pointer.kid : null; }
  async #identityThumbprints(tx, owner) { const out = new Set(); for (const row of await tx.list(key(SIGNING_RECORD, owner))) { const jwk = row.value?.publicJwk; if (row.value?.owner === owner && jwk?.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string') out.add(await jwkThumbprint(jwk, this.crypto)); } return out; }
  async #accountActive(owner) { if (typeof this.account !== 'function') return false; try { return (await this.account(owner))?.status === 'active'; } catch { return false; } }

  /** Issue (`renew:false`) or renew (`renew:true`, the jkt must already be active) for the occupant app `clientId`. */
  async issue(owner, { clientId }, input, { renew = false } = {}) {
    // Occupancy first: a caller that is not the occupant learns nothing about the request or the account's keys.
    const first = await this.occupancy(owner);
    if (first.state !== 'ok' || first.value.clientId !== clientId) forbidden();
    if (this.lifetime === null || typeof this.signer !== 'function' || !originValid(this.issuer, this.allowLoopback)) unavailable();
    if (!await this.#accountActive(owner)) forbidden();
    if (!only(input, ['delegate', 'purposes', 'proof', 'lifetime']) || !only(input.proof, ['iat', 'signature'])) invalid();
    const purposes = purposesOf(input.purposes); if (!purposes) invalid('Choose recognized purposes in ascending order.');
    if (!purposes.every(p => first.value.purposes.includes(p))) forbidden();
    const lifetime = input.lifetime === undefined ? this.lifetime : Number.isSafeInteger(input.lifetime) && input.lifetime >= DELEGATION_MIN_SECONDS ? Math.min(input.lifetime, this.lifetime) : invalid('Choose a certificate lifetime of at least 300 seconds.');
    const delegate = await delegatePublicJwk(input.delegate, this.crypto); if (!delegate) invalid('Send a P-256 public key only.');
    const jkt = await jwkThumbprint(delegate.jwk, this.crypto), nowMs = this.clock(), now = Math.floor(nowMs / 1000), { iat: popIat, signature } = input.proof;
    if (!Number.isSafeInteger(popIat) || Math.abs(popIat - now) > POP_SKEW_SECONDS || typeof signature !== 'string' || signature.length !== 86 || !B64.test(signature)) invalid('The proof of possession is missing or stale.');
    let sigBytes; try { sigBytes = fromBase64url(signature); } catch { sigBytes = null; }
    if (sigBytes?.length !== 64 || !await this.crypto.subtle.verify(ES256, delegate.key, sigBytes, popInput({ issuer: this.issuer, clientId, iat: popIat, jkt, subject: owner }))) invalid('The proof of possession is missing or stale.');
    const occupant = first.value;

    // Plan: read the record, tombstone, key aliasing and the current identity key.
    const plan = await this.store.transaction(async tx => {
      const record = await tx.get(key(RECORD, owner, jkt)), pruned = await tx.get(key(PRUNED, owner, jkt)), kid = await this.#currentKid(tx, owner), meta = await this.#meta(tx, owner);
      if ((await this.#identityThumbprints(tx, owner)).has(jkt)) return { refuse: 'alias' };
      if (pruned || record?.state === 'revoked') return { refuse: 'revoked' };
      if (record && !matches(record, occupant)) return { refuse: 'moved', reason: sameClient(record, occupant) ? 'consent-withdrawn' : 'occupant-changed' };
      if (!record && renew) return { refuse: 'unknown' };
      if (!record && meta.newKeys.filter(at => at > nowMs - 86400000).length >= this.newKeysPerDay) return { refuse: 'rate' };
      // Renewal reuse: the stored certificate still has at least half its lifetime and names exactly this request.
      if (record?.last && kid && record.last.kid === kid && samePurposes(record.purposes, purposes) && record.last.exp - now >= Math.min(lifetime, record.last.exp - record.last.iat) / 2 && record.last.exp <= now + lifetime) return { reuse: record };
      return { record: record ?? null, epoch: meta.epoch ?? 0 };
    });
    if (plan.refuse === 'alias') invalid('An identity key cannot be a delegate key.');
    if (plan.refuse === 'revoked') fault('delegation_revoked', 'This delegate key was revoked. Generate a new key.', 409);
    if (plan.refuse === 'unknown') fault('not_found', 'No active delegation for this key.', 404);
    if (plan.refuse === 'rate') fault('rate_limited', 'Too many new delegate keys today.', 429);
    if (plan.refuse === 'moved') {
      // A key never moves between apps or connection incarnations: revoke it where it was, then refuse.
      await this.store.transaction(async tx => { const meta = await this.#meta(tx, owner), record = await tx.get(key(RECORD, owner, jkt)); if (record && await this.#revokeRecord(tx, owner, meta, record, plan.reason, 'system')) await tx.set(key(META, owner), meta); });
      fault('delegation_revoked', 'This delegate key belongs to another connection. Generate a new key.', 409);
    }
    if (plan.reuse) return this.#result(owner, plan.reuse, plan.reuse.last.certificate, true);

    const signer = await this.signer(owner); if (!signer?.kid || !signer.privateKey) unavailable();
    const since = plan.record?.since ?? now, jti = this.uuid();
    const claims = { bindle: 'key-delegation', v: 1, iss: this.issuer, sub: owner, delegate: delegate.jwk, jkt, purposes, client: { client_id: occupant.clientId, origin: occupant.origin, ingress: occupant.ingress }, cnx: occupant.cnx, since, jti, iat: now, exp: now + lifetime };
    const certificate = await encodeDelegationCertificate(claims, signer, this.crypto);
    // Occupancy may have changed while signing; the commit below re-checks everything else.
    const second = await this.occupancy(owner);
    if (second.state !== 'ok' || !sameClient({ client: claims.client, cnx: claims.cnx }, second.value) || !purposes.every(p => second.value.purposes.includes(p))) forbidden();
    if (!await this.#accountActive(owner)) forbidden();
    return this.store.transaction(async tx => {
      const record = await tx.get(key(RECORD, owner, jkt)), meta = await this.#meta(tx, owner);
      if (await tx.get(key(PRUNED, owner, jkt)) || record?.state === 'revoked' || (record ? record.since !== since || !sameClient(record, occupant) : plan.record !== null) || await this.#currentKid(tx, owner) !== signer.kid || (meta.epoch ?? 0) !== plan.epoch) fault('delegation_conflict', 'The delegation changed meanwhile. Try again.', 409);
      const fresh = !record;
      if (fresh) { meta.seq += 1; meta.newKeys = [...meta.newKeys.filter(at => at > nowMs - 86400000), nowMs].slice(-this.newKeysPerDay); }
      const next = { owner, jkt, delegate: delegate.jwk, purposes, client: claims.client, cnx: claims.cnx, since, state: 'active', createdAt: record?.createdAt ?? nowMs, seq: record?.seq ?? meta.seq, issued: (record?.issued ?? 0) + 1, last: { jti, iat: claims.iat, exp: claims.exp, kid: signer.kid, certificate } };
      await tx.set(key(RECORD, owner, jkt), next);
      await this.#audit(tx, owner, meta, { event: fresh ? 'issued' : 'renewed', jkt, clientId: occupant.clientId, jti, exp: claims.exp * 1000, actor: 'app' });
      // A new key revokes every predecessor (spec §3.2): at most one active delegate key per principal.
      if (fresh) for (const other of await this.#records(tx, owner)) if (other.jkt !== jkt && other.state === 'active') await this.#revokeRecord(tx, owner, meta, other, 'superseded', 'system');
      await this.#prune(tx, owner, meta);
      await tx.set(key(META, owner), meta);
      return this.#result(owner, next, certificate, false);
    });
  }
  #result(owner, record, certificate, reused) { return { certificate, jkt: record.jkt, jti: record.last.jti, iat: record.last.iat, exp: record.last.exp, since: record.since, purposes: [...record.purposes], status: `${this.issuer}${delegationStatusPath(owner, record.jkt)}`, reused }; }

  /** `input`: {jkt} | {clientId} | {all:true}, plus optional `reason`. `actor`: {kind, clientId?}. Idempotent. */
  async revoke(owner, actor, input) {
    if (!only(input, ['jkt', 'clientId', 'all', 'reason']) || [input.jkt, input.clientId, input.all].filter(v => v !== undefined).length !== 1 || (input.jkt !== undefined && !isJkt(input.jkt)) || (input.clientId !== undefined && !CLIENT(input.clientId)) || (input.all !== undefined && input.all !== true)) invalid();
    // Reasons are limited by actor kind, so the owner audit never shows an app- or owner-chosen system reason (KD-6).
    const reason = input.reason ?? actor.kind, allowed = { app: ['app'], owner: ['owner', 'compromise'], system: ['system', 'uninstalled', 'suspended', 'deleted', 'compromise', 'client-breach'] }[actor.kind] ?? [];
    if (!allowed.includes(reason)) invalid();
    if (actor.kind === 'app' && input.jkt === undefined) forbidden();
    return this.store.transaction(async tx => {
      const meta = await this.#meta(tx, owner), records = await this.#records(tx, owner); let revoked = 0;
      const targets = records.filter(record => input.all || (input.jkt !== undefined ? record.jkt === input.jkt : record.client.client_id === input.clientId));
      // An app sees only its own keys: anything else is the same not_found as an unknown jkt.
      if (actor.kind === 'app' && !targets.some(record => record.client.client_id === actor.clientId)) fault('not_found', 'No delegation for this key.', 404);
      for (const record of targets) if (await this.#revokeRecord(tx, owner, meta, record, reason, actor.kind)) revoked++;
      // Client and all revocations also fence any issuance being signed meanwhile (review KD-3).
      if (input.jkt === undefined) meta.epoch = (meta.epoch ?? 0) + 1;
      if (revoked || input.jkt === undefined) await tx.set(key(META, owner), meta);
      return { revoked };
    });
  }
  /** Persists what status already reports: active keys whose client/cnx are not the current occupant's are revoked.
   * A failing port changes nothing. */
  async reconcile(owner, actor) {
    const found = await this.occupancy(owner); if (found.state === 'error') unavailable();
    return this.store.transaction(async tx => {
      const meta = await this.#meta(tx, owner); let revoked = 0;
      for (const record of await this.#records(tx, owner)) if (record.state === 'active' && (found.state !== 'ok' || !matches(record, found.value))) { if (await this.#revokeRecord(tx, owner, meta, record, mismatchReason(found, record), actor.kind)) revoked++; }
      meta.epoch = (meta.epoch ?? 0) + 1; await tx.set(key(META, owner), meta);
      return { revoked };
    });
  }
  /** Owner view: bounded history (oldest first) and the newest audit entries. */
  async list(owner) {
    return this.store.transaction(async tx => ({ delegations: (await this.#records(tx, owner)).map(view), audit: (await tx.list(key(AUDIT, owner))).map(row => row.value).filter(Boolean).slice(-50).reverse() }));
  }
  /** Public status of one jkt (see the header). `final` marks a persisted revocation (cacheable for long). */
  async status(owner, jkt) {
    if (!isJkt(jkt)) return { status: 'revoked', final: false };
    const record = await this.store.transaction(tx => tx.get(key(RECORD, owner, jkt)));
    if (!record || record.owner !== owner) return { status: 'revoked', final: false };
    if (record.state === 'revoked') return { status: 'revoked', revokedHour: hour(record.revokedAt), final: true };
    const found = await this.occupancy(owner); if (found.state === 'error') unavailable();
    if (found.state === 'ok' && matches(record, found.value)) return { status: 'active', final: false };
    // The first observed mismatch is persisted, so a returning occupant or cnx never revives the key (review KD-1).
    // One write per key at most: afterwards the record is revoked and answered without consulting the port.
    const persisted = await this.store.transaction(async tx => {
      const now = await tx.get(key(RECORD, owner, jkt)); if (now?.state !== 'active' || now.last?.jti !== record.last?.jti) return now;
      const meta = await this.#meta(tx, owner); await this.#revokeRecord(tx, owner, meta, now, mismatchReason(found, now), 'system'); meta.epoch = (meta.epoch ?? 0) + 1; await tx.set(key(META, owner), meta);
      return tx.get(key(RECORD, owner, jkt));
    });
    return persisted?.state === 'revoked' ? { status: 'revoked', revokedHour: hour(persisted.revokedAt), final: true } : { status: 'revoked', final: false };
  }
}

// Engine operations. Actors are built by trusted adapters only (account/identity.mjs), never from a request body:
//   {kind:'owner', owner}             list, revoke (any selector), reconcile
//   {kind:'app', owner, clientId}     issue, renew, revoke {jkt} of its own keys; occupancy decides issuance
//   {kind:'system', owner}            revoke {clientId}|{all} and reconcile (slot handoff, uninstall, suspension)
//   {kind:'public', owner}            status only; `owner` is the subject named in the status URL
export function delegationsProvider({ registry, enabled = false } = {}) {
  return class extends DelegationsProvider { static deps = []; constructor() { super(); Object.assign(this, { registry, enabled: enabled === true }); } };
}
export class DelegationsProvider extends Provider {
  async obtain({ actor } = {}) {
    if (!this.enabled || !this.registry) throw new AppFault('not_found', 'Not found.', 404);
    if (!UUID.test(actor?.owner ?? '') || !['owner', 'app', 'system', 'public'].includes(actor?.kind) || (actor.kind === 'app' && !CLIENT(actor.clientId))) throw new AppFault('unauthorized', 'Sign in to continue.', 401);
    const registry = this.registry, owner = actor.owner, kind = actor.kind, deny = () => forbidden();
    return Object.freeze({
      issue: input => kind === 'app' ? registry.issue(owner, { clientId: actor.clientId }, input) : deny(),
      renew: input => kind === 'app' ? registry.issue(owner, { clientId: actor.clientId }, input, { renew: true }) : deny(),
      revoke: input => kind === 'public' ? deny() : registry.revoke(owner, { kind, clientId: actor.clientId }, input),
      reconcile: () => ['owner', 'system'].includes(kind) ? registry.reconcile(owner, { kind }) : deny(),
      list: () => kind === 'owner' ? registry.list(owner) : deny(),
      status: input => only(input, ['jkt']) ? registry.status(owner, input.jkt) : invalid(),
    });
  }
  release() {}
}

/** `input`: {delegate, purposes, proof:{iat, signature}, lifetime?}. Returns {certificate, jkt, jti, iat, exp, since, purposes, status, reused}. */
export class IssueDelegation extends AppAction { static operation = 'delegations.issue'; static deps = ['delegations']; static changes = 'delegations-changed'; run({ delegations }) { return delegations.issue(this.input); } }
/** Same input; the delegate key must already be active for this app. */
export class RenewDelegation extends AppAction { static operation = 'delegations.renew'; static deps = ['delegations']; static changes = 'delegations-changed'; run({ delegations }) { return delegations.renew(this.input); } }
/** `input`: {jkt} | {clientId} | {all:true}, reason?. */
export class RevokeDelegation extends AppAction { static operation = 'delegations.revoke'; static deps = ['delegations']; static changes = 'delegations-changed'; run({ delegations }) { return delegations.revoke(this.input); } }
export class ReconcileDelegations extends AppAction { static operation = 'delegations.reconcile'; static deps = ['delegations']; static changes = 'delegations-changed'; run({ delegations }) { return delegations.reconcile(); } }
export class DelegationList extends AppQuery { static operation = 'delegations.list'; static deps = ['delegations']; static refreshOn = ['delegations-changed']; fetch({ delegations }) { return delegations.list(); } }
/** `input`: {jkt}. Public; runs outside the account gate. */
export class DelegationStatus extends AppQuery { static operation = 'delegations.status'; static deps = ['delegations']; static lifecycle = 'purging'; static gate = 'none'; fetch({ delegations }) { return delegations.status(this.input); } }
export const DELEGATION_OPERATIONS = Object.freeze([IssueDelegation, RenewDelegation, RevokeDelegation, ReconcileDelegations, DelegationList, DelegationStatus]);
