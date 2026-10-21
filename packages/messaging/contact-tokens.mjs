import {contactTagPolicy} from './tag-policy.mjs';
import { fail, key, canonical, base64url, fromBase64url, textEncoder, strictText, boundedString, mimeValid } from './store.mjs';
import { IdentityKeyRegistry, IDENTITY_ALGORITHMS as algorithms, importAlgorithm, verifiableSigningKey } from '../identity/keys.mjs';
// The identity key registry moved to packages/identity/keys.mjs (slice C0); re-exported for existing importers.
export { IdentityKeyRegistry, verifiableSigningKey } from '../identity/keys.mjs';
const encode = value => base64url(textEncoder.encode(canonical(value)));
const parse = segment => { try { return JSON.parse(strictText(fromBase64url(segment))); } catch { fail('invalid_token'); } };

export async function signContactToken({ claims, header, privateKey, crypto = globalThis.crypto }) {
  if (!algorithms[header?.alg] || !['contact+jwt', 'bindle-contact-endpoint+jwt', 'bindle-inbox+jwt', 'bindle-link-meta+jwt', 'bindle-link-data+jwt', 'bindle-contact-delivery+jwt'].includes(header.typ) || !boundedString(header.kid)) fail('invalid_token');
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(algorithms[header.alg], privateKey, textEncoder.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export function contactURL({ origin, handle, token, allowInsecureLocalhost = false }) {
  const url = new URL(origin);
  if ((url.protocol !== 'https:' && !(allowInsecureLocalhost && url.protocol === 'http:' && url.hostname === 'localhost')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !boundedString(handle, 80) || !boundedString(token, 16384)) fail('invalid_contact_url');
  url.pathname = `/users/${encodeURIComponent(handle)}/message`;
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.href;
}

export class ContactTokenService {
  constructor({ store, issuer, crypto = globalThis.crypto, clock = () => Date.now(), allowInsecureLocalhost = false }) {
    const origin = new URL(issuer);
    if ((origin.protocol !== 'https:' && !(allowInsecureLocalhost && origin.protocol === 'http:' && origin.hostname === 'localhost')) || origin.origin !== issuer) fail('invalid_issuer');
    Object.assign(this, { store, issuer, crypto, clock, keys: new IdentityKeyRegistry({ store, crypto, clock }) });
  }
  // Registry delegates (packages/identity/keys.mjs). Caller must have freshly authenticated the owner and confirmed key custody.
  async registerKey(owner, input) { return this.keys.register(owner, input); }
  async revokeKey(owner, kid) { await this.keys.revoke(owner, { purpose: 'signing', kid }); }
  async createGrant(owner, { kid, collections, mimeTypes, expiresAt, maxMessages = 100, maxBytes = 10485760, maxMessageBytes = 1048576,requiredTags=[],optionalTags=[] }) {
    const now = this.clock(),tagPolicy=contactTagPolicy({requiredTags,optionalTags});
    if (!Array.isArray(collections) || !collections.length || collections.length > 32 || collections.some(id => !boundedString(id)) || new Set(collections).size !== collections.length || !Array.isArray(mimeTypes) || !mimeTypes.length || mimeTypes.length > 32 || mimeTypes.some(type => !mimeValid(type)) || new Set(mimeTypes).size !== mimeTypes.length) fail('invalid_scope');
    if (!Number.isSafeInteger(expiresAt) || Math.floor(expiresAt / 1000) <= Math.floor(now / 1000) || expiresAt > now + 366 * 86400000 || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1073741824 || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 10485760 || maxMessageBytes > maxBytes) fail('invalid_limits');
    return this.store.transaction(async tx => {
      const signingKey = await verifiableSigningKey(tx, owner, kid);
      if (!signingKey) fail('invalid_key');
      if ((await tx.list(key('contact-grant'))).filter(row => row.value.owner === owner).length >= 1000) fail('grant_limit');
      for (const collection of collections) if (!(await tx.get(key('collection', owner, collection)))?.active) fail('invalid_collection');
      const claims = { iss: this.issuer, sub: owner, aud: `${this.issuer}/api/messages`, jti: this.crypto.randomUUID(), iat: Math.floor(now / 1000), exp: Math.floor(expiresAt / 1000), collections, mimeTypes, maxMessages, maxBytes, maxMessageBytes,...tagPolicy };
      const header = { alg: signingKey.alg, kid, typ: 'contact+jwt' };
      const grant = { id: claims.jti, owner, header, claims, active: true, messagesUsed: 0, bytesUsed: 0, createdAt: now };
      await tx.set(key('contact-grant', claims.jti), grant);
      return { grant, claims, protectedHeader: header };
    });
  }
  async revoke(owner, id) {
    return this.store.transaction(async tx => {
      const path = key('contact-grant', id); const grant = await tx.get(path);
      if (!grant || grant.owner !== owner) fail('not_found');
      grant.active = false; await tx.set(path, grant);
    });
  }
  async list(owner) { return this.store.transaction(async tx => (await tx.list(key('contact-grant'))).map(row => row.value).filter(grant => grant.owner === owner)); }
  async live(tx, verified) {
    const grant = await tx.get(key('contact-grant', verified.claims.jti));
    const signingKey = await verifiableSigningKey(tx, verified.claims.sub, verified.header.kid);
    if (!grant?.active || !signingKey || grant.claims.exp <= Math.floor(this.clock() / 1000) || canonical(grant.claims) !== canonical(verified.claims) || canonical(grant.header) !== canonical(verified.header)) fail('unauthorized');
    return grant;
  }
  async verify(token) {
    if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) fail('invalid_token');
    const [h, c, s] = token.split('.'); const header = parse(h); const claims = parse(c);
    if (!header || !claims || !algorithms[header.alg] || header.typ !== 'contact+jwt' || !boundedString(header.kid) || !boundedString(claims.sub) || !boundedString(claims.jti) || claims.iss !== this.issuer || claims.aud !== `${this.issuer}/api/messages`) fail('invalid_token');
    return this.store.transaction(async tx => {
      const verified = { header, claims }; await this.live(tx, verified);
      const signingKey = await verifiableSigningKey(tx, claims.sub, header.kid);
      let valid = false;
      try {
        const publicKey = await this.crypto.subtle.importKey('jwk', signingKey.publicJwk, importAlgorithm(header.alg), false, ['verify']);
        valid = await this.crypto.subtle.verify(algorithms[header.alg], publicKey, fromBase64url(s), textEncoder.encode(`${h}.${c}`));
      } catch { /* Uniform authentication failure. */ }
      if (!valid) fail('unauthorized'); return verified;
    });
  }
}
