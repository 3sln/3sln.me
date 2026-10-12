import { validateDocument, accessible, bounded, fail, recordKey } from './schema.mjs';

const hash = async (crypto, text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export class WorkersAIEmbeddingAdapter {
  constructor({ binding, model, dimensions, maxInputChars = 33300 }) {
    if (!binding?.run || !bounded(model) || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096) fail('invalid_embedding_configuration');
    Object.assign(this, { binding, model, dimensions, maxInputChars });
  }
  async embed(text) {
    if (typeof text !== 'string' || text.length > this.maxInputChars) fail('embedding_input_limit');
    const result = await this.binding.run(this.model, { text: [text] }), vector = result?.data?.[0];
    if (!Array.isArray(vector) || vector.length !== this.dimensions || vector.some(value => !Number.isFinite(value))) fail('invalid_search_vector');
    return vector;
  }
}

// state is durable metadata ({get,put,transaction}); gate.run serializes writes for this
// owner in one DO/process. Namespace filtering precedes ANN topK. Immutable
// revision-specific vector IDs prevent delayed writes from overwriting updates.
// Provider mutation completion is eventual: live authority checks remain required.
export class VectorizeSearchIndex {
  constructor({ binding, state, gate, owner, crypto = globalThis.crypto, dimensions, maxVectors = 10000 }) {
    if (!binding?.upsert || !binding?.query || !binding?.deleteByIds || !state?.get || !state?.put || !state?.transaction || !gate?.run || !bounded(owner) || !Number.isSafeInteger(dimensions) || dimensions < 1) fail('invalid_vectorize_configuration');
    Object.assign(this, { binding, state, gate, owner, crypto, dimensions, maxVectors });
  }
  async namespace(owner) { if (owner !== this.owner) fail('search_index_owner'); return hash(this.crypto, owner); }
  async upsert(input, vector) {
    const doc = validateDocument(input); await this.namespace(doc.owner);
    if (!accessible(doc, doc.owner) || !doc.embeddingAllowed) fail('embedding_not_authorized');
    if (!Array.isArray(vector) || vector.length !== this.dimensions || vector.some(value => !Number.isFinite(value))) fail('invalid_search_vector');
    return this.gate.run(async () => {
      const key = recordKey('search-vector-revision', doc.owner, doc.id); let prior = await this.state.get(key);
      if (prior?.cleanupIds?.length) { await this.cleanup(key, prior); prior = { ...prior, cleanupIds: [] }; }
      if (prior?.revision >= doc.revision) return false;
      const usageKey = recordKey('search-vector-usage', doc.owner), usage = await this.state.get(usageKey) || { count: 0 };
      if (!prior?.active && usage.count >= this.maxVectors) fail('search_vector_budget');
      const vectorId = await hash(this.crypto, JSON.stringify([doc.owner, doc.id, doc.revision]));
      await this.binding.upsert([{ id: vectorId, namespace: await this.namespace(doc.owner), values: vector, metadata: { owner: doc.owner, itemId: doc.id, revision: doc.revision } }]);
      const next = { revision: doc.revision, vectorId, active: true, cleanupIds: [...new Set([...(prior?.cleanupIds || []), ...(prior?.vectorId ? [prior.vectorId] : [])])] };
      await this.state.transaction(async tx => { await tx.put(key, next); if (!prior?.active) await tx.put(usageKey, { count: usage.count + 1 }); });
      await this.cleanup(key, next);
      return true;
    });
  }
  async tombstone(event) {
    await this.namespace(event.owner);
    return this.gate.run(async () => {
      const key = recordKey('search-vector-revision', event.owner, event.id), prior = await this.state.get(key);
      if (prior?.revision > event.revision) return false;
      const next = { revision: event.revision, vectorId: null, active: false, cleanupIds: [...new Set([...(prior?.cleanupIds || []), ...(prior?.vectorId ? [prior.vectorId] : [])])] };
      await this.state.transaction(async tx => {
        await tx.put(key, next);
        if (prior?.active) { const usageKey = recordKey('search-vector-usage', event.owner), usage = await tx.get(usageKey) || { count: 0 }; await tx.put(usageKey, { count: Math.max(0, usage.count - 1) }); }
      });
      await this.cleanup(key, next);
      return true;
    });
  }
  async cleanup(key, record) {
    if (!record.cleanupIds?.length) return;
    await this.binding.deleteByIds(record.cleanupIds);
    await this.state.put(key, { ...record, cleanupIds: [] });
  }
  async candidates(owner, query, { limit, vector }) {
    const namespace = await this.namespace(owner);
    const result = await this.binding.query(vector, { namespace, topK: Math.min(50, limit), returnMetadata: 'all', returnValues: false });
    // Only identifier metadata crosses this boundary. ACL/tag/date/type filters
    // are reapplied to authoritative items by SearchService, never remote text.
    return (result.matches || []).filter(row => row.namespace === namespace && row.metadata?.owner === owner).map(row => ({ owner, id: row.metadata.itemId, revision: row.metadata.revision, score: row.score }));
  }
}
