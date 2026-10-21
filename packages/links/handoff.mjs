// Core links: the `messaging-address` slot handoff (slice BB-C1b; docs/spec/bindlebox.md §2.1–§2.3; links §6.4;
// messaging-app.md §5 "Endpoints come from the occupant, never the slot").
//
// A sender who holds a contact link (from the landing page, an intent `web+bindle://send-message?contact-url=…`, or
// a QR code) GETs the link at the owner host with `Accept: application/vnd.bindlebox.ingress+json`. The provider
//   1. verifies the link itself (LinkService.verify: links §8 steps 1–2, exact stored claims, retired-key history);
//   2. reads the CURRENT occupant of the slot the link type is bound to (./types.mjs), through the occupancy port;
//   3. obtains that occupant's `describe` result through the provider's own consumer port (never from the sender or
//      from the slot), validates it against §2.3, and serves it with the link's signed `kinds` and an `expiresAt` of
//      at most one hour (and never past the link's own expiry).
// No occupant, an occupant whose describe fails or is invalid, or a failing port answers the single uniform
// `recipient_unavailable` (503, Retry-After 3600): nothing distinguishes an absent occupant from one mid-switch.
// Resolution delivers nothing, consumes no quota and creates no state. Describe results are cached per
// (owner, slot, occupant clientId, generation) for at most one hour, so replacing the occupant invalidates the cache.
import { fail } from '../core/records.mjs';
import { linkBinding, MESSAGING_PROFILE } from './types.mjs';

export const DESCRIPTOR_LIMITS = Object.freeze({ maxParticipants: 32, maxMessageBytes: 1048576, maxEnvelopeBytes: 65536, maxBatchContexts: 32, maxProfiles: 16, maxVerifies: 64, cacheMs: 3600000 });
const KINDS = ['conversation-init', 'one-off'];
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const unavailable = () => fail('recipient_unavailable');
function https(value, { allowLoopback = false, endpoint = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u; try { u = new URL(value); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (allowLoopback && loopback && u.protocol === 'http:')) || (loopback && !allowLoopback) || u.username || u.password || u.hash || value.includes('#') || u.search || value.includes('?')) return null;
  if (!endpoint && (u.pathname !== '/' || value !== u.origin)) return null;
  return endpoint && u.href !== value ? null : u;
}
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
/** §2.3 `describe` body (no `expiresAt`), exact members. Returns a detached copy or null. `origin`, when the
 * occupancy port knows it, must be the ingress origin. */
export function validateDescribe(input, { origin, allowLoopback = false } = {}) {
  let v; try { v = structuredClone(input); } catch { return null; }
  const names = ['version', 'profiles', 'ingress', 'limits', 'kinds'], optional = ['multicast', 'verifies'];
  if (!plain(v) || names.some(name => !Object.hasOwn(v, name)) || Object.keys(v).some(name => !names.includes(name) && !optional.includes(name)) || v.version !== 1) return null;
  if (!Array.isArray(v.profiles) || !v.profiles.length || v.profiles.length > DESCRIPTOR_LIMITS.maxProfiles || new Set(v.profiles).size !== v.profiles.length || !v.profiles.every(p => typeof p === 'string' && p.length <= 256 && https(p, { endpoint: true })) || !v.profiles.includes(MESSAGING_PROFILE)) return null;
  const ingress = https(v.ingress, { allowLoopback, endpoint: true }); if (!ingress || (origin !== undefined && ingress.origin !== origin)) return null;
  if (Object.hasOwn(v, 'multicast') && https(v.multicast, { allowLoopback, endpoint: true })?.origin !== ingress.origin) return null;
  if (Object.hasOwn(v, 'verifies') && (!Array.isArray(v.verifies) || v.verifies.length > DESCRIPTOR_LIMITS.maxVerifies || new Set(v.verifies).size !== v.verifies.length || !v.verifies.every(o => https(o, { allowLoopback })))) return null;
  const l = v.limits, limitNames = ['maxParticipants', 'maxMessageBytes', 'maxEnvelopeBytes'];
  if (!plain(l) || limitNames.some(name => !positive(l[name], DESCRIPTOR_LIMITS[name])) || Object.keys(l).some(name => ![...limitNames, 'maxBatchContexts'].includes(name)) || (Object.hasOwn(l, 'maxBatchContexts') && !positive(l.maxBatchContexts, DESCRIPTOR_LIMITS.maxBatchContexts))) return null;
  if (!Array.isArray(v.kinds) || !v.kinds.length || !v.kinds.every((k, i) => KINDS.includes(k) && (i === 0 || v.kinds[i - 1] < k))) return null;
  return v;
}

export class LinkHandoff {
  /** `service`: LinkService (verify). `occupant({owner, slot})` -> {clientId, generation, origin?} | null: the
   * occupancy port (LINK_SLOT_OCCUPANT / EXT-X4). `describe({owner, slot, occupant})` -> describe body: the
   * provider's consumer call to the occupant's mailbox resource (brokered, EXT-X7); without it nothing resolves. */
  constructor({ service, occupant, describe, clock = () => Date.now(), allowLoopback = false, maxCache = 1024 } = {}) {
    if (typeof service?.verify !== 'function' || !Number.isSafeInteger(maxCache) || maxCache < 1) throw new TypeError('Invalid link handoff.');
    Object.assign(this, { service, occupant, describe, clock, allowLoopback: allowLoopback === true, maxCache, cache: new Map() });
  }
  /** Returns the ingress descriptor for a verified link, or throws link_invalid / link_malformed / recipient_unavailable. */
  async descriptor(url) {
    const verified = await this.service.verify(url), record = verified.record, binding = linkBinding(record.type), now = this.clock();
    if (!binding) fail('link_invalid');
    if (typeof this.occupant !== 'function' || typeof this.describe !== 'function') unavailable();
    let seat; try { seat = await this.occupant({ owner: record.owner, slot: binding.slot }); } catch { unavailable(); }
    if (!plain(seat) || typeof seat.clientId !== 'string' || !seat.clientId) unavailable();
    const cacheKey = JSON.stringify([record.owner, binding.slot, seat.clientId, seat.generation ?? null, seat.origin ?? null]);
    let body = this.cache.get(cacheKey);
    if (!body || body.until <= now) {
      this.cache.delete(cacheKey);
      let described; try { described = await this.describe({ owner: record.owner, slot: binding.slot, occupant: { clientId: seat.clientId, generation: seat.generation ?? null, ...(typeof seat.origin === 'string' ? { origin: seat.origin } : {}) } }); } catch { unavailable(); }
      const valid = validateDescribe(described, { origin: typeof seat.origin === 'string' ? seat.origin : undefined, allowLoopback: this.allowLoopback });
      if (!valid) unavailable();
      body = { value: valid, until: now + DESCRIPTOR_LIMITS.cacheMs };
      // Bounded: the oldest entry goes first; a cache miss only costs one describe call.
      while (this.cache.size >= this.maxCache) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(cacheKey, body);
    }
    const { kinds: _instanceKinds, ...rest } = body.value;
    return { ...structuredClone(rest), kinds: [...verified.meta.claims.kinds], expiresAt: Math.min(body.until, now + DESCRIPTOR_LIMITS.cacheMs, verified.meta.claims.exp * 1000) };
  }
}
