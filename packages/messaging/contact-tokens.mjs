import {contactTagPolicy} from './tag-policy.mjs';
import { fail, key, canonical, base64url, fromBase64url, textEncoder, strictText, boundedString, mimeValid } from './store.mjs';

const algorithms = Object.assign(Object.create(null), { EdDSA: { name: 'Ed25519' }, ES256: { name: 'ECDSA', hash: 'SHA-256' } });
const importAlgorithm = alg => alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : algorithms[alg];
const encode = value => base64url(textEncoder.encode(canonical(value)));
const parse = segment => { try { return JSON.parse(strictText(fromBase64url(segment))); } catch { fail('invalid_token'); } };

export async function signContactToken({ claims, header, privateKey, crypto = globalThis.crypto }) {
  if (!algorithms[header?.alg] || !['contact+jwt', 'bindle-contact-endpoint+jwt', 'bindle-inbox+jwt'].includes(header.typ) || !boundedString(header.kid)) fail('invalid_token');
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
    Object.assign(this, { store, issuer, crypto, clock });
  }
  // Caller must have freshly authenticated the owner and confirmed key custody.
  async registerKey(owner, { kid, alg, publicJwk }) {
    if (!boundedString(owner) || !boundedString(kid) || !algorithms[alg] || !publicJwk || Object.hasOwn(publicJwk, 'd')) fail('invalid_key');
    try { await this.crypto.subtle.importKey('jwk', publicJwk, importAlgorithm(alg), false, ['verify']); } catch { fail('invalid_key'); }
    return this.store.transaction(async tx => {
      const path = key('contact-key', owner, kid);
      if (await tx.get(path)) fail('key_exists');
      await tx.set(path, { owner, kid, alg, publicJwk, active: true });
      return { kid, alg };
    });
  }
  async revokeKey(owner, kid) {
    return this.store.transaction(async tx => {
      const path = key('contact-key', owner, kid); const record = await tx.get(path);
      if (!record) fail('not_found'); record.active = false; await tx.set(path, record);
    });
  }
  async createGrant(owner, { kid, collections, mimeTypes, expiresAt, maxMessages = 100, maxBytes = 10485760, maxMessageBytes = 1048576,requiredTags=[],optionalTags=[] },internal) {
    if(internal!==undefined){const binding=internal?.binding,uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);if(!internal||internal.kind!=='developer-contact/v1'||!binding||Object.keys(binding).sort().join(',')!=='beneficiary,expiresAt,owner,tier'||binding.owner!==owner||!uuid(binding.beneficiary)||!['free','paid','plus','ultra'].includes(binding.tier)||binding.expiresAt!==expiresAt||!Number.isSafeInteger(expiresAt)||expiresAt%86400000!==0||internal.pointer!==`developer-contact/v1/${new Date(expiresAt-1).toISOString().slice(0,10)}/${binding.beneficiary}/${binding.tier}`)fail('invalid_grant_metadata');}
    const now = this.clock(),tagPolicy=contactTagPolicy({requiredTags,optionalTags});
    if (!Array.isArray(collections) || !collections.length || collections.length > 32 || collections.some(id => !boundedString(id)) || new Set(collections).size !== collections.length || !Array.isArray(mimeTypes) || !mimeTypes.length || mimeTypes.length > 32 || mimeTypes.some(type => !mimeValid(type)) || new Set(mimeTypes).size !== mimeTypes.length) fail('invalid_scope');
    if (!Number.isSafeInteger(expiresAt) || Math.floor(expiresAt / 1000) <= Math.floor(now / 1000) || expiresAt > now + 366 * 86400000 || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1073741824 || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 10485760 || maxMessageBytes > maxBytes) fail('invalid_limits');
    return this.store.transaction(async tx => {
      const signingKey = await tx.get(key('contact-key', owner, kid));
      if (!signingKey?.active) fail('invalid_key');
      if(internal){const prior=await tx.get(internal.pointer);if(prior!==undefined){const {grantId,...binding}=prior??{},expected={version:1,...internal.binding};if(canonical(binding)!==canonical(expected)||typeof grantId!=='string')fail('invalid_grant_metadata');const grant=await tx.get(key('contact-grant',grantId));if(!grant||grant.owner!==owner||grant.id!==grantId||grant.internalKind!==internal.kind||grant.internalPointer!==internal.pointer)fail('invalid_grant_metadata');const expectedClaims={...grant.claims,iss:this.issuer,sub:owner,aud:`${this.issuer}/api/messages`,jti:grantId,exp:Math.floor(expiresAt/1000),collections,mimeTypes,maxMessages,maxBytes,maxMessageBytes,...tagPolicy};if(canonical(expectedClaims)!==canonical(grant.claims)||grant.header.kid!==kid)fail('invalid_grant_metadata');await this.live(tx,{header:grant.header,claims:grant.claims});return {grant,claims:grant.claims,protectedHeader:grant.header};}}
      if ((await tx.list(key('contact-grant'))).filter(row => row.value.owner === owner).length >= 1000) fail('grant_limit');
      for (const collection of collections) if (!(await tx.get(key('collection', owner, collection)))?.active) fail('invalid_collection');
      const claims = { iss: this.issuer, sub: owner, aud: `${this.issuer}/api/messages`, jti: this.crypto.randomUUID(), iat: Math.floor(now / 1000), exp: Math.floor(expiresAt / 1000), collections, mimeTypes, maxMessages, maxBytes, maxMessageBytes,...tagPolicy };
      const header = { alg: signingKey.alg, kid, typ: 'contact+jwt' };
      const grant = { id: claims.jti, owner, header, claims, active: true, messagesUsed: 0, bytesUsed: 0, createdAt: now };
      if(internal){grant.internalKind=internal.kind;grant.internalPointer=internal.pointer;await tx.set(internal.pointer,{version:1,...internal.binding,grantId:grant.id});}
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
    const signingKey = await tx.get(key('contact-key', verified.claims.sub, verified.header.kid));
    if (!grant?.active || !signingKey?.active || grant.claims.exp <= Math.floor(this.clock() / 1000) || canonical(grant.claims) !== canonical(verified.claims) || canonical(grant.header) !== canonical(verified.header)) fail('unauthorized');
    return grant;
  }
  async verify(token) {
    if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) fail('invalid_token');
    const [h, c, s] = token.split('.'); const header = parse(h); const claims = parse(c);
    if (!header || !claims || !algorithms[header.alg] || header.typ !== 'contact+jwt' || !boundedString(header.kid) || !boundedString(claims.sub) || !boundedString(claims.jti) || claims.iss !== this.issuer || claims.aud !== `${this.issuer}/api/messages`) fail('invalid_token');
    return this.store.transaction(async tx => {
      const verified = { header, claims }; await this.live(tx, verified);
      const signingKey = await tx.get(key('contact-key', claims.sub, header.kid));
      let valid = false;
      try {
        const publicKey = await this.crypto.subtle.importKey('jwk', signingKey.publicJwk, importAlgorithm(header.alg), false, ['verify']);
        valid = await this.crypto.subtle.verify(algorithms[header.alg], publicKey, fromBase64url(s), textEncoder.encode(`${h}.${c}`));
      } catch { /* Uniform authentication failure. */ }
      if (!valid) fail('unauthorized'); return verified;
    });
  }
}
