import { fail, digest, boundedString } from './store.mjs';

// Bounded single-use record for audience responses (links §7.2). Storage is
// the injected runtime metadata port (Durable Object storage or Node
// SqliteMetadata): transaction(tx => tx.get/put/delete/list({prefix,limit})).
// Callers insert only after §8 steps 1–7 succeed and apply per-IP and
// per-principal rate limits first. At a cap the record refuses rather than
// evicting an unexpired row, because eviction would re-enable replay.
const MAX_ROW_MS = 420000, pad = time => String(time).padStart(16, '0');
export class LinkReplayRecord {
  constructor({ metadata, clock = () => Date.now(), crypto = globalThis.crypto, principalCap = 3, parentCap = 4200, evaluationRate = 10, purgeBatch = 64 }) {
    const positive = value => Number.isSafeInteger(value) && value > 0;
    if (typeof metadata?.transaction !== 'function' || ![principalCap, parentCap, evaluationRate, purgeBatch].every(positive) || parentCap < evaluationRate * MAX_ROW_MS / 1000 || principalCap > 256) fail('invalid_replay_limits');
    Object.assign(this, { metadata, clock, crypto, principalCap, parentCap, purgeBatch });
  }
  // Removes up to `limit` expired rows, oldest first (expiry-ordered keys).
  async #purge(tx, base, now, limit) {
    let removed = 0;
    for (const [path, row] of await tx.list({ prefix: `${base}e/`, limit })) {
      if (!(row?.expiresAt <= now)) break;
      await tx.delete([path, `${base}h/${row.hash}`, `${base}p/${row.principal}/${pad(row.expiresAt)}/${row.hash}`]); removed++;
    }
    if (removed) await tx.put(`${base}count`, Math.max(0, ((await tx.get(`${base}count`)) ?? 0) - removed));
    return removed;
  }
  async consume({ parent, iss, sub, key: hash, expiresAt }) {
    // parent must be the meta jti (bound inside H); ASCII-bounded to stay within storage key limits.
    if (typeof parent !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(parent) || !boundedString(iss, 2048) || !boundedString(sub) || typeof hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(hash) || !Number.isSafeInteger(expiresAt)) fail('invalid_replay_record');
    const now = this.clock();
    // Rows never outlive exp + 60 <= insertion + 420 s; never shorten a row (that would reopen replay).
    if (expiresAt <= now || expiresAt > now + MAX_ROW_MS) fail('audience_stale');
    const principal = await digest(this.crypto, `link-replay-principal\0${iss}\0${sub}`), base = `link-replay/${encodeURIComponent(parent)}/`;
    // Faults are returned, not thrown, so lazy purging commits even when admission is refused.
    const outcome = await this.metadata.transaction(async tx => {
      await this.#purge(tx, base, now, this.purgeBatch);
      if (await tx.get(`${base}h/${hash}`) !== undefined) return 'audience_stale';
      // Principal rows are expiry-ordered; listing after `now` counts live rows only.
      const live = await tx.list({ prefix: `${base}p/${principal}/`, startAfter: `${base}p/${principal}/${pad(now)}/\uffff`, limit: this.principalCap });
      if (live.size >= this.principalCap) return 'audience_unavailable';
      const count = (await tx.get(`${base}count`)) ?? 0;
      if (count >= this.parentCap) return 'audience_unavailable';
      const row = { hash, principal, expiresAt };
      await tx.put(`${base}h/${hash}`, row); await tx.put(`${base}p/${principal}/${pad(expiresAt)}/${hash}`, row);
      await tx.put(`${base}e/${pad(expiresAt)}/${hash}`, row); await tx.put(`${base}count`, count + 1);
      return null;
    });
    if (outcome) fail(outcome);
    return { consumed: true, expiresAt };
  }
  // Optional alarm hook: bounded purge for one parent.
  async purge(parent, limit = this.purgeBatch) {
    if (typeof parent !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(parent) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_replay_record');
    return this.metadata.transaction(tx => this.#purge(tx, `link-replay/${encodeURIComponent(parent)}/`, this.clock(), limit));
  }
}
