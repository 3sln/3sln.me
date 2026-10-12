import { fail, key, canonical, fromBase64url, strictText, textEncoder, boundedString } from './store.mjs';
import { signContactToken } from './contact-tokens.mjs';

// Project-private proposed media type; no IANA registration is claimed.
export const CONTACT_TOKEN_MIME = 'application/vnd.bindle.contact-token+jwt';
const ENDPOINT_TYPE = 'bindle-contact-endpoint+jwt';
const INBOX_TYPE = 'bindle-inbox+jwt';
const signatureAlgorithm = alg => alg === 'EdDSA' ? { name: 'Ed25519' } : alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : null;
const importAlgorithm = alg => alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'Ed25519' };
const decode = token => {
  try {
    if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) fail('unauthorized');
    const [h,c,s] = token.split('.');
    const header = JSON.parse(strictText(fromBase64url(h))); const claims = JSON.parse(strictText(fromBase64url(c)));
    if (!header || !claims || !signatureAlgorithm(header.alg) || !boundedString(header.kid) || !boundedString(claims.sub) || !boundedString(claims.jti)) fail('unauthorized');
    return { header, claims, input: `${h}.${c}`, signature: fromBase64url(s) };
  } catch { fail('unauthorized'); }
};

export function validateSenderMetadata(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_message_metadata');
  const { subject = input.title ?? '', tags = [] } = input;
  if (typeof subject !== 'string' || subject.length > 200 || /[\u0000-\u001f\u007f]/.test(subject) || !Array.isArray(tags) || tags.length > 32 || tags.some(tag => !boundedString(tag,64)) || new Set(tags).size !== tags.length) fail('invalid_message_metadata');
  return { subject, tags: [...tags] };
}

export class ContactEndpointService {
  constructor({ tokens, signer }) {
    if (!tokens || typeof signer !== 'function') fail('invalid_endpoint_service');
    this.tokens = tokens; this.signer = signer;
    const { store, issuer, crypto, clock } = tokens; Object.assign(this, { store, issuer, crypto, clock });
  }
  async create(owner, { handle, ...options }) {
    if (typeof handle !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(handle)) fail('invalid_handle');
    const issued = await this.tokens.createGrant(owner, options);
    const grant = issued.grant;
    const endpoint = `${this.issuer}/users/${encodeURIComponent(handle)}/contact/${encodeURIComponent(grant.id)}`;
    const header = { ...grant.header, typ: ENDPOINT_TYPE };
    const claims = { ...grant.claims, aud: endpoint };
    const privateKey = await this.signer({ owner, kid: header.kid, alg: header.alg });
    const signature = await signContactToken({ header, claims, privateKey, crypto: this.crypto });
    const url = `${endpoint}?sig=${signature}`;
    return this.store.transaction(async tx => {
      const current = await this.tokens.live(tx, { header: issued.protectedHeader, claims: issued.claims });
      current.endpoint = { url: endpoint, header, claims };
      current.quarantined = false;
      await tx.set(key('contact-grant', grant.id), current);
      return { grant: current, url, endpoint };
    });
  }
  async verifySignature(tx, parsed, grant) {
    const record = await tx.get(key('contact-key', grant.owner, parsed.header.kid));
    if (!record?.active || record.alg !== parsed.header.alg) fail('unauthorized');
    try {
      const publicKey = await this.crypto.subtle.importKey('jwk', record.publicJwk, importAlgorithm(record.alg), false, ['verify']);
      if (!await this.crypto.subtle.verify(signatureAlgorithm(record.alg), publicKey, parsed.signature, textEncoder.encode(parsed.input))) fail('unauthorized');
    } catch { fail('unauthorized'); }
  }
  async endpointLive(tx, parsed) {
    const grant = await tx.get(key('contact-grant', parsed.claims.jti));
    if (!grant?.endpoint || !grant.active || grant.owner !== parsed.claims.sub || grant.claims.exp <= Math.floor(this.clock()/1000) || canonical(grant.endpoint.header) !== canonical(parsed.header) || canonical(grant.endpoint.claims) !== canonical(parsed.claims)) fail('unauthorized');
    const signingKey = await tx.get(key('contact-key', grant.owner, parsed.header.kid));
    if (!signingKey?.active) fail('unauthorized');
    return grant;
  }
  async inspect(url) {
    let target, parsed;
    try {
      if (typeof url !== 'string' || url.length > 18000) fail('unauthorized');
      target = new URL(url);
      if (target.username || target.password || target.hash || target.origin !== this.issuer || [...target.searchParams.keys()].length !== 1 || !target.searchParams.has('sig')) fail('unauthorized');
      parsed = decode(target.searchParams.get('sig'));
      if (parsed.header.typ !== ENDPOINT_TYPE || parsed.claims.aud !== `${target.origin}${target.pathname}` || parsed.claims.iss !== this.issuer) fail('unauthorized');
    } catch { fail('unauthorized'); }
    return this.store.transaction(async tx => {
      const grant = await this.endpointLive(tx, parsed);
      await this.verifySignature(tx, parsed, grant);
      return { endpoint: grant.endpoint.url, grant, verified: { header: parsed.header, claims: parsed.claims } };
    });
  }
  async mint(url) {
    const inspected = await this.inspect(url);
    const { grant, verified } = inspected;
    const privateKey = await this.signer({ owner: grant.owner, kid: grant.header.kid, alg: grant.header.alg });
    return this.store.transaction(async tx => {
      const current = await this.endpointLive(tx, verified);
      const iat = Math.floor(this.clock()/1000); const exp = Math.min(iat + 300, current.claims.exp);
      const header = { ...current.header, typ: INBOX_TYPE };
      const claims = { ...current.claims, jti: this.crypto.randomUUID(), parent: current.id, endpoint: current.endpoint.url, iat, exp };
      const token = await signContactToken({ header, claims, privateKey, crypto: this.crypto });
      return { token, tokenType: 'Bearer', expiresAt: exp*1000, contentType: CONTACT_TOKEN_MIME };
    });
  }
  // Compatible with MessagingService.tokens.live: returns the mutable parent
  // grant so all bearer instances share quotas, receipts, revocation and policy.
  async live(tx, verified) {
    const { header, claims } = verified;
    if (header?.typ !== INBOX_TYPE || !boundedString(claims?.parent) || !boundedString(claims?.jti)) fail('unauthorized');
    const grant = await tx.get(key('contact-grant', claims.parent));
    const now = Math.floor(this.clock()/1000);
    if (!grant?.active || !grant.endpoint || claims.sub !== grant.owner || claims.iss !== this.issuer || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > now || claims.iat < grant.claims.iat || claims.exp <= now || claims.exp <= claims.iat || claims.exp > claims.iat+300 || claims.exp > grant.claims.exp || grant.claims.exp <= now) fail('unauthorized');
    const expected = { ...grant.claims, jti: claims.jti, parent: grant.id, endpoint: grant.endpoint.url, iat: claims.iat, exp: claims.exp };
    if (canonical(expected) !== canonical(claims) || canonical({ ...grant.header, typ: INBOX_TYPE }) !== canonical(header)) fail('unauthorized');
    const signingKey = await tx.get(key('contact-key', grant.owner, header.kid));
    if (!signingKey?.active) fail('unauthorized');
    return grant;
  }
  async verify(token) {
    const parsed = decode(token);
    return this.store.transaction(async tx => {
      const verified = { header: parsed.header, claims: parsed.claims };
      const grant = await this.live(tx, verified);
      await this.verifySignature(tx, parsed, grant);
      return verified;
    });
  }
  async revoke(owner, id) { return this.tokens.revoke(owner,id); }
  async quarantine(owner, id, quarantined = true) {
    if (typeof quarantined !== 'boolean') fail('invalid_quarantine');
    return this.store.transaction(async tx => {
      const path = key('contact-grant',id); const grant = await tx.get(path);
      if (!grant?.endpoint || grant.owner !== owner) fail('not_found');
      grant.quarantined = quarantined; await tx.set(path,grant);
      return { id, quarantined };
    });
  }
}
