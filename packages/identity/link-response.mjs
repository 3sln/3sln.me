import { fail } from '../messaging/store.mjs';
import { signContactToken } from '../messaging/contact-tokens.mjs';
import { parseLinkQuery, parseLinkMeta, parseLinkData, metaDigest, verifyLinkSignature, replayDigest, exactMembers, exactOrigin, randomToken, base64urlRandom, plainObject, LINK_DATA_TYP, CONTACT_LINK_TYPE } from '../messaging/bindle-links.mjs';

// Audience responses for conditional contact links (links §7.2, §7.3, §9).
// Providers sign only claims constructed here from a parsed meta, never
// caller-supplied bytes; owner hosts verify same-host principals only.
const DATA = ['bindle', 'v', 'type', 'md', 'aud', 'iat', 'exp', 'iss', 'sub', 'handle', 'nonce'];
const SKEW = 60, LIFETIME = 300;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const handleParts = (handle, iss) => { const at = typeof handle === 'string' ? handle.lastIndexOf('@') : -1, local = at > 0 ? handle.slice(0, at) : ''; return at > 0 && /^[a-z0-9][a-z0-9._-]{2,31}$/.test(local) && handle.slice(at + 1) === new URL(iss).host ? local : null; };

// §9 provider checks on an unverified link: exactly one query component
// bindle_meta, aud equals the link's origin and path, supported type, audience.
export function prepareLinkResponse(link, { types = [CONTACT_LINK_TYPE], allowInsecureLocalhost = false } = {}) {
  const query = parseLinkQuery(link);
  let meta;
  try {
    const target = new URL(link);
    if (query.form !== 'link' || query.data !== undefined || link.includes('#') || target.username || target.password || target.search !== `?bindle_meta=${query.meta}`) fail('link_invalid');
    meta = parseLinkMeta(query.meta);
    if (!(meta.claims.aud.startsWith('https:') || (allowInsecureLocalhost && target.protocol === 'http:' && target.hostname === 'localhost')) || meta.claims.aud !== `${target.origin}${target.pathname}` || !types.includes(meta.claims.type) || !plainObject(meta.claims.audience)) fail('link_invalid');
  } catch { fail('link_invalid'); }
  return meta;
}

// Constructs and signs a response from meta. `meta` is re-parsed from its
// exact value so callers cannot pair one claim set with another signing input.
// Callers own authentication, explicit account selection, CSRF and per-user rate limits.
export async function signLinkResponse({ meta, principal, key, crypto = globalThis.crypto, clock = () => Date.now(), lifetime = LIFETIME, types = [CONTACT_LINK_TYPE], allowInsecureLocalhost = false }) {
  const parsed = parseLinkMeta(typeof meta === 'string' ? meta : meta?.value);
  // §9 checks repeated here: this operation signs with the user's identity key.
  if (!types.includes(parsed.claims.type) || !(parsed.claims.aud.startsWith('https:') || (allowInsecureLocalhost && parsed.claims.aud.startsWith('http://localhost')))) fail('invalid_link_response');
  const { iss, sub, handle } = principal ?? {};
  if (!exactOrigin(iss) || !uuid(sub) || !handleParts(handle, iss) || !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > LIFETIME || !plainObject(parsed.claims.audience) || !key?.kid || !key?.privateKey) fail('invalid_link_response');
  const iat = Math.floor(clock() / 1000), exp = iat + lifetime;
  const header = { alg: 'ES256', kid: key.kid, typ: LINK_DATA_TYP };
  const claims = { bindle: 'link-data', v: 1, type: parsed.claims.type, md: await metaDigest(crypto, parsed), aud: parsed.claims.aud, iat, exp, iss, sub, handle, nonce: base64urlRandom(crypto, 16) };
  const data = await signContactToken({ header, claims, privateKey: key.privateKey, crypto });
  return { data, url: `${parsed.claims.aud}?bindle_meta=${parsed.value}&bindle_data=${data}`, expiresAt: exp * 1000 };
}

// Owner-host verification (§8 steps 5–7). `meta` must come from a verified
// inspection. `resolve({sub, handle, kid})` reads the host's own identity
// records and returns {active, handle, key:{kid, alg, publicJwk, active, purpose}}
// or null. Foreign issuers are audience_unverifiable until the directory exists.
export async function verifyLinkResponse({ meta, data, origin, resolve, crypto = globalThis.crypto, clock = () => Date.now() }) {
  let parsed, local;
  try {
    parsed = parseLinkData(data, ['ES256']);
    const { claims } = parsed;
    if (!exactMembers(claims, DATA) || claims.type !== meta.claims.type || claims.aud !== meta.claims.aud || !exactOrigin(claims.iss) || !uuid(claims.sub) || !randomToken(claims.nonce) || !(local = handleParts(claims.handle, claims.iss))) fail('audience_malformed');
  } catch { fail('audience_malformed'); }
  const { claims, header } = parsed, now = clock() / 1000;
  if (claims.md !== await metaDigest(crypto, meta)) fail('audience_stale');
  // Validity precedes any lookup so purge timing can never reopen replay.
  if (!(claims.iat < claims.exp) || claims.exp - claims.iat > LIFETIME || claims.iat < meta.claims.iat - SKEW || !(claims.iat - SKEW <= now && now < claims.exp + SKEW)) fail('audience_stale');
  if (claims.iss !== origin || typeof resolve !== 'function') fail('audience_unverifiable');
  const record = await resolve({ sub: claims.sub, handle: local, kid: header.kid });
  const signing = record?.key;
  if (record?.active !== true || record.handle !== local || signing?.kid !== header.kid || signing.active !== true || signing.purpose !== 'signing' || signing.alg !== 'ES256' || signing.publicJwk?.kty !== 'EC' || signing.publicJwk?.crv !== 'P-256' || Object.hasOwn(signing.publicJwk, 'd')) fail('audience_unverifiable');
  if (!await verifyLinkSignature(crypto, parsed, { alg: 'ES256', publicJwk: signing.publicJwk })) fail('audience_unverifiable');
  return { principal: { iss: claims.iss, sub: claims.sub }, replay: { key: await replayDigest(crypto, { jti: meta.claims.jti, iss: claims.iss, sub: claims.sub, nonce: claims.nonce }), expiresAt: (claims.exp + SKEW) * 1000 } };
}
