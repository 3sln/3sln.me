import { validateDocument, normalizeQuery, accessible, matchesFilters, fail, bounded, DEFAULT_BUDGETS, planBudget } from './schema.mjs';

export function reciprocalRankFusion(lists, limit = 200) {
  const combined = new Map();
  for (const list of lists) for (const [rank, row] of list.entries()) {
    const key = JSON.stringify([row.owner, row.id, row.revision]), prior = combined.get(key) || { ...row, score: 0 };
    prior.score += 1 / (60 + rank + 1); combined.set(key, prior);
  }
  return [...combined.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
const fingerprint = query => JSON.stringify(query);
export class SearchService {
  constructor({ index, authority, outbox, vectorIndex, embedder, semanticPolicy, onSemanticError, crypto = globalThis.crypto, clock = () => Date.now(), budgets = DEFAULT_BUDGETS, maxSessions = 1000, sessionTTL = 300000 }) {
    Object.assign(this, { index, authority, outbox, vectorIndex, embedder, semanticPolicy, onSemanticError, crypto, clock, budgets: { ...DEFAULT_BUDGETS, ...budgets }, maxSessions, sessionTTL }); this.sessions = new Map();
  }
  planBudget(plan, usage) { return planBudget(plan, usage); }
  async removeVector(event) {
    if (!this.vectorIndex) return;
    try { await this.vectorIndex.tombstone(event); } catch (error) { if (!this.onSemanticError) throw error; await this.onSemanticError(event, error); }
  }
  async live(owner, candidate, query) {
    if (candidate.owner !== owner) return null;
    const input = await this.authority.get(owner, candidate.id, { purpose: 'search', revision: candidate.revision }); if (!input) return null;
    let doc; try { doc = validateDocument(input, this.budgets); } catch { return null; }
    return doc.id === candidate.id && accessible(doc, owner) && doc.revision === candidate.revision && matchesFilters(doc, query) ? doc : null;
  }
  async ingest(event) {
    if (!bounded(event.owner) || !bounded(event.id, 300) || !Number.isSafeInteger(event.revision) || event.revision < 1 || !['upsert', 'tombstone'].includes(event.operation)) fail('invalid_search_event');
    if (event.operation === 'tombstone') { await this.index.tombstone(event); await this.removeVector(event); return; }
    const input = await this.authority.get(event.owner, event.id, { purpose: 'index', revision: event.revision });
    if (!input) { await this.index.tombstone(event); await this.removeVector(event); return; }
    const doc = validateDocument(input, this.budgets);
    // Delayed work never copies a stale payload or rewrites a later revision.
    if (doc.owner !== event.owner || doc.id !== event.id || doc.revision !== event.revision) return;
    if (!accessible(doc, event.owner)) { await this.index.tombstone(event); await this.removeVector(event); return; }
    await this.index.upsert(doc);
    if (this.vectorIndex) {
      try {
      if (this.embedder && doc.embeddingAllowed) {
        if (this.vectorIndex.needsUpdate && !await this.vectorIndex.needsUpdate(doc)) return;
        const vector = await this.embedder.embed(doc.title + '\n' + doc.text, { owner: doc.owner, purpose: 'document', maxTokens: 8192 });
        // Recheck after an external embedding await, before retaining its output.
        const live = await this.authority.get(doc.owner, doc.id, { purpose: 'authorize', revision: doc.revision });
        if (live?.revision !== doc.revision || !accessible(live, doc.owner) || live.embeddingAllowed !== true) { await this.vectorIndex.tombstone(event); return; }
        await this.vectorIndex.upsert(doc, vector);
      } else await this.vectorIndex.tombstone(event);
      } catch (error) { if (!this.onSemanticError) throw error; await this.onSemanticError(event, error); }
    }
  }
  async drain(owner, { limit = 50 } = {}) {
    if (!bounded(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_search_batch');
    const events = await this.outbox.peek(owner, limit); if (!Array.isArray(events) || events.length > limit) fail('unbounded_search_outbox');
    let processed = 0;
    for (const event of events) { if (event.owner !== owner) fail('search_outbox_owner'); await this.ingest(event); await this.outbox.acknowledge(event); processed++; }
    return { processed };
  }
  async rebuild(owner, { limit = 50, cursor, reset = false } = {}) {
    if (!bounded(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_search_batch');
    if (reset) { if (cursor || !this.index.reset || this.vectorIndex) fail('search_rebuild_reset_unavailable'); await this.index.reset(owner); }
    const page = await this.authority.scan(owner, { limit, cursor });
    if (!Array.isArray(page.items) || page.items.length > limit) fail('unbounded_search_authority');
    for (const item of page.items) { if (item.owner !== owner) fail('search_authority_owner'); await this.ingest({ owner, id: item.id, revision: item.revision, operation: item.deleted ? 'tombstone' : 'upsert' }); }
    return { processed: page.items.length, cursor: page.cursor || null };
  }
  async search(owner, input = {}) {
    if (!bounded(owner)) fail('invalid_search_owner');
    const query = normalizeQuery(input), queryKey = fingerprint(query), now = this.clock();
    for (const [id, session] of this.sessions) if (session.expires <= now) this.sessions.delete(id);
    let rows, semanticError = null, available = Boolean(this.embedder && this.vectorIndex) && (!this.semanticPolicy || await this.semanticPolicy.enabled(owner));
    if (input.cursor) {
      const session = this.sessions.get(input.cursor);
      if (!session || session.owner !== owner || session.queryKey !== queryKey) fail('invalid_search_cursor');
      if (session.available && !available) fail('semantic_search_not_authorized');
      rows = session.rows; available = session.available; this.sessions.delete(input.cursor);
    } else {
      if (query.mode === 'semantic' && !available) fail('semantic_search_unavailable');
      const lists = [];
      if (query.mode !== 'semantic') lists.push(await this.index.candidates(owner, query, { limit: this.budgets.candidates }));
      if (query.text && available && query.mode !== 'lexical') {
        try {
        const vector = await this.embedder.embed(query.text, { owner, purpose: 'query', maxTokens: 1000 });
        lists.push(await this.vectorIndex.candidates(owner, query, { limit: this.budgets.candidates, vector }));
        } catch (error) { if (query.mode === 'semantic') throw error; available = false; semanticError = error.code || 'semantic_provider_unavailable'; }
      }
      if (lists.some(list => !Array.isArray(list) || list.length > this.budgets.candidates)) fail('unbounded_search_index');
      rows = reciprocalRankFusion(lists.map(list => list.filter(row => row.owner === owner)), this.budgets.candidates);
    }
    if (available && query.mode !== 'lexical' && this.semanticPolicy && !await this.semanticPolicy.enabled(owner)) fail('semantic_search_not_authorized');
    const items = []; let offset = 0;
    for (; offset < rows.length && items.length < query.limit; offset++) {
      const row = rows[offset], doc = await this.live(owner, row, query); if (!doc) continue;
      items.push({ id: doc.id, source: doc.source, revision: doc.revision, type: doc.type, title: doc.title, snippet: Array.from(doc.text).slice(0, 240).join(''), tags: doc.tags, classification: doc.classification, createdAt: doc.createdAt, score: row.score });
    }
    let cursor = null;
    if (offset < rows.length) {
      while (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
      cursor = this.crypto.randomUUID(); this.sessions.set(cursor, { owner, queryKey, rows: rows.slice(offset), expires: now + this.sessionTTL, available });
    }
    return { items, cursor, semanticAvailable: available, ...(semanticError ? { semanticError } : {}), bounded: true, candidateLimit: this.budgets.candidates };
  }
}
