import {publicMessageMetadata as metadata} from './message-metadata.mjs';
import {validTagList,contactIntake,intakeDeliveryTags} from './tag-policy.mjs';
import {validTagIds,isSuspectedTag,validateTagActions,changeTags,applyRules,initialTags,migrateTags,seedDefaultRules,stampRules,normalizeAutomatedResult,validUserTagId,validTagLabel} from './tags.mjs';
import { fail, key, boundedString, mimeValid, digest, canonical } from './store.mjs';
import { validateContent } from './content.mjs';
import { validateSenderMetadata } from './contact-endpoints.mjs';

const validateActions = actions => {
  validateTagActions(actions, ['collection', 'tags', 'addTags', 'removeTags', 'classification', 'quarantined', 'read']);
  if (actions.collection !== undefined && !boundedString(actions.collection)) fail('invalid_actions');
  if (actions.quarantined !== undefined && typeof actions.quarantined !== 'boolean') fail('invalid_actions');
  if (actions.read !== undefined && typeof actions.read !== 'boolean') fail('invalid_actions');
};
const validMatch = match => match && typeof match === 'object' && !Array.isArray(match) && Object.keys(match).every(field => ['grantId', 'mimeType', 'collection', 'tagsAll', 'source'].includes(field)) && Object.entries(match).every(([field, value]) => field === 'tagsAll' ? validTagIds(value) && value.length > 0 : field === 'source' ? ['classifier', 'heuristic'].includes(value) && Boolean(match.tagsAll?.some(isSuspectedTag)) : boundedString(value));
/** Seeds versioned default rules and migrates legacy rule tags inside the caller's transaction. */
export async function ownerRules(tx, owner) {
  const rules = await tx.get(key('rules', owner)) || [], seeded = seedDefaultRules(rules, await tx.get(key('rule-defaults', owner)));
  if (!seeded) return rules;
  await tx.set(key('rules', owner), seeded.rules); await tx.set(key('rule-defaults', owner), seeded.state); return seeded.rules;
}

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
      const ids = new Set(), state = await tx.get(key('rule-defaults', owner));
      for (const rule of rules) {
        if (!rule || !boundedString(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean' || !validMatch(rule.match)) fail('invalid_rules');
        validateActions(rule.actions);
        if (Object.hasOwn(rule.actions, 'read')) fail('invalid_rules');
        if (rule.actions.collection && !(await tx.get(key('collection', owner, rule.actions.collection)))?.active) fail('invalid_collection');
        ids.add(rule.id);
      }
      // A first write before any seeding keeps the owner's list and appends defaults after it.
      const stamped = stampRules(rules, state ? await ownerRules(tx, owner) : []);
      await tx.set(key('rules', owner), stamped); return state ? stamped : ownerRules(tx, owner);
    });
  }
  async rules(owner) { return this.store.transaction(tx => ownerRules(tx, owner)); }
  /** Restores a deleted or edited default rule to its current shipped definition (keeps the enabled choice). */
  async restoreDefaultRule(owner, id) {
    const fresh = seedDefaultRules([], null).rules.find(rule => rule.id === id); if (!fresh) fail('not_found');
    return this.store.transaction(async tx => {
      const rules = await ownerRules(tx, owner), at = rules.findIndex(rule => rule.id === id), prior = rules[at], next = { ...fresh, enabled: prior?.enabled ?? fresh.enabled, revision: (prior?.revision ?? 0) + 1 };
      if (at >= 0) rules[at] = next; else { if (rules.length >= 100) fail('invalid_rules'); rules.push(next); }
      await tx.set(key('rules', owner), rules); return next;
    });
  }
  /** Owner label registry: renaming a label never retags messages, rules, Views or intake configuration. */
  async tagLabels(owner) { return this.store.transaction(async tx => await tx.get(key('tag-labels', owner)) || { revision: 0, labels: {} }); }
  async setTagLabel(owner, { id, label, expectedRevision } = {}) {
    if (label !== null && !validTagLabel(label) || id !== undefined && !validUserTagId(id) || id === undefined && label === null || expectedRevision !== undefined && !Number.isSafeInteger(expectedRevision)) fail('invalid_tag_label');
    return this.store.transaction(async tx => {
      const registry = await tx.get(key('tag-labels', owner)) || { revision: 0, labels: {} };
      if (expectedRevision !== undefined && registry.revision !== expectedRevision) fail('tag_label_conflict');
      const tag = id ?? 't.' + this.crypto.randomUUID().replaceAll('-', '').slice(0, 20);
      if (label === null) delete registry.labels[tag]; else { if (!Object.hasOwn(registry.labels, tag) && Object.keys(registry.labels).length >= 500) fail('tag_label_limit'); registry.labels[tag] = label; }
      registry.revision++; await tx.set(key('tag-labels', owner), registry); return { id: tag, label, revision: registry.revision };
    });
  }
  async receive(token, { collection, mimeType, bytes, idempotencyKey, senderMetadata }) {
    if (!boundedString(collection) || !mimeValid(mimeType) || !(bytes instanceof Uint8Array) || bytes.byteLength > 10485760 || !boundedString(idempotencyKey, 128)) fail('invalid_message');
    // Defensive copy before the first await: callers cannot mutate signed/accounted bytes.
    bytes = bytes.slice(); validateContent(mimeType, bytes);
    senderMetadata = validateSenderMetadata(senderMetadata);
    const verified = await this.tokens.verify(token);
    const fingerprint = await digest(this.crypto, canonical({ collection, mimeType, senderMetadata, digest: await digest(this.crypto, bytes) }));
    return this.store.transaction(async tx => {
      const grant = await this.tokens.live(tx, verified);
      const owner = grant.owner,intake=contactIntake(grant),deliveryTags=intakeDeliveryTags(intake,senderMetadata.tags);
      if (!grant.claims.collections.includes(collection) || !grant.claims.mimeTypes.includes(mimeType) || !(await tx.get(key('collection', owner, collection)))?.active) fail('forbidden');
      const receiptKey = key('message-receipt', grant.id, idempotencyKey); const prior = await tx.get(receiptKey);
      if (prior) { if (prior.fingerprint !== fingerprint) fail('idempotency_conflict'); return { id: prior.id, accepted: true }; }
      if (bytes.byteLength > grant.claims.maxMessageBytes || grant.messagesUsed + 1 > grant.claims.maxMessages || grant.bytesUsed + bytes.byteLength > grant.claims.maxBytes) fail('quota_exceeded');
      const usage = await tx.get(key('message-usage', owner)) || { bytes: 0, messages: 0 };
      if (usage.bytes + bytes.byteLength > this.maxStoredBytes || usage.messages + 1 > this.maxStoredMessages) fail('account_quota_exceeded');
      const now = this.clock(), message = initialTags({ id: this.crypto.randomUUID(), owner, collection, mimeType, size: bytes.byteLength, bytes, deliveryCollection: collection, receivedAt: now, readAt: null, deliveryTags, quarantined: Boolean(grant.quarantined), grantId: grant.id, senderMetadata, ...(intake ? { intakeRevision: intake.revision } : {}) }, deliveryTags, intake ? { source: 'intake', intakeRevision: intake.revision } : { source: 'grant' }, now);
      // Match all rules against original delivery metadata; no accidental rule cascades.
      await applyRules(message, await ownerRules(tx, owner), { now, active: async id => (await tx.get(key('collection', owner, id)))?.active });
      // Lazily persist legacy signed tags as revision-0 intake on first delivery.
      if (intake && !grant.intake) grant.intake = intake;
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
    return this.store.transaction(async tx => (await tx.list(key('message', owner))).map(row => migrateTags(row.value)).filter(message => (collection === undefined || message.collection === collection) && (unread === undefined || (message.readAt === null) === unread) && (quarantined === undefined || message.quarantined === quarantined)).sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id)).slice(0, limit).map(metadata));
  }
  async read(owner, id) { return this.store.transaction(async tx => { const message = await tx.get(key('message', owner, id)); if (!message) fail('not_found'); return migrateTags(message); }); }
  async update(owner, id, actions, provenance = { source: 'owner' }) {
    validateActions(actions);
    return this.store.transaction(async tx => {
      const path = key('message', owner, id), now = this.clock(), message = migrateTags(await tx.get(path));
      if (!message) fail('not_found');
      if (actions.collection && !(await tx.get(key('collection', owner, actions.collection)))?.active) fail('invalid_collection');
      const { read, tags, addTags, removeTags, classification, ...changes } = actions; Object.assign(message, changes);
      changeTags(message, { tags, addTags, removeTags, classification }, provenance, now, { owner: true });
      // Only explicit owner action releases quarantine; automation then never re-quarantines.
      if (actions.quarantined !== undefined) message.quarantineReleased = !actions.quarantined;
      if (read !== undefined) message.readAt = read ? now : null;
      await tx.set(path, message);
      if (actions.quarantined === false && message.readAt === null && !(await tx.get(key('notification-event', owner, id)))) await tx.set(key('notification-event', owner, id), { id, owner, messageId: id, createdAt: now });
      return metadata(message);
    });
  }
  /** Internal classifier/heuristic boundary (no owner, app or MCP route): applies registered suspected tags with
   * evidence, then runs only rules newly matched by them, atomically. Never invokes a model. */
  async applyAutomatedTags(owner, id, input) {
    const result = normalizeAutomatedResult(input);
    return this.store.transaction(async tx => {
      const path = key('message', owner, id), now = this.clock(), message = migrateTags(await tx.get(path));
      if (!message) fail('not_found');
      const { source, labels, model, version } = result, newly = [], evidence = probability => ({ ...model ? { model } : {}, version, ...probability !== undefined ? { probability } : {} });
      message.classificationResult = { ...message.classificationResult, [source]: { ...result, at: now } };
      for (const { tag, probability } of labels) {
        const prior = message.automated?.[tag];
        if (prior?.[source]) continue;
        newly.push(tag); message.automated = { ...message.automated, [tag]: { ...prior, [source]: { ...evidence(probability), at: now } } };
        if (!prior && !message.tagSuppressed?.includes(tag) && !message.tags.includes(tag)) { message.tags = [...message.tags, tag]; message.tagProvenance = { ...message.tagProvenance, [tag]: { source, ...evidence(probability), at: now } }; message.tagHistory = [...message.tagHistory ?? [], { at: now, op: 'add', tag, source }].slice(-16); }
      }
      const wasQuarantined = message.quarantined;
      if (newly.length) await applyRules(message, await ownerRules(tx, owner), { phase: 'automated', newly, now, active: async collection => (await tx.get(key('collection', owner, collection)))?.active });
      await tx.set(path, message);
      // Dispatch also rechecks quarantine; a notification may already have been sent before classification.
      if (message.quarantined && !wasQuarantined) await tx.delete(key('notification-event', owner, id));
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
