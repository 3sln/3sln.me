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

1. **Core feature `key-delegation.v1`** (a core amendment proposed here, declared in `features`; exact shape in spec §3.2). The provider signs a `bindle-key-delegation+jwt` certificate binding:
   - the principal `(iss, sub)` and its identity `keyId`;
   - the delegate public key and its RFC 7638 thumbprint `jkt`;
   - purposes;
   - the app `client_id`, origin and **certified ingress** (`client.ingress`), so peers accept ingress changes only to the provider-recorded URL (review S-4);
   - the connection incarnation;
   - `since` (first certification of this delegate key);
   - `iat`/`exp`, with `exp - iat ≤ 24 h`.

   It is a feature, not a slot. Slots carry no authorization rules ([extensions §2.1](../spec/extensions.md)).
2. **Purposes are published profile URIs.** BindleBox defines `…/bindlebox/v1/purposes/author`, `…/purposes/receipt` and `…/purposes/archive`.
   - They are certified **only to the current messaging-ingress occupant**. Certifying a new key revokes the previous one, so two apps never sign concurrently for one principal (reviews P-3, S-12). A provider can also revoke every delegation of a breached `client_id`.
   - The provider certifies only purposes its own policy recognizes, and only after an explicit owner consent screen ("Let BindleBox sign messages and delivery receipts as you").
   - Profiles verified against the identity key never accept a delegate key: link metas, audience responses, delegation certificates and conversation v1. A stolen delegate key therefore cannot forge them. The `typ` header separates JWS profiles, and domain prefixes separate the rest (added to the [links §7.2](../spec/links.md) table).
3. **Renewal and revocation.**
   - The app renews at half the lifetime, and the provider renews only while the connection is live.
   - Disconnect, uninstall, occupant replacement, suspension or "revoke messaging key" stops renewal immediately and marks the `jkt` revoked at the status endpoint. The status response carries only `active`/`revoked` and a coarse hour.
   - Status checks are **required** for every record with a lasting effect (edit, retract, rotate, leave, ingress, proposals, hellos, rejoin), for invitations and for every receipt (spec §3.4). For those, exposure after revocation is bounded by the 5-minute status cache. For plain messages and one-offs it is bounded by the remaining certificate lifetime (≤ 24 h). On learning of a revocation, receivers quarantine any unapplied records signed after the revocation hour minus 1 h (review S-3).
4. **The certificate travels in the proof, not the signed payload.** The proof is `{alg, kid:"jkt:<thumbprint>", delegation, signature}`, and the payload names only `author.delegate = jkt`. A retry can carry a renewed certificate for the same key without changing the semantic digest (spec §5.4). This is the spike's rule that immutable content identity survives renewal of transport proofs.
5. **Admission-time validity.** A receiver requires all of:
   - a certificate valid now (±60 s);
   - `createdAt ≥ since - 60`;
   - the author purpose;
   - a principal and identity key resolved through the directory under pinned continuity.

   It keeps the certificate as evidence.
6. **Custody.**
   - The delegate private key is encrypted at rest in MailboxObject storage under an app key-encryption key. It never reaches the browser.
   - Rotation means a new key, a new certificate and a new `since`. Routine rotation waits until no unresolved obligation is signed by the old key. On compromise, unresolved obligations are re-signed by the new key as new events with `resendOf`.
   - On reinstall or an app switch the new app generates its own key. Delegate keys never move between apps.
7. **Receipts** are signed by the recipient app's delegate key (receipt purpose). This replaces the provisional "admission receipt signed by the account identity key" (S16 in [contact delivery](../spec/contact-delivery.md)).
8. **The identity key still signs** delegation certificates, link metas (through core issuance, §6) and audience responses, all provider-side.

**Dependency.** Cross-host verification needs the core **directory and identity-document profile**, which is still unimplemented. Until it exists, an instance verifies only principals whose provider exposes a directory to it; for the bundled instance that means 3sln.me principals. Every other author receives `author_unverifiable`, matching today's same-host restriction.

## 5. Slots, extensions and installation

This section follows [extensions](../spec/extensions.md), [integrations](../spec/integrations.md) and [extensibility design](extensibility-design.md), all at revision 2. Manifest entries are claims of the form `{slot, digest?, role, ref, purpose?, required?, options?}`. Brokered resources use provider-minted 300 s tokens with bounded-delay severance.

| Slot | Selection | Consumers | Occupant | BindleBox's role |
| --- | --- | --- | --- | --- |
| `…/slots/messaging-ingress/v1` (BindleBox spec §2.1) | `exclusive` | `provider` only | The user's **mailbox resource**, a brokered resource implementing `…/bindlebox/v1/contracts/mailbox` (`describe`, effect `read`; `linkRevoked`) | Occupant (`ref: mailbox`) |
| `…/slots/public-message-intake/v1` (spec §9, published by the messaging spec as in extensibility design §7.1) | `exclusive` | `provider`, `application` | The same mailbox resource, also implementing `…/contracts/public-intake/v1` (`deliver`) | Occupant. The 3sln.me `email-bridge` feature is a provider consumer. |
| `…/slots/item-classifier/v1` (extensions §2; extensibility design §7.2) | `ordered` | `application`, `provider` | Decision-model resource: a 3sln.me built-in over Workers AI, or third party | **Consumer** (`ref: triage`), optional (§12) |

**Why the mailbox is a slot occupant.** The exclusive slot guarantees exactly one inbound handler per user. The owner chooses which integration fills it, and a newly connected app never displaces the current occupant. Only provider features consume it, so no other app can obtain a mailbox credential (review P-17).

**Endpoints come from the occupant, never the slot.** The provider's `messaging-address` feature calls `describe` with its own brokered token, validates the result, and serves it as the ingress descriptor (spec §2.3), cached for at most 1 h. Replacing the occupant invalidates the cache. Until the new occupant's consumer re-review completes (extensions §3.3), the descriptor answers `recipient_unavailable` (503, retryable).

**Installation** is an ordinary authorization with these grants:

- the owner's assignment of the mailbox to both occupant slots, made in the provider's own interface, never preselected;
- a storage fragment with an `object-storage/v1` field (§8);
- an optional consumer request for the classifier slot;
- the activity method grant (§14);
- `key-delegation.v1` consent (§4).

The app receives integration SET events (integrations §6.2) at its `events_endpoint`:

| Event | Meaning for BindleBox |
| --- | --- |
| `connection-revoked`, `credential-revoked`, `resource-detached` | Severance or occupant removal |
| `preferences-updated` | Storage or classifier changes |

Identity keys are resolved through the directory, and link changes are polled with `links.changes` (spec §2.4), because integrations defines no events for either.

**Open question answered: no public per-entity slot resolution.** Extensibility design §10.1 asked whether messaging needs public per-entity slot resolution. It does not.

- Senders reach a recipient only through a capability: a contact link, which yields a descriptor through the provider's consumer feature, or an existing conversation, whose peers announce bindings in signed records.
- Handle-only contact without a link is out of v1 (§19, question 6).
- Core therefore gains no enumeration surface.

**Providers lacking parts of the stack** (§16):

| Missing | Effect |
| --- | --- |
| `extensions.v1` or the `messaging-address` feature | No descriptor exists, so the user cannot receive. |
| `key-delegation.v1` | The app cannot sign, so the user can neither send nor issue receipts. Only local organization works. |
| The directory profile | Only same-provider principals verify. |

BindleBox checks all of these at installation and shows exactly which capabilities work.

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
4. **Deliver.** The sender POSTs the authored envelope to the ingress with `Authorization: BindleLink <bindle_meta>`. The recipient app first checks the edge index (§11), then verifies the meta against the owner's identity key resolved through the directory, compares it against its stored exact claims, and then verifies the author.

No bearer is minted. The meta goes straight to the app that holds the parent record, and the contact-delivery bearer profile is deleted.

Conditional links (`audience`) keep core semantics. GET evaluation happens at the provider. At delivery, the app calls `links.evaluate({jti, principal})`, reusing decisions as links §7.5 permits. Developer contact remains one conditional link, issued for the developer account's BindleBox occupant.

## 7. Conversations

The spike's D1 applies: independent owner replicas with directed consent, replacing the withdrawn v1 central-authority draft. This is option A from [conversation-contact design](conversation-contact-design.md), the user's stated preference: a shared secret gate, independently signed author events, each owner's accepted-peer set, no sequencer, and direct mesh fanout.

### 7.1 Bootstrap in both directions

`conversation-init` through a contact link carries the creator-signed genesis, the secret, `returnControl` and a recipient-specific `creatorBinding` (spec §6.1). The binding holds the creator's ingress, a fresh incarnation for this invitee, and the creator's limits and profiles. On accept, the invitee returns its own binding (spec §6.2). Both sides can then send to each other immediately (review P-1).

### 7.2 Groups form through `peer-hello`

Accepting an invitation may include **"also accept the other people listed"** (`acceptListed`, default off, shown with the unverified proposed roster). The creator relays each accepted participant's **own signed** invitation response to the others, as a `peer-proposal` introduction. Each participant then sends a direct `peer-hello`, gated by a pair token for the fixed incarnation `hello`, to every introduced participant. The receiver answers with its own hello, so both sides exchange incarnations (spec §6.3, §6.4).

A receiver that accepted with `acceptListed` and finds the author in the genesis adds the author automatically. Otherwise the hello becomes one owner prompt per person. A 32-person group therefore costs a single opt-in, not about 30 decisions (review P-2).

Proposals never carry another person's ingress (review S-2). A sender delivers to a peer only after that peer's own signed binding arrives, and the binding's ingress must equal the peer certificate's `client.ingress`.

### 7.3 Events and audiences

Each event is signed once and carries:

- its stream (the delegate `jkt`), a per-stream counter and the predecessor digest;
- at most 8 causal parents;
- an operation ID.

**A new key opens a new stream** that links to the last known head. An app switch or key rotation is therefore never mistaken for equivocation (review P-3), and the stream head is persisted before signing.

**Audience.** The audience is frozen at local acceptance: the sender's accepted peers with reciprocal bindings. Live authority is rechecked before every attempt.

**Edits and retractions** address the target's original audience intersected with still-authorized peers (review P-8). An edit or retraction that arrives before its target is held as a bounded pending mutation, and applied only if the target's author matches.

### 7.4 Order

Order is a deterministic topological sort with a stable event-ID tie-break, valid for the same validated set. Timestamps never decide order or authority.

**Missing parents** get bounded placeholders. Past 64, they collapse into one gap marker and the event is still accepted.

**Equivocation** is detected per stream. The affected stream is quarantined with the evidence kept, and the author's other streams are unaffected.

### 7.5 Membership, rotation and keys

- **Proposals.** Peer proposals and hellos are decided by each owner independently.
- **Block** wins over queued delivery, replay and forwarded copies. **Re-acceptance** creates a fresh incarnation, and old cancelled obligations stay cancelled.
- **Leave** is local. A signed `leave` notice is a courtesy, never a global expulsion.
- **Rotation** is a proposal. The previous epoch stays valid for 7 days after an owner accepts the new one, so in-flight records do not fail (review P-6). Conflicting rotations are surfaced for an explicit local choice.
- **Key changes** need authenticated continuity, and an embedded replacement key is never trusted.

### 7.6 Edits and retractions

Edits and retractions are author-signed, and receivers keep every revision for Peek. Minimal anti-resurrection state survives local erase and restore.

The UI distinguishes four cases: sender deletion, owner-local erase, unavailable history and host refusal. Remote erasure is never claimed: "Deleted for people whose apps accepted the deletion".

### 7.7 Limits

`maxParticipants` (default 32) bounds **each owner's** accepted-peer set for a conversation. No global roster can enforce a group size (review P-12).

- Each owner also keeps at most 64 known authors and 16 pending proposals.
- Senders pre-check limits from descriptors and bindings at compose time.
- When limits differ, the UI shows "some participants can't see messages from everyone".
- Each mailbox holds at most 500 live conversations.
- An event body is at most 1 MiB, an envelope at most 64 KiB.
- Reactions, read receipts and typing are not in v1.
- Large public rooms need a separate profile (spike §1).

### 7.8 Moving apps

After an app switch, the new occupant sends `rejoin` to every peer. A peer that recognizes the principal answers with a fresh incarnation, the current secret (`secret-share`) and its own `peer-hello` (spec §6.6). Secrets are therefore never written to plaintext storage.

## 8. Storage: the user's resources

The canonical, portable copy lives in a storage resource the user controls. The app's infrastructure holds hot, reconstructible state plus whatever must be durable before a receipt is issued.

| State | Where |
| --- | --- |
| Bodies ≥ 4 KiB | User storage resource, prefix `bindlebox/v1/`, staged before admission commits |
| Small bodies, metadata, receipts and replay frontiers, outbox and obligations, peer sets and incarnations, parent link records, Views, rules, overlays, event log | MailboxObject SQLite |
| Canonical archive: immutable segments plus a signed compare-and-swap manifest with a writer lease (spec §10). Conversation secrets and link metas are excluded until segment encryption exists; a new occupant regains them through `rejoin` and `links.list`. | User storage resource |

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
| Host circuit breaker | Per endpoint. Opens after 5 consecutive transport failures or 5xx, for 60 s doubling to 1 h, then one half-open probe. Per-account 403s and 429s never open it. Open means `retry_scheduled(unreachable)`. Recovery is paced. |

### 9.3 Failure classification

| Response | Classification |
| --- | --- |
| Timeout, reset, 429, any 503 (including `recipient_unavailable` and `recipient_storage_unavailable`) | Retryable until the deadline (review P-5). A timeout or reset is **indeterminate** and is retried with the identical envelope, never as a new operation. |
| 401, 403 | One bounded repair (re-resolve, renew), then `rejected`. Exception: a record's 403 after a rotation the sender knows of is `retry_scheduled` with reason `epoch` (spec §6.5). |
| 404, 410, `ingress_moved` | Links: one re-resolve. Conversation peers: `retry_scheduled` with reason `moved`, awaiting that peer's `ingress` or `rejoin` record. |
| 400, 409, 413, 415 and other typed permanent refusals | Terminal. |
| Redirects | Never followed. |

### 9.4 Obligation states

These match spike §3. State revisions are monotonic.

| State | Aggregate bucket | Final? | User action |
| --- | --- | --- | --- |
| `queued` / `retry_scheduled` (with reason: `rate_limited`, `unreachable`, `unavailable`, `storage`, `epoch`, `moved`, `authorization`; shows next attempt and deadline) | pending | no | "Retry now" brings the attempt forward but still respects host and `Retry-After` bounds |
| `in_progress` / `unknown` | pending | no | — |
| `delivered` (custody receipt verified per spec §8.1; not a read claim) | delivered | yes | — |
| `rejected` (class: `not_authorized`, `invalid`, `too_large`, `participants_exceeded`, `author_unverifiable`) | failed | yes | Only after the cause changes |
| `expired` (lifetime or attempt budget exhausted) | failed | yes | **Retry missing** or **Catch up** |
| `cancelled` (owner cancel, local block or local removal) | cancelled | yes | Only after re-acceptance, which creates a new message |

A late valid receipt resolves `unknown` or `expired` to `delivered`. A late receipt for a `cancelled` obligation is recorded as "delivered before cancel" and never revives future work (review P-14).

### 9.5 Aggregates

The aggregate is `{delivered, pending, failed, cancelled}` over the **original frozen denominator**. A group shows "7 delivered · 1 pending · 1 failed · 1 cancelled", and "Delivered" means every non-cancelled obligation is delivered.

Peers admitted after the message are not in its audience and are labelled "joined after this message". The per-recipient sheet lists state, reason and next attempt. Only the owner can read status.

### 9.6 Retry missing and catch-up

**Retry missing** applies to one message's `expired` and `unknown` obligations that are still authorized. It requeues them with:

- the same event ID, body and audience;
- a fresh attempt budget of 10;
- a manual deadline of the acceptance window minus 1 h, that is 23 h for link kinds and 6 days 23 h for records.

It never re-sends delivered copies, re-adds blocked peers or creates a new message.

**Catch up** applies per peer. It requeues every in-window `expired` obligation for that peer, oldest first, retractions and edits included. It runs automatically when that host's breaker closes, or when the peer sends any authenticated record, and can also be started manually (review P-7).

**Outside the window**, the only option is "send again as a new message" (`resendOf`). For one-offs, whose window is short, the UI says so plainly.

**After a long outage.** A recipient offline longer than 7 days misses events. When it returns:

- It receives later events, with gap markers for the missing ones.
- Retractions it missed are re-sent by catch-up only while they are in the window. Beyond the window, the conversation shows "history unavailable" for gaps. Old content is never re-sent automatically (spike §7, §13).

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

- **Grouping.** The sender groups only obligations whose own verified descriptors or bindings name the same `multicast` URL on the same origin as their ingress, and whose recipients are entitled to the exact same body. One immutable body travels with at most **32** per-recipient contexts, each with its own credential and envelope.
- **Edge processing.** The host charges the batch as one request per context against per-source limits before dispatching anything. It verifies every credential at the **edge index** (spec §7.4) without waking any mailbox, with equal timing for known and unknown mailboxes (reviews S-1, S-8). Each surviving context is then admitted through its owner's own transaction.
- **Outcomes.** Each context reports `delivered` (with a custody receipt), `accepted-host` (credential verified, staged), `rejected` or `unknown`. Only a receipt makes an obligation `delivered`.
- **Recovery.** Unresolved contexts are reconciled with unchanged envelopes. Falling back to individual POSTs is limited to explicit unsupported responses or controlled recovery. A timed-out batch is never doubled automatically.

## 11. Receiving

The order puts the cheapest refusal first (contact-delivery S4, spike §9, review S-1):

1. **Edge.** Framing and size bounds, then the credential against the instance-wide **edge index** (spec §7.4).
   - Links: `{jti → owner, claimsDigest, revoked}`.
   - Conversations: digests of the expected per-pair tokens with epochs and incarnations.

   A bad credential is refused without waking any mailbox: uniform 401 `link_invalid` for links, 403 `not_authorized` for conversations.
2. **Validation.** Envelope and body validation.
3. **Author.** Delegation and author proof, with status checks where spec §3.4 requires them. Directory lookups go through a bounded-cardinality cache with pinned continuity.
4. **Admission transaction** in the mailbox: live parent or peer and incarnation, receipt budgets, the replay frontier and gaps, storage, the custody receipt, the index, the edge-index update and the activity outbox.

Receipt budgets carry over unchanged from [messaging](../spec/messaging.md) "Reference-service receipt limits" as BindleBox policy. Conversation events, edits, retractions, proposals, hellos and invitations each have their own bounded allowance. Unknown authors allocate no pending rows. Quarantine has a finite byte, count and age allowance.

## 12. Views, tags, rules and the classifier slot

**Views, tags and rules move into BindleBox** with their current semantics:

- [message views](message-views.md), including the conversation overlays;
- [tags](tags.md) for suspected tags, provenance and default promotion;
- owner rules, including single-transaction `deleteRule`.

Core keeps the generic identifier and label validation and the reusable rule machinery for activity. BindleBox starts from a copy and the two diverge ([extraction](messaging-extraction.md) §2).

**The classifier is a slot.** BindleBox is an optional `application` consumer of `item-classifier/v1` (extensibility design §7.2), calling `decide`.

**Occupant available.** BindleBox invokes the first available occupant directly through the brokered resource. The slot's `any-error` failover *permits* advancing after any error. BindleBox deliberately advances **only** after failures that prove the occupant received nothing, the pre-dispatch class of extensions §3.3. Crafted content that makes one classifier time out therefore cannot push the same text to the next occupant (review S-7). The input is normative and minimal:

- bounded text, at most 2,000 tokens, after deterministic redaction of one-time codes, `bindle_meta`/`bindle_data` values, signed URLs, bearer-like strings and conversation secrets;
- automation hints;
- **no** sender identifiers, recipients, conversation IDs or URLs.

**What gets classified.** By default only bridged email and first-contact one-offs are classified. Conversations are classified only when the owner turns that on per conversation, because their senders never agreed to third-party processing. Typed results map to `sys:suspected.*` tags through the internal `applyAutomatedTags` boundary. The model never authorizes a final tag, quarantine or deletion.

**No occupant, consent not given, or `requiresConsent`.** BindleBox shows **no** AI classification setting, "Suspected" model tag or label. Deterministic header hints on bridged email remain, labelled as header hints, and never finalize a tag.

**Disclosure** (extensions §5.1, §9.5). Consent names each occupant's origin and states: "may receive minimized text of new messages when the classifiers before it are unavailable."

### 12.1 Public request filtering and auto-rejection

User direction, 2026-10-20.

**Scope.** Filtering applies only to **public/anonymous conversation requests**, and only when the owner has enabled them. These requests are:

- bridged email arriving through `public-message-intake`;
- first contact through a conditional or public contact link: a `one-off` or `conversation-init` from a principal who is not yet an accepted peer.

Messages from accepted peers and established conversations are never auto-rejected.

**Processing.** Requests go through the ordinary classification and rule pipeline: the classifier slot when it has an occupant (§12), then owner rules. The tiers reuse the [tag model](tags.md) instead of a new mechanism:

| Tier | Mapping from classifier output | Tag result | Default rule (visible, editable, deletable) |
| --- | --- | --- | --- |
| **Very likely spam** | `spam` probability ≥ `T_high` (provisionally 0.97) | `sys:suspected.spam` with `classifier` evidence, then promoted to final `sys:spam` by `default:reject.spam`, which matches `{tagsAll:[sys:suspected.spam], source:"classifier", minProbability:T_high, request:true}` | **Auto-reject.** The request never becomes a conversation or invitation. No activity item, no push and no reply beyond the single invariant bridge auto-reply (§13, which is unchanged). The item goes to the Rejected view. |
| **Could be spam** | `T_low` (provisionally 0.70) ≤ p < `T_high` | `sys:suspected.spam` stays suspected and is never finalized by default | **Deprioritize** (`default:quiet.suspected-spam`): no activity push, sorted to the bottom of a "Requests" View. The owner can find and accept the request normally. |
| Below `T_low` | p < `T_low` | none | Ordinary request |

**Threshold pinning.** Thresholds are pinned to the occupant's `{model, version, schema}`, which `decide` results carry as evidence.

- When an occupant reports a model, version or schema different from the pinned one, BindleBox **does not silently carry the thresholds over**. It enters calibration mode: "very likely" auto-rejection is suspended, and every item at or above `T_high` is treated as "could be spam" until the new version has a pinned threshold.
- A pinned threshold comes from the host's published calibration for that model version (the 3sln.me built-in classifier publishes one), or from the owner explicitly accepting the defaults for it.
- An owner occupant change behaves the same way.
- Rules use a new `minProbability` match field. It reads the stored evidence only, and applies only to `classifier` evidence.

**Fallback with no occupant** (or consent declined, or `requiresConsent`): deterministic heuristics only.

- Header hints such as `List-Unsubscribe`, `Auto-Submitted`, a DMARC failure, or a sender address shape.
- They can yield at most "could be spam" (`sys:suspected.spam` with `heuristic` evidence) and are deprioritized.
- **There is no auto-reject by default.** An owner may write an explicit heuristic rule that rejects, but none is shipped.

**Rejected view (recoverable).** Auto-rejected requests are kept in a bounded **Rejected** View:

- the most recent 500 items, or 7 days, whichever is smaller;
- body and provenance included, counted against storage;
- not searchable by default.

"Rescue" turns an item into an ordinary request. If the request has an unexpired `returnControl`, the owner can then accept it as usual. Rescuing also offers "always allow this sender". Expired items are erased. A daily coalesced activity summary ("12 requests were auto-rejected") can be enabled; it is off by default and never lists senders.

**Owner overrides.** An allowlist of principals, and of email addresses for bridged mail (addresses are convenience matches, not identity), is evaluated before any reject rule. **Allowlisted senders are never auto-rejected**: a reject action whose target matches the allowlist is skipped and recorded in `tagHistory`. Rescuing a request may add its sender. Rules can still tag and deprioritize allowlisted senders.

**Rate limits** are layered over the existing receipt budgets (§11):

- per sender principal or sender address: 5 requests per day;
- per sender domain, for email: 50 per day;
- per owner: 200 public requests per day;
- classifier calls bounded by the owner's metered allowance. When the allowance runs out, the fallback above applies, so there is no auto-reject.

Requests over limits are refused before classification, with the ordinary `rate_limited` response for link deliveries, or held and dropped by the bridge's own budgets for email. Rejected-view writes come from a separate small reserve, so a flood cannot evict legitimate requests.

**Never revealed to the sender.**

- An auto-rejected link request still receives the ordinary custody receipt: the item is genuinely held, in the Rejected view.
- An auto-rejected invitation simply lapses at `returnControl.expiresAt`, exactly like one the owner ignored.
- Bridged email gets the same invariant reply whatever the outcome.
- No error code, header, timing class, receipt member or reply varies with tier, score, rule or allowlist state (spec §6.7).

## 13. Email bridge handoff (shared slice X12)

The provider keeps SMTP intake, MIME bounds, provenance signing, the reply gates and the auto-reply ([public email bridge](public-email-bridge.md), none of it built yet). The 3sln.me `email-bridge` feature is a provider **consumer** of `public-message-intake/v1`, and the BindleBox mailbox is the occupant (extensibility design §7.1, spec §9).

1. **Accept.** The provider accepts or refuses at SMTP time using only owner settings and account eligibility. Unknown, disabled and ineligible handles receive the identical generic refusal and **no reply**. SMTP behaviour MUST NOT vary with occupancy, occupant availability or delivery outcome (extensions §9.8, no occupancy oracle).
2. **Hold and deliver.** Accepted mail enters the bridge's bounded per-owner holding queue (count, byte and 30-day age limits). The bridge mints a brokered token and calls the occupant's `deliver` with `tx = UUIDv5(ref, contract, entity, ingress fingerprint)`.
   - With no occupant, or an unavailable one, mail waits in the queue and is delivered when one is assigned. Otherwise it expires visibly in the owner's account.
   - An indeterminate outcome at a removed occupant is reported to the owner as unknown and is never re-sent to the new occupant (extensibility design §7.1 step 5).
3. **Store.** BindleBox verifies the provenance (spec §9), then stores the message as an email-origin receipt or pending invitation with the sender unverified.
4. **Auto-reply: one invariant text.** The reply is free marketing and is kept, but its content does not depend on occupancy or disposition (reviews S-5, P-16): "This address receives messages through Bindle. Your email was received. The recipient reads Bindle messages in their messaging app, and email replies may not reach them. To start a conversation, get Bindle: <link>."
   - It is sent only for accepted mail and only when every gate passes: platform DMARC-valid `reply()`, RFC 3834 suppression, a per-sender 30-day cooldown, per-sender-domain and per-handle caps, and a dedicated lowest-priority global budget that can never starve security mail or invitation acknowledgements.
   - The owner can switch it off.
   - It never claims storage or non-delivery, so it is never false.

Intents were considered and rejected for this path: intents are browser handoffs, while this is server-to-server with a consented recipient, which is exactly what a slot is for (extensibility design, rejected alternatives).

**Reconciliation note.** The [activity center](activity-center.md) extraction table lists `apps/worker/email.mjs` and `packages/messaging/dispatcher.mjs` as moving to the messaging app. Both are core: system mail and lifecycle notices. Only bridged-item *handling* moves ([review](../release/messaging-app-review.md) R-1).

**Product change needing sign-off.** The earlier bridge design sent replies only for stored personal invitations. The invariant marketing reply goes to every DMARC-aligned sender whose mail was accepted, still under all reply gates.

## 14. Notifications through core activity

BindleBox never pushes on its own. Under its connection and an explicit activity method grant ([activity](../spec/activity.md) "Authority and submission"), it keeps **one activity item per conversation** (and one for "new contact messages"). It updates the item with `Replace` as messages arrive, with:

- the subject "3 new messages from alice@3sln.example";
- no body;
- app tags `conversation`, `contact`, `invitation` or `delivery-problem`.

When the item reaches the 32-revision cap, BindleBox retracts it and starts a new one.

This respects activity's rule that distinct admitted items remain distinct and quota-accounted, and that collapse affects notifications only. A busy mailbox costs a few items a day, not one per message (review P-9).

A replacement connection does not inherit mutation authority. After a reinstall or app switch, earlier items are orphaned and stay until the owner archives them. BindleBox says so in its settings.

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
| Stale descriptor or binding (app switched) | Links: one re-resolve. Conversation peers: `retry_scheduled(moved)` until the new occupant's `ingress` or `rejoin` record arrives, then catch-up. |
| Recipient uninstalls mid-conversation | The provider revokes the occupant's delegation at once, so its receipts stop verifying (it cannot pose as custody). Descriptors return `recipient_unavailable` (503, retryable). Peers' obligations retry and then expire, the conversation shows "X's messaging app is unavailable", and catch-up runs when X returns. Nothing is dropped silently. |
| Sender uninstalls with obligations queued | The uninstalled app's delegation is revoked, so it stops sending. Its signed manifest lease lets a later occupant import the `outbox` segment and resume within the deadlines. Earlier activity items are orphaned (§14). |
| Recipient switches apps | The owner pre-selects the same storage resource in the switch flow. The new occupant takes the archive writer lease (which fences the old app), verifies the signed manifest, imports control state first (blocks, tombstones, replay, frontiers), then peers, stream heads, outbox and items. It sends `rejoin` to every peer, regaining secrets and fresh incarnations, and shows the owner the links issued under the old app with bulk revoke and reissue. Traffic is admitted as soon as control state is restored. Intake configuration and quota counters carry over in the archive. |
| Recipient's provider lacks `extensions.v1` or the messaging slot | No descriptor exists. The sender sees "This person's provider doesn't support Bindle messaging" before composing. |
| Own provider lacks `key-delegation.v1` | BindleBox cannot sign. Sending, receipts and archive signing are unavailable, and installation says so. |
| Directory profile missing (cross-host) | The descriptor's `verifies` and the sender's own capability are checked before composing: "Messages between example.org and 3sln.me can't be verified yet." Nothing is sent and then refused. |
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
| Block/re-accept, key continuity, rotation disagreement, late events | §4.3, §7.5; spec §6.3 (streams per key), §6.5, §6.6. |
| Group, event, dependency, attachment, expanded-work and pending bounds; protective reserve | §7.7, §8, §10, §11; spec §11. |
| Replay, receipt and tombstone retention with restore rules | Spec §8.2, §10: 7-day window; receipts and fences kept 9 days and exported; bounded gap exceptions; anti-resurrection state kept for the conversation's life; control state imported first; pre-checkpoint envelopes admitted only from the imported replay set. Offline replicas learn markers through catch-up while in the window, and see "history unavailable" after it (§9.6). New peers start at the counter in their `peer-hello`. |
| Plaintext custody, delivery metadata, scoped status, safe logging, social signals off | §16. |
| SMTP provenance, pre-acceptance refusal, bounded replies, no conversion to signed authorship | §13; spec §9. Email-origin items are never author-signed, and a sender becomes a participant only through the bridge's mailbox-confirmation and identity flow. |

P1 items (real-adapter queue recovery, browser verification of counts and resets, cross-host failure scenarios, abuse budgets, D1–D4 sign-off) become implementation gates in [extraction](messaging-extraction.md) §6. P2 items (enabling multicast, tuning, relays, MLS) stay deferred.

## 19. Open questions for the user

1. **Name:** BindleBox?
2. **Delegation lifetime:** certificates of at most 24 h, with status checks required for lasting-effect records and receipts but not for plain messages? The alternative is shorter certificates and more renewals.
3. **Marketing auto-reply:** one invariant reply to every gated sender of accepted public email, regardless of occupancy (§13). This is required by extensions §9.8; the owner can opt out. Acceptable?
4. **Conversation gate:** keep the shared secret (option A, the earlier preference), or drop it for identity plus bilateral admission (option C)?
5. **Bundled instance:** offer BindleBox as an opt-in default occupant at signup (recommended), or require explicit installation?
6. **Public native ingress:** should the handle accept Bindle-native messages from strangers in v1, or only bridged email (recommended: email only)?
7. **Auto-rejection thresholds** (§12.1): are the provisional `T_high` 0.97 and `T_low` 0.70, with calibration mode on model change, acceptable?
8. **Reset:** accept discarding all existing local messages, contacts and conversations at cutover ([extraction](messaging-extraction.md) §4)?
