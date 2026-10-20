# BindleBox: peer-to-peer messaging as a Bindle app

Status: **provisional design**, 2026-10-20. Sources:

- the user direction in DEVLOG ("Scope reduction: messaging leaves core", 2026-10-20) and NOTES.md;
- the slot mechanism in [extensions](../spec/extensions.md) (revision 2);
- core [activity](../spec/activity.md) and the [activity center](activity-center.md);
- the [messaging scaling spike](../release/messaging-scaling-spike.md).

Nothing here is implemented, and no production gate in [security](../spec/security.md) changes. The interop draft is [BindleBox interop v1](../spec/bindlebox.md), the extraction plan is [messaging extraction](messaging-extraction.md), and the wargame record is [messaging app review](../release/messaging-app-review.md).

Sign-off (all unsigned, so every decision is provisional):

| Decision | Reviewer | Date | Outcome |
| --- | --- | --- | --- |
| Name (§1) | ___ | ___ | ___ |
| Signing model: identity-bound delegate keys (§4) | ___ | ___ | ___ |
| Core/app boundary for links (§6) | ___ | ___ | ___ |
| Send queue, status model and retry profile (§9) | ___ | ___ | ___ |
| Email bridge handoff and auto-reply variants (§13) | ___ | ___ | ___ |
| Data reset instead of migration ([extraction](messaging-extraction.md) §4) | ___ | ___ | ___ |
| Spike decisions D1–D4 as answered in §18 | ___ | ___ | ___ |

## 1. Name

The app needs a product name, and the interop profile needs an identifier that other apps can implement. Using one name for both avoids a second vocabulary: other implementations are "BindleBox-compatible".

| Candidate | Rationale | Concern |
| --- | --- | --- |
| **BindleBox** | Pairs the bindle (a carried bundle) with a mailbox. Short, product-like and clearly part of the Bindle family. The user's own candidate. | Ties the app to the Bindle brand, which suits a reference app. |
| Bindle Inbox | Descriptive and instantly understood. | Generic. "Inbox" contradicts the earlier no-inboxes, Views-only decision. |
| Bindle Post | "Post" means mail, and the phrase works as a protocol name ("Bindle Post v1"). | Weak as an app name. Ambiguous with social-media posts. |
| Satchel | Bag metaphor next to "bindle". Warm. | Existing companies use it. Does not say "messages". |
| Pouch | Small, friendly bag metaphor. | Too cute for a protocol. Says nothing about messaging. |
| Courier | Says "delivery" and fits the queue and receipt model. | courier.com is an established notification API. |
| Missive | Means a letter. Distinctive. | An existing email client is called Missive. |
| Waymark | Travellers' marks, a nod to the bindle's heritage. | Abstract. Nobody will guess it means messaging. |

**Recommendation: BindleBox.** It is distinctive, has no obvious conflict with a known product, says "messages" and stays in the brand. No trademark search has been done; that is a publication gate. Identifiers use a `bindlebox` path segment, so a rename before publication is a search and replace.

## 2. Scope and boundary

BindleBox owns **peer-to-peer messaging**:

- messaging contacts and contact links of the messaging type;
- authored one-off messages;
- conversations;
- delivery, the send queue, receipts and resend;
- the user's message store;
- Views, tags and rules over that store;
- consuming a classifier for messages;
- handling bridged email.

Core (the Bindle spec and 3sln.me) keeps:

- identity, keys and the directory;
- the generic link envelope with audience responses and landing pages (§6);
- slots and extensions;
- **activity**: app-originated notifications, alerts and app messages, including their forms and postbacks;
- storage resources, preferences and grants;
- the SMTP entry point of the public email bridge and its auto-reply (§13).

The boundary rule is stated in [activity](../spec/activity.md) "Limits and scope": BindleBox MAY submit its own app-attributed activity ("New message from alice") under ordinary connection consent. Core MUST NOT accept peer envelopes through an activity backdoor or mirror peer bodies.

BindleBox is an ordinary app/integration. It uses grants, fragments, slots and brokered resources, with no private provider API. 3sln.me may bundle a default instance on its own origin ([extraction](messaging-extraction.md) §5), and an import-boundary test proves the instance cannot reach provider internals.

## 3. Topology

```
 Sender browser        Sender's BindleBox (app origin)             Recipient's provider (address)
 ──────────────        ───────────────────────────────             ──────────────────────────────
 compose ─POST /send─▶ edge ─▶ MailboxObject (per-user single writer)
         ◀── SSE ────         │ outbox: event + one obligation per
                              │ recipient; alarm drains outside txns
                              ├─(1) GET link, Accept: ingress ───────▶ verifies link envelope; asks the
                              │◀──────── ingress descriptor ──────────  messaging slot occupant (cached)
                              └─(2) POST envelope (or batch) ────────▶ Recipient's BindleBox ingress
                                ◀───── signed custody receipt ───────   verifies, admits, stores
```

- **Provider** (for example 3sln.me): the user's stable address. Handles, links and the directory live here. As a consumer of the messaging slot (§5), it introduces callers to the occupant. It is not in the message path.
- **BindleBox instance**: an edge tier plus one **MailboxObject** per user, the single writer for that user's messaging state (a Durable Object on Workers, a serialized controller on Node).
- **User storage resource** (`object-storage/v1`): the user-owned canonical archive (§8).
- **Peers**: other providers and BindleBox-compatible apps, reached over HTTPS under SSRF controls.

This is the NOTES.md principle that the provider introduces and the parties then talk directly. The provider pays nothing per message. Switching apps changes only what the introduction returns.

## 4. Identity, keys and signing

### 4.1 Problem

Today one provider-custodied P-256 identity key per account signs everything. It signs:

- link metas and audience responses;
- contact-delivery author proofs;
- conversation v1 payloads;
- admission receipts (provisionally).

See `packages/runtime/account/identity.mjs` (`signingKey`) and the signature-domain table in [links §7.2](../spec/links.md). As an app, BindleBox must produce author proofs attributable to the user's identity without ever holding that key.

### 4.2 Options

| Option | Mechanism | Assessment |
| --- | --- | --- |
| A. Provider signing oracle | The app calls a provider `sign` method. | The provider would need the messaging schema to validate payloads, which keeps messaging in core. Otherwise it becomes `sign(bytes)`, which [message sender identities](message-sender-identities.md) forbids. It also costs a provider round trip per message. **Rejected.** |
| B. Export the identity key to the app | The app holds the identity private key. | One compromised app could forge link metas, audience responses and every future core profile. **Rejected.** |
| **C. Identity-bound delegate key** | The app generates a per-user key. The provider certifies it with a short-lived, purpose-limited certificate signed by the identity key. Verifiers check identity key → certificate → message. | The identity key signs one small typed object. Purposes are fixed, revocation follows the app connection, and the scheme is portable and generic. **Chosen.** |
| D. Separate messaging identity | `alice@box.example`. | Breaks "the person is the principal" and forks contacts. **Rejected.** |

### 4.3 Chosen model

1. **Core feature `key-delegation.v1`** (new core work, declared in `features`). The exact assumed shape is in spec §3. The provider signs a `bindle-key-delegation+jwt` certificate binding:
   - the principal `(iss, sub)` and its identity `keyId`;
   - the delegate public key and its RFC 7638 thumbprint `jkt`;
   - purposes;
   - the app `client_id` and origin;
   - the connection incarnation;
   - `since` (first certification of this delegate key);
   - `iat`/`exp`, with `exp - iat ≤ 24 h`.

   It is a feature, not a slot. Slots carry no authorization rules ([extensions §2.1](../spec/extensions.md)).
2. **Purposes are published profile URIs.** BindleBox defines `…/bindlebox/v1/purposes/author` and `…/purposes/receipt`.
   - The provider certifies only purposes its own policy recognizes, and only after an explicit owner consent screen ("Let BindleBox sign messages and delivery receipts as you").
   - Profiles verified against the identity key never accept a delegate key: link metas, audience responses, delegation certificates and conversation v1. A stolen delegate key therefore cannot forge them. The `typ` header separates JWS profiles, and domain prefixes separate the rest (added to the [links §7.2](../spec/links.md) table).
3. **Renewal and revocation.**
   - The app renews at half the lifetime, and the provider renews only while the connection is live.
   - Disconnect, uninstall, suspension or "revoke messaging key" stops renewal immediately and lists the `jkt` at the optional status endpoint.
   - Exposure after revocation is at most the remaining lifetime (≤ 24 h) plus 60 s. It is zero for verifiers that check status, which is required for `conversation-init` and peer admission (spec §3.4).
4. **The certificate travels in the proof, not the signed payload.** The proof is `{alg, kid:"jkt:<thumbprint>", delegation, signature}`, and the payload names only `author.delegate = jkt`. A retry can carry a renewed certificate for the same key without changing the semantic digest (spec §5.4). This is the spike's rule that immutable content identity survives renewal of transport proofs.
5. **Admission-time validity.** A receiver requires all of:
   - a certificate valid now (±60 s);
   - `createdAt ≥ since - 60`;
   - the author purpose;
   - a principal and identity key resolved through the directory under pinned continuity.

   It keeps the certificate as evidence.
6. **Custody.**
   - The delegate private key is encrypted at rest in MailboxObject storage under an app key-encryption key. It never reaches the browser.
   - Rotation means a new key, a new certificate and a new `since`.
   - On reinstall or an app switch the new app generates its own key. Delegate keys never move between apps.
7. **Receipts** are signed by the recipient app's delegate key (receipt purpose). This replaces the provisional "admission receipt signed by the account identity key" (S16 in [contact delivery](../spec/contact-delivery.md)).
8. **The identity key still signs** delegation certificates, link metas (through core issuance, §6) and audience responses, all provider-side.

**Dependency.** Cross-host verification needs the core **directory and identity-document profile**, which is still unimplemented. Until it exists, an instance verifies only principals whose provider exposes a directory to it; for the bundled instance that means 3sln.me principals. Every other author receives `author_unverifiable`, matching today's same-host restriction.

## 5. Slots, extensions and installation

This section applies [extensions](../spec/extensions.md) revision 2 as published. Two companion documents were still absent when this was written: `docs/architecture/extensibility-design.md` and `docs/spec/integrations.md`. The brokered-resource and webhook members cited from integrations are **assumed** (spec §2.4) and must be reconciled.

| Slot | Selection | Consumers | Occupant | BindleBox's role |
| --- | --- | --- | --- | --- |
| `…/slots/messaging-ingress/v1` (defined by the BindleBox spec, §2.1) | `exclusive` | `provider`, `application` | The user's **mailbox resource**, hosted by the BindleBox integration as a brokered resource implementing the `…/bindlebox/v1/contracts/mailbox` contract | Supplies the occupant (declared as `role: occupant`, `ref: mailbox`) |
| `…/slots/public-message-intake/v1` (the example slot in extensions §4.1) | `exclusive` | `provider` | The same mailbox resource, which also implements the public-intake contract | Supplies the occupant. The provider's `email-bridge` feature is the consumer |
| `…/slots/item-classifier/v1` (extensions §2) | `ordered`, `failover: any-error` | `application`, `provider` | A decision-model resource (host built-in or third party) | **Consumer** (§12) |

How the pieces fit:

- **Why the mailbox is a slot occupant.** The slot fixes "exactly one inbound handler per user", so links, the handle and email resolve to one place. The owner chooses which installed integration fills it. A newly connected app never displaces the current occupant (extensions §6).
- **Endpoints come from the occupant, never from the slot.** The provider's `messaging-address` feature (a declared `consumer`) calls the occupant's `describe` method through the brokered credential. The result is the public ingress descriptor (spec §2.3), which the provider caches for at most 1 h and serves to senders. Replacing the occupant invalidates the cache.
- **Installation** is an ordinary login plus these fragment requests:
  - the mailbox occupant assignment, an owner action;
  - a storage fragment with an `object-storage/v1` field (§8);
  - an optional consumer request for the classifier slot (§12);
  - the activity method grant (§14);
  - `key-delegation.v1` consent (§4).

  The integration manifest declares a webhook for preference changes, identity-key rotation, provider-initiated link revocation, occupant removal and lifecycle events (assumed integrations member).
- **Severing.** The provider owns the coupling credential. Severing it (owner removes the occupant, disconnects, or the account is suspended) fails the brokered credential, stops delegation renewal and stops descriptors. In-flight inbound messages then fail with `recipient_unavailable`.
- **Providers without `extensions.v1`** (extensions §8) can still let BindleBox store data and send. Without the provider consumer feature, however, no descriptor exists, so that provider's users cannot receive. Senders learn this before composing (§16).

## 6. Contact links: core envelope, app type

### 6.1 Split

| Concern | Core (`links.md`, provider) | BindleBox (spec §4) |
| --- | --- | --- |
| Raw-query parser, `bindle_*` reservation, limits, JWS profile, exact stored claims, `md`, tooling rules (links §2–§5) | ✓ | |
| Link issuance and revocation for app-declared link types, signed with the identity key | ✓: a provider-hosted `…/contracts/links/v1` resource (`issue`, `revoke`, `evaluate`) requested by fragment | requests issuance |
| Audience requirement, response signing, replay record, GET evaluation, policy registry (links §7.1–§7.4, §8 GET, §9) | ✓ | |
| Delivery-time policy re-evaluation (links §7.5) | `evaluate` | calls it at admission, with bounded decision reuse |
| Landing page (HTML GET), previews, oEmbed, `web+bindle` intents and the `intents.v1` handoff (links §6.4) | ✓: a generic "open with your messaging app" page | handles `send-message`/`add-contact` |
| Contact link type: `kinds`, MIME/quota members, intake configuration and representation, authored-delivery rule, quotas (links §6, §6.1–§6.3, §7.5 delivery half) | | ✓ |
| Legacy `?sig=` endpoints, inbox bearers, contact-delivery bearer minting (links §10, contact-tokens) | **deleted** | |

Links stay on the provider origin (`https://3sln.example/users/alice/contact/<id>?bindle_meta=…`). That gives them a stable address, lets them survive an app switch, and keeps the provider as the verifier of the envelope. A link type names the slot that handles it.

### 6.2 Flow

1. **Issue.** BindleBox calls `links.issue({type, claims})`. The provider validates the common members, stores the exact header and claims, and signs with the identity key. BindleBox stores the parent record: exact claims, intake, quotas and receipts.
2. **Resolve.** The sender GETs the link with `Accept: application/vnd.bindlebox.ingress+json`. The provider verifies the envelope (links §8 steps 1–2) and returns the descriptor (spec §2.3), with an expiry of at most 1 h. With no occupant it returns uniform `recipient_unavailable`.
3. **Intake.** The sender fetches optional tags from `{ingress}/intake` (spec §4.4).
4. **Deliver.** The sender POSTs the authored envelope to the ingress with `Authorization: BindleLink <bindle_meta>`. The recipient app verifies the meta with the identity key it learned through the webhook, compares it against its stored exact claims, and then verifies the author.

No bearer is minted. The meta goes straight to the app that holds the parent record, and the contact-delivery bearer profile is deleted.

Conditional links (`audience`) keep core semantics. GET evaluation happens at the provider. At delivery, the app calls `links.evaluate({jti, principal})`, reusing decisions as links §7.5 permits. Developer contact remains one conditional link, issued for the developer account's BindleBox occupant.

## 7. Conversations

The spike's D1 applies: independent owner replicas with directed consent, replacing the withdrawn v1 central-authority draft. This is option A from [conversation-contact design](conversation-contact-design.md), the user's stated preference:

- a shared conversation secret as a cheap pre-authentication gate;
- independently signed author events (signed by delegate keys);
- each owner's accepted-peer set;
- no sequencer;
- direct mesh fanout.

### 7.1 Bootstrap

`conversation-init` through a contact link carries a creator-signed genesis, the secret and `returnControl` (trimmed from [contact delivery](../spec/contact-delivery.md#conversation-bootstrap)). The recipient explicitly accepts or declines. On acceptance:

- the recipient creates a new **admission incarnation** for the creator;
- it returns its own ingress binding;
- each side adds the other to its accepted-peer set.

### 7.2 Events

Each event is signed once and carries:

- a per-author counter and the predecessor digest;
- at most 8 causal parents;
- an operation ID.

Its **audience** is frozen at local acceptance: the sender's accepted-outgoing peers that have reciprocal admission. Approved but non-reciprocal peers show as "not sent: awaiting approval" and stay outside the denominator. Live authority is still rechecked before every attempt.

### 7.3 Order

The display order is a deterministic topological sort with a stable tie-break on event ID, valid only for the same validated set. Arrival order and timestamps never decide order or authority. A missing parent gets a bounded placeholder (at most 64 outstanding per conversation) and is never fetched recursively. Two signed successors at the same author counter are equivocation: that branch is quarantined and the evidence kept.

### 7.4 Membership and keys

Any accepted participant may send a signed peer proposal, and each owner decides independently.

- **Block** at the recipient wins over queued delivery, replay and forwarded copies from that author.
- **Re-acceptance** creates a fresh admission incarnation. Old cancelled obligations stay cancelled.
- **Leave** is local. A signed `leave` notice is a courtesy, never a global expulsion.
- **Secret rotation** is a proposal. Conflicting rotations are surfaced for explicit local selection. While an epoch is incompatible, delivery to that peer is `deferred(epoch)`, never silently dropped.
- **Key changes** need authenticated continuity, and an embedded replacement key is never trusted.

### 7.5 Edits and retractions

Author-signed `edit` and `retract` records name the target event ID and digest. They travel as ordinary obligations with status, and receivers keep every revision for Peek.

A retraction received before its target suppresses any later fetch or render of that body. Minimal anti-resurrection state survives local erase and restore.

The UI distinguishes four cases:

- sender deletion;
- owner-local erase;
- history that is unavailable;
- refusal by the host.

Remote erasure is never claimed: "Deleted for people whose apps accepted the deletion".

### 7.6 Limits

| Bound | Default | Notes |
| --- | --- | --- |
| Participants | 32 total | Each occupant declares `maxParticipants` in its descriptor, and a proposal that exceeds an invitee's limit fails for that invitee with `participants_exceeded`. Sender audience, incoming authors and proposal churn are bounded separately: at most 32 accepted peers, at most 64 known authors and at most 16 pending proposals per conversation. |
| Live conversations per mailbox | 500 | |
| Event body | 1 MiB | |
| Envelope | 64 KiB | |
| Reactions, read receipts, typing | not in v1 | |

Larger public rooms need a separate distribution and governance profile (spike §1).

## 8. Storage: the user's resources

The canonical, portable copy lives in a storage resource the user controls. The app's infrastructure holds hot, reconstructible state plus whatever must be durable before a receipt is issued.

| State | Where |
| --- | --- |
| Bodies ≥ 4 KiB | User storage resource, prefix `bindlebox/v1/`, staged before admission commits |
| Small bodies, metadata, receipts and replay frontiers, outbox and obligations, peer sets and incarnations, parent link records, Views, rules, overlays, event log | MailboxObject SQLite |
| Canonical archive: immutable segments plus a compare-and-swap manifest (spec §10) | User storage resource |

- **Admission order.** A body is staged in user storage, then the MailboxObject commits metadata, the reference, accounting, the replay entry and the receipt in one transaction. Orphaned staged objects are collected later.
- **Checkpoints** run at least every 15 min or every 256 changes. Settings disclose this data-loss window for the case where the app's own infrastructure is destroyed.
- **Storage resource unavailable.** Intake continues into a bounded hot allowance (64 MiB or 5,000 items). Beyond it, ingress refuses with `recipient_storage_unavailable` (503 with `Retry-After`), and the owner sees a banner.
- **Protective reserve.** Block, leave, retract, erase and their anti-resurrection records always fit within a fixed reserve (1 MiB and 1,000 records), even at quota (spike §14).
- **Encryption.** Segments are encrypted under an app-held owner key, wrapped to the identity encryption key once core exposes one. Until then the storage provider sees plaintext, and the UI says so. This is not end-to-end encryption.

## 9. Sending: queue, obligations, SSE, resend

### 9.1 Submit

`POST /api/send` is app-local, not interop. One MailboxObject transaction:

- validates;
- reserves queue, byte and work capacity, refusing with `send_capacity` when full, before promising anything;
- signs the envelope once;
- stores the body;
- writes **one obligation per recipient** and the frozen audience;
- writes the operation receipt.

It returns 202 `{messageId, obligations}`. Repeating the `operationId` returns the same result. Different content under the same ID is `send_operation_conflict`.

### 9.2 Drain

The drain runs from MailboxObject alarms, using the shared account scheduler, which also carries checkpoints and renewals. A bounded sweep repairs work stranded after the platform's alarm retries are exhausted. Network I/O always happens **outside** transactions. Results are recorded in a short transaction that first rechecks the generation and consent.

| Control | Value (candidate from spike, not measured capacity) |
| --- | --- |
| Concurrent outbound requests per invocation | 4 |
| Concurrent requests per destination host | 2 |
| Fairness | Weighted round-robin across conversations and hosts. A reserved control lane for leave, block and retract. |
| Attempt timeout | Connect 5 s, total 15 s, response at most 64 KiB, so trickling or oversized responses are bounded. |
| Backoff | 5 s minimum, exponential with ±20% jitter, capped at 1 h, at most 100 attempts per recipient. `nextAttemptAt` is persisted. Restarts and manual actions never reset backoff. |
| Automatic lifetime | Contact deliveries (`one-off`, `conversation-init`): until `createdAt + 23 h`, inside the 24 h acceptance window. Conversation records: `createdAt + 72 h`, inside the 7-day acceptance window (spec §8). |
| `Retry-After` | Honoured as a lower bound. If it falls beyond the deadline, the obligation expires visibly instead of retrying early. A malformed value means 60 s. |
| Host circuit breaker | Per endpoint. Opens after 5 consecutive transport failures or 5xx, for 60 s doubling to 1 h, then one half-open probe. Per-account 403s and 429s never open it. Open means `deferred(unreachable)`. Recovery is paced. |

### 9.3 Failure classification

| Response | Classification |
| --- | --- |
| Timeout, reset, 429, 502, 503, 504 | Retryable. A timeout or reset is **indeterminate**, retried with the identical envelope, never a new operation. |
| 401, 403 | One bounded repair: re-resolve the descriptor and renew the delegation, then one retry. After that it is `rejected`. |
| 404, 410, `ingress_moved` | One re-resolve through the provider, then retry. Otherwise `rejected(not_reachable)`. |
| 413, 415 | `rejected`. An explicit size or capability remedy is required. |
| Valid typed permanent refusal | Terminal. |
| Redirects | Never followed. |

### 9.4 Obligation states

These match spike §3. State revisions are monotonic.

| State | Final? | User action |
| --- | --- | --- |
| `not_sent` (approved but awaiting reciprocal admission; no obligation yet, outside the denominator) | no | — |
| `queued` / `retry_scheduled` (shows next attempt and deadline) | no | "Retry now" brings the attempt forward but still respects host and `Retry-After` bounds |
| `in_progress` / `unknown` (an attempt may have committed remotely) | no | — |
| `delivered` (valid custody receipt for the full body; not a read claim) | yes | — |
| `rejected` (class: `not_authorized`, `invalid`, `too_large`, `participants_exceeded`, `author_unverifiable`, `not_reachable`) | yes | Only after the cause changes |
| `expired` (lifetime or attempt budget exhausted) | yes | **Retry missing** |
| `cancelled` (owner cancel, local block or local removal) | yes | Only after re-acceptance, which creates a new message |

A late valid receipt resolves `unknown` or `expired` to `delivered`. It never revives cancelled future work.

### 9.5 Aggregates

The aggregate is `{delivered, pending, failed}` over the **original frozen denominator**, plus `notSent` shown separately. A group shows "7 delivered · 2 pending · 1 failed", with a per-recipient sheet listing state, reason class and next attempt.

The denominator never shrinks after a membership change. "Delivered" requires every obligation delivered. Only the owner can read status. Other participants learn nothing about each other's delivery.

### 9.6 Retry missing

"Retry missing" selects unresolved, still-authorized `expired` and `unknown` obligations.

- **Inside the acceptance window** it keeps the same event ID, body and audience, so recipients deduplicate. It does not create a new message or reset budgets, re-send delivered copies, or re-add blocked peers.
- **Beyond the window** it offers "send again as a new message", which carries `resendOf` for display and starts a new operation.

### 9.7 SSE

`GET /api/events` is a **view over durable state**. It streams `obligation`, `message`, `incoming`, `conversation` and `reset` events from a bounded log (1,000 events or 24 h), each carrying a monotonic ID and coalesced at about one update per message every 250 ms.

- **Resume** with `Last-Event-ID`. A gap produces `reset`, and the client refetches `GET /api/outbox/:id` and snapshots.
- **Lifetime.** Streams last at most 5 minutes. A stream never keeps an otherwise idle MailboxObject awake: when the drain is idle, the stream closes and the client polls slowly. The WebSocket Hibernation API is the recorded alternative if measurements justify it.
- **Disconnects** never cancel or authorize anything.
- **Polling fallback.** The UI works by polling alone.

### 9.8 Offline sender

The browser keeps unsent drafts locally. Once a message is submitted, the MailboxObject owns it, and closing the tab stops nothing.

## 10. Host multicast (optional, after measurement)

The spike ranks multicast P2. The spec defines it now (spec §7.3) so the wire does not change later. Instances enable it only when host concentration makes the benefit material, which it does for 3sln.me users on the bundled instance.

- **Discovery.** An occupant's descriptor may include `multicast`. The sender groups only obligations whose **own verified descriptors** name the same multicast URL and whose recipients are entitled to the exact same body. It never groups by URL suffix, IP or CDN.
- **Request.** One immutable body plus at most **32** per-recipient contexts. Each context has its own credential and envelope binding the body digest, the exact recipient, the admission incarnation and the epoch. No context carries another host's credentials.
- **Host processing.** The host admits bytes, entry count and expanded work before dispatch. It authorizes, budgets and deduplicates each context through that owner's own transaction, with no cross-mailbox atomicity.
- **Response.** Bounded per-context outcomes that distinguish `accepted-host` (staged) from `delivered` (owner custody receipt). Only a receipt makes an obligation `delivered`.
- **Recovery.** Unresolved contexts are reconciled with unchanged event IDs. Falling back to individual POSTs happens only after an explicit `unsupported` or a controlled recovery. Both paths share recipient deduplication, and a timed-out batch is never doubled automatically.
- **Accounting.** A batch reserves the same per-recipient allowance as the equivalent individual requests, plus a separately bounded host staging allowance. Unknown or unauthorized contexts get uniform `recipient_unavailable`, so batches cannot enumerate mailboxes.

## 11. Receiving

The order follows contact-delivery S4 and spike §9: the cheapest refusal comes first.

1. Framing and size bounds, then the credential (uniform 401) before any hashing, key fetch or MailboxObject wake beyond the credential check.
2. For conversations, a local membership pre-check on `(conversation, author principal)` before any crypto or directory work.
3. Envelope and body validation.
4. Delegation and author proof. Directory lookups use bounded caching with pinned continuity, and the cache has bounded cardinality.
5. One admission transaction: live parent or peer and incarnation, receipt budgets, the replay frontier, storage, the custody receipt, the index and the activity outbox.

Receipt budgets carry over unchanged from [messaging](../spec/messaging.md) "Reference-service receipt limits" as BindleBox policy. Conversation events, edits, retractions, proposals and invitations each have their own bounded allowance (spike §9). Unknown authors allocate no pending rows. Quarantine has a finite byte, count and age allowance.

## 12. Views, tags, rules and the classifier slot

**Views, tags and rules move into BindleBox** with their current semantics:

- [message views](message-views.md), including the conversation overlays;
- [tags](tags.md) for suspected tags, provenance and default promotion;
- owner rules, including single-transaction `deleteRule`.

Core keeps the generic identifier and label validation and reusable owner-rule machinery for activity ([activity center](activity-center.md) extraction table). BindleBox starts from a copy and the two diverge ([extraction](messaging-extraction.md) §2).

**The classifier is a slot.** BindleBox is an `application` consumer of `item-classifier/v1`, with ordered selection and failover permitted because classification is pure computation (extensions §3.2).

- **Occupant available:** BindleBox invokes it directly through the brokered resource, sending the minimized, redacted text from [public email bridge](public-email-bridge.md) and only for ingresses with classification enabled. Typed results map to `sys:suspected.*` tags through the internal `applyAutomatedTags` boundary. The model never authorizes a final tag, quarantine or deletion.
- **No occupant, consent not given, or `requiresConsent`:** BindleBox shows **no** AI classification setting, "Suspected" model tag or label. Deterministic header hints on bridged email remain, labelled as header hints, and never finalize a tag.
- **Disclosure** follows extensions §5.1/§9.5: the consent screen names the occupant origin that receives the content.

## 13. Email bridge handoff

SMTP intake, MIME bounds, the reply gates and the auto-reply stay with the provider ([public email bridge](public-email-bridge.md); none of it is implemented yet). The provider's `email-bridge` feature is the declared **consumer** of `public-message-intake/v1`, and BindleBox's mailbox resource is the occupant.

1. **Resolve.** The provider resolves the envelope recipient to the account. It requires the owner to have enabled "Receive public email" (extensions §5.3), an available occupant, and the account to pass the earlier eligibility rules.
2. **Hand off.** The provider parses within its bounds and invokes the occupant's `receiveBridged` method (spec §9) with a provider-signed provenance record and the normalized parts. Under `exclusive` selection there is exactly one target. An ambiguous outcome is never retried against another occupant (extensions §3.2).
3. **Store.** BindleBox stores the message as an email-origin receipt or a pending invitation, with the sender unverified, and returns a `disposition` within 2 s.
4. **Reply.** The provider picks the auto-reply variant:
   - `stored-invitation`: "stored as a conversation invitation; the recipient hasn't accepted yet";
   - no occupant, intake disabled, `refused` or a timeout: a marketing variant ("This address receives messages through Bindle; email isn't delivered. Get Bindle to reach them").

   Both variants require every reply-safety gate: platform DMARC-valid `reply()`, RFC 3834 suppression, cooldown and the global budget. There is at most one reply per sender address per 30 days. Unknown handles never get a reply.

The intent mechanism was rejected for this path: intents are browser handoffs, while SMTP intake is server-to-server with a live event deadline.

**Reconciliation note.** The [activity center](activity-center.md) extraction table lists `apps/worker/email.mjs` as moving to the messaging app. That file is the core outbound system-mail transport (verify, login, accounts senders), and it stays in core. Only bridge-item *handling* moves. This is recorded for the activity owner in the [review](../release/messaging-app-review.md).

**Product change needing sign-off.** The earlier design sent no reply to unknown, disabled or ineligible recipients, to avoid backscatter. The marketing variant keeps "nothing for unknown handles" but does reply, for known handles that lack an accepting occupant. It goes only to DMARC-aligned senders, through the platform's own reply restrictions, with a cooldown.

## 14. Notifications through core activity

BindleBox never pushes on its own. Under its installed connection and an explicit activity method grant ([activity](../spec/activity.md) "Authority and submission"), it submits app-attributed items:

- a subject such as "New message from alice@3sln.example";
- no body by default;
- app tags `conversation`, `contact`, `invitation` and `delivery-problem`;
- a collapse key per conversation.

Push routing, quiet hours and per-app-tag controls belong to the activity center. A retracted peer message retracts its activity item. Activity limits apply, so a flood of peer messages coalesces through the collapse key instead of spending the activity budget per message.

## 15. Moderation and abuse

Each scope is distinct (spike §15):

- **Owner:** block a principal (all conversations and links), mute, quarantine, leave, revoke a link.
- **BindleBox host:** abuse refusal per source principal or host, with an explicit sender outcome `rejected(not_authorized)` that never states the private reason.
- **Provider:** account suspension removes the occupant binding and stops delegation.

Reports carry only evidence the owner deliberately selects, never the full history, credentials or participant lists. Rejection alerts to the owner are coalesced (at most one summary per hour) so an attack is not reflected back at its victim. No receipt-of-receipt, bounce-of-bounce or alert loops.

## 16. Offline, failure and metadata exposure

| Situation | Behaviour |
| --- | --- |
| Recipient's app offline or returning 5xx | `retry_scheduled` until the deadline, then `expired` with "Retry missing" offered. |
| Recipient's provider unreachable during resolution | Use a cached descriptor while fresh. Otherwise `retry_scheduled(unreachable)`. |
| Stale descriptor (app switched) | 404, 410 or `ingress_moved` lead to one re-resolve and an immediate retry. |
| Recipient uninstalls mid-conversation | Descriptors return `recipient_unavailable`. Peers' obligations retry and then expire, and the conversation shows "X's messaging app is unavailable". Nothing is dropped silently. |
| Recipient switches apps | The new occupant imports the archive (§8, spec §10), including peer sets, incarnations, frontiers and parent link records, so links and conversations continue under the same identity with a new delegate key. Until the import completes it answers `recipient_storage_unavailable` (503) rather than admitting into empty state. |
| Recipient's provider lacks `extensions.v1` or the messaging slot | No descriptor exists. The sender sees "This person's provider doesn't support Bindle messaging" before composing. |
| Sender's delegation lapses mid-queue | The drain renews before sending. If renewal fails, obligations pause as `retry_scheduled(authorization)` and the owner is told to reconnect. They expire at the normal deadline. |
| Partial multicast response | Per-context outcomes apply. Missing entries are `unknown` and are reconciled individually. |
| Lost receipt | Retry with the identical envelope. The stored receipt is replayed with no new charge or notification. |
| Recipient's device offline, provider online | Custody is unaffected. The device catches up through paginated snapshots with cursor incarnation and gap markers. Host receipts never claim device delivery or reading. |
| Peer returns after months | Admission and key state may need renewal. Blocked access is never silently restored, and old archives never override newer erase or revocation evidence. |
| MailboxObject restart mid-drain | Leases expire, attempts become `unknown`, and they retry with the same envelope. |
| Clock skew | Receivers allow ±60 s and refuse anything beyond with `clock_skew`, carrying the server time. `createdAt` is fixed at submit, deadlines use receiver time, and persisted deadlines survive restarts. |

**Metadata exposure.** Delivery is not end-to-end encrypted.

| Party | Learns |
| --- | --- |
| Sender's BindleBox | Content, recipients, timing and outcomes |
| Recipient's provider | That a link was resolved, and by whom when the request is authenticated; never content |
| Recipient's BindleBox | Content, the sender principal, timing and size; per batch, only its own recipients |
| Storage provider | Encrypted segments (later) or plaintext (now), plus sizes |
| Classifier occupant | Minimized text of classified items |
| Push service, through core activity | Content-free or minimal subject per the activity center |

Logs carry no bodies, capabilities, link metas or full recipient lists. Status is owner-only. Read receipts and typing are not in v1.

## 17. Engine-first

BindleBox is engine-first from its first commit. It has its own ngin engine, provider catalogue, owner-scoped domain providers, harness, multi-party network simulator and CLI ([extraction](messaging-extraction.md) §7). It follows the conventions of [app engine](app-engine.md) §4 without importing 3sln.me's composition.

## 18. Spike checklist: P0 answers

| P0 item ([spike](../release/messaging-scaling-spike.md)) | Answer |
| --- | --- |
| Reconcile the central-authority draft; app/core boundary; upgrade path | §2, §7: v1 is withdrawn and replaced by directed-consent replicas. Boundary in §2 and §6. Profiles are versioned by identifier with negotiation in the descriptor (spec §2.3); no silent downgrade. |
| Immutable event/audience identity, causal bounds, admission incarnations, custody receipt scope | Spec §5.4 and §6.3: event ID is the semantic digest; at most 8 parents; frozen audience bound to incarnations; the receipt covers the full body (v1 has no separate attachments). |
| Atomic local acceptance, complete fanout, queue reservation, honest states | §9.1 and §9.4. |
| Retry classification, spacing, deadlines, budgets, breakers, probes; resend on the same obligation | §9.2, §9.3, §9.6. |
| Block/re-accept, key continuity, rotation disagreement, late events | §4.3, §7.4; spec §6.5. |
| Group, event, dependency, attachment, expanded-work and pending bounds; protective reserve | §7.6, §8, §10, §11; spec §11. |
| Replay, receipt and tombstone retention with restore rules | Spec §8: 7-day acceptance window, receipts kept 9 days, frontiers with gap exceptions, retraction and erase anti-resurrection state kept for the conversation's life and restored with control generations before traffic. |
| Plaintext custody, delivery metadata, scoped status, safe logging, social signals off | §16. |
| SMTP provenance, pre-acceptance refusal, bounded replies, no conversion to signed authorship | §13; spec §9. Email-origin items are never author-signed, and a sender becomes a participant only through the bridge's mailbox-confirmation and identity flow. |

P1 items (real-adapter queue recovery, browser verification of counts and resets, cross-host failure scenarios, abuse budgets, D1–D4 sign-off) become implementation gates in [extraction](messaging-extraction.md) §6. P2 items (enabling multicast, tuning, relays, MLS) stay deferred.

## 19. Open questions for the user

1. **Name:** BindleBox?
2. **Delegation lifetime:** certificates of at most 24 h, with status checks required only for first contact and peer admission, or shorter certificates and more renewals?
3. **Marketing auto-reply** to known handles without an accepting occupant (§13): acceptable under DMARC-only gating?
4. **Conversation gate:** keep the shared secret (option A, the earlier preference), or drop it for identity plus bilateral admission (option C)?
5. **Bundled instance:** offer BindleBox as an opt-in default occupant at signup (recommended), or require explicit installation?
6. **Public native ingress:** should the handle accept Bindle-native messages from strangers in v1, or only bridged email (recommended: email only)?
7. **Reset:** accept discarding all existing local messages, contacts and conversations at cutover ([extraction](messaging-extraction.md) §4)?
