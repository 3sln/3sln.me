// The engine CLI (scripts/engine.mjs) runs scripted dispatches against the same
// provider set as the engine tests, and reports unexpected outcomes by exit code.
import test from 'node:test';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = (args, input) => { const run = spawnSync(process.execPath, ['--no-warnings', 'scripts/engine.mjs', ...args], { input, encoding: 'utf8' }); return { status: run.status, lines: run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), stderr: run.stderr }; };
const script = steps => steps.map(step => JSON.stringify(step)).join('\n');

test('engine CLI: scripted dispatch with named results, expectations, facts and audit', () => {
  const { status, lines, stderr } = cli(['--seed', '3', '-'], script([
    { op: 'views.create', input: { name: 'Work', filter: { version: 1, tagsAll: ['work'] } }, as: 'work' },
    { op: 'views.update', id: { $: 'work.id' }, input: { name: 'Renamed', filter: { version: 1 }, expectedRevision: 1 }, expect: { revision: 2, name: 'Renamed' } },
    { op: 'views.update', id: { $: 'work.id' }, input: { name: 'Stale', filter: { version: 1 }, expectedRevision: 1 }, expectFault: 'view_conflict' },
    { op: 'views.list', owner: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expect: { views: [{ id: 'all', builtin: true }, { id: 'unread' }, { id: 'conversations' }] } },
    { events: true }, { audit: true },
  ]));
  assert.equal(status, 0, stderr + JSON.stringify(lines));
  assert.deepEqual(lines.map(line => line.ok ?? null), [true, true, false, true, null, null]);
  assert.deepEqual(lines[4].events.map(event => event.operation), ['views.create', 'views.update']);
  assert.deepEqual(lines[5].audit.map(entry => entry.outcome), ['ok', 'ok', 'error']);
  // The same seed replays the same generated IDs.
  assert.equal(cli(['--seed', '3', '-'], script([{ op: 'views.create', input: { name: 'Work', filter: { version: 1, tagsAll: ['work'] } } }])).lines[0].result.id, lines[0].result.id);
});

test('engine CLI: an unmet expectation or unknown operation exits 1; --db persists across runs; --list names everything', async t => {
  assert.equal(cli(['-'], script([{ op: 'rules.list', expect: { length: 1 } }])).status, 1);
  assert.equal(cli(['-'], script([{ op: 'views.nope' }])).status, 1);
  const directory = await mkdtemp(join(tmpdir(), 'bindle-engine-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, 'account.sqlite');
  assert.equal(cli(['--db', db, '-'], script([{ op: 'tags.set-label', input: { label: 'Clients' } }])).status, 0);
  assert.deepEqual(Object.values(cli(['--db', db, '-'], script([{ op: 'tags.labels' }])).lines[0].result.labels), ['Clients']);
  const bound = join(directory, 'bound.sqlite'), { DatabaseSync } = await import('node:sqlite'), handle = new DatabaseSync(bound);
  handle.exec(`CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records VALUES ('owner', '"x"')`); handle.close();
  assert.equal(cli(['--db', bound, '-'], script([{ op: 'views.list' }])).status, 2, 'a file bound to an account is refused');
  const listed = cli(['--list']).lines;
  assert.ok(listed.some(line => line.provider === 'accountStore' && line.status === 'pilot'));
  assert.deepEqual(listed.filter(line => line.operation).map(line => line.operation).sort(), Object.keys(ACCOUNT_OPERATIONS).sort());
});
