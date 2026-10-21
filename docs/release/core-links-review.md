# Core links review (BB-C1a)

Independent security review, 2026-10-20, of slice BB-C1a: the new `packages/links/` package, the issuance half of `packages/messaging/contact-endpoints.mjs`, the re-export shims (`messaging/{bindle-links,link-replay}.mjs`, `runtime/{contact-links,contact-preview}.mjs`, `beaming/profile.mjs`), `runtime/developer-contact.mjs`, `identity/link-response.mjs`, the new `runtime/{account,routes}/links.mjs` and `tests/core-links{,-http}.test.mjs`. It covered key-rotation verification, replay, parser differentials after the move, and app-actor issuance authorization. Human reviewer: ___ Date: ___ Outcome: ___. This record is not a release approval. Production stays disabled, and everything new stays behind `BINDLEBOX_ENABLED` (default off).

## What was implemented (local behavior only)

- **Move with re-exports.** The envelope parser, JWS profile and replay digest moved to `links/envelope.mjs`, and the replay record to `links/replay.mjs`. Audience decisions, inspection, response signing and state sweeps moved to `links/audience.mjs`. Previews went to `links/preview.mjs`, the contact profile to `links/profile.mjs`, and the operator policy registry to `links/policies.mjs`. Every old path re-exports the identical bindings, which a test asserts.
- **New signer.** `signLinkJWS` signs the link positions only. It produces the same canonical bytes as the old contact-token signer.
- **Current-key minting.**
  - `ContactEndpointService.createLink` and `rotateChallenge` sign with the owner's current registry key, and re-check that the key is still current inside the commit.
  - A caller-named kid is used only when no registry-held key exists, and only while that kid is active.
  - Verification still accepts retired keys through the registry history. Revoked and pruned keys verify nothing.
- **Links contract (`links/issuance.mjs`, `links/engine.mjs`).**
  - `LinkService` provides issue, revoke, rotate, evaluate, list, changes and verify for the app link types in `links/types.mjs`. The only type is the BindleBox contact type, bound to the messaging-ingress slot.
  - App Actions/Queries run over a scoped `links` provider (catalogue row added). Owner actors may list, see changes and revoke. App actors may act only on slots they occupy now, per the `LINK_SLOT_OCCUPANT` port. Without that port, nothing is authorized.
  - The account slice exposes owner `listLinks`, `linkChanges` and `revokeLink`. `linkOperation` is internal, with no `rpc` entry.
  - Owner routes `GET /api/links`, `GET /api/links/changes` and `POST /api/links/:jti/revoke` exist only with the flag on.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium, confirmed (not reachable until C1b) | `links.evaluate` trusts the principal the app supplies. An occupant could use a developer-policy link as an oracle for other users' paid tiers, trigger cross-account tier refreshes, and write unbounded decision rows. | **Partly fixed.** Evaluations are budgeted at 60 per link and 600 per owner per hour; past the budget the answer is `unavailable`. Results carry `state` only. **Open for C1b:** the adapter must pass a host-verifiable author proof (the delegated envelope signature) instead of a bare principal before the contract is mounted. |
| 2 | Medium, confirmed | Revoked links counted toward the 1000-link cap until expiry plus 30 days, so an occupant could lock out the owner and any successor for about 13 months. | **Fixed.** Revocation stops counting immediately. Revoked records are reclaimed 30 days after revocation. Reclaim commits even when the cap still refuses. Regression test added. |
| 3 | Low, confirmed | A key rotation between `createGrant` and the endpoint commit left an active grant with no endpoint, which counted toward `grant_limit`. | **Fixed.** The grant is deleted when the commit refuses. Regression test races a rotation inside the signer. |
| 4 | Info | Once `linkOperation` gets an `rpc` entry it needs `gate:'none'`: an owner-principal evaluation calls `controller.gated()`. | **Open (C1b).** |
| 5 | Info | The app actor's `handle` is only checked against the format regex. | **Open (C1b):** the adapter must take the handle from the owner's identity, never from the app. |
| 6 | Info | A new occupant can list, rotate, evaluate and revoke links the previous occupant issued (the bindlebox §4.2 handoff design). | **Accepted, provisional.** To be recorded as a decision in DEVLOG. |
| 7 | Info, pre-existing | A non-canonical final base64url character in a signature still verifies. | **Accepted.** Verification and replay are keyed on the signing input. Never deduplicate on URL strings. |
| 8 | Low | `LinkService.rotateChallenge` skipped the store owner-binding check. | **Fixed.** |

The reviewer found no issue in these areas:
- retired-key verification, and revoked or pruned keys being refused;
- commit-time key checks in all four minting paths;
- re-export identity, and type confusion between the legacy and app link types;
- `jti` namespaces;
- the handling of `aud`, userinfo, fragments and `bindle_data`;
- claim override (`exactMembers`);
- the policy registry;
- flag gating, and whether `invoke` or `dispatch` can reach the new operations;
- audit inputs;
- bounds on list, changes and reclaim.

## Known limits

Legacy bearers (inbox `mint` and contact-delivery `mintDelivery`) still sign with their parent's stored kid. After a rotation they fail closed until the challenge is rotated (for conditional links) or the parent is reissued. Both are deleted at cutover. Identity key rotation is still internal (no route). Minting no longer blocks exposing it, but that route belongs to the identity route owner.

## Evidence

- `tests/core-links.test.mjs`, 11 tests:
  - re-export identity;
  - seeded signer round trips and mutations;
  - the replay record;
  - contact links across a rotation and a revocation;
  - external-key fixtures;
  - contract authorization, exact claims and occupant replacement;
  - the contract across a rotation;
  - scoping, idempotence and bounded changes;
  - the cap and owner binding;
  - seeded interleavings of issue, revoke and rotation;
  - regressions for findings 1–3.
- `tests/core-links-http.test.mjs`, 2 tests on the real Node adapter:
  - with the flag off, the routes are unmounted and `linkOperation` refuses;
  - with the flag on, an occupant issues, the owner lists, sees changes and revokes, and contact links survive a rotation.
- Existing link suites are unchanged and pass: `bindle-links`, `link-replay`, `link-response`, `contact-preview`, `links-http`, `developer-contact`, `contact-endpoints*`, `engine-links` (including the seeded parser fuzz).
