# Conversation authority, fanout and trust — design draft

Status: provisional design, 2026-10-12. This document defines the intended architecture; it is not evidence that cross-provider delivery or every protocol feature is implemented. See the [conversation specification](../spec/conversations.md), [security gates](../spec/security.md), and [decision ledger](../../DEVLOG.md). Human architecture/security sign-off: reviewer ___ / date ___ / outcome ___.

## Separate admission from participation

A contact capability answers “may this sender approach this recipient?” A conversation capability answers “may its holder contribute to this already admitted conversation?” These have separate lifetimes and quotas. Creating a group requires initial contact authority for each invited recipient. Once Jerry has admitted the conversation, Tom can reply through it without obtaining Jerry's personal contact token. Revoking the original contact link stops new introductions; it does not remove Jerry from an admitted conversation. Jerry can leave, mute, quarantine or block the conversation through owner controls independently.

The initial sender generates a fresh 256-bit conversation secret. Every admitted participant receives the same current secret through an authorized, private delivery. The secret is a bearer write capability, not an encryption key, an account login credential or evidence of the author's identity. A holder can give it to someone else. Product copy must make that transferability clear.

An opaque HTTPS conversation URI identifies the conversation and its canonical coordinator. It contains no secret. HTTP authorization headers carry capabilities; an initial protected admission envelope can carry the secret to the invited recipient. Public manifest entries, titles, notification previews, search documents, trace data and access logs contain no secret. Sharing or copying a conversation identifier alone conveys no authority.

## One ordering authority, federated recipients

Each conversation has exactly one canonical authority. It serializes policy revisions and message acceptance, assigns an increasing sequence, and publishes authenticated membership snapshots. Participant providers independently enforce local admission, quota and storage policy, and accept only authorized deliveries from that authority. Self-hosting changes the operator, not these semantics. A particular conversation does not have a shared global account directory or a global message hot path; implementations can partition coordinators by conversation ID.

This is a deliberate availability tradeoff. If the authority is unavailable, clients queue bounded local drafts and retry; a recipient does not invent a replacement authority, accept a conflicting branch or silently elect itself. Migration and authority failover require a separately authenticated continuity protocol and are outside this version. Compromise of the authority can forge its own policy history or fork views; signatures alone do not prove that an operator presented one history to everyone. Independent witnesses/consensus are outside the profile. Clients must detect conflicting signed revisions they actually observe and stop applying the affected history.

Membership changes use compare-and-swap against the expected revision. The signed snapshot binds the conversation URI, authority, revision, previous snapshot digest, epoch, policy and exact participant identities. Every accepted message binds that revision and an immutable recipient set. A message accepted before a membership change belongs to the old snapshot; it is never silently retargeted. A newly admitted participant receives future messages after activation; history sharing is a separate explicit permission and action.

## A symmetric key cannot establish unequal roles

If Alice and Bob both know key K, either can compute any MAC under K. A claim such as `{"member":"Alice","role":"admin"}` authenticated only with K is therefore forgeable by Bob. Per-member role labels embedded in the shared-secret token do not fix this.

The bearer profile grants every holder the same bounded contribution permissions. The identity profile additionally requires a proof made using the acting member's independent key, or a trusted locally authenticated account session at the authority. That proof binds the exact operation, conversation, epoch, revision, payload digest and replay bounds. The authority evaluates current member permissions; a caller-supplied member ID or display name is never a proof. The creator's administrative authority is anchored independently of the shared secret in both profiles.

Creator policy can permit all holders to contribute while reserving membership changes to the creator, or permit independently authenticated members to invite/remove according to their roles. Enforcing different `send`, `invite` or `remove` rights for individual participants requires the identity profile. A holder-only request must fail when an operation requires identity; it cannot be upgraded by filling in an `actor` field.

Removal must rotate the epoch secret and deliver the replacement only over independently authorized channels to retained members. Fetching the new secret with the old secret defeats removal. Tightening permissions can require the same rotation. The coordinator rejects old-epoch writes and stale replay attempts after the cutover. Retained members can still deliberately leak the replacement; shared secrets cannot prevent that collusion or erase previously received content. A removal cannot recall a message already accepted for delivery under an earlier snapshot.

## Complete fanout is a durable obligation

For a message accepted at revision r, let M(r) be the snapshot's active membership. Acceptance atomically records the immutable body reference, content digest, message ID, sequence, epoch/revision, idempotency receipt and one delivery obligation for every member of M(r), including the author when the author has a participant inbox. There is no caller-selectable `to` subset in a conversation send. A private side message is a different conversation.

Cross-provider delivery cannot be made one database transaction. Acceptance means the coordinator durably committed all obligations. It does not mean all inboxes accepted or that people read the message. Delivery workers use the stable `(conversation, message, recipient)` key for retries; recipient inboxes enforce deduplication. Exactly-once visible copies require durable recipient receipts, even when an acknowledgment is lost. No protocol can make an offline, unwilling or out-of-quota recipient accept bytes merely because a sender holds a key.

The coordinator exposes each obligation's state and an aggregate `queued`, `partial`, `delivered` or `failed` result. It may report `delivered` only after every snapshot recipient has durably acknowledged. Permanent rejections and exhausted retries remain visible; they cannot be dropped to manufacture successful fanout. Retry attempts, time, queue entries and byte reservations must have explicit bounds and backoff. Exhausted entries move to a bounded dead-letter state with owner-visible recovery. An indeterminate timeout is retried using the same ID, never as a new message.

Participant removal stops future snapshot inclusion and current-epoch access. Earlier accepted obligations retain their original recipient identities for an honest audit, but each recipient can reject or delete locally. A hard safety block can cancel pending local delivery; its cancellation must remain a visible final state instead of rewriting the old membership or pretending delivery occurred.

## Admission, privacy and economics

Initial contact permission must explicitly allow a conversation invitation and its MIME profile. A generic permission to receive a one-off text blob does not grant an unlimited group subscription. Admission is an explicit recipient action, or a previously configured recipient policy narrowly covering the sender, conversation class and budgets. It cannot be inferred from a GET, preview, profile lookup or the sender claiming consent. Private pending invitations must not disclose a recipient's collections, contact links or other groups.

The recipient chooses an owned collection and can apply ordinary quarantine, tags and notification rules. The conversation sender cannot select arbitrary recipient collections, override a quarantine decision, mark copies read, or turn data into executable automation. Per-recipient limits remain independent of the coordinator's message limits. A full inbox yields an honest delivery failure, not forced storage or unbounded retries.

At n members and payload size b, a straightforward recipient-copy model adds up to n × b stored payload bytes plus O(n) metadata, delivery attempts, notifications and search work for each message. A shared physical blob can reduce payload duplication but requires separate per-owner logical quota, authorization, retention and deletion records; it does not eliminate fanout work. Enforce member-count, payload, live conversation, per-conversation/day, sender/account/day and aggregate retained-byte/queue bounds before accepting work. Membership churn and repeated failed invitations also consume bounded work budgets. No unlimited group messaging claim follows from an annual storage subscription.

## Human conversations and document transport

A thread is a sequence of immutable messages, with optional reply references to messages in that conversation. Text, sanitized HTML and the existing bounded web-archive format remain documents. Subject, display names, summary and sender annotations are untrusted presentation data. Stable participant URIs and verified proof status distinguish identities; a verified signature means control of the registered key, not truth of its claims.

Search indexes authorized document text and selected safe thread metadata. It must exclude shared secrets, admission capabilities, authorization headers, private key material, raw signed invitations and control envelopes. Search results still reauthorize against the current owner copy. Notifications carry safe summaries and conversation/message identifiers; they never carry a reusable conversation credential. Read receipts, typing, edits, reactions and richer media need separate bounded schemas and consent, not undocumented fields in this version.

## Verification before broader claims

| Boundary | Evidence required |
| --- | --- |
| Authority | Concurrent revision conflicts; immutable recipient snapshots; forged roles/actors; old epochs; creator/member removal policy; observed forks. |
| Durable fanout | Crash at each acceptance/delivery boundary; lost acknowledgment; duplicate sends; one unavailable recipient; quota rejection; retry/dead-letter limits; restart recovery. |
| Admission | Initial token required for each new member; no contact token needed for admitted replies; revoked introduction does not revoke admitted conversation; nonconsensual subscription denied. |
| Independent providers | Two separately implemented providers exchanging signed policies, invitations, contributions and receipts; exact schema/algorithm compatibility; explicit partial failures. |
| Network | HTTPS origin binding; no redirect or private-address access; DNS rebinding; bounded bodies/time; hostile manifest/key documents; malicious participant URI. |
| Browser and privacy | Text-safe names; inert MIME rendering; no secret in URL/history/log/search/notification/cache; actual owner collection controls; accessible pending/partial/failed states. |
| Economics | Measured fanout, membership churn, denied traffic and storage/search cleanup cost; bounded queues; operational retention and retry policy. |

Passing a local implementation's tests establishes those tested local behaviors. Configured provider keys, a schema document and a populated discovery flag do not establish any of these external or operational properties. Production remains disabled until the existing security gates and conversation-specific reviews are signed.
