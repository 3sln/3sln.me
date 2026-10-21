// Core identity key registry (docs/architecture/messaging-extraction.md slice C0, formerly the key half of
// ContactTokenService). Engine-first: IdentityKeyRegistry is the provider resource, and the Actions/Queries below
// are the operations over it. Slice C3 (key-delegation.v1) signs delegation certificates with the current signing key.
//
// Purposes are separated by construction: every operation names its purpose, and each purpose has its own record
// prefix, key algorithm and private-key usage. A kid looked up under one purpose never resolves under the other.
//   signing     ES256 (legacy registrations may be EdDSA). Public records keep the legacy `contact-key/<owner>/<kid>/`
//               prefix that contact tokens and endpoints read; the current private key is the `signing-key` pointer.
//   encryption  ECDH-ES P-256. Public records `identity-encryption-key/<owner>/<kid>/`; pointer `encryption-key`.
// States are monotonic: active -> retired -> revoked, or active -> revoked; never back.
//   active   exactly the pointer's key: signs new artifacts, and same-host lookups report it `active`.
//   retired  replaced by rotation. The record keeps `active: true`, so provider-stored artifacts it signed earlier
//            (contact grants, link metas, whose exact claims the provider holds) stay verifiable, but nothing can be
//            minted under them any more (no private key): pre-C0 endpoints re-sign with their grant's kid, so rotation
//            stays internal (no route) until those consumers move to the current key (review finding 4). Fresh-signature
//            verifiers (link responses, author proofs, delegation certificates) accept the current key only.
//   revoked  `active: false`: everything signed by it stops verifying. Revoking the current key clears its pointer;
//            the next ensure creates an unrelated key with no continuity, because a revoked key cannot vouch.
// Rotation continuity: the old signing key signs the new signing key; the current signing key signs a new
// encryption key (an ECDH key cannot sign). The statement is `{alg:'ES256', kid, payload, signature}` over
// UTF-8 `3sln-identity-key-continuity-v1.ES256.<kid>.<payload>`, payload = canonical base64url JSON.
// Custody is unchanged: private keys exist only as `seal`ed (KEY_ENCRYPTION_KEY) records and non-extractable
// imports; retired/revoked signing private keys are dropped, and encryption private keys are retained sealed
// (`identity-key-retained/<owner>/<kid>/`), because old content may still need them. Never log key material.
// History is bounded per owner and purpose: signing prunes its oldest revoked, then oldest retired, record (whose
// stored artifacts then stop verifying); encryption never prunes and refuses rotation with `key_history_full`.
import { Engine, Provider, Action, Query } from '../../vendor/ngin/index.js';
import { fail, key, canonical, base64url, fromBase64url, textEncoder, strictText, boundedString } from '../core/records.mjs';

export const KEY_PURPOSES = Object.freeze(['signing', 'encryption']);
export const KEY_HISTORY_LIMIT = 16;
export const REVOCATION_REASONS = Object.freeze(['unspecified', 'compromise', 'owner', 'superseded']);
export const CONTINUITY_DOMAIN = '3sln-identity-key-continuity-v1';
const PREFIX = { signing: 'contact-key', encryption: 'identity-encryption-key' }, POINTER = { signing: 'signing-key', encryption: 'encryption-key' }, RETAINED = 'identity-key-retained', TOMBSTONE = 'identity-key-pruned';
export const IDENTITY_ALGORITHMS = Object.freeze(Object.assign(Object.create(null), { EdDSA: { name: 'Ed25519' }, ES256: { name: 'ECDSA', hash: 'SHA-256' } }));
export const importAlgorithm = alg => alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : IDENTITY_ALGORITHMS[alg];
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const purposeOf = purpose => KEY_PURPOSES.includes(purpose) ? purpose : fail('invalid_purpose');
const ownerOf = owner => boundedString(owner) ? owner : fail('invalid_key');
const publicPath = (purpose, owner, kid) => key(PREFIX[purpose], owner, kid);
// The public shape is constructed explicitly, so no private member (`d`) or usage hint ever reaches a record.
const publicOf = jwk => Object.fromEntries(['kty', 'crv', 'x', 'y'].filter(name => typeof jwk?.[name] === 'string').map(name => [name, jwk[name]]));
export const keyState = record => record?.state ?? (record?.active === true ? 'active' : 'revoked');

/** The public descriptor a lookup returns; `current` only for the pointer's key in state active. */
function describe(record, purpose, pointer) {
  const state = keyState(record);
  return { kid: record.kid, purpose, alg: record.alg, publicJwk: publicOf(record.publicJwk), state, current: state === 'active' && pointer?.kid === record.kid, verifiable: state !== 'revoked', createdAt: record.createdAt ?? null, retiredAt: record.retiredAt ?? null, revokedAt: record.revokedAt ?? null, predecessor: record.predecessor ?? null, successor: record.successor ?? null, continuity: record.continuity ?? null };
}
/** Same-host signing record still usable for provider-stored artifacts (contact grants, link metas): active or retired. */
export async function verifiableSigningKey(tx, owner, kid) { const record = await tx.get(publicPath('signing', owner, kid)); return record?.active === true && keyState(record) !== 'revoked' ? record : null; }

const continuityInput = (kid, payload) => textEncoder.encode(`${CONTINUITY_DOMAIN}.ES256.${kid}.${payload}`);
/** Checks `next.continuity` against `signer` (a signing descriptor or record): for a signing rotation the signer is
 * the predecessor itself; for an encryption rotation it is the signing key current at rotation time. Pure. */
export async function verifyKeyContinuity({ signer, next, subject, crypto = globalThis.crypto }) {
  const proof = next?.continuity;
  // A revoked signer vouches for nothing (review finding 2): its private key may be in other hands.
  if (!proof || signer?.verifiable === false || keyState(signer) === 'revoked' || proof.alg !== 'ES256' || signer?.alg !== 'ES256' || proof.kid !== signer.kid || typeof proof.payload !== 'string' || typeof proof.signature !== 'string' || proof.payload.length > 4096) return false;
  let statement; try { statement = JSON.parse(strictText(fromBase64url(proof.payload))); } catch { return false; }
  const purpose = next.purpose ?? 'signing';
  if (statement?.version !== 1 || typeof statement.subject !== 'string' || (subject !== undefined && statement.subject !== subject) || !Number.isSafeInteger(statement.at) || (Number.isSafeInteger(signer.revokedAt) && statement.at >= signer.revokedAt) || statement.purpose !== purpose || statement.signer !== signer.kid || statement.previous !== next.predecessor || statement.next?.kid !== next.kid || statement.next.alg !== next.alg || canonical(statement.next.publicJwk) !== canonical(publicOf(next.publicJwk))) return false;
  if (purpose === 'signing' && statement.previous !== signer.kid) return false;
  try { const publicKey = await crypto.subtle.importKey('jwk', publicOf(signer.publicJwk), ECDSA, false, ['verify']); return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromBase64url(proof.signature), continuityInput(proof.kid, proof.payload)); } catch { return false; }
}

/** Verification-key lookup across hosts: same-host principals resolve through `local`; any other issuer goes to the
 * future directory profile hook (`directory.resolve`), and without one it is unverifiable (null), never trusted. */
export async function resolveIdentityKey({ issuer, subject, kid, purpose = 'signing' }, { issuer: localIssuer, local, directory } = {}) {
  purposeOf(purpose); if (!boundedString(subject) || !boundedString(kid) || typeof issuer !== 'string') return null;
  const found = issuer === localIssuer ? await local?.(subject, kid, purpose) : await directory?.resolve?.({ issuer, subject, kid, purpose });
  return found && found.purpose === purpose && found.kid === kid ? found : null;
}

export class IdentityKeyRegistry {
  /** `store`: the serializable transaction contract (`transaction(tx => {get,set,delete,list})`). `seal`/`open`
   * encrypt private JWKs at rest; only the private-key operations need them. */
  constructor({ store, seal, open, clock = () => Date.now(), crypto = globalThis.crypto, historyLimit = KEY_HISTORY_LIMIT }) {
    if (!store?.transaction || !Number.isSafeInteger(historyLimit) || historyLimit < 2) throw new TypeError('Invalid identity key registry');
    Object.assign(this, { store, seal, open, clock, crypto, historyLimit });
  }
  #sealing() { if (typeof this.seal !== 'function' || typeof this.open !== 'function') fail('identity_keys_unavailable'); }
  async #pointer(tx, owner, purpose) { const pointer = await tx.get(POINTER[purpose]); if (pointer && pointer.owner !== undefined && pointer.owner !== owner) fail('forbidden'); return pointer; }
  async #records(tx, owner, purpose) { return (await tx.list(key(PREFIX[purpose], owner))).map(row => row.value).filter(record => record?.owner === owner).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.kid).localeCompare(String(b.kid))); }
  // Records carry a per-owner, per-purpose sequence, so history order and pruning never depend on clock resolution.
  async #next(tx, owner, purpose) { return (await this.#records(tx, owner, purpose)).reduce((max, record) => Math.max(max, record.seq ?? 0), 0) + 1; }
  // Makes room for one more record within the bounded history (see the header).
  async #admit(tx, owner, purpose, keep) {
    const records = await this.#records(tx, owner, purpose); if (records.length < this.historyLimit) return;
    // Encryption prunes only revoked public records (their private keys stay in `identity-key-retained/`), so a
    // revocation can always be followed by a replacement (review finding 1); retired encryption keys are never pruned.
    const prunable = records.filter(record => record.kid !== keep && keyState(record) !== 'active'), victim = prunable.find(record => keyState(record) === 'revoked') ?? (purpose === 'signing' ? prunable[0] : undefined);
    if (!victim || records.length - 1 >= this.historyLimit) fail('key_history_full');
    // A pruned kid is tombstoned for good, so it can never be registered again (review finding 3).
    await tx.set(key(TOMBSTONE, owner, victim.kid), { kid: victim.kid, purpose, prunedAt: this.clock() });
    await tx.delete(publicPath(purpose, owner, victim.kid));
  }
  async #generate(purpose) {
    const pair = await this.crypto.subtle.generateKey(purpose === 'signing' ? ECDSA : ECDH, true, purpose === 'signing' ? ['sign', 'verify'] : ['deriveKey', 'deriveBits']);
    const publicJwk = publicOf(await this.crypto.subtle.exportKey('jwk', pair.publicKey));
    return { kid: this.crypto.randomUUID(), alg: purpose === 'signing' ? 'ES256' : 'ECDH-ES', publicJwk, encrypted: await this.seal(await this.crypto.subtle.exportKey('jwk', pair.privateKey)) };
  }
  async #importPrivate(purpose, jwk) { return this.crypto.subtle.importKey('jwk', jwk, purpose === 'signing' ? ECDSA : ECDH, false, purpose === 'signing' ? ['sign'] : ['deriveBits']); }

  /** Legacy public-only signing registration. Caller must have freshly authenticated the owner and confirmed key custody. */
  async register(owner, { kid, alg, publicJwk } = {}) {
    if (!boundedString(owner) || !boundedString(kid) || !IDENTITY_ALGORITHMS[alg] || !publicJwk || typeof publicJwk !== 'object' || Object.hasOwn(publicJwk, 'd')) fail('invalid_key');
    const clean = publicOf(publicJwk);
    try { await this.crypto.subtle.importKey('jwk', clean, importAlgorithm(alg), false, ['verify']); } catch { fail('invalid_key'); }
    return this.store.transaction(async tx => {
      const path = publicPath('signing', owner, kid);
      if (await tx.get(path) || await tx.get(publicPath('encryption', owner, kid)) || await tx.get(key(TOMBSTONE, owner, kid))) fail('key_exists');
      await this.#admit(tx, owner, 'signing', (await this.#pointer(tx, owner, 'signing'))?.kid);
      await tx.set(path, { owner, kid, alg, publicJwk: clean, active: true, purpose: 'signing', state: 'active', custody: 'external', createdAt: this.clock(), seq: await this.#next(tx, owner, 'signing') });
      return { kid, alg };
    });
  }
  /** Idempotently provides the owner's current key of `purpose`. A legacy pointer without a public record is backfilled. */
  async ensure(owner, purpose) {
    ownerOf(owner); purposeOf(purpose); this.#sealing();
    const [existing, published] = await this.store.transaction(async tx => {
      let pointer = await this.#pointer(tx, owner, purpose); const record = pointer && await tx.get(publicPath(purpose, owner, pointer.kid));
      // A pointer left on a revoked record (the pre-C0 revokeKey kept it) is dropped, never signed with (review finding 6).
      if (record && keyState(record) === 'revoked') { if (purpose === 'encryption') await tx.set(key(RETAINED, owner, pointer.kid), { kid: pointer.kid, owner, purpose, encrypted: pointer.encrypted, retiredAt: record.revokedAt ?? this.clock() }); await tx.delete(POINTER[purpose]); pointer = undefined; }
      else if (pointer && pointer.owner === undefined) { pointer = { ...pointer, owner, purpose }; await tx.set(POINTER[purpose], pointer); }
      return [pointer, Boolean(record)];
    });
    if (existing) {
      if (published) return { kid: existing.kid, created: false };
      const publicJwk = publicOf(await this.open(existing.encrypted));
      return this.store.transaction(async tx => {
        const pointer = await this.#pointer(tx, owner, purpose); if (pointer?.kid !== existing.kid) fail('key_conflict');
        if (!await tx.get(publicPath(purpose, owner, existing.kid))) { await this.#admit(tx, owner, purpose, existing.kid); await tx.set(publicPath(purpose, owner, existing.kid), { owner, kid: existing.kid, alg: purpose === 'signing' ? 'ES256' : 'ECDH-ES', publicJwk, active: true, purpose, state: 'active', createdAt: this.clock(), seq: await this.#next(tx, owner, purpose) }); }
        return { kid: existing.kid, created: false };
      });
    }
    // Generated outside the transaction; a concurrent winner's key is kept and this one is discarded unstored.
    const fresh = await this.#generate(purpose);
    return this.store.transaction(async tx => {
      const pointer = await this.#pointer(tx, owner, purpose); if (pointer) return { kid: pointer.kid, created: false };
      const now = this.clock();
      // A registry-held record left active without its pointer has no private key any more: it is retired, without a
      // successor link (nothing vouched). Externally registered keys are never current and keep their state (finding 5).
      for (const record of await this.#records(tx, owner, purpose)) if (keyState(record) === 'active' && record.custody !== 'external') await tx.set(publicPath(purpose, owner, record.kid), { ...record, state: 'retired', retiredAt: now });
      await this.#admit(tx, owner, purpose, fresh.kid);
      await tx.set(publicPath(purpose, owner, fresh.kid), { owner, kid: fresh.kid, alg: fresh.alg, publicJwk: fresh.publicJwk, active: true, purpose, state: 'active', createdAt: now, seq: await this.#next(tx, owner, purpose) });
      await tx.set(POINTER[purpose], { kid: fresh.kid, owner, purpose, encrypted: fresh.encrypted });
      return { kid: fresh.kid, created: true };
    });
  }
  /** Replaces the current key of `purpose` (compare-and-set on `expectedKid`) and records signed continuity. */
  async rotate(owner, { purpose, expectedKid } = {}) {
    ownerOf(owner); purposeOf(purpose); this.#sealing(); if (!boundedString(expectedKid)) fail('invalid_key');
    const [current, signing] = await this.store.transaction(async tx => [await this.#pointer(tx, owner, purpose), await this.#pointer(tx, owner, 'signing')]);
    if (!current) fail('not_found'); if (current.kid !== expectedKid) fail('key_conflict'); if (!signing) fail('identity_keys_unavailable');
    const fresh = await this.#generate(purpose), at = this.clock(), signer = signing.kid;
    const payload = base64url(textEncoder.encode(canonical({ version: 1, subject: owner, purpose, previous: expectedKid, signer, next: { kid: fresh.kid, alg: fresh.alg, publicJwk: fresh.publicJwk }, at })));
    const signature = base64url(new Uint8Array(await this.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await this.#importPrivate('signing', await this.open(signing.encrypted)), continuityInput(signer, payload))));
    return this.store.transaction(async tx => {
      const pointer = await this.#pointer(tx, owner, purpose), signingNow = await this.#pointer(tx, owner, 'signing'), old = await tx.get(publicPath(purpose, owner, expectedKid));
      // Anything that moved since the reads above (a concurrent rotation or revocation) invalidates this statement.
      if (pointer?.kid !== expectedKid || signingNow?.kid !== signer || !old || keyState(old) !== 'active' || keyState(await tx.get(publicPath('signing', owner, signer))) !== 'active') fail('key_conflict');
      await this.#admit(tx, owner, purpose, expectedKid);
      const now = this.clock();
      await tx.set(publicPath(purpose, owner, expectedKid), { ...old, state: 'retired', retiredAt: now, successor: fresh.kid });
      if (purpose === 'encryption') await tx.set(key(RETAINED, owner, expectedKid), { kid: expectedKid, owner, purpose, encrypted: pointer.encrypted, retiredAt: now });
      await tx.set(publicPath(purpose, owner, fresh.kid), { owner, kid: fresh.kid, alg: fresh.alg, publicJwk: fresh.publicJwk, active: true, purpose, state: 'active', createdAt: now, seq: await this.#next(tx, owner, purpose), predecessor: expectedKid, continuity: { alg: 'ES256', kid: signer, payload, signature } });
      await tx.set(POINTER[purpose], { kid: fresh.kid, owner, purpose, encrypted: fresh.encrypted });
      return { kid: fresh.kid, previous: expectedKid, purpose };
    });
  }
  /** Revokes one key of `purpose` (idempotent). Revoking the current key clears its pointer in the same transaction. */
  async revoke(owner, { purpose, kid, reason = 'unspecified' } = {}) {
    ownerOf(owner); purposeOf(purpose); if (!boundedString(kid) || !REVOCATION_REASONS.includes(reason)) fail('invalid_key');
    return this.store.transaction(async tx => {
      const path = publicPath(purpose, owner, kid), record = await tx.get(path), pointer = await this.#pointer(tx, owner, purpose);
      if (!record || record.owner !== owner) fail('not_found');
      if (keyState(record) !== 'revoked' || record.active !== false) {
        const revoked = { ...record, active: false, state: 'revoked', revokedAt: record.revokedAt ?? this.clock(), reason: record.reason ?? reason };
        await tx.set(path, revoked); Object.assign(record, revoked);
      }
      if (pointer?.kid === kid) {
        if (purpose === 'encryption') await tx.set(key(RETAINED, owner, kid), { kid, owner, purpose, encrypted: pointer.encrypted, retiredAt: record.revokedAt });
        await tx.delete(POINTER[purpose]);
      }
      return describe(record, purpose, null);
    });
  }
  /** Public descriptor of `kid` under `purpose`, or null. */
  async lookup(owner, { purpose, kid } = {}) {
    purposeOf(purpose); if (!boundedString(owner) || !boundedString(kid)) return null;
    return this.store.transaction(async tx => { const record = await tx.get(publicPath(purpose, owner, kid)); return record?.owner === owner ? describe(record, purpose, await this.#pointer(tx, owner, purpose)) : null; });
  }
  async current(owner, { purpose } = {}) {
    purposeOf(purpose); ownerOf(owner);
    return this.store.transaction(async tx => { const pointer = await this.#pointer(tx, owner, purpose), record = pointer && await tx.get(publicPath(purpose, owner, pointer.kid)); return record ? describe(record, purpose, pointer) : null; });
  }
  /** Bounded history, oldest first. */
  async history(owner, { purpose } = {}) {
    purposeOf(purpose); ownerOf(owner);
    return this.store.transaction(async tx => { const pointer = await this.#pointer(tx, owner, purpose); return (await this.#records(tx, owner, purpose)).map(record => describe(record, purpose, pointer)); });
  }
  /** The current private key, imported non-extractable for its purpose only (sign, or ECDH deriveBits), or null. */
  async privateKey(owner, purpose) {
    ownerOf(owner); purposeOf(purpose); this.#sealing();
    const pointer = await this.store.transaction(async tx => { const found = await this.#pointer(tx, owner, purpose); return found && keyState(await tx.get(publicPath(purpose, owner, found.kid)) ?? { active: true }) !== 'revoked' ? found : null; });
    return pointer ? { kid: pointer.kid, privateKey: await this.#importPrivate(purpose, await this.open(pointer.encrypted)) } : null;
  }
  /** Internal identity-backup port only: the current private JWK of `purpose`, or null. Never expose through a route. */
  async exportPrivate(owner, purpose) {
    ownerOf(owner); purposeOf(purpose); this.#sealing();
    const pointer = await this.store.transaction(tx => this.#pointer(tx, owner, purpose));
    return pointer ? { kid: pointer.kid, privateJWK: await this.open(pointer.encrypted) } : null;
  }
}

// Engine operations. `owner` is the authenticated principal the caller speaks for; nothing else is copied in.
class KeyAction extends Action {
  static deps = ['identityKeys'];
  constructor({ owner, input } = {}) { super(); this.owner = owner; this.input = input ?? {}; }
  async execute({ identityKeys }, { dispatchFeed, engineFeed }) {
    const value = await this.run(identityKeys);
    dispatchFeed.dispatchEvent(new CustomEvent('result', { detail: value }));
    engineFeed.dispatchEvent(new CustomEvent('identity-keys-changed', { detail: { owner: this.owner, purpose: this.input.purpose ?? 'signing' } }));
  }
}
/** `input`: {purpose}. */
export class EnsureIdentityKey extends KeyAction { run(keys) { return keys.ensure(this.owner, this.input.purpose); } }
/** `input`: {purpose, expectedKid}. */
export class RotateIdentityKey extends KeyAction { run(keys) { return keys.rotate(this.owner, this.input); } }
/** `input`: {purpose, kid, reason?}. */
export class RevokeIdentityKey extends KeyAction { run(keys) { return keys.revoke(this.owner, this.input); } }
/** `input`: {kid, alg, publicJwk}; legacy public-only signing registration. */
export class RegisterIdentityKey extends KeyAction { run(keys) { return keys.register(this.owner, this.input); } }
class KeyQuery extends Query {
  static deps = ['identityKeys'];
  constructor({ owner, input } = {}) { super(); this.owner = owner; this.input = input ?? {}; }
}
/** `input`: {purpose, kid}. */
export class IdentityKeyByKid extends KeyQuery { fetch({ identityKeys }) { return identityKeys.lookup(this.owner, this.input); } }
/** `input`: {purpose}. */
export class CurrentIdentityKey extends KeyQuery { fetch({ identityKeys }) { return identityKeys.current(this.owner, this.input); } }
/** `input`: {purpose}. */
export class IdentityKeyHistory extends KeyQuery { fetch({ identityKeys }) { return identityKeys.history(this.owner, this.input); } }

/** An engine over one registry (or the resources to build one); `engine.identityKeys` is that registry. */
export function createIdentityKeyEngine(resources) {
  const registry = resources instanceof IdentityKeyRegistry ? resources : new IdentityKeyRegistry(resources);
  return Object.assign(new Engine({ providers: { identityKeys: Provider.fromSingleton(registry) } }), { identityKeys: registry });
}
/** Dispatches a key Action and resolves with its result once the dispatch completed; rejects with what it threw. */
export async function performKeyAction(engine, action) {
  const feed = engine.dispatch(action); let result;
  feed.addEventListener('result', event => { result = event; }, { once: true });
  await feed.next('complete');
  if (!result) throw new Error(`${action.constructor.name} completed without a result`);
  return result.detail;
}
export const readKeyQuery = (engine, query) => engine.query(query).peek();
