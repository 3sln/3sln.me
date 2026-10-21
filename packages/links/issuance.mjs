// Core links: issuance, stored exact-claims verification, challenge rotation and the links contract service
// (docs/spec/links.md §3.3, §7.1; docs/spec/bindlebox.md §4.2; extraction plan slice C1a).
//
// Keys. New metas are always signed with the owner's CURRENT identity signing key from the registry
// (packages/identity/keys.mjs), never with a kid a caller or a stored parent names. Verification goes through the
// registry's history instead: a meta whose exact header and claims the provider stored stays valid under a retired
// key (rotation never breaks issued links) and stops verifying once that key is revoked or pruned. A fresh
// signature can therefore never be produced under a retired key, and a revoked key verifies nothing.
//
// LinkService holds the app-declared link types of ./types.mjs on `link/<jti>/` records. The legacy core contact
// type stays on `contact-grant` parents (ContactEndpointService) until cutover and uses the helpers below.
import { fail, key, canonical, boundedString } from '../core/records.mjs';
import { keyState, verifiableSigningKey } from '../identity/keys.mjs';
import { parseLinkQuery, parseLinkMeta, verifyLinkSignature, signLinkJWS, exactMembers, base64urlRandom, LINK_META_TYP } from './envelope.mjs';
import { linkBinding } from './types.mjs';
import { UUID } from '../core/primitives.mjs';

/** The kid/alg new metas must carry: the owner's current registry signing key. Without a registry-held current
 * key (externally registered keys only) the caller's `fallback` is used, which callers check is itself active. */
export async function currentLinkKey(keys, owner, fallback) {
  // A store whose key pointer belongs to another owner (shared test stores) has no current key for this owner.
  let current = null; try { current = typeof keys?.current === 'function' ? await keys.current(owner, { purpose: 'signing' }) : null; } catch (error) { if (error?.code !== 'forbidden') throw error; }
  return current?.current === true && current.state === 'active' ? { kid: current.kid, alg: current.alg } : fallback ?? null;
}
/** True only for a signing record in state `active` (the current key, or an external key never superseded). */
export const mintableSigningKey = async (tx, owner, kid) => keyState(await tx.get(key('contact-key', owner, kid))) === 'active';
/** Signs a meta and returns the exact value and signing input the provider stores. */
export async function signLinkMeta({ header, claims, privateKey, crypto = globalThis.crypto }) {
  if (header?.typ !== LINK_META_TYP) fail('invalid_token');
  const value = await signLinkJWS({ header, claims, privateKey, crypto });
  return { value, input: value.split('.').slice(0, 2).join('.') };
}
/** links §3.3 inside a transaction: exact stored header, claims and input; a key that is active or retired (never
 * revoked or pruned) in the owner's history; a valid signature over the received input. */
export async function verifyStoredMeta(tx, parsed, stored, { owner, crypto = globalThis.crypto }) {
  if (canonical(stored.header) !== canonical(parsed.header) || canonical(stored.claims) !== canonical(parsed.claims) || stored.input !== parsed.input) return false;
  const record = await verifiableSigningKey(tx, owner, parsed.header.kid);
  return Boolean(record && record.alg === parsed.header.alg && await verifyLinkSignature(crypto, parsed, { alg: record.alg, publicJwk: record.publicJwk }));
}

const HANDLE = /^(?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9})$/;
const pad = value => String(value).padStart(16, '0');
const DAY = 86400000, PURGE_AFTER = 30 * DAY;
const PRINCIPAL = principal => typeof principal?.issuer === 'string' && principal.issuer.length <= 2048 && UUID.test(principal?.subject ?? '');
// Store contracts differ in list order (Map insertion order in memory); every ordered read sorts by key.
const sorted = rows => [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const live = (record, now) => Boolean(record && !record.revoked && record.claims.exp * 1000 > now);

export class LinkService {
  /** `store`: the transaction contract (`transaction(tx => {get, set, delete, list(prefix)})`). `keys`: the identity
   * key registry (current key lookups). `signingKey(owner)` -> {kid, privateKey}: the current private key, imported
   * for signing only. `decide({owner, parent, policy, principal})`: the bounded audience decision (links §7.5).
   * `policies`: the operator registry URIs (packages/links/policies.mjs). */
  constructor({ store, issuer, keys, signingKey, decide, policies = [], crypto = globalThis.crypto, clock = () => Date.now(), maxLinks = 1000, changeRetention = 1024, evaluationsPerLink = 60, evaluationsPerOwner = 600 }) {
    let origin; try { origin = new URL(issuer); } catch { fail('invalid_link_service'); }
    if (typeof store?.transaction !== 'function' || origin.origin !== issuer || typeof signingKey !== 'function' || !Array.isArray(policies) || !Number.isSafeInteger(maxLinks) || maxLinks < 1 || !Number.isSafeInteger(changeRetention) || changeRetention < 1) fail('invalid_link_service');
    if (![evaluationsPerLink, evaluationsPerOwner].every(value => Number.isSafeInteger(value) && value > 0)) fail('invalid_link_service');
    Object.assign(this, { store, issuer, keys, signingKey, decide, policies: Object.freeze([...policies]), crypto, clock, maxLinks, changeRetention, evaluationsPerLink, evaluationsPerOwner });
  }
  async #bound(tx, owner) { const bound = await tx.get('owner'); if (bound !== undefined && bound !== owner) fail('forbidden'); }
  async #state(tx, owner) { return (await tx.get(key('link-state', owner))) ?? { seq: 0, floor: 0, count: 0 }; }
  async #change(tx, owner, state, jti, slot, change) {
    state.seq += 1; await tx.set(key('link-change', owner, pad(state.seq)), { seq: state.seq, jti, slot, change });
    // Bounded change log: a reader older than the floor is told to re-list (`reset`), never given a partial view.
    const rows = sorted(await tx.list(key('link-change', owner)));
    for (const row of rows.slice(0, Math.max(0, rows.length - this.changeRetention))) { await tx.delete(row.key); state.floor = Math.max(state.floor, row.value.seq); }
  }
  // Expired records are kept 30 days for list/changes, then reclaimed (bounded) when the owner is at the cap.
  async #reclaim(tx, owner, state, now) {
    let removed = 0;
    for (const { key: path, value } of sorted(await tx.list(key('link')))) {
      if (removed >= 16) break;
      if (value?.owner !== owner) continue;
      // Revoked records were uncounted at revocation; expired live ones are uncounted here.
      if (value.revoked && Math.min(value.revokedAt ?? Infinity, value.claims.exp * 1000) + PURGE_AFTER <= now) { await tx.delete(path); continue; }
      if (!value.revoked && value.claims.exp * 1000 + PURGE_AFTER <= now) { await tx.delete(path); removed++; }
    }
    state.count = Math.max(0, state.count - removed);
  }

  /** Issues one link of an app-declared type. `issuer`: {kind, clientId?, generation?} for the record. */
  async issue(owner, { type, claims, expiresAt, audience, handle } = {}, issuer = { kind: 'owner' }) {
    const binding = linkBinding(type), now = this.clock();
    if (!UUID.test(owner ?? '')) fail('invalid_link_owner');
    if (!binding) fail('unsupported_link_type');
    if (!exactMembers(claims, binding.members) || !binding.valid(claims)) fail('invalid_link_claims');
    if (!Number.isSafeInteger(expiresAt) || Math.floor(expiresAt / 1000) <= Math.floor(now / 1000) + 60 || expiresAt > now + 366 * DAY) fail('invalid_link_expiry');
    if (audience !== undefined && (!binding.conditional || !exactMembers(audience, [], ['policy']) || (audience.policy !== undefined && !this.policies.includes(audience.policy)))) fail('invalid_link_policy');
    if (typeof handle !== 'string' || !HANDLE.test(handle)) fail('invalid_handle');
    const signer = await this.signingKey(owner);
    if (!boundedString(signer?.kid) || !signer.privateKey) fail('identity_keys_unavailable');
    const jti = this.crypto.randomUUID(), aud = `${this.issuer}${binding.path(handle, jti)}`, iat = Math.floor(now / 1000);
    const header = { alg: 'ES256', kid: signer.kid, typ: LINK_META_TYP };
    const meta = { bindle: 'link-meta', v: 1, type, iss: this.issuer, aud, jti, iat, exp: Math.floor(expiresAt / 1000), sub: owner, ...structuredClone(claims), ...(audience ? { audience: { challenge: base64urlRandom(this.crypto, 16), ...(audience.policy ? { policy: audience.policy } : {}) } } : {}) };
    const { value, input } = await signLinkMeta({ header, claims: meta, privateKey: signer.privateKey, crypto: this.crypto });
    const refused = await this.store.transaction(async tx => {
      await this.#bound(tx, owner);
      // The key must still be current when the record commits: a concurrent rotation or revocation refuses.
      if (!await mintableSigningKey(tx, owner, signer.kid)) fail('key_conflict');
      const state = await this.#state(tx, owner);
      // Reclaimed rows commit even when the cap still refuses, so the refusal is returned rather than thrown.
      if (state.count >= this.maxLinks) { await this.#reclaim(tx, owner, state, now); if (state.count >= this.maxLinks) { await tx.set(key('link-state', owner), state); return 'link_limit'; } }
      state.count += 1;
      await tx.set(key('link', jti), { version: 1, jti, owner, type, slot: binding.slot, header, claims: meta, input, revoked: false, issuedAt: now, issuer: { kind: issuer.kind, ...(issuer.clientId ? { clientId: issuer.clientId } : {}), ...(issuer.generation !== undefined ? { generation: issuer.generation } : {}) } });
      await this.#change(tx, owner, state, jti, binding.slot, 'issued');
      await tx.set(key('link-state', owner), state);
      return null;
    });
    if (refused) fail(refused);
    return { link: `${aud}?bindle_meta=${value}`, jti };
  }
  async #owned(tx, owner, jti, slots) {
    const record = typeof jti === 'string' && UUID.test(jti) ? await tx.get(key('link', jti)) : undefined;
    if (record?.owner !== owner || (slots && !slots.includes(record.slot))) fail('not_found');
    return record;
  }
  /** Idempotent revocation. `slots`, when given, limits the caller to links of those slots. */
  async revoke(owner, jti, { slots } = {}) {
    return this.store.transaction(async tx => {
      await this.#bound(tx, owner); const record = await this.#owned(tx, owner, jti, slots);
      if (record.revoked) return {};
      const state = await this.#state(tx, owner);
      // A revoked link stops counting toward the cap at once (review finding 2); its record stays for list/changes.
      state.count = Math.max(0, state.count - 1);
      await tx.set(key('link', jti), { ...record, revoked: true, revokedAt: this.clock() });
      await this.#change(tx, owner, state, jti, record.slot, 'revoked'); await tx.set(key('link-state', owner), state);
      return {};
    });
  }
  /** Challenge rotation (links §7.1): a fresh challenge and `iat`, every other claim kept, re-signed with the
   * CURRENT key. The previous meta and every outstanding response stop verifying. */
  async rotateChallenge(owner, jti, { slots } = {}) {
    const before = await this.store.transaction(async tx => { await this.#bound(tx, owner); return this.#owned(tx, owner, jti, slots); });
    if (!live(before, this.clock()) || !before.claims.audience) fail('not_found');
    const signer = await this.signingKey(owner);
    if (!boundedString(signer?.kid) || !signer.privateKey) fail('identity_keys_unavailable');
    const header = { alg: 'ES256', kid: signer.kid, typ: LINK_META_TYP }, claims = { ...before.claims, iat: Math.floor(this.clock() / 1000), audience: { ...before.claims.audience, challenge: base64urlRandom(this.crypto, 16) } };
    const { value, input } = await signLinkMeta({ header, claims, privateKey: signer.privateKey, crypto: this.crypto });
    return this.store.transaction(async tx => {
      const current = await this.#owned(tx, owner, jti, slots);
      if (!live(current, this.clock()) || current.input !== before.input) fail('rotation_conflict');
      if (!await mintableSigningKey(tx, owner, signer.kid)) fail('key_conflict');
      await tx.set(key('link', jti), { ...current, header, claims, input });
      return { link: `${claims.aud}?bindle_meta=${value}`, jti };
    });
  }
  /** Bounded page of the owner's links, ordered by jti. */
  async list(owner, { type, cursor, limit = 50 } = {}, { slots } = {}) {
    if ((type !== undefined && !linkBinding(type)) || (cursor !== undefined && !UUID.test(cursor ?? '')) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_link_query');
    return this.store.transaction(async tx => {
      await this.#bound(tx, owner);
      const rows = (await tx.list(key('link'))).map(row => row.value).filter(record => record?.owner === owner && (type === undefined || record.type === type) && (!slots || slots.includes(record.slot)) && (cursor === undefined || record.jti > cursor)).sort((a, b) => (a.jti < b.jti ? -1 : 1));
      const page = rows.slice(0, limit);
      return { links: page.map(record => ({ jti: record.jti, type: record.type, header: record.header, claims: record.claims, revoked: record.revoked, occupantGeneration: record.issuer.generation ?? null })), ...(rows.length > limit ? { cursor: page.at(-1).jti } : {}) };
    });
  }
  /** Issued and revoked `jti` values since provider sequence `since`; `reset` when the log no longer reaches it. */
  async changes(owner, { since = 0 } = {}, { slots } = {}) {
    if (!Number.isSafeInteger(since) || since < 0) fail('invalid_link_query');
    return this.store.transaction(async tx => {
      await this.#bound(tx, owner); const state = await this.#state(tx, owner);
      if (since > state.seq) fail('invalid_link_query');
      if (since < state.floor) return { reset: true, seq: state.seq };
      const changes = sorted(await tx.list(key('link-change', owner))).map(row => row.value).filter(row => row.seq > since && (!slots || slots.includes(row.slot))).map(({ seq, jti, change }) => ({ seq, jti, change }));
      return { changes, seq: state.seq };
    });
  }
  /** Delivery-time policy evaluation (links §7.5) for a verified principal: eligible, ineligible or unavailable. */
  async evaluate(owner, { jti, principal } = {}, { slots } = {}) {
    if (!PRINCIPAL(principal)) fail('invalid_link_query');
    const record = await this.store.transaction(async tx => { await this.#bound(tx, owner); return this.#owned(tx, owner, jti, slots); });
    if (!live(record, this.clock()) || !record.claims.audience || typeof this.decide !== 'function') return { state: 'unavailable' };
    // The principal is the author the occupant verified; the host cannot re-check it here (review finding 1), so
    // evaluations are budgeted per link and per owner per hour. Past the budget the answer is `unavailable`, which
    // bounds the policy oracle, cross-account tier lookups and decision-row writes an occupant can cause.
    if (!await this.#evaluationBudget(owner, jti)) return { state: 'unavailable' };
    let decision; try { decision = await this.decide({ owner, parent: jti, policy: record.claims.audience.policy, principal: { issuer: principal.issuer, subject: principal.subject } }); } catch { decision = null; }
    return { state: ['eligible', 'ineligible'].includes(decision?.state) ? decision.state : 'unavailable' };
  }
  async #evaluationBudget(owner, jti) {
    const hour = Math.floor(this.clock() / 3600000);
    return this.store.transaction(async tx => {
      const linkKey = key('link-evaluations', owner, jti), ownerKey = key('link-evaluations', owner), perLink = await tx.get(linkKey), perOwner = await tx.get(ownerKey);
      const linkCount = perLink?.hour === hour ? perLink.count : 0, ownerCount = perOwner?.hour === hour ? perOwner.count : 0;
      if (linkCount >= this.evaluationsPerLink || ownerCount >= this.evaluationsPerOwner) return false;
      await tx.set(linkKey, { hour, count: linkCount + 1 }); await tx.set(ownerKey, { hour, count: ownerCount + 1 });
      return true;
    });
  }
  /** Owner-host verification of a received link URL (links §2, §3.3, §8 steps 1–3). */
  async verify(url, { allowData = false } = {}) {
    let query, meta, binding;
    try {
      query = parseLinkQuery(url); const target = new URL(url);
      if (query.form !== 'link' || target.username || target.password || target.origin !== this.issuer) fail('link_invalid');
      meta = parseLinkMeta(query.meta); binding = linkBinding(meta.claims.type);
      if (!binding || meta.claims.iss !== this.issuer || meta.claims.aud !== `${target.origin}${target.pathname}` || !UUID.test(meta.claims.jti) || !UUID.test(meta.claims.sub ?? '')) fail('link_invalid');
    } catch (error) { if (error?.code === 'link_malformed') throw error; fail('link_invalid'); }
    const record = await this.store.transaction(async tx => {
      const stored = await tx.get(key('link', meta.claims.jti));
      if (!live(stored, this.clock()) || stored.owner !== meta.claims.sub || !await verifyStoredMeta(tx, meta, stored, { owner: stored.owner, crypto: this.crypto })) fail('link_invalid');
      return stored;
    });
    if (query.data !== undefined && (!allowData || !meta.claims.audience)) fail('link_malformed');
    return { record, meta, conditional: Boolean(meta.claims.audience), ...(query.data !== undefined ? { data: query.data } : {}) };
  }
}
