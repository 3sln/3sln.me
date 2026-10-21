# BindleBox archive and app switch review (BB-B6)

Date: 2026-10-21.

**Scope.**
- Engine domain: `packages/bindlebox-engine/domains/archive.mjs` (new).
- Writer: `packages/bindlebox-engine/store/archive-writer.mjs` (new).
- Registration: `ARCHIVE_OPERATIONS` appended to `packages/bindlebox-engine/operations.mjs`. The planned `archive` row in `providers.mjs` is now marked `local`.
- Tests: `tests/bindlebox/{archive-fixtures,archive,archive-security,app-switch}.test.mjs`, run on the BB-B4 conversation mesh (seeded network simulator), with simulated object-storage/v1 resources and a simulated key holder.

Design sources:
- [spec](../spec/bindlebox.md) §3.2, §6.6, §8.2 and §10;
- [architecture](../architecture/messaging-app.md) §8, §16 and §18 (scaling spike P0: retention and anti-resurrection);
- [design review](messaging-app-review.md) S-9, S-15, P-3, P-4 and P-15;
- DEVLOG 2026-10-13, "Conversation storage and contact handoff redesign" and "owner-bucket archives": cold data lives in the owner's bucket, encrypted to the recovery identity's encryption key, so backups and transfers include everything.

**Method.** One independent security-reviewer subagent reviewed the code read-only and reproduced findings with scratch probes against the simulator. The implementer fixed the confirmed findings and added a regression test for each fix in `archive-security.test.mjs`.

**This is agent review, not human sign-off.** Human sign-off: reviewer ___ / date ___ / outcome ___.

Nothing here is mounted, flag-enabled, production-verified or interop-verified:
- The provider refuses unless it is built with `BINDLEBOX_ENABLED === true`.
- No shell mounts it and no alarm schedules it.
- No real storage backend or key holder has been exercised.

## What was implemented

**Operations.** All are ngin Actions or Queries over a scoped `archive` provider.

| Operation | Purpose |
| --- | --- |
| `archive.checkpoint` | Writes a delta, or a snapshot when compaction is due. Owner or system actor. |
| `archive.compact` | Writes a full snapshot that replaces the segment list. |
| `archive.export` | Writes the handoff snapshot and returns the anchor `{generation, digest}`. |
| `archive.import` | Imports into the new occupant, from an anchor or an owner-confirmed `unanchored` restore. |
| `archive.reclaim` | Reclaims capacity in the hot send queue and in storage. |
| `archive.verify` | Verifies every object without importing anything. |
| `archive.status` | Owner status, including a statement that the archive is not end-to-end encrypted. |

**Archive contents.** An allowlist classification of mailbox rows by spec §10 type, with import phases control → peers → outbox → items.
- Secrets, pair tokens, return routes, pending-rotation secrets, B3 envelopes, credentials, owner link metas and app configuration are never exported.
- Sanitizers run on export and again on import.
- Other people's contact links are exported, encrypted, so the address book survives a switch.

**Sealing.** Each object is sealed to the owner's identity encryption key: an ephemeral P-256 ECDH key, an HKDF bound to kid, name, owner and epk, and a random AES-256-GCM content key, with the header as AAD.
- The writer needs only the public key.
- Opening uses the key holder's `unwrap`, which returns one object's content key. It answers only after a fresh proof of possession by the current occupant's archive-purpose delegate key.

**Manifest.** A compact JWS (`bindlebox-archive+jwt`) under the archive purpose, embedding the signing certificate.
- It is verified against the owner's identity key, the certificate's lifetime at `writtenAt`, and the key's revocation status.
- It advances by compare-and-swap through the object-storage/v1 `put` with `absent` and `version` conditions.

**Crash safety.**
- A journal reserves every object name before its put.
- On resume, a segment is reused only when its key range holds byte-identical lines.
- A manifest committed before a lost reply is adopted by its plan ID.
- The per-key shadow advances only after a commit.
- A lock lease is rechecked and extended in every journal, commit and import transaction.

**Writer lease.** A newer manifest signed by an active key from another writer fences this one. An older or revoked-key manifest is reported as `archive_rolled_back` without changing any state.

**App switch.**
1. The previous app exports a snapshot and hands over the anchor.
2. The new app verifies every object first.
3. It proves occupancy through `attest`.
4. It takes the lease by compare-and-swap on the exact version it verified.
5. It imports absent-only, so live rows win, in resumable batches.
6. It republishes imported links to the edge with higher generations.
7. It runs `conversations.rejoin` under its own key. The existing BB-B4 rejoin with a digest-bound secret-share returns the secrets.

**Retention and tombstones.**
- Deletions travel as delete records.
- Retraction rows live as long as their conversation, through every compaction.
- Imports are anchored by exact digest.
- Storage rollback is refused.

**Capacity reclamation.** This is the item BB-B3 left open.
- Archived, final send obligations past any manual catch-up become summaries: no envelope, body, credential or secret.
- They leave the queue's task and byte counters. `outbox.get` and `conversations.status` still report the true per-recipient states.
- Superseded objects are deleted after a 24-hour grace period. Abandoned objects are deleted at once.
- Objects awaiting deletion travel in the manifest's `retired` list, so the next occupant can finish the cleanup. Live objects are never deleted.
- A backend without conditional delete keeps objects. Status reports them as retained.

**Simulator coverage.** 17 tests:
- a full switch from A to B with history, contacts, links and blocks intact, a forger-free rejoin, honest status of events sent before the switch, A fenced and A's objects reclaimed;
- a retracted message and a removed contact are not resurrected through import, replay, compaction, a second switch or a rolled-back manifest;
- corrupted, swapped, truncated, forged and foreign archives are detected before anything is written;
- owner encryption-key and delegate-key rotation across generations;
- a large history (200+ messages, 20+ segments, a 200 KB message stored as blob parts);
- interrupted export, checkpoint and import all resume;
- custody and occupancy refusals;
- one regression test per review finding.

## Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| BB6-S1 | high | `derive` returned the raw ECDH secret for any supplied point. The identity encryption key is general-purpose, so whoever could call `derive` could decrypt anything else encrypted to it. | **Fixed.** The port is now `unwrap(header)`. The key holder runs the archive HKDF, bound to the object name, owner, kid and epk, and returns only that object's content key (`localUnwrap`). There is no raw ECDH oracle. Test: BB6-S1/S2. A dedicated archive key, separate from the identity key, is recommended to the core key owner. |
| BB6-S2 | high | `derive` was authorized by the certificate, which is public: it sits in the manifest and in every envelope. | **Fixed.** Every `unwrap` and `attest` call carries a fresh (±60 s) signature by the delegate key over the object name, kid and time (`unwrapProof`, `verifyUnwrapProof`). Stale, foreign and cross-object proofs fail. The real key holder must also authenticate the app connection; this is stated in the port contract. |
| BB6-S3 | high | A revoked previous key could backdate `writtenAt`, and an anchor accepted any higher generation. Reproduced: a resurrected retraction. | **Fixed.** An anchored import accepts only the exact anchor digest (`archive_stale` otherwise). The checkpoint path treats a revoked-key manifest as a rollback, never as a fence or an adoption. Test: BB6-S3/S4/S5. |
| BB6-S4 | high | An import without an anchor accepted a rolled-back genuine manifest and resurrected deleted rows. | **Fixed.** `archive.import` requires `expect`, or the owner's explicit `unanchored: true` (otherwise `archive_anchor_required`). The result and status record `anchored`. **Residual:** an owner-confirmed unanchored restore trusts storage freshness; the UI must show generation and time. |
| BB6-S5 | medium | Replaying an old manifest fenced the real writer permanently, and a same-writer older manifest was silently adopted. | **Fixed.** A writer is fenced only by a newer manifest from an active key of another writer. Older manifests, and any manifest from a revoked key, raise `archive_rolled_back` (or `archive_untrusted` inside the quarantine hour) without persisting anything. A lower generation is never adopted. |
| BB6-S6 | medium | The plaintext manifest leaked mailbox keys (conversation IDs, principals, emails) through segment `first`/`last`. | **Fixed.** Key ranges stay in the sealed objects and the writer's local journal. The manifest holds names, digests, sizes, counts, kinds and key IDs. **Documented:** object counts, sizes, timing, the retired list and the certificate's client, connection and ingress remain visible to the storage provider. |
| BB6-S7 | medium | The S-9 restore boundary is not wired. A fresh occupant can admit traffic before control state is imported, and absent-only import then keeps the live row. | **Open (integration).** `archiveRestore(store)` exposes `{importing, controlRestored, checkpointAt}`. `receive.mjs`, `conversations.mjs` and the shell (not owned by BB-B6) must refuse with `recipient_storage_unavailable` until control state is restored, and apply `admissibleAfterRestore`. The messaging-app review marks S-9 and P-15 as fixed by design only; that needs reconciling in DEVLOG. **Gate before enabling.** |
| BB6-S8 | medium | Import trusts row contents from any valid signer: allow rules, peer ingress, items whose authorship is not re-verified, and the resend list. | **Partly mitigated, open.** Only an exactly anchored or owner-confirmed archive is imported. Every class is re-sanitized and allowlisted; config, owner, shell and secret rows are refused. Resends are only listed for the owner, never sent automatically. Still pending: envelope re-verification where present (spec §10), per-class shape validation, and an "imported, unverified" marker. |
| BB6-S9 | low | Capability fragments (`returnControl` route and nonce, `creatorBinding`) survived the sanitizers. | **Fixed** for invitation items: secret, return control and creator binding are removed, and `needsReinvite` is set. **Accepted:** `conv/intro` keeps the signed response it relays (its echoed nonce is already used), and `parent/` keeps the unsigned claims. |
| BB6-S10 | low | Takeover was not checked against occupancy. A zero-segment manifest needs no unwrap. | **Fixed.** `attest` proves occupancy before the takeover put (`archive_not_occupant`). |
| BB6-S11 | low | The 10-minute lock had no renewal, so a stale holder could retire objects from a stale journal. | **Fixed.** A fencing token is rechecked and extended in every journal, commit and import transaction (`archive_busy`). The rest of the journal, adoption and shadow logic held up under review. |

## Deviations from spec §10 (provisional; reconcile in DEVLOG)

1. **The encryption profile is implemented.** The archive is sealed to the owner's identity encryption key. Conversation secrets, owner link metas and delegate keys are still excluded; secrets return through `rejoin` and links through `links.list`. Other people's contact links are now exported. **This is not end-to-end encryption:** the provider holds the private key today.
2. **Manifest payload additions:** `profile`, `owner`, `base`, `previous`, `writer.jkt`, `writtenAt`, `handoff`, `plan`, `takeover`, `retired` and `delegation` (the certificate). Segment entries are `{name, sha256, bytes, count, kind, keyId}`. `firstAt` and `lastAt` are dropped as metadata.
3. **Record format.** Records are `{t, k, v}` / `{t, k, d:1}`: the spec type plus the reference implementation's row key and value. There are additional types: `conversation`, `revocation`, `evidence`, `counter`, `contact` and `gc`. Field schemas usable across implementations are pending.
4. **Bodies are stored inline.** Lines larger than a segment become sealed blob parts under random names. `bodies/<sha256>` would reveal plaintext equality to the storage provider.
5. **Outbox obligations are not re-signed.** Unresolved obligations of the previous occupant are imported as `expired/moved` summaries plus an owner resend list. Automatic re-signing with `resendOf` needs a BB-B4 hook.
6. **A handoff anchor is required.** Without one, the import needs the owner's explicit confirmation.

## Integration items (not owned by BB-B6)

- Shell mount behind `BINDLEBOX_ENABLED`, with alarm scheduling: checkpoint every 15 min or 256 changes, then reclaim.
- The real `ownerKeys` port in core identity keys: `current`, `unwrap` and `attest`, connection-authenticated, logged per object. Consider a dedicated archive key.
- An object-storage/v1 `userStorage.call` client in the composition.
- `links.list` to restore owner link metas.
- The S-9 admission gate (BB6-S7).
- BB-B2 stages large bodies under `bindlebox/v1/items/…` **in plaintext**. They must be sealed or folded into the archive before enablement.
- `conversations.status` labels for unsent operations imported from the previous app (currently shown as cancelled).

## Accepted limitations (must be disclosed)

- **Encryption:** not end-to-end; the provider holds the key. Old encryption keys must be retained indefinitely, and rotation re-seals data only at the next compaction.
- **What the storage provider sees and controls:** object names, sizes, counts and timing are visible to it, and it can withhold or delete objects (an availability risk). Backends without conditional delete keep superseded ciphertext.
- **Trust in imported history:** imported history is vouched for only by the previous occupant, and envelopes whose secret was redacted can no longer be verified.
- **Fencing:** writer fencing relies on app code. A malicious old app is stopped only when its storage access is revoked, which happens when the occupant is replaced.

## Wave 4 integration follow-up (2026-10-21, provisional)

The shell now composes the archive domain over ordinary object-storage and key-holder service
ports, with fixed 15-minute checkpoint alarms, durable retry and reclamation. Worker and Node
mount the B9 owner interface. Production still requires the durable authenticated key holder;
the explicitly selected Node helper is disposable and local. No production service was
configured or verified, and no reviewer approval is asserted.

- **BB6-S7 implemented locally:** imports establish a durable hold under the archive writer
  lock before archive reads. Link, conversation, return-control and public-intake admission
  check it again at commit. It clears after control rows commit; restored checkpoint/replay
  fences refuse old unknown envelopes. Existing-writer conflicts do not strand a hold.
- **BB6-S8 envelope gate implemented locally:** preserved envelopes and genesis proofs are
  reverified at historical signing time before applying rows. Their projected author, causal
  fields, content descriptors and row identities must match signed values. Body bytes must
  match the authenticated descriptor; a genuine outer archive signature cannot make an altered
  inner body valid. Capability-redacted and legacy rows retain `imported.verified:false`.
  Remaining unsigned control-field schema portability and the previous occupant's trust
  boundary are unchanged; this gate does not claim to validate all archived overlay values.
- **BB-B2 staged storage:** only independently authenticated AES-GCM chunks enter user storage.
  Random body keys stay in mailbox metadata and the encrypted archive. Owner Rejected reads
  verify ciphertext and the signed body digest, and render bounded plain text.

`tests/bindlebox/wave4-integration.test.mjs` adds regressions for admission during reads and
asynchronous provenance verification, stale replay fences, forged envelope signatures,
altered body bytes, forged projected genesis authors, pre-existing-writer conflicts, chunk
secrecy/tampering, actual shell mounting, verified contacts, bounded timeline/revision transfer,
Rejected content and durable checkpoint scheduling. Existing archive/security/app-switch tests
continue to exercise signed ciphertext, takeover and crash recovery.

Independent agent cross-review identified the altered-body, projected-genesis, revision-history,
stranded-hold and public-intake race gaps; the integration fixes and focused regressions cover
them. Human sign-off remains reviewer ___ / date ___ / outcome ___. DEVLOG.md was not edited.
