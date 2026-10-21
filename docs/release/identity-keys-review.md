# Identity key registry review (BB-C0)

Independent security review, 2026-10-20, of slice C0 (IDKEYS-1): `packages/identity/keys.mjs` (new), the registry half of `packages/messaging/contact-tokens.mjs` (now a delegate plus re-export), `packages/runtime/account/identity.mjs` and `tests/identity-keys.test.mjs`. The review covered key custody, rotation and revocation races, and purpose confusion. Human reviewer: ___ Date: ___ Outcome: ___. This record is not a release approval. Production stays disabled.

## What was implemented (local behavior only)

- `IdentityKeyRegistry` (the provider resource) with ngin operations:
  - Actions `EnsureIdentityKey`, `RotateIdentityKey` (compare-and-set on `expectedKid`), `RevokeIdentityKey` and `RegisterIdentityKey` (legacy, public key only);
  - Queries `IdentityKeyByKid`, `CurrentIdentityKey` and `IdentityKeyHistory`;
  - exports `createIdentityKeyEngine`, `verifyKeyContinuity` and the `resolveIdentityKey` directory hook.
- Purposes are `signing` (record prefix `contact-key/`, kept for the existing consumers) and `encryption` (`identity-encryption-key/`). The `signing-key` and `encryption-key` pointers keep the sealed private keys exactly as before.
- States move only forward: active → retired → revoked. A retired key keeps `active: true`, so artifacts the provider stores stay verifiable. Only the current key is reported `active` to fresh-signature verifiers.
- Continuity: the old signing key signs the new signing key. The current signing key signs a new encryption key. The signature is under the domain `3sln-identity-key-continuity-v1`.
- History is bounded (16 per owner and purpose) and every record carries a sequence number. Rotation and revocation have no route and no `rpc` entry. They are internal controller methods.
- Recovery: verification compares the file against the current keys. A file made before a rotation or revocation is therefore rejected (rollback prevention), and no replacement keys are created.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium, confirmed | When encryption history was full, revoking the current encryption key left the account without one. `ensure` hit `key_history_full`, so recovery backups failed. | **Fixed.** Encryption history may now prune revoked public records (their private keys stay sealed in `identity-key-retained/`). Retired encryption keys are never pruned. Regression test added. |
| 2 | Medium, confirmed | `verifyKeyContinuity` accepted a revoked signer and did not bind `subject` or `at`. | **Fixed.** It now rejects revoked or non-verifiable signers and statements dated at or after `revokedAt`. It requires `subject` and `at`, and an optional expected `subject` must match. Tests added. |
| 3 | Medium/low, confirmed | A pruned revoked kid could be registered again, which brought its grants back to life. | **Fixed.** Pruned kids get a permanent tombstone in `identity-key-pruned/`. `register` refuses tombstoned kids and kids that exist under the other purpose. Test added. |
| 4 | Medium, suspected | Rotation stops minting for existing endpoints and links, because they re-sign with their grant's kid. Conversation authority pins the current public key. | **Accepted, gated.** Rotation stays internal, with no route. The header no longer claims full continuity for stored artifacts. Moving minting to the current key is follow-up work for C1 (core links) before any rotation route exists. |
| 5 | Low, confirmed | `ensure` relabelled externally registered keys as retired, with an invented successor. | **Fixed.** Registered keys carry `custody: 'external'`, are never current and are never relabelled. Orphan retirement no longer writes a successor. Test added. |
| 6 | Low, confirmed | A legacy pointer on a revoked record kept signing. A legacy pointer had no owner. | **Fixed.** `ensure` drops a pointer whose record is revoked (encryption material is retained) and creates a fresh key. `privateKey` never returns a revoked key. Legacy pointers get the `owner` written in. Test added. Stores shared by several owners stay unsupported for pointers, because account stores have a single owner. |
| 7 | Low, suspected | `conversationIdentity` (packages/conversations/runtime.mjs) re-reads the pointer and imports it as extractable, so a race can pair a kid with the wrong key. | **Open.** The file is outside this slice. It should take `publicJwk` from `CurrentIdentityKey` in the same read. Owner: conversations/BindleBox cutover. |
| 8 | Info | `resolveIdentityKey` needs `kid`, but `identitySigningKey` lacked it. Signing races revocation outside the transaction. Retired and revoked kids now return `active: false` instead of null. Old recovery files still hold keys that were later retired. | **Fixed** (the port now returns `kid`). **Accepted:** a race only produces an artifact that fails verification; every consumer checks `active === true`; and token or key revocation cannot recall copies already exfiltrated, as docs/spec/recovery-identity.md already states. |

## Evidence

- `npm test`: 1403 passed, 0 failed.
- `npm run test:worker`: 53 passed.
- `npm run check:worker`: the dry run built cleanly.
- `tests/identity-keys.test.mjs` has 13 tests covering:
  - rotation and continuity;
  - kid lookup after rotation;
  - revocation;
  - purpose separation;
  - custody;
  - the bounded history;
  - legacy backfill;
  - the directory hook;
  - 25 seeded chaos schedules;
  - recovery restore through the Node runtime;
  - the review regressions.
- Not verified: Worker Durable Object behavior of the new operations beyond the existing worker suite, cross-host directory resolution (not implemented), and any production custody.
