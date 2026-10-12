import { validateDocument, tokens, matchesFilters, accessible, fail, DEFAULT_BUDGETS } from './schema.mjs';

// Bounded reference adapter for tests and small loopback demos. Production uses
// indexed adapters; this intentionally caps each account instead of pretending
// a full Map scan is a scalable database query.
export class MemorySearchIndex {
  constructor({ budgets = DEFAULT_BUDGETS } = {}) { this.budgets = { ...DEFAULT_BUDGETS, ...budgets }; this.owners = new Map(); }
  async reset(owner) { this.owners.delete(owner); }
  async readContent(owner, id, revision) { const doc = this.partition(owner).get(id); return doc && !doc.deleted && doc.revision === revision ? { title: doc.title, text: doc.text } : null; }
  partition(owner) { if (!this.owners.has(owner)) this.owners.set(owner, new Map()); return this.owners.get(owner); }
  async upsert(input) {
    const doc = validateDocument(input, this.budgets), rows = this.partition(doc.owner), prior = rows.get(doc.id);
    if (prior && prior.revision >= doc.revision) return false;
    if ((!prior || prior.deleted) && [...rows.values()].filter(row => !row.deleted).length >= this.budgets.maxDocuments) fail('search_document_budget');
    let count = tokens(doc.title + ' ' + doc.text).length;
    for (const row of rows.values()) if (row.id !== doc.id) count += row.tokenCount || 0;
    if (count > this.budgets.indexedTokens) fail('search_token_budget');
    rows.set(doc.id, { ...doc, tokenCount: tokens(doc.title + ' ' + doc.text).length }); return true;
  }
  async tombstone({ owner, id, revision }) {
    const rows = this.partition(owner), prior = rows.get(id);
    if (prior && prior.revision >= revision) return false;
    rows.set(id, { id, owner, revision, deleted: true }); return true;
  }
  async candidates(owner, query, { limit }) {
    const terms = [...new Set(tokens(query.text))], best = [];
    for (const doc of this.partition(owner).values()) {
      if (!accessible(doc, owner) || !matchesFilters(doc, query)) continue;
      const counts = new Map(); for (const term of tokens(doc.title + ' ' + doc.text)) counts.set(term, (counts.get(term) || 0) + 1);
      if (terms.length && !terms.every(term => counts.has(term))) continue;
      const score = terms.reduce((sum, term) => sum + counts.get(term), 0);
      best.push({ id: doc.id, owner, revision: doc.revision, score, createdAt: doc.createdAt });
      best.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      if (best.length > limit) best.pop();
    }
    return best;
  }
}

// Exact vectors supplied by a real/test embedding port. No hash-derived or
// lexical pseudo-embedding is provided. Accounts are partitioned before scoring.
export class MemoryVectorIndex {
  constructor({ dimensions = 384, maxVectors = 10000 } = {}) { this.dimensions = dimensions; this.maxVectors = maxVectors; this.owners = new Map(); }
  async upsert(doc, vector) {
    if (!Array.isArray(vector) || vector.length !== this.dimensions || vector.some(value => !Number.isFinite(value))) fail('invalid_search_vector');
    const rows = this.owners.get(doc.owner) || new Map(); this.owners.set(doc.owner, rows);
    const prior = rows.get(doc.id); if (prior && prior.revision >= doc.revision) return false;
    if ((!prior || prior.deleted) && [...rows.values()].filter(row => !row.deleted).length >= this.maxVectors) fail('search_vector_budget');
    rows.set(doc.id, { ...structuredClone(doc), vector: [...vector] }); return true;
  }
  async tombstone({ owner, id, revision }) {
    const rows = this.owners.get(owner) || new Map(); this.owners.set(owner, rows);
    if ((rows.get(id)?.revision || 0) >= revision) return false;
    rows.set(id, { owner, id, revision, deleted: true }); return true;
  }
  async candidates(owner, query, { limit, vector }) {
    if (!Array.isArray(vector) || vector.length !== this.dimensions || vector.some(value => !Number.isFinite(value))) fail('invalid_search_vector');
    const best = [], qnorm = Math.hypot(...vector);
    for (const doc of (this.owners.get(owner) || new Map()).values()) {
      if (!accessible(doc, owner) || !matchesFilters(doc, query)) continue;
      const norm = Math.hypot(...doc.vector), score = qnorm && norm ? doc.vector.reduce((sum, value, i) => sum + value * vector[i], 0) / (qnorm * norm) : 0;
      best.push({ owner, id: doc.id, revision: doc.revision, score }); best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); if (best.length > limit) best.pop();
    }
    return best;
  }
}
