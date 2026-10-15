// Identity-authored contact-delivery admission (slice L0). The HTTP adapter
// (L4) parses framing via contact-delivery-wire.mjs, then calls
// `deliver(credential, {envelope, body, idempotencyKey})`. Ports:
//  parents.verify(credential) -> verified capability (signature + liveness; uniform `unauthorized`).
//  parents.live(tx, verified) -> mutable live contact-grant; `grant.delivery = {resource, kinds,
//    collection, conditional?}` is the bound profile, with `kinds` already intersected with a child bearer (L2).
//  intake(parentId, tx) -> {revision, autoTags, optionalTags}: mutable link intake (default: contactIntake(grant)).
//  resolve({issuer, subject, keyId}) -> local identity key record (see localAuthorResolver). Called again
//    inside the owner transaction to fence revocation; it must be safe to call there.
//  admissionKey() -> {kid, privateKey}: provider admission-receipt signer.
//  audience.admit(tx, {grant, principal, now}) -> {tags?}: conditional parents only (links §7.5). It reads a
//    decision the host recorded before admission and throws audience_ineligible / audience_unavailable.
// Adapters whose resolve() must not run inside the owner transaction call prepare(), set
// `prepared.fence = await resolve(...)` immediately before commit(), and then commit().
import { fail, key, boundedString } from './store.mjs';
import { contactIntake } from './tag-policy.mjs';
import { validTagIds, validIntakeTagIds, initialTags, addTag, applyRules } from './tags.mjs';
import { ownerRules } from './messages.mjs';
import { validateContent } from './content.mjs';
import { validateEnvelope, checkBody, verifyAuthor, payloadDigest, signAdmission, DELIVERY_LIMITS } from './contact-delivery.mjs';

export const CONTACT_DELIVERY_STATUS = Object.freeze({ invalid_envelope: 400, invalid_multipart: 400, invalid_utf8: 400, invalid_content: 400, invalid_archive: 400, invalid_conversation_content: 400, body_mismatch: 400, idempotency_mismatch: 400, operation_expired: 400, unauthorized: 401, author_unverifiable: 401, author_required: 403, recipient_mismatch: 403, kind_forbidden: 403, forbidden_tags: 400, forbidden: 403, audience_ineligible: 403, link_malformed: 400, link_invalid: 401, ambiguous_credentials: 400, not_acceptable: 406, rate_limited: 429, operation_conflict: 409, too_large: 413, unsupported_media: 415, kind_unsupported: 415, quota_exceeded: 429, account_quota_exceeded: 429, audience_unavailable: 503, admission_unavailable: 503 });

export class ContactDeliveryService {
  constructor({ store, issuer, parents, intake = async (id, tx) => contactIntake(await tx.get(key('contact-grant', id))), resolve, admissionKey, audience, crypto = globalThis.crypto, clock = () => Date.now(), allowInsecureLocalhost = false, maxStoredBytes = 1073741824, maxStoredMessages = 10000 }) {
    if (!store || typeof issuer !== 'string' || typeof parents?.verify !== 'function' || typeof parents?.live !== 'function' || typeof intake !== 'function' || typeof resolve !== 'function' || typeof admissionKey !== 'function' || (audience !== undefined && typeof audience?.admit !== 'function')) fail('invalid_delivery_service');
    Object.assign(this, { store, issuer, parents, intake, resolve, admissionKey, audience, crypto, clock, allowInsecureLocalhost, maxStoredBytes, maxStoredMessages });
  }
  async deliver(credential, input = {}) { return this.commit(await this.prepare(credential, input)); }
  // Everything that needs no owner transaction: credential, framing, body, author.
  async prepare(credential, { envelope, body, idempotencyKey } = {}) {
    // Defensive copies before the first await; signed bytes cannot change underneath.
    if (!(body instanceof Uint8Array)) fail('invalid_envelope');
    envelope = structuredClone(envelope); body = body.slice();
    const { crypto } = this, options = { allowInsecureLocalhost: this.allowInsecureLocalhost, crypto };
    // Link/credential validity first (links.md §8 step 2): no hashing, content
    // inspection or identity lookup for unauthenticated callers.
    let verified; try { verified = await this.parents.verify(credential); } catch (error) { fail(['link_invalid', 'link_malformed'].includes(error?.code) ? error.code : 'unauthorized'); }
    await validateEnvelope(envelope, options);
    const p = envelope.payload;
    if (idempotencyKey !== undefined && idempotencyKey !== p.operationId) fail('idempotency_mismatch');
    const bodyDigest = await checkBody(envelope, body, crypto); validateContent(p.content.mimeType, body);
    const fingerprint = await payloadDigest(envelope, crypto);
    // Foreign authors fail without any lookup. Re-run on replay so revoked
    // keys cannot read back private receipt details.
    const author = await verifyAuthor(envelope, { issuer: this.issuer, resolve: this.resolve, crypto });
    let signer; try { signer = await this.admissionKey(); } catch { fail('admission_unavailable'); }
    if (!signer?.privateKey || !boundedString(signer.kid, 128)) fail('admission_unavailable');
    return { verified, envelope, body, bodyDigest, fingerprint, author, signer };
  }
  async commit({ verified, envelope, body, bodyDigest, fingerprint, author, signer, fence }) {
    const { crypto } = this, p = envelope.payload;
    return this.store.transaction(async tx => {
      const grant = await this.parents.live(tx, verified), d = grant?.delivery, now = this.clock();
      if (!grant || !d || typeof d.resource !== 'string' || !Array.isArray(d.kinds) || !boundedString(d.collection)) fail('unauthorized');
      // Revocation fence: the key and account must still be active at admission.
      let current = fence; if (current === undefined) try { current = await this.resolve({ issuer: this.issuer, subject: author.principal.subject, keyId: author.keyId }); } catch { fail('author_unverifiable'); }
      if (current?.active !== true || current.purpose !== 'signing' || current.publicJwk?.x !== author.publicJwk.x || current.publicJwk?.y !== author.publicJwk.y) fail('author_unverifiable');
      const r = p.recipient;
      if (r.issuer !== this.issuer || r.owner !== grant.owner || r.contactId !== grant.id || r.resource !== d.resource) fail('recipient_mismatch');
      if (!d.kinds.includes(p.kind)) fail('kind_forbidden');
      // conversation-init is fully validated and signature-checked above, but
      // pending-bootstrap custody/acceptance is conversation-v2 runtime work.
      if (p.kind !== 'one-off') fail('kind_unsupported');
      // Replay namespace (owner, parent, author principal, operationId): one author can never squat or probe
      // another author's operation ID. An exact replay returns its receipt before any policy re-evaluation.
      const receiptKey = key('contact-delivery-receipt', grant.owner, grant.id, author.principal.issuer, author.principal.subject, p.operationId), prior = await tx.get(receiptKey);
      if (prior) { if (prior.fingerprint !== fingerprint) fail('operation_conflict'); return { receipt: prior.receipt, replayed: true }; }
      // Conditional parents: host policy on the verified author, in this admission step (links §7.5).
      let policy = null;
      if (d.conditional) { if (!this.audience) fail('audience_unavailable'); policy = await this.audience.admit(tx, { grant, principal: author.principal, now }); }
      if (!grant.claims.mimeTypes.includes(p.content.mimeType)) fail('unsupported_media');
      if (p.content.byteLength > grant.claims.maxMessageBytes) fail('too_large');
      if (!grant.claims.collections.includes(d.collection) || !(await tx.get(key('collection', grant.owner, d.collection)))?.active) fail('forbidden');
      let intake; try { intake = await this.intake(grant.id, tx) ?? { revision: 0, autoTags: [], optionalTags: [] }; } catch { fail('admission_unavailable'); }
      if (!Number.isSafeInteger(intake.revision) || !validIntakeTagIds(intake.autoTags) || !validIntakeTagIds(intake.optionalTags)) fail('admission_unavailable');
      if (p.optionalTags.some(tag => !intake.optionalTags.includes(tag))) fail('forbidden_tags');
      const policyTags = Array.isArray(policy?.tags) ? policy.tags : [], deliveryTags = [...new Set([...intake.autoTags, ...p.optionalTags, ...policyTags])];
      if (!validIntakeTagIds(policyTags) || !validTagIds(deliveryTags)) fail('forbidden_tags');
      if (p.createdAt < now - DELIVERY_LIMITS.maxOperationAgeMs || p.createdAt > now + DELIVERY_LIMITS.maxFutureSkewMs) fail('operation_expired');
      // Conditional links: signed limits apply per verified author principal per UTC day (links §7.1).
      const day = Math.floor(now / 86400000), dayKey = key('contact-author-day', grant.owner, grant.quotaFamily ?? grant.id, author.principal.issuer, author.principal.subject, day), daily = d.conditional ? await tx.get(dayKey) ?? { messagesUsed: 0, bytesUsed: 0, expiresAt: (day + 3) * 86400000 } : null;
      const used = daily ?? grant;
      if (used.messagesUsed + 1 > grant.claims.maxMessages || used.bytesUsed + body.byteLength > grant.claims.maxBytes) fail('quota_exceeded');
      const usage = await tx.get(key('message-usage', grant.owner)) || { bytes: 0, messages: 0 };
      if (usage.bytes + body.byteLength > this.maxStoredBytes || usage.messages + 1 > this.maxStoredMessages) fail('account_quota_exceeded');
      const message = initialTags({ id: crypto.randomUUID(), owner: grant.owner, collection: d.collection, mimeType: p.content.mimeType, size: body.byteLength, bytes: body, deliveryCollection: d.collection, receivedAt: now, readAt: null, deliveryTags, quarantined: Boolean(grant.quarantined), grantId: grant.id, senderMetadata: { subject: p.subject, tags: [...p.optionalTags] }, intakeRevision: intake.revision,
        delivery: { profile: 'contact-delivery/v1', kind: p.kind, noReply: p.noReply, operationId: p.operationId, createdAt: p.createdAt, payloadDigest: fingerprint, bodyDigest, authorship: 'identity', author: p.author, intakeRevision: intake.revision } }, [...new Set([...intake.autoTags, ...p.optionalTags])], { source: 'intake', intakeRevision: intake.revision }, now);
      // Policy-derived tags are authorized delivery tags with provenance `policy` (links §7.5).
      for (const tag of policyTags) addTag(message, tag, { source: 'policy' }, now);
      // Same owner-rule path as MessagingService.receive (original delivery metadata, no cascades).
      await applyRules(message, await ownerRules(tx, grant.owner), { now, active: async id => (await tx.get(key('collection', grant.owner, id)))?.active });
      const receipt = await signAdmission({ version: 1, purpose: 'bindle-contact-admission-v1', issuer: this.issuer, recipient: { ...r }, operationId: p.operationId, messageId: message.id, kind: p.kind, noReply: p.noReply, payloadDigest: fingerprint, bodyDigest, authorship: 'identity', receivedAt: now, state: 'accepted' }, signer, crypto);
      grant.messagesUsed++; grant.bytesUsed += body.byteLength; usage.bytes += body.byteLength; usage.messages++;
      if (daily) { daily.messagesUsed++; daily.bytesUsed += body.byteLength; await tx.set(dayKey, daily); }
      await tx.set(key('message-usage', grant.owner), usage);
      await tx.set(key('contact-grant', grant.id), grant);
      await tx.set(key('message', grant.owner, message.id), message);
      // Receipt/fence retained at least minReceiptRetentionMs past admissibility; adapters collect after retainUntil.
      await tx.set(receiptKey, { fingerprint, messageId: message.id, receipt, intakeRevision: intake.revision, admittedAt: now, retainUntil: Math.max(now, p.createdAt + DELIVERY_LIMITS.maxOperationAgeMs) + DELIVERY_LIMITS.minReceiptRetentionMs });
      if (!message.quarantined) await tx.set(key('notification-event', grant.owner, message.id), { id: message.id, owner: grant.owner, messageId: message.id, createdAt: now });
      return { receipt, replayed: false };
    });
  }
}
