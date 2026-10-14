import {publicMessageMetadata as metadata} from './message-metadata.mjs';
import {contactDeliveryTags,validTagList} from './tag-policy.mjs';
import { fail, key, boundedString, mimeValid, digest, canonical } from './store.mjs';
import { validateContent } from './content.mjs';
import { validateSenderMetadata } from './contact-endpoints.mjs';

const classifications = ['unclassified', 'personal', 'work', 'spam', 'automation'];
const validTags = tags => Array.isArray(tags) && tags.length <= 32 && tags.every(tag => boundedString(tag, 64)) && new Set(tags).size === tags.length;
const validateActions = actions => {
  if (!actions || typeof actions !== 'object' || Array.isArray(actions) || Object.keys(actions).some(field => !['collection', 'tags', 'classification', 'quarantined', 'read'].includes(field))) fail('invalid_actions');
  if (actions.collection !== undefined && !boundedString(actions.collection)) fail('invalid_actions');
  if (actions.tags !== undefined && !validTags(actions.tags)) fail('invalid_actions');
  if (actions.classification !== undefined && !classifications.includes(actions.classification)) fail('invalid_actions');
  if (actions.quarantined !== undefined && typeof actions.quarantined !== 'boolean') fail('invalid_actions');
  if (actions.read !== undefined && typeof actions.read !== 'boolean') fail('invalid_actions');
};

export class MessagingService {
  constructor({ store, tokens, crypto = globalThis.crypto, clock = () => Date.now(), maxStoredBytes = 1073741824, maxStoredMessages = 10000 }) { Object.assign(this, { store, tokens, crypto, clock, maxStoredBytes, maxStoredMessages }); }
  async createCollection(owner, name) {
    if (!boundedString(owner) || !boundedString(name, 100)) fail('invalid_collection');
    return this.store.transaction(async tx => {
      if ((await tx.list(key('collection', owner))).length >= 100) fail('collection_limit');
      const collection = { id: this.crypto.randomUUID(), owner, name, active: true };
      await tx.set(key('collection', owner, collection.id), collection); return collection;
    });
  }
  async collections(owner) { return this.store.transaction(async tx => (await tx.list(key('collection', owner))).map(row => row.value)); }
  async disableCollection(owner, id) {
    return this.store.transaction(async tx => {
      const path = key('collection', owner, id); const collection = await tx.get(path);
      if (!collection) fail('not_found'); collection.active = false; await tx.set(path, collection);
      // Reactivating/recreating a collection must never revive prior grants.
      for (const row of await tx.list(key('contact-grant'))) if (row.value.owner === owner && row.value.claims.collections.includes(id)) { row.value.active = false; await tx.set(row.key, row.value); }
    });
  }
  async setRules(owner, rules) {
    if (!Array.isArray(rules) || rules.length > 100) fail('invalid_rules');
    return this.store.transaction(async tx => {
      const ids = new Set();
      for (const rule of rules) {
        if (!rule || !boundedString(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean' || !rule.match || typeof rule.match !== 'object' || Array.isArray(rule.match) || Object.keys(rule.match).some(field => !['grantId', 'mimeType', 'collection','tagsAll'].includes(field)) || Object.entries(rule.match).some(([field,value])=>field==='tagsAll'?(!validTagList(value)||!value.length):!boundedString(value))) fail('invalid_rules');
        validateActions(rule.actions);
        if (Object.hasOwn(rule.actions, 'read')) fail('invalid_rules');
        if (rule.actions.collection && !(await tx.get(key('collection', owner, rule.actions.collection)))?.active) fail('invalid_collection');
        ids.add(rule.id);
      }
      await tx.set(key('rules', owner), rules); return rules;
    });
  }
  async rules(owner) { return this.store.transaction(async tx => await tx.get(key('rules', owner)) || []); }
  async receive(token, { collection, mimeType, bytes, idempotencyKey, senderMetadata }) {
    if (!boundedString(collection) || !mimeValid(mimeType) || !(bytes instanceof Uint8Array) || bytes.byteLength > 10485760 || !boundedString(idempotencyKey, 128)) fail('invalid_message');
    // Defensive copy before the first await: callers cannot mutate signed/accounted bytes.
    bytes = bytes.slice(); validateContent(mimeType, bytes);
    senderMetadata = validateSenderMetadata(senderMetadata);
    const verified = await this.tokens.verify(token);
    const fingerprint = await digest(this.crypto, canonical({ collection, mimeType, senderMetadata, digest: await digest(this.crypto, bytes) }));
    return this.store.transaction(async tx => {
      const grant = await this.tokens.live(tx, verified);
      const owner = grant.owner,deliveryTags=contactDeliveryTags(grant.claims,senderMetadata.tags);
      if (!grant.claims.collections.includes(collection) || !grant.claims.mimeTypes.includes(mimeType) || !(await tx.get(key('collection', owner, collection)))?.active) fail('forbidden');
      const receiptKey = key('message-receipt', grant.id, idempotencyKey); const prior = await tx.get(receiptKey);
      if (prior) { if (prior.fingerprint !== fingerprint) fail('idempotency_conflict'); return { id: prior.id, accepted: true }; }
      if (bytes.byteLength > grant.claims.maxMessageBytes || grant.messagesUsed + 1 > grant.claims.maxMessages || grant.bytesUsed + bytes.byteLength > grant.claims.maxBytes) fail('quota_exceeded');
      const usage = await tx.get(key('message-usage', owner)) || { bytes: 0, messages: 0 };
      if (usage.bytes + bytes.byteLength > this.maxStoredBytes || usage.messages + 1 > this.maxStoredMessages) fail('account_quota_exceeded');
      const message = { id: this.crypto.randomUUID(), owner, collection, mimeType, size: bytes.byteLength, bytes, receivedAt: this.clock(), readAt: null, tags: [...deliveryTags], deliveryTags, classification: 'unclassified', quarantined: Boolean(grant.quarantined), grantId: grant.id, senderMetadata };
      const original = { collection, mimeType, grantId: grant.id,deliveryTags };
      // Match all rules against original delivery metadata; no accidental rule cascades.
      for (const rule of await tx.get(key('rules', owner)) || []) if (rule.enabled && Object.entries(rule.match).every(([field, value]) => field==='tagsAll'?value.every(tag=>original.deliveryTags.includes(tag)):original[field]===value)) {
        if (rule.actions.collection && !(await tx.get(key('collection', owner, rule.actions.collection)))?.active) continue;
        const quarantine = message.quarantined || Boolean(rule.actions.quarantined);
        Object.assign(message, rule.actions); message.quarantined = quarantine;
      }
      grant.messagesUsed++; grant.bytesUsed += bytes.byteLength;
      usage.bytes += bytes.byteLength; usage.messages++;
      await tx.set(key('message-usage', owner), usage);
      await tx.set(key('contact-grant', grant.id), grant);
      await tx.set(key('message', owner, message.id), message);
      await tx.set(receiptKey, { id: message.id, fingerprint });
      // Outbox creation is atomic with acceptance. Dispatch must re-check preferences,
      // unread status, quarantine and current ownership before each delivery attempt.
      if (!message.quarantined) await tx.set(key('notification-event', owner, message.id), { id: message.id, owner, messageId: message.id, createdAt: message.receivedAt });
      return { id: message.id, accepted: true };
    });
  }
  async list(owner, { collection, unread, quarantined, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_limit');
    return this.store.transaction(async tx => (await tx.list(key('message', owner))).map(row => row.value).filter(message => (collection === undefined || message.collection === collection) && (unread === undefined || (message.readAt === null) === unread) && (quarantined === undefined || message.quarantined === quarantined)).sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id)).slice(0, limit).map(metadata));
  }
  async read(owner, id) { return this.store.transaction(async tx => { const message = await tx.get(key('message', owner, id)); if (!message) fail('not_found'); return message; }); }
  async update(owner, id, actions) {
    validateActions(actions);
    return this.store.transaction(async tx => {
      const path = key('message', owner, id); const message = await tx.get(path);
      if (!message) fail('not_found');
      if (actions.collection && !(await tx.get(key('collection', owner, actions.collection)))?.active) fail('invalid_collection');
      const { read, ...changes } = actions; Object.assign(message, changes);
      if (read !== undefined) message.readAt = read ? this.clock() : null;
      await tx.set(path, message);
      if (actions.quarantined === false && message.readAt === null && !(await tx.get(key('notification-event', owner, id)))) await tx.set(key('notification-event', owner, id), { id, owner, messageId: id, createdAt: this.clock() });
      return metadata(message);
    });
  }
  async delete(owner, id) {
    return this.store.transaction(async tx => {
      const path = key('message', owner, id); const message = await tx.get(path); if (!message) fail('not_found');
      const usage = await tx.get(key('message-usage', owner));
      if (usage) { usage.bytes -= message.size; usage.messages--; await tx.set(key('message-usage', owner), usage); }
      await tx.delete(path); await tx.delete(key('notification-event', owner, id)); return { deleted: true };
    });
  }
}
