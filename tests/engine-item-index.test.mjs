// Engine-level incoming catalog: AccountItemIndex over in-memory SQLite driven
// by seeded upserts, moves and removals of plain and conversation messages.
// After every step the paged catalog must equal a model computed from the
// current messages: counts, unread state, activity order, no gaps or repeats.
// Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { AccountItemIndex } from '../packages/runtime/item-index.mjs';
import { forEachSeed } from './helpers/chaos.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1), OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = { origin: 'https://source.example', owner: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const conversationOf = n => `cccccccc-cccc-4ccc-8ccc-00000000000${n}`;

async function allPages(index, limit, query = {}) {
  const items = []; let cursor;
  for (let guard = 0; guard < 100; guard++) {
    const page = await index.incomingPage(OWNER, { ...query, limit, ...cursor ? { cursor } : {} });
    items.push(...page.items); cursor = page.cursor; if (!cursor) return items;
  }
  assert.fail('pagination did not terminate');
}

test('incoming catalog matches a model of its members after every seeded mutation', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  await forEachSeed(4, async random => {
    const metadata = new SqliteMetadata(':memory:'), index = new AccountItemIndex(metadata.sql), model = new Map();
    try {
      for (let step = 0; step < 90; step++) {
        const id = `m${String(random.int(16)).padStart(2, '0')}`;
        if (model.has(id) && random.chance(0.25)) { index.remove(id); model.delete(id); }
        else {
          const conversation = random.chance(0.5) ? conversationOf(random.int(3)) : null;
          const message = { id, owner: OWNER, receivedAt: 1000 + random.int(20), readAt: random.chance(0.5) ? null : 5000, collection: 'inbox', tags: random.shuffle(['a', 'b', 'c']).slice(0, random.int(3)), classification: 'unclassified', mimeType: 'text/plain', size: 1,
            ...conversation ? { conversation: { id: conversation, source: SOURCE, eventId: id } } : {} };
          index.upsert(message); model.set(id, message);
          // An identical re-upsert (at-least-once projection) must be a no-op.
          if (random.chance(0.2)) index.upsert(structuredClone(message));
        }
        // Expected items: one per plain message, one per conversation with any member.
        const groups = new Map();
        for (const m of model.values()) { const key = m.conversation ? m.conversation.id : m.id; groups.set(key, [...groups.get(key) ?? [], m]); }
        const items = await allPages(index, 2 + random.int(5));
        assert.equal(items.length, groups.size, `step ${step}: ${items.length} items for ${groups.size} groups`);
        assert.equal(new Set(items.map(i => i.id)).size, items.length, 'no item repeats across pages');
        for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].activityAt > items[i].activityAt || items[i - 1].activityAt === items[i].activityAt && items[i - 1].id > items[i].id, 'activity order with id tie-break');
        for (const item of items) {
          const members = item.type === 'conversation' ? groups.get(item.messageId && model.get(item.messageId)?.conversation?.id) : groups.get(item.id);
          assert.ok(members, `catalog item ${item.id} has no members`);
          assert.equal(item.activityAt, Math.max(...members.map(m => m.receivedAt)));
          assert.equal(item.receivedAt, Math.min(...members.map(m => m.receivedAt)));
          if (item.type === 'conversation') assert.equal(item.eventCount, members.length);
          assert.equal(item.readAt === null, members.some(m => m.readAt === null), `unread state of ${item.id}`);
        }
        // Tag filters over plain messages agree with the model.
        const tagged = await allPages(index, 50, { filter: { version: 1, types: ['message'], tagsAll: ['a'] } });
        assert.deepEqual(tagged.map(i => i.id).sort(), [...model.values()].filter(m => !m.conversation && m.tags.includes('a')).map(m => m.id).sort());
      }
    } finally { metadata.close(); }
  }, { base: BASE });
});

test('a cursor from before a mutation is refused rather than skipping or repeating items', async () => {
  const metadata = new SqliteMetadata(':memory:'), index = new AccountItemIndex(metadata.sql);
  try {
    for (let i = 0; i < 6; i++) index.upsert({ id: `m${i}`, owner: OWNER, receivedAt: 1000 + i, readAt: null, collection: 'inbox', tags: [], classification: 'unclassified', mimeType: 'text/plain', size: 1 });
    const first = await index.incomingPage(OWNER, { limit: 2 });
    index.upsert({ id: 'late', owner: OWNER, receivedAt: 999, readAt: null, collection: 'inbox', tags: [], classification: 'unclassified', mimeType: 'text/plain', size: 1 });
    await assert.rejects(index.incomingPage(OWNER, { limit: 2, cursor: first.cursor }), { code: 'cursor_stale' });
    // A forged or cross-view cursor is refused too.
    const fresh = await index.incomingPage(OWNER, { limit: 2 });
    await assert.rejects(index.incomingPage(OWNER, { limit: 2, cursor: fresh.cursor, filter: { version: 1, read: false } }), { code: 'invalid_cursor' });
    await assert.rejects(index.incomingPage(OWNER, { limit: 2, cursor: (fresh.cursor[0] === 'e' ? 'f' : 'e') + fresh.cursor.slice(1) }), { code: 'invalid_cursor' });
  } finally { metadata.close(); }
});
