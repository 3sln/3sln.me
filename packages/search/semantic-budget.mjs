import { bounded, fail, recordKey } from './schema.mjs';

export const SEMANTIC_MODEL = '@cf/baai/bge-small-en-v1.5';
export const SEMANTIC_DIMENSIONS = 384;
export const SEMANTIC_LIMITS = Object.freeze({ documents: 1000, queries: 500, embeddingTokens: 768000, vectorDimensions: 576000, spendMicroUSD: 25000, vectors: 1000 });
// Estimates deliberately round each paid request upward and ignore free credits.
// They bound this application's admitted work, not the provider's entire bill.
export const SEMANTIC_COST = Object.freeze({ embed: 11, query: 4, upsert: 4 });
export const validSemanticCount = value => Number.isSafeInteger(value) && value >= 0;
export class SearchMutationGate {
  constructor() { this.tail = Promise.resolve(); }
  async run(operation) { const previous = this.tail; let release; this.tail = new Promise(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
}
export class DurableSemanticBudget {
  constructor({ state, configured = false, globalSpend, clock = () => Date.now(), limits = {} }) {
    this.state = state; this.configured = configured; this.globalSpend = globalSpend; this.clock = clock;
    this.limits = Object.fromEntries(Object.entries(SEMANTIC_LIMITS).map(([name, maximum]) => { const value = limits[name] ?? maximum; if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('invalid_semantic_budget'); return [name, value]; }));
  }
  async enabled(owner) { return this.configured && Boolean(this.globalSpend?.reserve) && (await this.state.get(recordKey('search-consent', owner)))?.enabled === true; }
  async generation(owner) { return (await this.state.get(recordKey('search-consent', owner)))?.generation || 0; }
  month() { return new Date(this.clock()).toISOString().slice(0, 7); }
  async status(owner) {
    if (!bounded(owner)) fail('invalid_search_owner');
    const consent = await this.state.get(recordKey('search-consent', owner));
    const usage = await this.state.get(recordKey('search-semantic-spend', owner));
    const vectors = await this.state.get(recordKey('search-vector-usage', owner)) || { count: 0, reservations: 0 };
    const current = usage?.month === this.month() ? usage : { month: this.month(), documents: 0, queries: 0, embeddingTokens: 0, vectorDimensions: 0, spendMicroUSD: 0 };
    return { enabled: consent?.enabled === true, configured: this.configured && Boolean(this.globalSpend?.reserve), available: await this.enabled(owner), model: SEMANTIC_MODEL, dimensions: SEMANTIC_DIMENSIONS, language: 'en', excerptBytes: 480, limits: { ...this.limits }, usage: { ...current, vectors: vectors.count, vectorReservations: vectors.reservations || 0 }, estimateOnly: true };
  }
  async consent(owner, enabled) {
    if (!bounded(owner) || typeof enabled !== 'boolean') fail('invalid_search_consent');
    if (enabled && (!this.configured || !this.globalSpend?.reserve)) fail('semantic_search_unavailable');
    await this.state.transaction(async tx => {
      const key = recordKey('search-consent', owner), prior = await tx.get(key);
      await tx.put(key, { enabled, generation: (prior?.generation || 0) + 1, updatedAt: this.clock() });
    });
  }
  async reserve(owner, operation, { purpose, newVector = false } = {}) {
    if (!bounded(owner) || !Object.hasOwn(SEMANTIC_COST, operation) || operation === 'embed' && !['document', 'query'].includes(purpose)) fail('invalid_semantic_operation');
    if (!await this.enabled(owner)) fail('semantic_search_not_authorized');
    const month = this.month(), units = operation === 'embed' ? 512 : SEMANTIC_DIMENSIONS, costMicroUSD = SEMANTIC_COST[operation];
    await this.state.transaction(async tx => {
      if ((await tx.get(recordKey('search-consent', owner)))?.enabled !== true) fail('semantic_search_not_authorized');
      const key = recordKey('search-semantic-spend', owner), old = await tx.get(key);
      const next = old?.month === month ? { ...old } : { month, documents: 0, queries: 0, embeddingTokens: 0, vectorDimensions: 0, spendMicroUSD: 0 };
      for (const name of ['documents', 'queries', 'embeddingTokens', 'vectorDimensions', 'spendMicroUSD']) if (!validSemanticCount(next[name])) fail('semantic_account_budget');
      if (operation === 'embed') { next[purpose === 'document' ? 'documents' : 'queries']++; next.embeddingTokens += units; }
      else next.vectorDimensions += units;
      next.spendMicroUSD += costMicroUSD;
      for (const name of ['documents', 'queries', 'embeddingTokens', 'vectorDimensions', 'spendMicroUSD']) if (next[name] > this.limits[name]) fail('semantic_account_budget');
      await tx.put(key, next);
    });
    // Both reservations precede the provider call. Errors/timeouts are charged;
    // refunding them would let retries evade admission after uncertain outcomes.
    const admitted = await this.globalSpend.reserve({ owner, operation, units, costMicroUSD, newVector });
    if (admitted !== true) fail('semantic_global_budget');
    if (!await this.enabled(owner)) fail('semantic_search_not_authorized');
  }
}
