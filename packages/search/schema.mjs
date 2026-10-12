export class SearchFault extends Error {
  constructor(code) { super(code); this.name = 'SearchFault'; this.code = code; }
}
export const fail = code => { throw new SearchFault(code); };
export const bounded = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const recordKey = (...parts) => parts.map(part => encodeURIComponent(String(part))).join('/') + '/';
export const tokens = text => text.normalize('NFC').toLocaleLowerCase('en').match(/[\p{L}\p{N}\p{M}]+/gu) || [];
export const DEFAULT_BUDGETS = Object.freeze({ maxDocuments: 10000, indexedTokens: 2000000, vectors: 10000, dimensions: 384, queue: 1000, candidates: 200, maxTextBytes: 32768 });
// These are product configuration placeholders, not provider pricing or entitlements.
export const PLAN_BUDGETS = Object.freeze({ free: Object.freeze({ ...DEFAULT_BUDGETS }), paid: Object.freeze({ ...DEFAULT_BUDGETS, maxDocuments: 100000, indexedTokens: 20000000, vectors: 100000, queue: 5000 }) });
export function planBudget(plan = 'free', usage = {}) {
  if (!PLAN_BUDGETS[plan]) fail('invalid_search_plan');
  const limits = PLAN_BUDGETS[plan];
  return { plan, provisional: true, limits: { ...limits }, remaining: Object.fromEntries(['maxDocuments', 'indexedTokens', 'vectors', 'queue'].map(key => [key, Math.max(0, limits[key] - (usage[key] || 0))])) };
}
export function validateDocument(input, { maxTextBytes = DEFAULT_BUDGETS.maxTextBytes } = {}) {
  if (!input || !bounded(input.id, 300) || !bounded(input.owner) || !bounded(input.type, 64) || !bounded(input.source?.kind, 64) || !bounded(input.source?.id, 300) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) fail('invalid_search_document');
  if ([input.type, input.source.kind, input.classification].some(value => typeof value === 'string' && ['credential', 'credentials', 'provider-credential', 'provider-credentials', 'secret'].includes(value.toLowerCase()))) fail('sensitive_search_document');
  if (input.classification !== undefined && !bounded(input.classification, 64)) fail('invalid_search_classification');
  if (typeof input.title !== 'string' || input.title.length > 500 || typeof input.text !== 'string' || new TextEncoder().encode(input.text).length > maxTextBytes) fail('invalid_search_content');
  const tags = input.tags || [];
  if (!Array.isArray(tags) || tags.length > 32 || tags.some(tag => !bounded(tag, 64)) || new Set(tags).size !== tags.length) fail('invalid_search_tags');
  const readers = input.acl?.readers || [];
  if (!Array.isArray(readers) || readers.length > 100 || readers.some(reader => !bounded(reader))) fail('invalid_search_acl');
  return { id: input.id, owner: input.owner, source: { kind: input.source.kind, id: input.source.id }, revision: input.revision, type: input.type, title: input.title, text: input.text, tags: [...tags], classification: input.classification || 'unclassified', createdAt: input.createdAt, acl: { readers: [...new Set(readers)] }, quarantined: Boolean(input.quarantined), deleted: Boolean(input.deleted), embeddingAllowed: input.embeddingAllowed === true };
}
export function normalizeQuery(input = {}) {
  const text = input.text ?? '';
  if (typeof text !== 'string' || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) fail('invalid_search_query');
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_search_limit');
  const tags = { all: input.tags?.all || [], any: input.tags?.any || [] };
  for (const values of [tags.all, tags.any, input.types || []]) if (!Array.isArray(values) || values.length > 32 || values.some(value => !bounded(value, 64))) fail('invalid_search_filter');
  for (const date of [input.from, input.to]) if (date !== undefined && (!Number.isSafeInteger(date) || date < 0)) fail('invalid_search_date');
  if (input.from !== undefined && input.to !== undefined && input.from > input.to) fail('invalid_search_date');
  const mode = input.mode || 'hybrid';
  if (!['lexical', 'semantic', 'hybrid'].includes(mode)) fail('invalid_search_mode');
  return { text: text.trim(), tags: { all: [...new Set(tags.all)].sort(), any: [...new Set(tags.any)].sort() }, types: [...new Set(input.types || [])].sort(), from: input.from, to: input.to, mode, limit };
}
export const accessible = (doc, owner) => doc?.owner === owner && !doc.deleted && !doc.quarantined && doc.acl?.readers?.includes(owner);
export const matchesFilters = (doc, query) => query.tags.all.every(tag => doc.tags.includes(tag)) && (!query.tags.any.length || query.tags.any.some(tag => doc.tags.includes(tag))) && (!query.types.length || query.types.includes(doc.type)) && (query.from === undefined || doc.createdAt >= query.from) && (query.to === undefined || doc.createdAt <= query.to);
