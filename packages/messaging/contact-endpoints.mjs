import { fail, key, canonical, fromBase64url, strictText, textEncoder, boundedString } from './store.mjs';
import { signContactToken } from './contact-tokens.mjs';
import { parseLinkQuery, parseLinkMeta, exactMembers, httpsURI, randomToken, base64urlRandom, LINK_META_TYP, CONTACT_LINK_TYPE } from './bindle-links.mjs';
import { CONTACT_DELIVERY_CONTRACT } from './contact-delivery.mjs';
import { contactIntake, validateIntake } from './tag-policy.mjs';

// Project-private proposed media type; no IANA registration is claimed.
export const CONTACT_TOKEN_MIME = 'application/vnd.bindle.contact-token+jwt';
const ENDPOINT_TYPE = 'bindle-contact-endpoint+jwt';
const INBOX_TYPE = 'bindle-inbox+jwt';
const DELIVERY_TYPE = 'bindle-contact-delivery+jwt';
export const CONTACT_DELIVERY_TOKEN_MIME = 'application/vnd.bindle.contact-token+jwt; profile="contact-delivery-v1"';
const CONTACT_META = ['bindle','v','type','iss','aud','jti','iat','exp','sub','resource','kinds','collections','mimeTypes','maxMessages','maxBytes','maxMessageBytes'];
const KINDS = ['conversation-init','one-off'];
const validKinds = kinds => Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind, i) => KINDS.includes(kind) && (i === 0 || kinds[i-1] < kind));
// Exact contact meta member set (links §6, §7.1). Tags are intake, not claims.
const contactMetaValid = claims => exactMembers(claims, CONTACT_META, ['audience']) && claims.type === CONTACT_LINK_TYPE && boundedString(claims.sub) && boundedString(claims.resource, 2048) && validKinds(claims.kinds) && (claims.audience === undefined || (exactMembers(claims.audience, ['challenge'], ['policy']) && randomToken(claims.audience.challenge) && (claims.audience.policy === undefined || httpsURI(claims.audience.policy))));
// Language tags match case-insensitively (BCP 47): exact, then primary language, then en.
const labelFor = (labels = {}, locales) => { const lower = Object.fromEntries(Object.entries(labels).map(([locale, label]) => [locale.toLowerCase(), label])); for (const locale of [...locales.flatMap(value => [value.toLowerCase(), value.split('-')[0].toLowerCase()]), 'en']) if (Object.hasOwn(lower, locale)) return lower[locale]; };
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
  // linkPolicies is the operator policy registry (links §7.1); tenants cannot add to it.
  constructor({ tokens, signer, linkPolicies = [] }) {
    if (!tokens || typeof signer !== 'function' || !Array.isArray(linkPolicies) || linkPolicies.some(uri => !httpsURI(uri))) fail('invalid_endpoint_service');
    this.tokens = tokens; this.signer = signer; this.linkPolicies = Object.freeze([...linkPolicies]);
    const { store, issuer, crypto, clock } = tokens; Object.assign(this, { store, issuer, crypto, clock });
  }
  // Legacy ?sig= issuance only. New-form links are a separate trusted method so
  // spread owner request bodies cannot select form, kinds or audience.
  async create(owner, { handle, form, kinds, audience, tagLabels, ...options }) {
    if (typeof handle !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(handle)) fail('invalid_handle');
    if (form !== undefined || kinds !== undefined || audience !== undefined || tagLabels !== undefined) fail('invalid_link_form');
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
      if(current.endpoint){if(canonical(current.endpoint)!==canonical({url:endpoint,header,claims}))fail('invalid_grant_metadata');}
      else {current.endpoint = { url: endpoint, header, claims };current.quarantined = false;}
      await tx.set(key('contact-grant', grant.id), current);
      return { grant: current, url, endpoint };
    });
  }
  // New-form contact link (links §6). One parent has exactly one form; the
  // exact header, claims and signing input are stored for comparison.
  async createLink(owner, { handle, kinds = ['one-off'], audience, tagLabels, requiredTags = [], optionalTags = [], ...options }) {
    if (typeof handle !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(handle)) fail('invalid_handle');
    if (!validKinds(kinds)) fail('invalid_link_kinds');
    if (audience !== undefined && (!exactMembers(audience, [], ['policy']) || (audience.policy !== undefined && !this.linkPolicies.includes(audience.policy)))) fail('invalid_link_policy');
    const intake = validateIntake({ autoTags: requiredTags, optionalTags, labels: tagLabels }, 1, this.clock());
    // Base grant claims carry no tags, so minted bearers never disclose auto tags.
    const issued = await this.tokens.createGrant(owner, { ...options, requiredTags: [], optionalTags: [] });
    const { grant } = issued, base = grant.claims;
    const endpoint = `${this.issuer}/users/${encodeURIComponent(handle)}/contact/${encodeURIComponent(grant.id)}`;
    const claims = { bindle: 'link-meta', v: 1, type: CONTACT_LINK_TYPE, iss: base.iss, aud: endpoint, jti: base.jti, iat: base.iat, exp: base.exp, sub: base.sub, resource: `${this.issuer}/entities/${encodeURIComponent(owner)}/contacts/${encodeURIComponent(grant.id)}`, kinds: [...kinds], collections: base.collections, mimeTypes: base.mimeTypes, maxMessages: base.maxMessages, maxBytes: base.maxBytes, maxMessageBytes: base.maxMessageBytes, ...(audience ? { audience: { challenge: base64urlRandom(this.crypto, 16), ...(audience.policy ? { policy: audience.policy } : {}) } } : {}) };
    const header = { alg: grant.header.alg, kid: grant.header.kid, typ: LINK_META_TYP };
    const privateKey = await this.signer({ owner, kid: header.kid, alg: header.alg });
    const value = await signContactToken({ header, claims, privateKey, crypto: this.crypto });
    return this.store.transaction(async tx => {
      const current = await this.tokens.live(tx, { header: issued.protectedHeader, claims: issued.claims });
      if (current.endpoint) fail('invalid_grant_metadata');
      current.endpoint = { url: endpoint, form: 'link', header, claims, input: value.split('.').slice(0, 2).join('.') }; current.quarantined = false; current.intake = intake;
      current.delivery = { resource: claims.resource, kinds: claims.kinds, collection: claims.collections[0] };
      await tx.set(key('contact-grant', grant.id), current);
      return { grant: current, url: `${endpoint}?bindle_meta=${value}`, endpoint };
    });
  }
  // Challenge rotation (links §7.1): new meta for the same parent. Quotas,
  // receipts and intake are untouched; every outstanding response's md breaks.
  async rotateChallenge(owner, id) {
    const signed = await this.store.transaction(async tx => tx.get(key('contact-grant', id)));
    if (!signed?.endpoint?.claims?.audience || signed.owner !== owner || !signed.active) fail('not_found');
    const privateKey = await this.signer({ owner, kid: signed.endpoint.header.kid, alg: signed.endpoint.header.alg });
    return this.store.transaction(async tx => {
      const path = key('contact-grant', id), current = await tx.get(path), now = Math.floor(this.clock()/1000);
      if (!current?.active || current.owner !== owner || current.endpoint?.input !== signed.endpoint.input || current.claims.exp <= now) fail('rotation_conflict');
      const { header } = current.endpoint, claims = { ...current.endpoint.claims, iat: now, audience: { ...current.endpoint.claims.audience, challenge: base64urlRandom(this.crypto, 16) } };
      const value = await signContactToken({ header, claims, privateKey, crypto: this.crypto });
      current.endpoint = { ...current.endpoint, claims, input: value.split('.').slice(0, 2).join('.') };
      await tx.set(path, current);
      return { url: `${current.endpoint.url}?bindle_meta=${value}` };
    });
  }
  // Owner-authenticated intake mutation (links §6.2). Never re-signs or touches
  // stored claims, so md, outstanding responses and quotas are unaffected.
  async intake(owner, id) {
    return this.store.transaction(async tx => { const grant = await tx.get(key('contact-grant', id)); if (!grant?.endpoint || grant.owner !== owner) fail('not_found'); return contactIntake(grant); });
  }
  // Port for contact-delivery admission (L0): intake(parentId, tx).
  async intakeOf(parentId, tx) { return contactIntake(await tx.get(key('contact-grant', parentId))); }
  async updateIntake(owner, id, { revision, autoTags, optionalTags, labels } = {}) {
    return this.store.transaction(async tx => {
      const path = key('contact-grant', id), grant = await tx.get(path);
      if (!grant?.endpoint || grant.owner !== owner || !grant.active || grant.claims.exp <= Math.floor(this.clock()/1000)) fail('not_found');
      const current = contactIntake(grant), expected = current?.revision ?? 0;
      if (revision !== expected) fail('intake_conflict', 'The intake configuration changed; reload and retry.');
      grant.intake = validateIntake({ autoTags, optionalTags, labels }, expected + 1, this.clock());
      await tx.set(path, grant);
      return grant.intake;
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
    if (!grant?.endpoint || !grant.active || grant.owner !== parsed.claims.sub || grant.claims.exp <= Math.floor(this.clock()/1000) || canonical(grant.endpoint.header) !== canonical(parsed.header) || canonical(grant.endpoint.claims) !== canonical(parsed.claims) || (grant.endpoint.form === 'link') !== (parsed.form === 'link') || (grant.endpoint.form === 'link' && grant.endpoint.input !== parsed.input)) fail('unauthorized');
    const signingKey = await tx.get(key('contact-key', grant.owner, parsed.header.kid));
    if (!signingKey?.active) fail('unauthorized');
    return grant;
  }
  // Routes on the shared raw-query parser (links §2). Legacy ?sig= keeps its
  // exact behavior; data is accepted only when the caller is the JSON
  // inspection representation of a conditional link (links §7.2).
  async inspect(url, { allowData = false } = {}) {
    const query = typeof url === 'string' ? parseLinkQuery(url) : { form: 'none' };
    if (query.form === 'link') return this.inspectLink(url, query, allowData);
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
      return { endpoint: grant.endpoint.url, grant, form: 'legacy', verified: { header: parsed.header, claims: parsed.claims } };
    });
  }
  async inspectLink(url, query, allowData) {
    let meta;
    try {
      const target = new URL(url);
      if (target.username || target.password || target.origin !== this.issuer) fail('link_invalid');
      meta = { ...parseLinkMeta(query.meta), form: 'link' };
      if (!contactMetaValid(meta.claims) || meta.claims.iss !== this.issuer || meta.claims.aud !== `${target.origin}${target.pathname}`) fail('link_invalid');
    } catch { fail('link_invalid'); }
    const inspected = await this.store.transaction(async tx => {
      try { const grant = await this.endpointLive(tx, meta); await this.verifySignature(tx, meta, grant); return grant; }
      catch (error) { if (error?.code === 'unauthorized') fail('link_invalid'); throw error; }
    });
    // Step 3 follows verification: data on a non-inspection representation or an unconditional link.
    if (query.data !== undefined && (!allowData || !meta.claims.audience)) fail('link_malformed');
    const { form, ...verified } = meta;
    return { endpoint: inspected.endpoint.url, grant: inspected, form: 'link', conditional: Boolean(meta.claims.audience), verified: { header: verified.header, claims: verified.claims, input: verified.input, form }, meta: verified, ...(query.data !== undefined ? { data: query.data } : {}) };
  }
  // Side-effect-free sender metadata representation (links §6.3). It never
  // evaluates bindle_data and never discloses auto tags or collections.
  async linkMetadata(url, { locales = [] } = {}) {
    if (!Array.isArray(locales) || locales.length > 16 || locales.some(locale => typeof locale !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(locale))) fail('invalid_locale');
    const { grant, form } = await this.inspect(url);
    const claims = form === 'link' ? grant.endpoint.claims : grant.claims, intake = contactIntake(grant);
    return { version: 1, form, ...(form === 'link' ? { type: claims.type } : {}), intakeRevision: intake?.revision ?? null,
      optionalTags: (intake?.optionalTags ?? []).map(id => { const label = labelFor(intake.labels[id], locales); return label === undefined ? { id } : { id, label }; }),
      kinds: form === 'link' ? claims.kinds : ['one-off'], mimeTypes: claims.mimeTypes, maxMessageBytes: claims.maxMessageBytes, maxMessages: claims.maxMessages, maxBytes: claims.maxBytes,
      quotaScope: claims.audience ? 'principal-day' : 'parent', expiresAt: claims.exp * 1000, conditional: Boolean(claims.audience), ...(claims.audience?.policy ? { policy: claims.audience.policy } : {}) };
  }
  // Legacy inbox bearers carry no author proof, so new-form links never mint
  // them (links §6.1: a legacy inbox-bearer request is 406).
  async mint(url) {
    const inspected = await this.inspect(url);
    if (inspected.form === 'link') fail('not_acceptable');
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
  // Authored-delivery profile of a parent (links §6, §10). Legacy parents get the
  // host-assigned carve-out: one-off only, identity authorship, a derived
  // parent-bound resource and their first collection as the internal partition.
  deliveryProfile(grant) {
    const conditional = Boolean(grant.endpoint?.form === 'link' && grant.endpoint.claims.audience);
    return grant.endpoint?.form === 'link' ? { ...grant.delivery, conditional } : { resource: `${this.issuer}/entities/${encodeURIComponent(grant.owner)}/contacts/${encodeURIComponent(grant.id)}`, kinds: ['one-off'], collection: grant.claims.collections[0], conditional: false };
  }
  // ContactDeliveryService parents port. Credentials are {url} (signed link POST,
  // never with bindle_data) or {token} (contact-delivery bearer for RPC).
  async verifyCredential(credential) {
    if (typeof credential?.token === 'string') { const verified = await this.verifyDelivery(credential.token); return { kind: 'token', verified, owner: verified.claims.sub, parent: verified.claims.parent }; }
    const inspected = await this.inspect(credential?.url);
    return { kind: 'url', verified: inspected.verified, owner: inspected.grant.owner, parent: inspected.grant.id, conditional: Boolean(inspected.conditional), policy: inspected.meta?.claims.audience?.policy };
  }
  async liveCredential(tx, credential) {
    let grant; try { grant = credential.kind === 'token' ? await this.deliveryLive(tx, credential.verified) : await this.endpointLive(tx, credential.verified); } catch (error) { if (error?.code === 'unauthorized' && credential.verified.form === 'link') fail('link_invalid'); throw error; }
    const profile = this.deliveryProfile(grant);
    grant.delivery = { resource: profile.resource, kinds: credential.kind === 'token' ? profile.kinds.filter(kind => credential.verified.claims.kinds.includes(kind)) : profile.kinds, collection: profile.collection, ...(profile.conditional ? { conditional: true } : {}) };
    return grant;
  }
  // Contact-delivery bearer (contact-delivery "Contact bearer RPC"): a distinct
  // typ, audience and scope; identity authorship only; never an inbox token.
  deliveryClaims(grant, { jti, iat, exp }) {
    const profile = this.deliveryProfile(grant);
    return { iss: this.issuer, sub: grant.owner, aud: `${this.issuer}/bindle/rpc`, jti, iat, exp, parent: grant.id, endpoint: grant.endpoint.url, resource: profile.resource, contract: CONTACT_DELIVERY_CONTRACT, methods: ['deliver'], kinds: profile.kinds, authorship: ['identity'], mimeTypes: grant.claims.mimeTypes, maxMessageBytes: grant.claims.maxMessageBytes };
  }
  async mintDelivery(url) {
    const { grant, verified } = await this.inspect(url);
    const header = { alg: grant.endpoint.header.alg, kid: grant.endpoint.header.kid, typ: DELIVERY_TYPE };
    const privateKey = await this.signer({ owner: grant.owner, kid: header.kid, alg: header.alg });
    return this.store.transaction(async tx => {
      const current = await this.endpointLive(tx, verified), iat = Math.floor(this.clock()/1000), exp = Math.min(iat + 300, current.claims.exp);
      const token = await signContactToken({ header, claims: this.deliveryClaims(current, { jti: this.crypto.randomUUID(), iat, exp }), privateKey, crypto: this.crypto });
      return { token, tokenType: 'Bearer', expiresAt: exp * 1000, contentType: CONTACT_DELIVERY_TOKEN_MIME };
    });
  }
  async deliveryLive(tx, { header, claims }) {
    if (header?.typ !== DELIVERY_TYPE || !boundedString(claims?.parent) || !boundedString(claims?.jti)) fail('unauthorized');
    const grant = await tx.get(key('contact-grant', claims.parent)), now = Math.floor(this.clock()/1000);
    if (!grant?.active || !grant.endpoint || claims.sub !== grant.owner || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > now || claims.iat < grant.claims.iat || claims.exp <= now || claims.exp <= claims.iat || claims.exp > claims.iat + 300 || claims.exp > grant.claims.exp) fail('unauthorized');
    if (canonical(this.deliveryClaims(grant, claims)) !== canonical(claims) || canonical({ alg: grant.endpoint.header.alg, kid: grant.endpoint.header.kid, typ: DELIVERY_TYPE }) !== canonical(header)) fail('unauthorized');
    if (!(await tx.get(key('contact-key', grant.owner, header.kid)))?.active) fail('unauthorized');
    return grant;
  }
  async verifyDelivery(token) {
    const parsed = decode(token);
    return this.store.transaction(async tx => {
      const verified = { header: parsed.header, claims: parsed.claims }, grant = await this.deliveryLive(tx, verified);
      await this.verifySignature(tx, parsed, grant);
      return verified;
    });
  }
  // Compatible with MessagingService.tokens.live: returns the mutable parent
  // grant so all bearer instances share quotas, receipts, revocation and policy.
  async live(tx, verified) {
    const { header, claims } = verified;
    if (header?.typ !== INBOX_TYPE || !boundedString(claims?.parent) || !boundedString(claims?.jti)) fail('unauthorized');
    const grant = await tx.get(key('contact-grant', claims.parent));
    if (grant?.endpoint?.form === 'link') fail('unauthorized');
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
