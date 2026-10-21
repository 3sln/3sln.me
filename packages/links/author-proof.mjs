// Core links: host-verifiable author proof for links-contract `evaluate` (docs/spec/links.md §7.5; bindlebox.md
// §3.3, §4.6; core-links review finding 1, closed by slice BB-C1b).
//
// `evaluate` decides a policy for a principal. Before C1b the occupant named that principal and the host trusted it,
// so an occupant could use a conditional link as an oracle for anyone's policy state. Now the occupant must hand the
// host the author-signed object it is admitting: the signed envelope `{payload, proof}` exactly as received. The host
// accepts it only when, independently of the occupant:
//   - the envelope is addressed to THIS link: payload.recipient = {issuer: host, owner, contactId: jti, ...};
//   - its author principal is the principal being evaluated, its kind is a link kind, and createdAt lies in the
//     link window (24 h, ±60 s skew) of the host clock;
//   - the delegation certificate (header {alg:'ES256', kid, typ:'bindle-key-delegation+jwt'}) is for that principal,
//     certifies the author purpose for the proof's jkt, is valid now and since createdAt, and verifies under the
//     principal's identity key resolved by the HOST (`resolveKey`; same-host principals only until the directory
//     profile exists, every other issuer is unverifiable);
//   - the envelope signature verifies under the certified delegate key over the bindlebox envelope domain;
//   - the host's delegation status port answers `active` for that jkt (a revoked delegate key proves nothing).
// A proof is reusable within its window only for the same (link, principal) pair, which is exactly the evaluation an
// honest occupant needs; budgets in LinkService bound the rest.
//
// Core may not import BindleBox (tests/bindlebox/import-boundary.test.mjs). The envelope domain, the JCS reading and
// the certificate shape are written here against packages/bindlebox-protocol and pinned to it by
// tests/core-links-handoff.test.mjs, which verifies proofs produced by the protocol library's own signers.
import { fail, base64url, fromBase64url, textEncoder, strictText } from '../core/records.mjs';
import { UUID } from '../core/primitives.mjs';
import { DELEGATION_PURPOSES, DELEGATION_TYP, delegatePublicJwk, jwkThumbprint } from '../identity/delegation.mjs';

export const ENVELOPE_DOMAIN = 'bindlebox-envelope-v1\n';
export const AUTHOR_PROOF_LIMITS = Object.freeze({ maxBytes: 65536, windowMs: 86400000, skewMs: 60000, maxCompact: 8192, maxCertificateSeconds: 86400 });
const LINK_KINDS = ['conversation-init', 'one-off'];
const ES256 = { name: 'ECDSA', hash: 'SHA-256' }, P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const B64 = /^[A-Za-z0-9_-]+$/, JKT = /^jkt:[A-Za-z0-9_-]{43}$/, COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const invalid = () => fail('author_proof_invalid');
const unavailable = () => fail('author_proof_unavailable');
const exact = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

/** RFC 8785 over the I-JSON the bindlebox profile admits (safe integers, well-formed strings, plain objects). */
export function jcs(value, depth = 0) {
  if (depth > 32) invalid();
  if (value === null || value === true || value === false) return String(value);
  if (typeof value === 'string') { if (!value.isWellFormed()) invalid(); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(); return String(value); }
  if (Array.isArray(value)) return `[${Array.from(value, v => jcs(v, depth + 1)).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${jcs(k)}:${jcs(value[k], depth + 1)}`).join(',')}}`;
  invalid();
}
// Strict certificate segments: UTF-8 I-JSON, depth-bounded by jcs, and no duplicate member names at any depth
// (counted by a tokenizer pass, since JSON.parse silently keeps the last duplicate).
function duplicateMembers(text) {
  const stack = []; let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { let j = i + 1; while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1; const name = text.slice(i, j + 1); i = j + 1; let k = i; while (/\s/.test(text[k])) k++; const top = stack.at(-1); if (top instanceof Set && text[k] === ':') { if (top.has(name)) return true; top.add(name); } continue; }
    if (ch === '{') stack.push(new Set()); else if (ch === '[') stack.push(null); else if (ch === '}' || ch === ']') stack.pop();
    i++;
  }
  return false;
}
const json = segment => { let text, value; try { text = strictText(fromBase64url(segment)); value = JSON.parse(text); } catch { invalid(); } if (text.length > AUTHOR_PROOF_LIMITS.maxCompact || duplicateMembers(text)) invalid(); jcs(value); return value; };
const signature = value => { if (typeof value !== 'string' || value.length !== 86 || !B64.test(value)) invalid(); const bytes = fromBase64url(value); if (bytes.length !== 64 || base64url(bytes) !== value) invalid(); return bytes; };
async function verifyES256(publicJwk, bytes, input, crypto) {
  let key; try { key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, P256, false, ['verify']); } catch { return false; }
  try { return await crypto.subtle.verify(ES256, key, bytes, input); } catch { return false; }
}

/**
 * Verifies one author proof. Throws `author_proof_invalid` (the proof does not prove authorship of a delivery to this
 * link by this principal) or `author_proof_unavailable` (the host cannot decide now: key lookup or status failed).
 * Ports: `resolveKey({issuer, subject, kid})` -> {alg:'ES256', publicJwk} | null (null: unverifiable, a throw:
 * unavailable); `status({issuer, subject, jkt})` -> {status:'active'|...} (anything but active is invalid, a throw or
 * a missing port is unavailable). Returns {principal:{issuer, subject}, jkt, createdAt}.
 */
export async function verifyAuthorProof(proof, { issuer, owner, jti, resource, kinds, principal, now, resolveKey, status, crypto = globalThis.crypto }) {
  if (!Number.isSafeInteger(now) || !UUID.test(owner ?? '') || !UUID.test(jti ?? '') || typeof issuer !== 'string') invalid();
  if (typeof principal?.issuer !== 'string' || !UUID.test(principal?.subject ?? '')) invalid();
  // Shape and size first: everything below is bounded by the profile's envelope limit.
  let size; try { size = textEncoder.encode(jcs(proof)).length; } catch { invalid(); }
  if (size > AUTHOR_PROOF_LIMITS.maxBytes || !exact(proof, ['payload', 'proof'])) invalid();
  const { payload: p, proof: sig } = proof;
  if (!exact(sig, ['alg', 'kid', 'delegation', 'signature']) || sig.alg !== 'ES256' || typeof sig.kid !== 'string' || !JKT.test(sig.kid) || typeof sig.delegation !== 'string' || sig.delegation.length > AUTHOR_PROOF_LIMITS.maxCompact || !COMPACT.test(sig.delegation)) invalid();
  const envelopeSignature = signature(sig.signature), jkt = sig.kid.slice(4);
  // Binding to this link, this owner and this principal, before any crypto or lookup.
  if (!plain(p) || !LINK_KINDS.includes(p.kind) || !plain(p.recipient) || p.recipient.issuer !== issuer || p.recipient.owner !== owner || p.recipient.contactId !== jti || (resource !== undefined && p.recipient.resource !== resource) || (kinds !== undefined && !kinds.includes(p.kind))) invalid();
  const author = p.author;
  if (!exact(author, ['principal', 'identityDocument', 'keyId', 'delegate']) || !exact(author.principal, ['issuer', 'subject', 'identityURI']) || author.principal.issuer !== principal.issuer || author.principal.subject !== principal.subject || author.delegate !== sig.kid || typeof author.keyId !== 'string' || !author.keyId || author.keyId.length > 512) invalid();
  if (!Number.isSafeInteger(p.createdAt) || p.createdAt > now + AUTHOR_PROOF_LIMITS.skewMs || p.createdAt < now - AUTHOR_PROOF_LIMITS.windowMs - AUTHOR_PROOF_LIMITS.skewMs) invalid();
  // Delegation certificate (spec §3.2): the issuer-signed binding of the delegate key to the principal.
  const [h, c] = sig.delegation.split('.'), header = json(h), claims = json(c), certSignature = signature(sig.delegation.split('.')[2]);
  if (!exact(header, ['alg', 'kid', 'typ']) || header.alg !== 'ES256' || header.typ !== DELEGATION_TYP || header.kid !== author.keyId) invalid();
  if (!exact(claims, ['bindle', 'v', 'iss', 'sub', 'delegate', 'jkt', 'purposes', 'client', 'cnx', 'since', 'jti', 'iat', 'exp']) || claims.bindle !== 'key-delegation' || claims.v !== 1 || claims.iss !== principal.issuer || claims.sub !== principal.subject || claims.jkt !== jkt) invalid();
  if (!Array.isArray(claims.purposes) || !claims.purposes.includes(DELEGATION_PURPOSES.author) || ![claims.since, claims.iat, claims.exp].every(Number.isSafeInteger) || !(claims.iat < claims.exp) || claims.exp - claims.iat > AUTHOR_PROOF_LIMITS.maxCertificateSeconds || claims.since > claims.iat) invalid();
  if (now < claims.iat * 1000 - AUTHOR_PROOF_LIMITS.skewMs || now > claims.exp * 1000 + AUTHOR_PROOF_LIMITS.skewMs || p.createdAt < claims.since * 1000 - AUTHOR_PROOF_LIMITS.skewMs) invalid();
  const delegate = await delegatePublicJwk(claims.delegate, crypto);
  if (!delegate || await jwkThumbprint(delegate.jwk, crypto) !== jkt) invalid();
  // The identity key comes from the host, never from the proof.
  if (typeof resolveKey !== 'function') unavailable();
  let identityKey; try { identityKey = await resolveKey({ issuer: principal.issuer, subject: principal.subject, kid: header.kid }); } catch { unavailable(); }
  if (!identityKey || identityKey.alg !== 'ES256' || !plain(identityKey.publicJwk) || !await verifyES256(identityKey.publicJwk, certSignature, textEncoder.encode(`${h}.${c}`), crypto)) invalid();
  if (!await verifyES256(delegate.jwk, envelopeSignature, textEncoder.encode(ENVELOPE_DOMAIN + jcs({ alg: sig.alg, kid: sig.kid, payload: p })), crypto)) invalid();
  // Status last, so a forged proof costs no status lookup.
  if (typeof status !== 'function') unavailable();
  let state; try { state = await status({ issuer: principal.issuer, subject: principal.subject, jkt }); } catch { unavailable(); }
  if (state?.status !== 'active') { if (state?.status === 'revoked') invalid(); unavailable(); }
  return { principal: { issuer: principal.issuer, subject: principal.subject }, jkt, createdAt: p.createdAt };
}
