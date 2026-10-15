import { fail, base64url, fromBase64url, textEncoder, digest, boundedString } from './store.mjs';

// Single shared Bindle link envelope parser (docs/spec/links.md §2–§4). Edge
// routing, account storage and providers MUST all use this module; never mix
// URLSearchParams decisions with it.
export const LINK_META_TYP = 'bindle-link-meta+jwt';
export const LINK_DATA_TYP = 'bindle-link-data+jwt';
export const CONTACT_LINK_TYPE = 'https://spec.bindle.example/links/contact/v1';
export const LINK_LIMITS = Object.freeze({ meta: 4096, data: 2048, target: 8192 });
const VALUE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Keeps a leading BOM so strictJSON rejects it: no alternative encodings of the same JSON.
const utf8 = bytes => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('invalid_utf8'); } };
const asciiLower = value => value.replace(/[A-Z]/g, char => char.toLowerCase());
// WHATWG percent-decode: invalid sequences such as %zz stay literal.
const percentDecode = value => {
  const bytes = textEncoder.encode(value), out = [];
  for (let i = 0; i < bytes.length; i++) {
    const hex = bytes[i] === 37 && i + 2 < bytes.length ? String.fromCharCode(bytes[i+1], bytes[i+2]) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; } else out.push(bytes[i]);
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(out));
};

export function parseLinkQuery(target) {
  // Bounded before any splitting: the legacy request bound is the larger one (§10).
  if (typeof target !== 'string' || target.length > 18000) fail('link_malformed');
  const base = target.split('#')[0], start = base.indexOf('?'), raw = start < 0 ? '' : base.slice(start + 1);
  let meta, data, legacy = false, bindle = false;
  for (const component of raw.split('&')) {
    if (!component) continue;
    const eq = component.indexOf('='), name = eq < 0 ? component : component.slice(0, eq), decoded = asciiLower(percentDecode(name));
    if (decoded === 'sig') { legacy = true; continue; }
    if (!decoded.startsWith('bindle_')) continue;
    bindle = true;
    const value = eq < 0 ? '' : component.slice(eq + 1);
    if ((name !== 'bindle_meta' && name !== 'bindle_data') || !VALUE.test(value)) fail('link_malformed');
    if (name === 'bindle_meta') { if (meta !== undefined) fail('link_malformed'); meta = value; }
    else { if (data !== undefined) fail('link_malformed'); data = value; }
  }
  if (legacy && bindle) fail('link_malformed');
  if (legacy) return { form: 'legacy' };
  if (!bindle) return { form: 'none' };
  if (meta === undefined || meta.length > LINK_LIMITS.meta || (data !== undefined && data.length > LINK_LIMITS.data) || target.length > LINK_LIMITS.target) fail('link_malformed');
  return data === undefined ? { form: 'link', meta } : { form: 'link', meta, data };
}

// Strict I-JSON (RFC 7493): duplicate names at any depth, lone surrogates,
// non-safe integers, non-finite numbers and trailing data are rejected.
export function strictJSON(text) {
  let i = 0;
  const bad = () => fail('invalid_json'), ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const string = () => {
    let out = ''; i++;
    for (;;) {
      if (i >= text.length) bad();
      const char = text[i++], code = char.charCodeAt(0);
      if (char === '"') return out;
      if (code < 32) bad();
      if (char !== '\\') { out += char; continue; }
      const escape = text[i++];
      if (escape === 'u') {
        const unit = hex4();
        if (unit >= 0xdc00 && unit <= 0xdfff) bad();
        if (unit >= 0xd800 && unit <= 0xdbff) { if (text[i] !== '\\' || text[i+1] !== 'u') bad(); i += 2; const low = hex4(); if (low < 0xdc00 || low > 0xdfff) bad(); out += String.fromCharCode(unit, low); }
        else out += String.fromCharCode(unit);
      } else { const mapped = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape]; if (mapped === undefined) bad(); out += mapped; }
    }
  };
  const hex4 = () => { const digits = text.slice(i, i + 4); if (!/^[0-9A-Fa-f]{4}$/.test(digits)) bad(); i += 4; return parseInt(digits, 16); };
  const value = depth => {
    if (depth > 8) bad(); ws();
    const char = text[i];
    if (char === '{') {
      i++; const entries = [], names = new Set(); ws();
      if (text[i] === '}') { i++; return {}; }
      for (;;) {
        ws(); if (text[i] !== '"') bad();
        const name = string(); if (names.has(name)) bad(); names.add(name);
        ws(); if (text[i++] !== ':') bad();
        entries.push([name, value(depth + 1)]); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] !== '}') bad();
        // fromEntries defines own data properties; "__proto__" cannot alter the prototype.
        return Object.fromEntries(entries);
      }
    }
    if (char === '[') {
      i++; const items = []; ws();
      if (text[i] === ']') { i++; return items; }
      for (;;) { items.push(value(depth + 1)); ws(); if (text[i] === ',') { i++; continue; } if (text[i++] !== ']') bad(); return items; }
    }
    if (char === '"') return string();
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(word, i)) { i += word.length; return literal; }
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y; match.lastIndex = i;
    const number = match.exec(text); if (!number) bad(); i = match.lastIndex;
    const result = Number(number[0]);
    if (!Number.isFinite(result) || Object.is(result, -0) || (Number.isInteger(result) && !Number.isSafeInteger(result))) bad();
    return result;
  };
  if (typeof text !== 'string') bad();
  const result = value(0); ws(); if (i !== text.length) bad();
  return result;
}

export const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exactMembers = (value, required, optional = []) => plainObject(value) && required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name) || optional.includes(name));
export const httpsURI = (value, max = 256) => { try { const url = new URL(value); return typeof value === 'string' && value.length <= max && url.protocol === 'https:' && !url.username && !url.password && url.href === value; } catch { return false; } };
// Canonical audience: origin plus path, no query, fragment or userinfo. Plain
// HTTP is accepted only for localhost development issuers.
export const audienceURL = value => { try { const url = new URL(value); return typeof value === 'string' && value.length <= 2048 && url.href === value && !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')); } catch { return false; } };
export const exactOrigin = value => { try { const url = new URL(value); return typeof value === 'string' && url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')); } catch { return false; } };
export const randomToken = value => typeof value === 'string' && value.length === 22 && /^[A-Za-z0-9_-]+$/.test(value) && (() => { try { return fromBase64url(value).length === 16; } catch { return false; } })();
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const COMMON = { meta: ['bindle', 'v', 'type', 'iss', 'aud', 'jti', 'iat', 'exp'], data: ['bindle', 'v', 'type', 'md', 'aud', 'iat', 'exp'] };
const TYP = { meta: LINK_META_TYP, data: LINK_DATA_TYP }, MAGIC = { meta: 'link-meta', data: 'link-data' };

// §3.1 JWS profile shared by both positions. Claims are returned for
// type-specific exact-member checks; nothing here verifies a signature.
function parseLinkJWS(value, kind, algs, code) {
  try {
    if (typeof value !== 'string' || value.length > LINK_LIMITS[kind] || !VALUE.test(value)) fail(code);
    const [h, p, s] = value.split('.');
    const header = strictJSON(utf8(fromBase64url(h))), claims = strictJSON(utf8(fromBase64url(p))), signature = fromBase64url(s);
    if (!exactMembers(header, ['alg', 'kid', 'typ']) || !algs.includes(header.alg) || header.typ !== TYP[kind] || !boundedString(header.kid) || /[\u0080-\u009f]/.test(header.kid) || signature.length !== 64) fail(code);
    if (!plainObject(claims) || !COMMON[kind].every(name => Object.hasOwn(claims, name)) || claims.bindle !== MAGIC[kind] || claims.v !== 1 || !httpsURI(claims.type) || !audienceURL(claims.aud) || !safeTime(claims.iat) || !safeTime(claims.exp)) fail(code);
    if (kind === 'meta' && (!exactOrigin(claims.iss) || !boundedString(claims.jti) || claims.iat >= claims.exp)) fail(code);
    if (kind === 'data' && (typeof claims.md !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.md))) fail(code);
    return { header, claims, input: `${h}.${p}`, signature, value };
  } catch { fail(code); }
}
export const parseLinkMeta = value => parseLinkJWS(value, 'meta', ['ES256', 'EdDSA'], 'link_invalid');
export const parseLinkData = (value, algs = ['ES256']) => parseLinkJWS(value, 'data', algs, 'audience_malformed');
export const metaDigest = (crypto, meta) => digest(crypto, meta.input);

const algorithms = { ES256: [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }], EdDSA: [{ name: 'Ed25519' }, { name: 'Ed25519' }] };
// Verifies the exact received signing input; never re-serializes JSON.
export async function verifyLinkSignature(crypto, parsed, { alg, publicJwk }) {
  if (!algorithms[alg] || parsed?.header?.alg !== alg) return false;
  try { return await crypto.subtle.verify(algorithms[alg][1], await crypto.subtle.importKey('jwk', publicJwk, algorithms[alg][0], false, ['verify']), parsed.signature, textEncoder.encode(parsed.input)); }
  catch { return false; }
}

// §7.2 replay record key H = SHA-256(jti 0x00 iss 0x00 sub 0x00 nonce-bytes).
export async function replayDigest(crypto, { jti, iss, sub, nonce }) {
  const parts = [textEncoder.encode(jti), [0], textEncoder.encode(iss), [0], textEncoder.encode(sub), [0], fromBase64url(nonce)];
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return digest(crypto, bytes);
}
export const base64urlRandom = (crypto, size) => base64url(crypto.getRandomValues(new Uint8Array(size)));
