import { validateDocument, accessible, tokens, DEFAULT_BUDGETS, fail } from './schema.mjs';

const schema = [
  'CREATE TABLE IF NOT EXISTS search_revisions(owner TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(owner,id))',
  'CREATE TABLE IF NOT EXISTS search_usage(owner TEXT PRIMARY KEY,documents INTEGER NOT NULL,tokens INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS search_documents(owner TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,classification TEXT NOT NULL,created_at INTEGER NOT NULL,token_count INTEGER NOT NULL,PRIMARY KEY(owner,id))',
  'CREATE INDEX IF NOT EXISTS search_documents_date ON search_documents(owner,created_at DESC,id)',
  'CREATE INDEX IF NOT EXISTS search_documents_type_date ON search_documents(owner,type,created_at DESC,id)',
  'CREATE TABLE IF NOT EXISTS search_tags(owner TEXT NOT NULL,id TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(owner,id,tag))',
  'CREATE INDEX IF NOT EXISTS search_tag_lookup ON search_tags(owner,tag,id)',
  "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(owner_scope,owner UNINDEXED,id UNINDEXED,title,text,tokenize='unicode61 remove_diacritics 0')",
];
const ownerScope = owner => [...new TextEncoder().encode(owner)].map(byte => byte.toString(16).padStart(2, '0')).join('');

// sql.exec(statement, ...bindings) must be synchronous and return an iterable of
// rows. Inject transactionSync for DO storage; nodeSqlPort supplies transactions
// for Node DatabaseSync. Keep each instance in its account database for isolated
// FTS corpus statistics. No node:* imports enter this portable module.
export class SqliteSearchIndex {
  constructor({ sql, transaction = sql.transaction?.bind(sql), budgets = DEFAULT_BUDGETS }) {
    if (!transaction) fail('search_transaction_required');
    Object.assign(this, { sql, transaction, budgets: { ...DEFAULT_BUDGETS, ...budgets } });
    for (const statement of schema) this.sql.exec(statement);
  }
  rows(statement, ...bindings) { return [...this.sql.exec(statement, ...bindings)]; }
  async readContent(owner, id, revision) { return this.rows('SELECT title,text FROM search_documents WHERE owner=? AND id=? AND revision=?', owner, id, revision)[0] || null; }
  async reset(owner) {
    return this.transaction(() => { for (const table of ['search_fts', 'search_tags', 'search_documents', 'search_revisions', 'search_usage']) this.sql.exec(`DELETE FROM ${table} WHERE owner=?`, owner); });
  }
  change(event, document) {
    return this.transaction(() => {
      const prior = this.rows('SELECT revision FROM search_revisions WHERE owner=? AND id=?', event.owner, event.id)[0];
      if (prior?.revision >= event.revision) return false;
      const oldDoc = this.rows('SELECT token_count FROM search_documents WHERE owner=? AND id=?', event.owner, event.id)[0];
      const usage = this.rows('SELECT documents,tokens FROM search_usage WHERE owner=?', event.owner)[0] || { documents: 0, tokens: 0 };
      const documents = usage.documents - (oldDoc ? 1 : 0) + (document ? 1 : 0), count = usage.tokens - (oldDoc?.token_count || 0) + (document ? tokens(document.title + ' ' + document.text).length : 0);
      if (documents > this.budgets.maxDocuments) fail('search_document_budget');
      if (count > this.budgets.indexedTokens) fail('search_token_budget');
      this.sql.exec('DELETE FROM search_fts WHERE owner=? AND id=?', event.owner, event.id);
      this.sql.exec('DELETE FROM search_tags WHERE owner=? AND id=?', event.owner, event.id);
      this.sql.exec('DELETE FROM search_documents WHERE owner=? AND id=?', event.owner, event.id);
      this.sql.exec('INSERT INTO search_revisions(owner,id,revision) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET revision=excluded.revision', event.owner, event.id, event.revision);
      this.sql.exec('INSERT INTO search_usage(owner,documents,tokens) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET documents=excluded.documents,tokens=excluded.tokens', event.owner, documents, count);
      if (document) {
        this.sql.exec('INSERT INTO search_documents(owner,id,revision,type,title,text,classification,created_at,token_count) VALUES(?,?,?,?,?,?,?,?,?)', document.owner, document.id, document.revision, document.type, document.title, document.text, document.classification, document.createdAt, tokens(document.title + ' ' + document.text).length);
        this.sql.exec('INSERT INTO search_fts(owner_scope,owner,id,title,text) VALUES(?,?,?,?,?)', ownerScope(document.owner), document.owner, document.id, document.title.normalize('NFC'), document.text.normalize('NFC'));
        for (const tag of document.tags) this.sql.exec('INSERT INTO search_tags(owner,id,tag) VALUES(?,?,?)', document.owner, document.id, tag);
      }
      return true;
    });
  }
  async upsert(input) { const doc = validateDocument(input, this.budgets); return this.change(doc, accessible(doc, doc.owner) ? doc : null); }
  async tombstone(event) { return this.change(event, null); }
  async candidates(owner, query, { limit }) {
    const terms = [...new Set(tokens(query.text))], bindings = [owner], conditions = ['d.owner=?'];
    if (terms.length) { conditions.push('search_fts MATCH ?'); bindings.push(`owner_scope : "${ownerScope(owner)}" AND {title text} : (${terms.map(term => '"' + term.replaceAll('"', '""') + '"').join(' AND ')})`); }
    if (query.types.length) { conditions.push(`d.type IN (${query.types.map(() => '?').join(',')})`); bindings.push(...query.types); }
    if (query.from !== undefined) { conditions.push('d.created_at>=?'); bindings.push(query.from); }
    if (query.to !== undefined) { conditions.push('d.created_at<=?'); bindings.push(query.to); }
    for (const tag of query.tags.all) { conditions.push('EXISTS(SELECT 1 FROM search_tags t WHERE t.owner=d.owner AND t.id=d.id AND t.tag=?)'); bindings.push(tag); }
    if (query.tags.any.length) { conditions.push(`EXISTS(SELECT 1 FROM search_tags t WHERE t.owner=d.owner AND t.id=d.id AND t.tag IN (${query.tags.any.map(() => '?').join(',')}))`); bindings.push(...query.tags.any); }
    bindings.push(limit);
    const score = terms.length ? '-bm25(search_fts)' : '0';
    return this.rows(`SELECT d.owner,d.id,d.revision,${score} AS score FROM search_documents d ${terms.length ? 'JOIN search_fts ON search_fts.owner=d.owner AND search_fts.id=d.id' : ''} WHERE ${conditions.join(' AND ')} ORDER BY score DESC,d.created_at DESC,d.id LIMIT ?`, ...bindings);
  }
}

export function nodeSqlPort(db) {
  return {
    exec(statement, ...bindings) { const prepared = db.prepare(statement); if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement)) return prepared.all(...bindings); prepared.run(...bindings); return []; },
    transaction(operation) {
      db.exec('SAVEPOINT search_write');
      try { const result = operation(); db.exec('RELEASE search_write'); return result; }
      catch (error) { db.exec('ROLLBACK TO search_write'); db.exec('RELEASE search_write'); throw error; }
    },
  };
}
