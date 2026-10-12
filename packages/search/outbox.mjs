import { bounded, fail, recordKey, DEFAULT_BUDGETS } from './schema.mjs';

export const searchEventPrefix = owner => recordKey('search-event', owner);
export const searchRevisionKey = (owner, id) => recordKey('search-revision', owner, id);
export const searchEventKey = (owner, id) => recordKey('search-event', owner, id);
// Invoke inside the SAME serializable transaction as the source mutation.
// Coalescing bounds pending work by item, while retained revisions prevent a
// delete/recreate cycle or delayed upsert from reviving an older document.
export async function enqueueSearchEvent(tx, { owner, id, operation = 'upsert', source, revision }, { maxQueue = DEFAULT_BUDGETS.queue } = {}) {
  if (!bounded(owner) || !bounded(id, 300) || !['upsert', 'tombstone'].includes(operation) || !bounded(source?.kind, 64) || !bounded(source?.id, 300)) fail('invalid_search_event');
  const get = key => tx.get(key), put = (key, value) => (tx.set || tx.put).call(tx, key, value);
  const prior = await get(searchRevisionKey(owner, id));
  revision ??= (prior?.revision || 0) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision <= (prior?.revision || 0)) fail('invalid_search_revision');
  const eventKey = searchEventKey(owner, id), usageKey = recordKey('search-queue-usage', owner);
  const pending = await get(eventKey), usage = await get(usageKey) || { count: 0 };
  if (!pending && usage.count >= maxQueue) fail('search_queue_full');
  const event = { owner, id, operation, source: { kind: source.kind, id: source.id }, revision };
  await put(searchRevisionKey(owner, id), { revision, operation });
  await put(eventKey, event);
  if (!pending) await put(usageKey, { count: usage.count + 1 });
  return event;
}

// Metadata.list must honor its SQL/range LIMIT before materialization.
export class MetadataSearchOutbox {
  constructor(metadata) { this.metadata = metadata; }
  async peek(owner, limit) { if (!bounded(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_search_batch'); return [...(await this.metadata.list({ prefix: searchEventPrefix(owner), limit })).values()]; }
  async acknowledge(event) {
    return this.metadata.transaction(async tx => {
      const path = searchEventKey(event.owner, event.id), current = await tx.get(path);
      if (current?.revision !== event.revision) return false;
      await tx.delete(path);
      const usageKey = recordKey('search-queue-usage', event.owner), usage = await tx.get(usageKey) || { count: 0 };
      await (tx.set || tx.put).call(tx, usageKey, { count: Math.max(0, usage.count - 1) });
      return true;
    });
  }
}
