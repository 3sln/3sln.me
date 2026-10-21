# BindleBox conversations review (BB-B4)

Date: 2026-10-20.

**Scope.**
- Engine domain: `packages/bindlebox-engine/domains/conversations.mjs` (new).
- Tests: `tests/bindlebox/{conversations-fixtures,conversations,conversations-security}.test.mjs`, run on the seeded network simulator with a 3–5 party mesh across three hosts, one of them a shared hub.

Design sources:
- [spec](../spec/bindlebox.md) §5–§8 and §11;
- [architecture](../architecture/messaging-app.md) §4.3, §7, §9 and §16;
- [design review](messaging-app-review.md) blockers P-1 (one-way conversations), P-2 (groups never form) and P-3 (an app switch looks like a forger).

The conversation model is option A, provisional pending user confirmation (architecture §19 question 4): a shared secret gate, independently signed author events, each owner's accepted-peer set, no sequencer, and direct mesh delivery.

**Method.** One independent security-reviewer subagent reviewed the code read-only, using executable probes against the simulator. The implementer fixed the confirmed findings and added a regression test for each fix.

**This is agent review, not human sign-off.** Human sign-off: reviewer ___ / date ___ / outcome ___.

Nothing here is mounted, flag-enabled, production-verified or interop-verified:
- The operations are not in `MAILBOX_OPERATIONS`.
- No route exists.
- `BINDLEBOX_ENABLED` stays off.

## What was implemented

- **Create and invite (§6.1).**
  - One creator-signed genesis.
  - Per invitee: a `creatorBinding`, a return-control route and a single-use nonce.
  - The `conversation-init` travels on the invitee's contact link through BB-B3's queue and BB-B2's link admission.
- **Accept, both directions (P-1).** The invitee signs a response, so both sides can send. The creator joins the invitee's audience only after the response is confirmed.
- **Groups (P-2).**
  - The creator relays each accepted participant's own signed response as a `peer-proposal` introduction.
  - Participants exchange direct `peer-hello`s, auto-accepted only under `acceptListed` for genesis participants.
  - Everything else becomes an owner offer (`conversations.decide`).
- **Send.**
  - The stream head and event ID are persisted before signing.
  - Each event is signed once per recipient (the event ID is stable across recipients) with a frozen audience, then submitted to BB-B3.
  - A `withConversations` authorization hook cancels obligations to removed, blocked or re-incarnated peers.
- **Receive.**
  - An edge pair-gate index refuses bad credentials before a mailbox wakes.
  - The mailbox then rechecks the gate from its own secrets and verifies the author, with a status check where §3.4 requires one.
  - Replay, frontier, effects and the receipt commit in one transaction.
  - Conversation records have their own receive allowance, separate from BB-B2's link budgets.
- **Membership.** Remove, readmit (with a fresh incarnation), leave, blocks, and the group bound on every acceptance path, using the lower of the room's bound and the live setting.
- **Edits and retractions.**
  - Every revision is kept.
  - Mutations that arrive before their target wait, bounded.
  - A retraction is never undone by a later edit.
  - Only the author can mutate a message.
- **Rotation.** Rotation is a proposal: the proposer selects it, and every other owner chooses explicitly. Conflicting proposals are flagged. Old epochs stay accepted for 7 days. Peers that have not accepted the new epoch get `retry_scheduled(epoch)`.
- **App switch (P-3).**
  - A new key opens a new stream that links to the old head.
  - `rejoin` goes out with a fresh incarnation to each peer.
  - Peers answer with `secret-share` and a hello.
  - A shared secret is accepted only if it matches the digest the rejoining mailbox recorded.
- **Honest status.** `conversations.status` reports outbox states over the frozen audience, plus "joined after this message".
- **IDKEYS-1 finding 7 is not repeated.** Each operation reads one delegate-key snapshot. An allocation signed under another key is abandoned rather than re-signed.

## Findings

The reviewer reported no critical or high findings. Every finding below was confirmed by an executable probe. Each fix has a regression test in `conversations-security.test.mjs`.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| BB4-S1 | medium | A spoofed `conversation-init` reusing a conversation ID could be declined, which overwrote the owner's real invitation response and sent it to the attacker's return control. | **Fixed.** Any answer to an invitation whose conversation already has a room or a response is refused with `conversation_conflict`, before and inside the commit. |
| BB4-S2 | medium | Rotation and share secrets, and the init envelopes that embed the secret, stayed in `conv/op/*` rows after submission and outlived the secret sweep. | **Fixed in this module.** Once the outbox holds a delivery, its op row drops the secret parts and init envelopes. The decided invitation item drops `sharedSecret`. **Open (BB-B3):** outbox task rows keep `task.secret` and init envelopes after the task finishes. |
| BB4-S3 | low-medium | Removed or declined members could re-prompt the owner indefinitely with `peer-hello`. | **Fixed.** Removal, decline and departure are sticky. Hello is admitted only from accepted peers and from genesis participants not in those states; their `keyId` must match the genesis. |
| BB4-S4 | low-medium | Proposals about invented principals filled the 64 peer rows and the 16 offer slots. | **Fixed.** A proposal creates no row without the proposed principal's own verified introduction. |
| BB4-S5 | low | A contacts-blocked principal was auto-accepted through a relayed introduction. | **Fixed.** `admit` and both auto-accept paths check the block. |
| BB4-S6 | low | Only the first retraction was recorded, so a later-quarantined forged retraction hid the author's genuine one. | **Fixed.** Every retraction is kept. A message is deleted if any non-quarantined retraction exists. |
| BB4-S7 | low | A parentless message could be ground to sort before the genesis. | **Fixed.** Content events with no known parent are ordered after the genesis. Concurrent order otherwise remains an event-ID tie-break, which is inherent to having no sequencer. |
| BB4-S8 | low | Control records were uncharged, and per-conversation caps could be exhausted by one member. | **Fixed.** Every admitted record is charged against the conversation allowance. Per-author caps: 16 pending mutations, one pending rotation per proposer, 8 streams, 16 stored proposal responses. |
| BB4-S9 | low | While awaiting a secret, the mailbox answered 503 before verifying anything, which revealed accepted-peer membership. | **Fixed.** The 503 is returned only after the author's signature verifies. |

Informational items (spec reconciliation):
- **Proposal auto-accept.** §6.3 says a peer-proposal is "never auto-accepted". The code auto-accepts a *listed* genesis participant under `acceptListed` when a verified introduction arrives, which mirrors the hello rule of the same section. The spec owner should reconcile.
- **Per-recipient split views.** An author can send different events under one counter to different recipients, and no single receiver can detect it. This is inherent to option A.
- **Outside this module:**
  - A revoked key's records are accepted within the 5-minute status cache.
  - The §3.4 quarantine window (revocation hour − 1 h) also hides genuine records from that hour.

## Open items

- **BB4-I1 (BB-B3).** Retries carry the original certificate. Any obligation older than the 24 h certificate lifetime is refused by its receiver (`author_unverifiable`), so retries after a long outage, and catch-up, cannot deliver. The architecture (§9.2, §16) says the drain renews the certificate before sending, and spec §5.3 lets a retry carry a renewed certificate for the same key. The test asserts that catch-up requeues the obligation, but not that it is delivered.
- **BB4-I2 (BB-B3).** Outbox task rows should clear `secret` and conversation-init envelopes once a task is final (see BB4-S2).
- **BB4-I3 (spec, design owner).**
  - **Awaiting secret.** While a rejoining mailbox awaits its secret, accepted peers get a verified 503 (`recipient_unavailable`) rather than §6.6's `retry_scheduled(epoch)`. The sender outcome is the same: retry until the deadline.
  - **Rotation.** One event carries one epoch, so peers that have not accepted the sender's current epoch get `retry_scheduled(epoch)` until they choose.
  - **Adding members.** Adding a principal outside the genesis needs a new conversation. Proposals can only introduce genesis participants who have accepted.
- **BB4-I4 (integration).**
  - Operations are not registered in `MAILBOX_OPERATIONS`, and the `conversations` provider row is still `planned`.
  - The composition must supply `withConversations(...)` as the outbox `authorize`, mount `handleConversationIngress`, and flush `flushConversationEdge`.
  - Descriptor resolution of invitee ingress is the composition's job.


## Wave 3a integration reconciliation (provisional, 2026-10-20)

BB4-I1 now renews the same delegate key's certificate before an expired transport proof is retried, preserving the signed payload, event ID, signature and frozen audience. The simulator asserts delivery after a 73-hour outage. BB4-I2 clears protected secret parts, embedded invitation secrets and credentials on delivered/rejected/cancelled tasks; expired catch-up tasks retain retry material only to their last retry horizon, with a durable cleanup alarm. BB4-I4 is composed in both shells, the shared operation registry and the metadata index; a three-party composed-shell simulator covers send, receive, Views/tags, edit and removal.

BB4-I3 is reconciled in [spec §§6.1–6.6](../spec/bindlebox.md#61-genesis-and-bootstrap): verified awaiting-secret 503, one epoch per event, genesis-only membership and prior-opt-in proposal acceptance. Each change remains provisional. This integration records implementation and local tests; it does not provide independent security review, human approval or production verification.

Reviewer ___ / date ___ / outcome ___.
