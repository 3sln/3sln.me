// Contact-delivery v1 candidate core (docs/spec/contact-delivery.md): strict
// JSON, exact envelope shape, JCS digests and domain-separated ES256 proofs.
// Every link delivery is identity-authored (links.md §6.1); there is no
// author:null branch. Pure: no storage, network or HTTP framing.
import { fail, canonical, digest, fromBase64url, base64url, textEncoder, mimeValid } from './store.mjs';
import { validTagIds } from './tags.mjs';
import { isUUID as uuid } from '../core/primitives.mjs';

export const CONTACT_DELIVERY_CONTRACT = 'https://3sln.me/artefacts/contracts/contact-delivery/v1';
export const CONVERSATION_V2_CONTRACT = 'https://3sln.me/artefacts/contracts/conversation/v2';
export const DELIVERY_DOMAIN = 'bindle-contact-delivery-v1\n';
export const GENESIS_DOMAIN = 'bindle-conversation-genesis-v2\n';
export const ADMISSION_DOMAIN = 'bindle-contact-admission-v1\n';
export const DELIVERY_LIMITS = Object.freeze({ maxRequestBytes: 1500000, maxEnvelopeBytes: 65536, maxBodyBytes: 1048576, maxOperationAgeMs: 86400000, maxFutureSkewMs: 60000, minReceiptRetentionMs: 172800000, maxBootstrapMs: 604800000 });
const ES256 = { name: 'ECDSA', hash: 'SHA-256' };
const bad = () => fail('invalid_envelope');
// Stricter than the schema's C0/DEL pattern: all Cc, line/paragraph separators
// and bidi overrides/isolates are refused in signed display strings.
const controls = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const points = v => [...v].length;
const text = (v, max, min = 0) => typeof v === 'string' && v.isWellFormed() && points(v) >= min && points(v) <= max && !controls.test(v);
const time = v => Number.isSafeInteger(v) && v >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v, required, optional = []) => { if (!object(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) bad(); return v; };
const b64 = (v, bytes) => { if (typeof v !== 'string') bad(); let decoded; try { decoded = fromBase64url(v); } catch { bad(); } if (decoded.byteLength !== bytes) bad(); return decoded; };
// Unicode scalar-value order (not UTF-16 code-unit order) for signed tag lists.
const scalarCompare = (a, b) => { const x = [...a], y = [...b]; for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0); return x.length - y.length; };
export const sameValue = (a, b) => canonical(a) === canonical(b);

// I-JSON parser: rejects duplicate names at any depth, lone surrogates,
// fractions/exponents/negative or unsafe numbers, and depth/size abuse before
// any canonicalization. Members are defined (not assigned) so `__proto__`
// stays an ordinary own key that the exact-shape checks then reject.
export function strictJSON(source, { maxBytes = DELIVERY_LIMITS.maxEnvelopeBytes } = {}) {
  let input = source;
  if (source instanceof Uint8Array) { if (source.byteLength > maxBytes) fail('too_large'); try { input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source); } catch { bad(); } }
  if (typeof input !== 'string' || textEncoder.encode(input).byteLength > maxBytes) fail('too_large');
  if (input.startsWith('\ufeff')) bad();
  let i = 0;
  const ws = () => { while (' \t\n\r'.includes(input[i]) && i < input.length) i++; };
  const token = re => { re.lastIndex = i; const m = re.exec(input); if (!m) bad(); i = re.lastIndex; return m[0]; };
  const string = () => { const raw = token(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y), v = JSON.parse(raw); if (!v.isWellFormed()) bad(); return v; };
  const value = depth => {
    if (depth > 16) bad(); ws(); const c = input[i];
    if (c === '"') return string();
    if (c === '{') { i++; const o = {}; ws(); if (input[i] === '}') { i++; return o; } for (;;) { ws(); if (input[i] !== '"') bad(); const k = string(); if (Object.hasOwn(o, k)) bad(); ws(); if (input[i++] !== ':') bad(); Object.defineProperty(o, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); ws(); const n = input[i++]; if (n === '}') return o; if (n !== ',') bad(); } }
    if (c === '[') { i++; const a = []; ws(); if (input[i] === ']') { i++; return a; } for (;;) { a.push(value(depth + 1)); ws(); const n = input[i++]; if (n === ']') return a; if (n !== ',') bad(); } }
    const literal = token(/true|false|null|(?:0|[1-9][0-9]*)(?![0-9.eE+-])/y);
    if (literal === 'true') return true; if (literal === 'false') return false; if (literal === 'null') return null;
    const n = Number(literal); if (!Number.isSafeInteger(n)) bad(); return n;
  };
  const result = value(0); ws(); if (i !== input.length) bad(); return result;
}

// Exact canonical URL forms; no userinfo, query on origins, fragments or
// parser-normalized spellings. `http://localhost` only when a dev host opts in.
const scheme = (u, local) => u.protocol === 'https:' || (local && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
const url = (v, local) => { if (typeof v !== 'string' || v.length > 2048) bad(); let u; try { u = new URL(v); } catch { bad(); } if (!scheme(u, local) || u.username || u.password || u.hash || u.href !== v) bad(); return u; };
const origin = (v, local) => { if (typeof v !== 'string' || v.length > 2048) bad(); let u; try { u = new URL(v); } catch { bad(); } if (!scheme(u, local) || u.origin !== v) bad(); return v; };
const keyId = v => { if (!text(v, 128, 1)) bad(); return v; };
export function validateIdentity(v, local) {
  exact(v, ['principal', 'identityDocument', 'keyId']); exact(v.principal, ['issuer', 'subject', 'identityURI']);
  origin(v.principal.issuer, local); if (!uuid(v.principal.subject)) bad(); keyId(v.keyId);
  if (url(v.principal.identityURI, local).origin !== v.principal.issuer || url(v.identityDocument, local).origin !== v.principal.issuer) bad();
  return v;
}
const validateProof = v => { exact(v, ['alg', 'kid', 'signature']); if (v.alg !== 'ES256') bad(); keyId(v.kid); b64(v.signature, 64); return v; };
const validateContentDescriptor = v => { exact(v, ['mimeType', 'byteLength', 'sha256']); if (!mimeValid(v.mimeType) || !time(v.byteLength) || v.byteLength > DELIVERY_LIMITS.maxBodyBytes) bad(); b64(v.sha256, 32); return v; };
const validateTags = v => { if (!Array.isArray(v) || v.length > 32 || v.some(t => !text(t, 64, 1) || !t.trim()) || !validTagIds(v, { suspected: false })) bad(); for (let n = 1; n < v.length; n++) if (scalarCompare(v[n - 1], v[n]) >= 0) bad(); return v; };
const principalKey = p => `${p.issuer}\u0000${p.subject}`;

// Every proof's signature bytes are removed (outer and nested genesis), so a
// re-signed retry of identical claims keeps one operation identity.
export const semanticEnvelope = ({ payload, proof }) => {
  const genesis = payload.conversation?.genesis;
  return { payload: genesis ? { ...payload, conversation: { ...payload.conversation, genesis: { payload: genesis.payload, proof: { alg: genesis.proof.alg, kid: genesis.proof.kid } } } } : payload, proof: { alg: proof.alg, kid: proof.kid } };
};
export const signingInput = (domain, { payload, proof }) => textEncoder.encode(domain + canonical({ alg: proof.alg, kid: proof.kid, payload }));
export const payloadDigest = (envelope, crypto = globalThis.crypto) => digest(crypto, canonical(semanticEnvelope(envelope)));

// Protected conversation-v2 bootstrap: shape plus every binding checkable
// without the (unpublished) v2 runtime. Acceptance, peer policy, secret
// custody and return-control dispatch are out of scope for this module.
async function validateConversation(c, payload, local, crypto) {
  exact(c, ['genesis', 'sharedSecret', 'returnControl']); exact(c.genesis, ['payload', 'proof']); validateProof(c.genesis.proof);
  const g = exact(c.genesis.payload, ['version', 'contract', 'conversationId', 'createdAt', 'creator', 'creatorResource', 'participants', 'secretEpoch', 'secretDigest', 'initialContent', 'initialSubject']);
  if (g.version !== 2 || g.contract !== CONVERSATION_V2_CONTRACT || !uuid(g.conversationId) || !time(g.createdAt) || g.createdAt > payload.createdAt || !uuid(g.secretEpoch) || !text(g.initialSubject, 200)) bad();
  validateIdentity(g.creator, local); url(g.creatorResource, local); b64(g.secretDigest, 32); validateContentDescriptor(g.initialContent);
  if (!Array.isArray(g.participants) || g.participants.length < 2 || g.participants.length > 32) bad();
  const seen = new Set(); for (const p of g.participants) { exact(p, ['identity', 'resource']); validateIdentity(p.identity, local); url(p.resource, local); const k = principalKey(p.identity.principal); if (seen.has(k)) bad(); seen.add(k); }
  const creators = g.participants.filter(p => sameValue(p.identity.principal, payload.author.principal)), recipients = g.participants.filter(p => p.identity.principal.issuer === payload.recipient.issuer && p.identity.principal.subject === payload.recipient.owner);
  if (!sameValue(g.creator, payload.author) || creators.length !== 1 || !sameValue(creators[0].identity, payload.author) || creators[0].resource !== g.creatorResource || recipients.length !== 1 || c.genesis.proof.kid !== payload.author.keyId) bad();
  if (!sameValue(g.initialContent, payload.content) || g.initialSubject !== payload.subject) bad();
  if (await digest(crypto, b64(c.sharedSecret, 32)) !== g.secretDigest) bad();
  const r = exact(c.returnControl, ['resource', 'recipient', 'genesisDigest', 'nonce', 'expiresAt', 'method', 'maxBytes', 'capability']);
  url(r.resource, local); exact(r.recipient, ['issuer', 'subject', 'identityURI']); b64(r.genesisDigest, 32);
  if (!sameValue(r.recipient, recipients[0].identity.principal) || !uuid(r.nonce) || !time(r.expiresAt) || r.expiresAt <= payload.createdAt || r.expiresAt > payload.createdAt + DELIVERY_LIMITS.maxBootstrapMs || r.method !== 'respondInvitation' || r.maxBytes !== 8192 || !text(r.capability, 4096, 1)) bad();
  if (await digest(crypto, canonical(semanticEnvelope(c.genesis))) !== r.genesisDigest) bad();
}

// Validates the exact envelope `{payload,proof}`. A null/missing author or
// missing proof is `author_required` (links.md §8), never an anonymous mode.
export async function validateEnvelope(envelope, { allowInsecureLocalhost = false, crypto = globalThis.crypto } = {}) {
  const local = allowInsecureLocalhost;
  if (!object(envelope) || !object(envelope.payload)) bad();
  if (envelope.payload.author == null || envelope.proof == null) fail('author_required');
  exact(envelope, ['payload', 'proof']); validateProof(envelope.proof);
  const p = exact(envelope.payload, ['version', 'kind', 'noReply', 'operationId', 'createdAt', 'recipient', 'content', 'subject', 'optionalTags', 'author'], ['conversation']);
  if (p.version !== 1 || !uuid(p.operationId) || !time(p.createdAt) || !text(p.subject, 200)) bad();
  if (!(p.kind === 'one-off' && p.noReply === true && !Object.hasOwn(p, 'conversation')) && !(p.kind === 'conversation-init' && p.noReply === false && Object.hasOwn(p, 'conversation'))) bad();
  const r = exact(p.recipient, ['issuer', 'owner', 'contactId', 'resource']); origin(r.issuer, local); if (!uuid(r.owner) || !uuid(r.contactId)) bad(); url(r.resource, local);
  validateContentDescriptor(p.content); validateTags(p.optionalTags); validateIdentity(p.author, local);
  if (envelope.proof.kid !== p.author.keyId) bad();
  if (p.kind === 'conversation-init') await validateConversation(p.conversation, p, local, crypto);
  if (textEncoder.encode(canonical(envelope)).byteLength > DELIVERY_LIMITS.maxEnvelopeBytes) fail('too_large');
  return envelope;
}

// Body bytes must match the signed descriptor exactly.
export async function checkBody(envelope, body, crypto = globalThis.crypto) {
  const c = envelope.payload.content;
  if (!(body instanceof Uint8Array)) bad();
  if (body.byteLength > DELIVERY_LIMITS.maxBodyBytes) fail('too_large');
  if (body.byteLength !== c.byteLength || await digest(crypto, body) !== c.sha256) fail('body_mismatch');
  return c.sha256;
}

export const decodeBody = value => { if (typeof value !== 'string' || value.length > 1398102) bad(); if (value === '') return new Uint8Array(); try { return fromBase64url(value); } catch { bad(); } };

const importKey = async (crypto, record) => {
  const jwk = record?.publicJwk;
  if (record?.alg !== 'ES256' || !object(jwk) || Object.hasOwn(jwk, 'd') || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  try { return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); } catch { return null; }
};
export async function verifyProof(domain, signed, record, crypto = globalThis.crypto) {
  const key = await importKey(crypto, record); if (!key) return false;
  try { return await crypto.subtle.verify(ES256, key, fromBase64url(signed.proof.signature), signingInput(domain, signed)); } catch { return false; }
}

// Same-host 3sln identity descriptor. The URIs are this host's naming for its
// own principals; they are compared exactly and never fetched.
export function localIdentityDescriptor(issuer, subject, kid) {
  if (!uuid(subject) || !text(kid, 96, 1) || /[#/?]/.test(kid)) fail('invalid_identity');
  const identityURI = `${issuer}/identity/${subject}`;
  return { principal: { issuer, subject, identityURI }, identityDocument: `${identityURI}/identity.json`, keyId: `${identityURI}#${kid}` };
}

// Author verification. Foreign issuers are refused before any lookup: the
// directory/identity-document profile is unimplemented, so no network fetch,
// embedded key or supplied URI can authenticate them. The resolver must
// return the *locally recorded* descriptor and currently active signing key.
export async function verifyAuthor(envelope, { issuer, resolve, crypto = globalThis.crypto }) {
  const { author } = envelope.payload;
  if (author.principal.issuer !== issuer) fail('author_unverifiable');
  let record; try { record = await resolve({ issuer, subject: author.principal.subject, keyId: author.keyId }); } catch { fail('author_unverifiable'); }
  if (!record || record.active !== true || record.purpose !== 'signing' || !object(record.descriptor) || !sameValue(record.descriptor, author)) fail('author_unverifiable');
  if (!await verifyProof(DELIVERY_DOMAIN, envelope, record, crypto)) fail('author_unverifiable');
  const genesis = envelope.payload.conversation?.genesis;
  if (genesis && !await verifyProof(GENESIS_DOMAIN, genesis, record, crypto)) fail('author_unverifiable');
  return { principal: author.principal, keyId: author.keyId, publicJwk: { x: record.publicJwk.x, y: record.publicJwk.y } };
}

// Adapter for same-host identities: `lookup(subject, kid)` reads that
// account's key record {alg, publicJwk, active, purpose, accountActive};
// accountActive is false for suspended, deleting or deleted accounts.
export function localAuthorResolver({ issuer, lookup }) {
  return async ({ subject, keyId: id }) => {
    const prefix = `${issuer}/identity/${subject}#`;
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const kid = id.slice(prefix.length), record = await lookup(subject, kid);
    if (!record) return null;
    return { descriptor: localIdentityDescriptor(issuer, subject, kid), alg: record.alg, publicJwk: record.publicJwk, active: record.active === true && record.accountActive === true, purpose: record.purpose };
  };
}

// Provider-side sender helper. It only signs a payload it constructs and
// validates itself, always under DELIVERY_DOMAIN; it never signs caller bytes
// (links.md §7.2 signature-domain table). Conversation-init needs the
// unimplemented v2 genesis builder and is refused here.
// A provider that never holds the body may sign the author's own descriptor
// `{byteLength, sha256}` instead; the receiver still checks the exact bytes.
export async function createAuthoredEnvelope({ author, privateKey, recipient, mimeType, body, byteLength, sha256, subject = '', optionalTags = [], operationId, createdAt, kind = 'one-off', allowInsecureLocalhost = false, crypto = globalThis.crypto }) {
  if (kind !== 'one-off') fail('kind_unsupported');
  if (body === undefined ? !time(byteLength) || typeof sha256 !== 'string' : !(body instanceof Uint8Array)) bad();
  const content = body === undefined ? { mimeType, byteLength, sha256 } : { mimeType, byteLength: body.byteLength, sha256: await digest(crypto, body) };
  const payload = { version: 1, kind, noReply: true, operationId: operationId ?? crypto.randomUUID(), createdAt: createdAt ?? Date.now(), recipient, content, subject, optionalTags: Array.isArray(optionalTags) ? [...optionalTags].sort(scalarCompare) : optionalTags, author };
  // Sign exactly the validated detached copy, never the caller's live objects.
  const validated = await validateEnvelope(structuredClone({ payload, proof: { alg: 'ES256', kid: author?.keyId, signature: 'A'.repeat(86) } }), { allowInsecureLocalhost, crypto });
  validated.proof.signature = base64url(new Uint8Array(await crypto.subtle.sign(ES256, privateKey, signingInput(DELIVERY_DOMAIN, validated))));
  return { envelope: validated, body: body?.slice() };
}

export async function signAdmission(payload, { kid, privateKey }, crypto = globalThis.crypto) {
  const proof = { alg: 'ES256', kid };
  return { payload, proof: { ...proof, signature: base64url(new Uint8Array(await crypto.subtle.sign(ES256, privateKey, signingInput(ADMISSION_DOMAIN, { payload, proof })))) } };
}
