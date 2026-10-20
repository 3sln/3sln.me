# Messaging scaling and federation failure research spike

Date: 2026-10-20. Status: research and provisional recommendations only. Protocol/security reviewer: ___ / date: ___ / outcome: ___. Architecture/operations reviewer: ___ / date: ___ / outcome: ___. Product/privacy reviewer: ___ / date: ___ / outcome: ___. No sign-off, implementation, capacity measurement, external-service verification or release approval is implied.

## Scope and reading of the current design

The [2026-10-20 scope reduction](../../DEVLOG.md#2026-10-20--scope-reduction-messaging-leaves-core-manifest-extensions-activity-stays) moves peer messaging out of Bindle core and 3sln.me into a separate app and interop specification. [NOTES.md](../../NOTES.md) asks for participant limits, queued sends, per-recipient progress/resend and optional host multicast. This spike supplies research for that app. It does not add messaging obligations to the core manifest or activity system.

The baseline is URL-identified peers on different hosts, identity-signed immutable events, shared conversation possession secrets, recipient-local admission, independent owner copies and HTTP POST delivery per recipient. The reference host uses account-local Cloudflare Durable Objects (DOs); that partitioning is not an interoperable room authority. Providers currently remain trusted with plaintext and signing material: a shared authorization secret, TLS and encrypted archives do not establish end-to-end encryption (E2EE).

The input documents disagree in material ways:

| Input | What this spike takes from it | Reconciliation needed in the future app spec |
| --- | --- | --- |
| [Contact delivery](../spec/contact-delivery.md) | Separate author proof, delivery authority, admission receipt and replay identity. | Candidate profiles and local implementation notes are not cross-host conformance evidence. |
| [Conversations](../spec/conversations.md) | Useful durable fan-out, idempotency and status requirements. | Its central authority, canonical sequence and global membership revisions conflict with the later independent-replica proposal. Do not combine their guarantees. |
| [Links](../spec/links.md) | Versioned capability interpretation, explicit consent and identity requirements. | Messaging extraction must identify which link/introduction semantics belong to the app; opening a URL cannot enqueue a send or subscribe. |
| [Conversation/contact design](../architecture/conversation-contact-design.md) | Independent author streams, causal references, directed approvals, owner copies, immutable edits and sender tombstones. | This is the working design assumption, not an approved or fully implemented replacement protocol. |
| [Public email bridge](../architecture/public-email-bridge.md) | Bounded, opt-in SMTP ingress with provenance and safe acknowledgements. | Under the scope reduction this is a messaging-app adapter, not a new core inbox. Provider features require separate verification. |

Per the task restriction, the research record and unsigned recommendations stay in this new file; DEVLOG.md and existing documents are untouched. A later authorized design task should reconcile decisions in DEVLOG.md. The [existing security/release gates](../spec/security.md) remain in force, and the loopback-only `dev:demo` is not evidence for a public messaging API.

## Evidence and method

Web search and primary-source browsing were available. Sources below are protocol specifications, implementer documentation/source, first-party operational reports and original research. Historical reports are dated deliberately: an old failure is evidence of a failure mode, not a claim that today's software still has that bug. Mutable implementation links, especially Mastodon `main`, describe the source inspected for this spike and are not stable interop contracts. Standards describe documented limitations even where no particular outage is cited. Inferences and app recommendations are identified separately from observed incidents.

This was a documentation review, not a fresh runtime audit. Repository implementation statements below are attributed to the input drafts; no code, external configuration or production deployment was verified. No benchmarks or executable tests were run.

## What other systems encountered

### Email/SMTP: durable responsibility, bounces and backscatter

**Pain and mitigation.** SMTP distinguishes temporary refusal from permanent refusal and transfers responsibility when a server accepts a message. An uncertain final acknowledgement can lead to a duplicate on retry. It uses store-and-forward queues, delayed retries and eventual non-delivery reports; error messages use an empty reverse path to prevent bounce loops. These are long-standing protocol realities, not exactly-once delivery. [RFC 5321 §§4.2.5, 4.5.4–4.5.5](https://www.rfc-editor.org/rfc/rfc5321.html)

Delivery Status Notifications have per-recipient results, including delayed and failed outcomes, because one submission can succeed for some recipients and fail for others. [RFC 3464 §2](https://www.rfc-editor.org/rfc/rfc3464.html#section-2)

Automatic replies to forged return addresses can flood uninvolved people: backscatter. RFC 3834 documents this abuse and recommends suppression, loop prevention, bounded replies and `Auto-Submitted` handling. SMTP refusal during the transaction avoids creating a new unsolicited response. [RFC 3834 §§2, 3, 6](https://www.rfc-editor.org/rfc/rfc3834.html)

**Applicability and recommendation.** High for HTTP queues and the email bridge. A local send receipt transfers only local responsibility; recipient durable admission needs its own receipt. Report failures to the authenticated sender's outbox. Never generate failure messages to an arbitrary address or callback supplied in incoming content. The bridge should refuse disabled/unknown recipients before acceptance and suppress unsafe marketing acknowledgements.

### Email/SMTP: greylisting and authentication through intermediaries

**Pain and mitigation.** Greylisting delays unfamiliar senders and relies on retry. RFC 6647 records repeated deferrals when receiving servers do not share greylist state, sending IPs change, or clients alter identifiers between retries; some senders fail to retry correctly. Shared state, suitable exception policies and correct transient-error handling reduce the damage. [RFC 6647 §§2, 4](https://www.rfc-editor.org/rfc/rfc6647.html)

DKIM authenticates responsibility by a signing domain, which is distinct from the purported human author. [RFC 6376 §1](https://www.rfc-editor.org/rfc/rfc6376.html#section-1) Forwarding can invalidate SPF, and mailing-list modifications can break DKIM; DMARC policy can consequently reject legitimate indirect mail. [RFC 7960 §§3–4](https://www.rfc-editor.org/rfc/rfc7960.html) ARC carries authenticated assessments through intermediaries, but validating a chain does not establish trust in its sealers or prove a human identity. [RFC 8617 §§7, 9 and Appendix A.2](https://www.rfc-editor.org/rfc/rfc8617.html)

**Applicability and recommendation.** Direct for bridge provenance, analogous for federation load balancing. Keep retry identities stable across workers and use shared recipient dedup state. Prefer explicit admission/rate limits to deliberate greylisting of established peers. Store trusted ingress authentication assessments separately from attacker-supplied headers; label imported email as email provenance, not an identity-signed app message. Mailbox confirmation and explicit identity binding remain necessary for joining.

### XMPP: reconnects, archives, room floods and attachments

**Pain and mitigation.** Mobile stream failures leave uncertainty about handled stanzas. XEP-0198 adds acknowledgements/resumption but explicitly allows duplicates and distinguishes stream acknowledgement from end-to-end receipt. [XEP-0198 §§4–5, 8](https://xmpp.org/extensions/xep-0198.html) Archive synchronization can overlap offline delivery; XEP-0313 uses archive IDs, pagination and synchronization rules and acknowledges that a server may suppress redundant offline copies. It also replaced a more complex archive extension after implementation experience. [XEP-0313 §§1–3, 6](https://xmpp.org/extensions/xep-0313.html)

MUC centralizes a room at a service, broadcasts presence/messages and exposes occupant/history limits. [XEP-0045 §§7.2, 7.4, 15](https://xmpp.org/extensions/xep-0045.html) Prosody's `mod_muc_limits` documents malicious and accidental room floods and limits joins, nickname/status changes and messages at room scope. Its exemption for affiliated members is a deployment choice, not a safe assumption for our admitted peers. [Prosody module documentation](https://modules.prosody.im/mod_muc_limits)

Peer-to-peer file transfer works poorly for multiple recipients/devices and offline history. XEP-0363 separates upload from messaging and advertises upload bounds; it also warns that downloads reveal client IPs to the file service. [XEP-0363 §§1, 3, 9](https://xmpp.org/extensions/xep-0363.html)

**Applicability and recommendation.** High for durable reconciliation, limits on all event types and separate media transfer. Adopt stable event IDs and paged sync. Do not equate an HTTP hop acknowledgement with durable owner storage or copy XMPP's room-service authority into a design that intentionally has no room coordinator. Do not exempt accepted members from work limits.

### Matrix: room DAGs, state resolution and the big-room problem

**Pain and mitigation.** Matrix events reference predecessors to form a room DAG; independently received branches need deterministic state resolution and authorization checks. Origin homeservers broadcast persistent events to other homeservers in the room, rather than sending a separate federation request for each remote user. Host diversity therefore matters alongside membership count. Federation uses bounded server-to-server transactions with transaction identities and individual PDU results. A transaction HTTP 200 can contain failed PDUs. [Matrix v1.16 Server-Server API, Transactions, PDUs and Room State Resolution](https://spec.matrix.org/v1.16/server-server-api/)

In August 2022, Matrix reported roughly 80,000 state events and 126,000 authorization-chain events for Matrix HQ, with remote joins taking many minutes. Partial-state/faster joins moved much of that synchronization out of the foreground. These are historical figures for that room and implementation. [Matrix Summer Special, 2022](https://matrix.org/blog/2022/08/15/the-matrix-summer-special-2022/) The 2023 Synapse faster-joins release documented incremental background synchronization and client support requirements. [Synapse 1.76 release](https://matrix.org/blog/2023/01/31/synapse-1-76-released/)

State-resolution problems were also security problems: delayed federation could roll state back, including membership/access control. Project Hydra's 2025 coordinated release changed state resolution and room semantics; it cites real state resets in public rooms. [Project Hydra disclosure, 2025-08-14](https://matrix.org/blog/2025/08/project-hydra-improving-state-res/)

**Applicability and recommendation.** Causal history, authorization dependencies, federation fan-out and join costs apply. Matrix's exact global room-state algorithm does not: our later proposal intentionally permits different local accepted-peer sets. Keep local revocation authoritative; do not merge a late remote event into broader permission. Bound parent/dependency work, bootstrap from authenticated frontiers and avoid downloading an entire lifetime of membership churn before displaying new messages. A deterministic display order is not agreement on a universal roster.

### ActivityPub/Mastodon: fan-out, dead instances and key caches

**Pain and mitigation.** ActivityPub explicitly describes overwhelming delivery counts on hosts with many actors and defines optional `sharedInbox` delivery for appropriate audiences. It also specifies deduplication/retry behavior and acknowledges that remote deletion cannot be enforced. [ActivityPub §§5.2, 7.1, 7.1.3, 7.4](https://www.w3.org/TR/activitypub/)

Mastodon separates local, outbound federation and inbound processing queues and documents that queue priorities can starve lower-priority work. [Mastodon scaling documentation](https://docs.joinmastodon.org/admin/scaling/) Its inspected delivery worker has bounded retries, custom jitter and a circuit breaker; the failure tracker skips unavailable domains and clears failures on success. These are implementation mitigations, not ActivityPub guarantees. [Delivery worker source](https://raw.githubusercontent.com/mastodon/mastodon/main/app/workers/activitypub/delivery_worker.rb), [failure tracker source](https://raw.githubusercontent.com/mastodon/mastodon/main/app/lib/delivery_failure_tracker.rb)

Cached signing keys can become stale. Mastodon v4.4.0's verification source retries verification after refreshing the remote actor key and bounds failing fetches with a circuit breaker. This documents key-refresh behavior, not authenticated key continuity for every deployment. [Versioned signature-verification source](https://raw.githubusercontent.com/mastodon/mastodon/v4.4.0/app/controllers/concerns/signature_verification.rb)

**Applicability and recommendation.** Very high: HTTP delivery, cached identities and abandoned hosts closely match our transport. Use queue isolation, per-host health and bounded refresh. A batch success cannot substitute for each recipient's receipt, and refreshed discovery cannot silently replace a pinned identity key. Reserve recovery probes so a dead-host marker does not permanently strand a recovered host.

### Signal and MLS: sender keys are not a transport solution

**Pain and mitigation.** Original research describes deployed Signal/WhatsApp group messaging using individual sender keys distributed to other members, rather than one common group encryption key. [Balbás, Collins and Gajland, Sender Keys analysis](https://arxiv.org/abs/2301.07045) RFC 9420 explains that distributing fresh keys for all senders after compromise can require quadratic key-update traffic; tree-based updates reduce key-establishment work toward logarithmic paths while supporting forward secrecy and post-compromise security. It does not make delivering ciphertext to every recipient free. [RFC 9420 §§1, 3, 16](https://www.rfc-editor.org/rfc/rfc9420.html)

MLS has a linear epoch history. Concurrent commits need a delivery/application reconciliation strategy; distributed direct delivery does not automatically give every member the same next epoch. The architecture describes both consistent and eventually consistent delivery services and desynchronization recovery. [RFC 9750 §§5.2–5.3](https://www.rfc-editor.org/rfc/rfc9750.html)

Signal's earlier private-group design described inconsistent client-distributed group updates and introduced encrypted group state with access control. [Signal private group system, 2019](https://signal.org/blog/signal-private-group-system/) Sealed sender separately addresses delivery metadata and uses recipient delivery tokens to control abuse. [Signal sealed sender, 2018](https://signal.org/blog/sealed-sender/)

**Applicability and recommendation.** Group churn, secret distribution and offline key state apply now. E2EE properties do not apply to our provider-readable possession secret. Keep identity signing keys, possession epochs and any future encryption keys distinct. Evaluate MLS as a separately reviewed E2EE profile, including its membership/epoch agreement requirements; it is not a drop-in implementation of divergent local consent. Sender-key encryption amortizes cryptography, not HTTP fan-out or recipient storage.

### Bluesky/AT Protocol: relays, firehose costs and resynchronization

**Pain and mitigation.** In November 2024, Bluesky reported over 2,000 events/second multiplied by hundreds of firehose subscribers becoming difficult for a single server. It increased capacity and introduced Rainbow fan-out services. The report is historical and explicitly superseded by later relay work. [Relay Operational Updates, 2024](https://atproto.com/blog/relay-ops) Jetstream reduced consumer complexity/bandwidth using filtering and simpler events, but omitted cryptographic verification material. [Introducing Jetstream, 2024](https://atproto.com/blog/jetstream)

The January 2026 relay-transition notice warned of sequence jumps and duplicate events under new sequence numbers. [Upcoming Relay Transition, 2026-01-24](https://atproto.com/blog/relay-rollout) Sync distinguishes relay cursors from account revisions and defines desynchronized repository recovery. [AT Sync specification](https://atproto.com/specs/sync) The Tap announcement explicitly describes fragile recovery and the difficulty of joining backfill to live delivery. [Introducing Tap](https://atproto.com/blog/introducing-tap)

**Applicability and recommendation.** Useful for host multicast, SSE reconnects and background sync; the public firehose itself is unsuitable for private conversations. Scope cursors to a stream incarnation, deduplicate by authenticated event identity, and offer snapshot/reconciliation when a cursor expires. Optional relays must preserve original proofs, carry only entitled traffic and never become mandatory global room authorities. A filtered notification stream may prompt a fetch; it cannot replace the verified durable log.

## Design consequences by topic

All recommendations in this section are inferences for the messaging app, not claims that the cited systems implement this exact design. Each topic identifies the documented pain/mitigation above, its relevance and concrete next design work.

### 1. Group size limits and per-recipient fan-out cost

**Pain/mitigation elsewhere:** MUC caps occupants/events; Matrix reduces large-room bootstrap work; ActivityPub and AT deployments amortize distribution by host or relay. Limits on just message body size do not bound delivery or membership churn.

**Applies:** directly. Let `n` be eligible remote recipients in one immutable sender snapshot, `h` their destination hosts, `b` immutable body bytes, `a` mean attempts per recipient and `r` posts/second across the group. Direct delivery costs approximately `n × a` POST attempts/event and `n × b` body bytes/event without retries. A working host batch can reduce requests/body uploads toward `h × a` and `h × b`, plus O(n) recipient envelopes/results. It still entails O(n) authorizations, owner writes and receipts. With every member posting at a fixed rate, aggregate deliveries grow quadratically with membership; at fixed aggregate group rate they grow linearly. Directed admission state can also total O(n²) across n replicas while each replica holds O(n).

Illustrative arithmetic, excluding protocol overhead, attachments and retries:

| Remote recipients | Hosts | Aggregate posts/s | Direct POSTs/s | Batched POSTs/s at one batch/host/event | Stored recipient copies/day |
| --- | --- | --- | --- | --- | --- |
| 32 | 4 | 1 | 32 | 4 | 2,764,800 |
| 256 | 16 | 1 | 256 | 16 | 22,118,400 |
| 1,000 | 1,000 | 1 | 1,000 | 1,000 | 86,400,000 |

**Recommendation:** begin with small groups; 32 total participants is a candidate initial ceiling consistent with a bound mentioned in the architecture draft, not a measured safe capacity. Define sender audience limits, incoming author limits and room proposal/churn limits separately because no universal roster exists. Advertise host limits without promising throughput. Budget posts, recipient obligations, bytes, attempts and pending state; benchmark 8/32/128/256-member cases with one host, several hosts and one host per participant. Large public rooms need a separate distribution/governance profile.

### 2. Shared or host-level multicast inboxes

**Pain/mitigation elsewhere:** ActivityPub shares an inbox; Matrix batches host transactions; AT fan-out services reduce upstream subscription load. They change transport topology, not the existence of downstream work.

**Applies:** valuable when `h` is much smaller than `n`. It adds a host-level ingress/queue and can amplify one cheap request into many account DO calls.

**Recommendation:** specify an optional, versioned messaging-app capability discoverable through the eventual extension mechanism. Do not add a core manifest field in this spike. A proposed flow:

1. Group only exact, independently admitted recipient resources whose authenticated discovery binds the same batch endpoint. Never infer authority from a common URL suffix or shared IP/CDN.
2. Send one immutable signed event plus a bounded list of recipient-specific signed delivery contexts/credentials. Each context binds event digest, exact recipient, admission incarnation and accepted epoch. Include no other host's credentials or private recipient settings. Batch only recipients entitled to these exact bytes.
3. Apply byte, entry-count and expanded-work admission before dispatch. Validate each recipient's live consent and quota through its owner transaction. Shared verification/body staging may be amortized, but no cross-DO atomic commit is assumed.
4. Return bounded, authenticated per-recipient outcomes. Distinguish durable host staging (`accepted-host`) from durable owner admission (`accepted-recipient`). A 202 or overall 2xx without the latter receipts leaves recipients pending. Unknown entries are not successes.
5. On partial processing, restart or lost response, retry/reconcile unresolved recipients with unchanged event IDs. Fallback to individual POST only for an explicit unsupported capability or controlled recovery; both paths share recipient deduplication. Do not double every timed-out batch automatically.

Cache capability results briefly, bind them to a discovery generation, and invalidate safely after migration. No provider-wide scan, arbitrary collection expansion, remote forwarding or recipient enumeration is allowed. An encrypted-message future profile must account for per-recipient key envelopes and padding; identical plaintext is not a reason to weaken future privacy.

### 3. Per-recipient delivery status and resend UX

**Pain/mitigation elsewhere:** SMTP DSNs report individual failures; XMPP distinguishes acknowledgement scopes; Matrix batch 200 responses can contain event errors.

**Applies:** essential. Local queue acceptance, host staging, recipient custody, device synchronization and human reading are different events.

**Recommendation:** atomically commit the immutable event, original eligible audience and all obligations before returning `accepted-local`. Persist per-recipient status and authenticated evidence, with monotonic status revisions:

| State | Meaning / sender action |
| --- | --- |
| Not sent: awaiting approval | No delivery obligation exists for this proposed peer; keep visibly separate from the accepted denominator. |
| Queued / retry scheduled | Durable obligation; show next attempt and expiry. |
| In progress / outcome unknown | An attempt may have committed remotely; reconcile/retry the same event. |
| Delivered to provider | Valid receipt for this recipient's durable owner copy and declared attachment scope; no read claim. |
| Rejected | Permanent policy/admission/protocol refusal; offer explanation/remediation where disclosure is allowed. |
| Retry exhausted / expired | Automatic delivery stopped; show partial outcome and any safe manual action. |
| Cancelled locally | Future attempts stopped; already transferred or remotely committed bytes cannot be recalled. |

For 10 original obligations, show “7 delivered, 2 pending, 1 failed”; separately show peers awaiting admission. Never remove a failure from the denominator after a membership change. Late valid receipts can resolve uncertainty without reviving cancelled future work. “Retry missing” selects only unresolved, still-authorized obligations and retains IDs/body/audience. It does not re-send successful copies, re-add a blocked peer, reset budgets or create a new message. Beyond the replay horizon, offer reconciliation or explicit composition as a new message. SSE is a view over durable state; reload/poll must recover it.

### 4. Queueing and backoff

**Pain/mitigation elsewhere:** SMTP queues survive outages; Mastodon separates queue classes and adds jitter; AT consumers need durable cursor recovery. Large priority queues can starve other work.

**Applies:** directly to a per-account DO. Holding a foreground request open for all destinations creates latency and makes client disconnects operationally significant.

**Recommendation:** maintain durable due-time obligations with bounded batches, attempt leases/fencing and a finite retry/dead-letter lifecycle. Keep account transactions short; perform network I/O outside them and recheck generation/consent before recording results. Reserve queue/byte/work capacity at append so overload refuses new sends before promising delivery. Retain local body references until obligations resolve or expire. Use weighted fairness across conversations, senders and hosts; reserve bounded control capacity for leave/block/key recovery rather than unbounded high-priority work.

Classify failures: network timeout/reset, 429 and appropriate 5xx are retryable; valid typed permanent refusal is terminal. A 401/403 can justify one bounded credential/discovery repair, not indefinite retry or automatic approval. A 413 requires an explicit size/capability remedy; redirects never justify forwarding credentials. Honor valid `Retry-After` as a lower bound. Malformed or excessive delays must not wrap into immediate retries; if the requested delay exceeds the delivery deadline, expire/pause visibly instead of retrying early. Use capped exponential delay with jitter, a minimum spacing and finite attempt/age/byte budgets. Persist `nextAttemptAt`; restarts and manual actions cannot reset backoff.

### 5. Dead or slow hosts and circuit breakers

**Pain/mitigation elsewhere:** Mastodon tracks unavailable domains and uses circuit breakers. Retrying dead destinations indefinitely consumes capacity needed by reachable recipients.

**Applies:** very high; self-hosts may vanish, lose DNS/TLS or return after months. Many accounts on one provider share an outage.

**Recommendation:** use per-endpoint breakers with bounded host-level coordination for correlated transport failures; account-specific blocks/429s must not automatically mark a whole provider dead. Bound connection, TLS, header, body and total attempt time, including trickling/oversized responses. Cap host concurrency and aggregate retry probes across account DOs without creating one global per-message sequencer. Use expiring breaker state and a bounded half-open probe; recovered hosts receive a paced backlog. Open breaker means deferred/unreachable, not delivered or globally deleted. Show paused-host status and expiry. DNS ownership changes and recovered URLs still require identity/key continuity and current admission.

### 6. Ordering and causality

**Pain/mitigation elsewhere:** Matrix uses a DAG and state resolution; XMPP archives define local order; AT relay sequences change across streams. Arrival order and timestamps cannot establish a universal order.

**Applies:** directly, but global Matrix-style membership state is intentionally absent.

**Recommendation:** bind per-author counter/predecessor, bounded causal parents and operation ID into immutable signed content. Serialize the author's initial multi-device submissions at its owner resource; independently offline device streams need a separate profile. Preserve concurrent events and use a deterministic topological display rule with a stable tie-break only for the same validated event set. Maintain local pagination cursors separately. Missing parents get bounded placeholders/reconciliation, not unbounded recursive fetches. New members need authenticated frontiers/header proofs that do not expose old bodies. Detect conflicting signed author successors as equivocation; do not pick by timestamp. A host batch or SSE cursor never becomes global causal authority.

### 7. Edits/deletes across hosts

**Pain/mitigation elsewhere:** ActivityPub propagates updates/deletes but cannot enforce remote erasure; delayed branches in replicated histories can restore stale state if handled incorrectly.

**Applies:** directly. Our product additionally requires inspectable immutable edit history and sender tombstones, which differ from a promise to purge every recipient copy.

**Recommendation:** author-signed edits bind target digest/revision and form immutable history; sender deletion is a signed marker. Deliver these mutations with ordinary durable obligations and status. A tombstone received before its body suppresses body-fetch initiation; it must not fetch deleted bytes just to complete a chain. Preserve minimal anti-resurrection state after local erase, including across backup restore. Recheck tombstones before starting delayed transfers, while acknowledging in-flight races. Former members may receive a narrowly authorized marker for content already held only if policy permits; they gain no new history grant. Define how offline replicas learn markers after retry expiry. UI must distinguish sender deletion, owner-local erase, unavailable history and provider removal.

### 8. Membership changes and key rotation

**Pain/mitigation elsewhere:** Signal improved group-state consistency; sender-key designs pay redistribution cost; MLS explicitly handles epoch evolution and concurrent commits. Key-cache refresh alone does not prove continuity.

**Applies:** central to the design. Separate local acceptance/revocation, identity-key continuity, shared possession epochs and any future encryption epochs.

**Recommendation:** recipient-local block/revoke wins over queued delivery, replay and forwarded content from that original author. A fresh acceptance creates a new admission incarnation; old cancelled obligations stay cancelled. Freeze the event audience at local acceptance, but recheck live authority before each attempt/admission. Do not assert global expulsion: other owners may retain their own relationships. Old copies cannot be revoked retroactively.

Distribute new possession secrets over independently authenticated approved channels. Bound coexistence of old/new epochs, pending proposals and recovery work; show incompatible accepted epochs as a delivery problem. Conflicting rotations need explicit local selection/reconciliation, not permanent acceptance of every branch. Immutable content identity should survive renewal of a recipient-specific transport proof. Historical signing keys verify retained history but cannot authorize fresh acquisitions after known revocation. Refresh unknown keys under bounded caching and authenticated continuity/recovery rules; never trust an embedded replacement key. Before adopting MLS, decide how a shared cryptographic roster coexists with directed consent, how commits agree, and how offline devices recover without indefinite old-key retention.

### 9. Spam and abuse at scale

**Pain/mitigation elsewhere:** SMTP authentication and greylisting address different pieces of abuse; Prosody limits floods; Signal uses recipient delivery tokens. A cryptographically valid sender can still be abusive. Bluesky's 2024 moderation report documents millions of labels and operational reporting/appeal work. [Bluesky 2024 Moderation Report](https://bsky.social/about/blog/01-17-2025-moderation-2024)

**Applies:** high, including attacks by accepted peers and cheaply created identities. Real identity verification is not a resource budget or content guarantee.

**Recommendation:** apply cheap framing/credential checks before expensive parsing, remote key fetches, signature/decompression work, storage allocation and DO wakeups. Layer account, contact/admission, conversation, host and aggregate infrastructure limits; an attacker cannot replenish allowance by minting a token or rotating an alias. Bound invitations, joins, edits, reactions, reports, notification generation and optional classification independently. Quarantine gets a finite byte/count/age allowance, not a free shadow inbox. No unknown author may allocate unlimited pending rows. Classifier output is an advisory category and never grants identity or membership. Keep the app usable with no AI slot, and coalesce rejection alerts to avoid reflecting the attack to its victim.

### 10. Replay and deduplication

**Pain/mitigation elsewhere:** SMTP final-ACK ambiguity, XMPP resumption/archive overlap and AT relay transitions all produce duplicates. Stable identifiers and durable reconciliation mitigate them; timestamps alone do not.

**Applies:** unavoidable with retries and multicast fallback.

**Recommendation:** key event dedup by conversation incarnation, author identity/stream and stable event/operation identity; bind an immutable payload digest. Keep recipient admission incarnation and transport-attempt identity separate. Same ID/different digest is a conflict. Recipient commit atomically includes content/accounting, dedup receipt and notification/index outboxes. Replaying cannot charge storage again, emit another push or recreate an erased message; live authorization still gates cached-receipt disclosure. A repeated network attempt may consume bounded ingress work even when it causes no new durable effect. Preserve dedup across Node/Worker restart, cold restore, host multicast and endpoint migration. Define the supported horizon and compact signed frontiers with gap exceptions/tombstones; a bare largest-seen counter would incorrectly discard missing earlier events. Beyond the horizon require explicit reconciliation.

### 11. Clock skew

**Pain/mitigation elsewhere:** signed HTTP requests can fail freshness checks when hosts disagree on time. RFC 9421 discusses replay, creation/expiry and nonce policy; signatures alone do not prevent replay. [RFC 9421 §§2.3, 7](https://www.rfc-editor.org/rfc/rfc9421.html)

**Applies:** directly to proof validity, retry scheduling, expiry and fixed-window quotas, not just display time.

**Recommendation:** publish a finite skew tolerance and a machine-readable clock-error category with bounded diagnostic time. Use receiver-local time for admission/deadlines and monotonic elapsed timers for active waits; persist deadlines and fence rollback so restarts cannot reset budgets or revive revoked authority. Do not order edits/membership by sender timestamps or trust them as proof of pre-revocation sending. Keep immutable author content independent from short-lived transport freshness so an authorized offline retry can acquire a fresh delivery proof without rewriting history. Never fix clock failures by silently widening the replay window indefinitely.

### 12. Large attachments

**Pain/mitigation elsewhere:** XMPP moved multi-recipient/offline transfers to HTTP upload; recipient downloads still incur bandwidth, custody and privacy costs. A shared URL can expire or disappear with its host.

**Applies:** direct; copying a 20 MiB attachment to 32 owners is roughly 640 MiB of retained recipient bytes before overhead, even if the sender uploads only once per destination host.

**Recommendation:** use immutable digest/length/MIME references, separately bounded staging reservations, streaming verification and resumable transfer. Enforce decoded bytes, decompression ratio, MIME depth/parts, image pixels and parser work, as well as wire size. A message receipt declares whether attachment custody is complete; “delivered” for a required attachment needs durable verified owner custody or an independently durable authorized retention reference. An expiring sender URL is only a fetch opportunity. Fetch only admitted endpoints with SSRF/DNS/redirect controls, never arbitrary signed URLs from content. Prevent cross-tenant dedup existence probes. Track partial transfers/orphans, reserve quotas before fetching and perform bounded GC. Sender deletion must not remove a recipient's owned reference; previews must not bypass safe-media handling.

### 13. Offline recipients

**Pain/mitigation elsewhere:** XMPP separates offline storage from archive sync; MLS requires catching up with key state; AT backfill has a finite window. Being offline longer than retained history cannot be repaired by a socket reconnect alone.

**Applies:** distinguish device offline/host online from provider offline. The first should not prevent provider custody; the second prevents a recipient ACK.

**Recommendation:** retain a durable owner copy independently of the browser/push service. Push and SSE only signal that state changed. Expose authenticated paginated catch-up with cursor incarnation, gap markers and a snapshot/reset path. Retrying a provider outage is finite and funded by the sender's queue budget. After expiry, keep an honest failed/unknown outcome and offer authorized reconciliation. Returning after months may require renewed admission/key state and explicit history sharing; it cannot silently restore blocked access. A recovered device's old archive must not overwrite current revocation or local erase evidence. Never claim offline-device delivery or reading from a host receipt.

### 14. Storage growth

**Pain/mitigation elsewhere:** Matrix accumulated substantial membership/auth state; XMPP archives expose retention; AT relay storage depends on its replay window. Keeping every event forever multiplies content, indexes, receipts and backup costs.

**Applies:** high because every owner keeps a copy, transparent edits add history and outbox obligations add O(n) metadata per event.

**Recommendation:** account separately for content, attachment custody, edit/reaction history, tombstones/frontiers, receipt/outbox state, search indexes, encrypted archive overhead and cleanup debt. Publish finite retention and replay horizons. Segment cold data with authenticated checkpoints; avoid whole-history rewrites and polling every idle account. Reserve essential space/work for leave, block, erase and anti-resurrection evidence even at quota exhaustion. Compact only after preserving unresolved delivery obligations and gap/erasure proofs. Restores must restore control generations alongside data and reconcile newer controls before accepting traffic. Owner erase, sender tombstone, outbox expiry and physical garbage collection are distinct operations. Meter bucket operations and wakeups as well as logical bytes.

### 15. Moderation

**Pain/mitigation elsewhere:** Mastodon provides account/domain-level restrictions; Bluesky separates service enforcement from additional user-selected moderation labels. Neither model provides universal deletion across independently run hosts. [Mastodon moderation actions](https://docs.joinmastodon.org/admin/moderation/), [Bluesky stackable moderation](https://bsky.social/about/blog/03-12-2024-stackable-moderation)

**Applies:** directly, with extra care for private content. Recipient control is necessary but does not eliminate provider responsibility or organized cross-host harassment.

**Recommendation:** define owner block/mute/quarantine, host abuse refusal and optional group governance as different scopes. Include reports, appeal/remediation state and audit evidence with finite retention. Cross-host reports disclose only deliberately selected evidence; do not forward full private history, credentials or unrelated participant lists to a labeler. Provider-level refusal yields an explicit sender outcome without exposing private reasons. Third-party labels are advice under chosen policy, not authority to mutate consent or revoke identity. If public managed rooms later require shared bans, specify their authority/partition semantics in another profile. The current directed-consent model cannot promise unanimous community enforcement.

### 16. DoS amplification through fan-out

**Pain/mitigation elsewhere:** room floods, follower delivery and relay subscriptions multiply one input. ActivityPub specifically discusses federation DoS and rate limiting. [ActivityPub security considerations B.7–B.9](https://www.w3.org/TR/activitypub/#security-considerations)

**Applies:** critical for batch ingress, group invitations, missing-parent fetches, key refresh, receipts and public email auto-replies.

**Recommendation:** charge admission for expanded work: recipient count, attempted bytes, signature/key lookups, DO dispatches and generated notifications. Bind destinations to verified admissions; an incoming group list is not permission to contact those URLs. Do not let a receiver recursively fan out to everyone or fetch unbounded causal/auth chains. Cap delegation/forwarding depth and expanded destinations; cache verified public data without creating an attacker-controlled cache-cardinality sink. Rate-limit control traffic and half-open probes too. No receipt-of-receipt, bounce-to-bounce or classifier-alert loop. A cheap batch request must reserve the same recipient work allowance as equivalent individual requests, with a separately bounded host staging allowance.

### 17. Privacy leakage via delivery metadata

**Pain/mitigation elsewhere:** Signal introduced sealed sender because encrypted content alone leaves envelope information; XMPP upload documents IP disclosure. Public AT firehoses intentionally expose updates and are an unsuitable template for private delivery.

**Applies:** directly, and our present plaintext/key custody exposes more than an E2EE design. Hosts can observe source/destination, timing, message sizes, group correlations and retries. Per-recipient failure/read information can disclose availability and relationships.

**Recommendation:** document what each sender, recipient provider, optional batch ingress/relay, push service and attachment service learns. Batch envelopes disclose only that host's necessary recipients; do not attach the entire private roster unless the signed content profile deliberately requires and discloses it. Recipient counts/frontiers themselves can leak activity; avoid global enumerable IDs/status. Status access is owner-authenticated; other participants receive only separately consented signals. Default read receipts/presence/typing off, use short TTLs/coalescing, and never equate them to custody. Redact capabilities and bodies from logs/traces; restrict retention of destination/event correlation data. Use content-free push where practical and no automatic remote pixels or viewer-triggered attachment fetches. Padding/batching may reduce some traffic signals but require measurement and do not provide anonymity.

### 18. Local actor hot spots and progress streams

**Pain/mitigation elsewhere:** Matrix moves expensive join work into background synchronization; Mastodon isolates queues; AT separates durable sync from filtered streams. Scaling total accounts does not remove one hot account's bottleneck.

**Applies:** directly to the reference host. Cloudflare documents single-threaded individual DO execution, platform limits and finite connection/CPU/storage budgets. [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) Its alarms provide at-least-once execution and bounded automatic failure retries; setting another alarm replaces the scheduled one. [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)

**Recommendation:** keep an indexed due-work queue and schedule its earliest deadline through a shared account scheduler, including other lifecycle jobs. Alarm callbacks must be idempotent and a bounded sweep must repair stranded work after exhausted platform retries. Do not hold a storage transaction or account-wide concurrency lock during remote delivery. Choose network batch sizes below verified platform ceilings with headroom for auth/storage/control work. Shard hot delivery work only with explicit quota reservations, immutable obligations and fenced completion; moving work cannot duplicate charges or broaden rights. SSE uses durable local status revisions and bounded replay, coalesces updates and supports reload/reset after gaps. SSE disconnects never cancel sends, authorize retries or keep idle DOs awake solely to prove progress. Measure contention with ordinary account operations before extracting per-conversation actors.

## Candidate operational profile and validation work

These are starting points for a later experiment, not normative numbers, measured capacities or approved product promises. Hosts may publish stricter capabilities; negotiated constraints cannot silently drop recipients.

| Control | Candidate to investigate | Required acceptance evidence |
| --- | --- | --- |
| Group bound | 32 total participants initially; exercise larger groups only in load experiments. | Predictable admission and bounded work under churn, full fan-out and one-host-per-peer cases. |
| Multicast envelope | At most 32 recipient contexts; separate small event/control byte bound from attachments. | Equivalent per-recipient authority, quota, replay and receipts under partial commit. |
| Sender work batch | Start at 4 simultaneous outbound requests per invocation, subject to platform/adaptor limits and host concurrency limits. | No account starvation, connection exhaustion or event-loop hot loop. |
| Retry envelope | Start with 5-second minimum, exponential jittered backoff capped near 1 hour, at most 100 network attempts/recipient and 72-hour automatic lifetime; remote delay can extend next attempt only within the lifetime. | Outage/recovery simulations stay within attempt/byte/cost budgets; UI explains terminal outcomes. These candidates require coordination, not independent promises. |
| Transport freshness | Investigate a 5-minute maximum skew tolerance independently of immutable content age and replay retention. | Offset, rollback, proof renewal and revocation tests do not admit unauthorized replay. |
| Retained replay evidence | Support the automatic/manual retry horizon plus declared safety margin; compact only with durable frontiers/exceptions. | Old snapshots, gaps, erasure and migrated endpoints cannot resurrect content. Exact retention remains an open design decision. |
| Ephemeral signals | Disabled by default; if enabled, coalesced updates with short leases and no long-lived retry obligations. | Loss never blocks messages; disabling invalidates queued disclosures. |

Observe p50/p95/p99 local-append and recipient-ACK latency, oldest due obligation, queue bytes, attempts per ACK, host breaker age, cold restores, DO wakeups/CPU, storage operations, attachment bytes, dependency/key fetches and notification volume. Keep identity-sensitive telemetry access/retention bounded. Report measured load distribution and failure mix with any capacity claim; average throughput alone hides a single dead host or hot owner.

The later implementation/conformance work should exercise at least:

| Scenario | Required observable result |
| --- | --- |
| Sender crashes after append commit and before first POST. | Restart finds all original obligations; no accepted message disappears. |
| Recipient commits, ACK is lost, sender restarts. | Same event yields the same owner copy/accounting and a verifiable receipt; no second notification. |
| Multicast commits 7/10 owners, then times out; fallback races a retry. | Exactly one durable effect per authorized owner; unresolved three remain visible, not guessed successful. |
| One host trickles responses while others return 429 with long `Retry-After`. | Healthy hosts progress; bounded memory/time/work; no retry earlier than the valid delay. |
| Host is dead for longer than retry lifetime, then recovers. | Sender sees expiry; bounded probe/reconciliation can recover authorized data without silently reactivating terminal work. |
| Concurrent replies, edits and delete-before-body arrival. | Causal placeholders/conflict evidence and correct tombstone behavior; timestamps cannot restore old state. |
| Block/reaccept and secret rotations race queued old events. | Fresh incarnation checks prevent old admission replay; incompatible epochs are explicit. |
| Key rotates while caches are stale; attacker supplies a replacement key URL. | Bounded continuity verification or refusal; no substitution, SSRF or fetch storm. |
| Clock is ahead/behind, jumps forward/backward, or resets after restore. | No quota reset, expiry revival or history reordering by timestamp; useful bounded error. |
| Browser/push offline, SSE cursor expired, provider retains messages. | Snapshot/catch-up recovers durable state; no fabricated read/device-delivery status. |
| New member joins an old, heavily edited conversation. | Bounded frontier/bootstrap without unauthorized old bodies or lifetime DAG traversal. |
| Oversized/decompression-bomb attachment, quota exhaustion, abandoned upload. | Admission fails within budget; no false complete receipt; reservations/orphans are reclaimed safely. |
| Local erase followed by stale backup restore, archive sync and retry. | Minimal current erasure/revocation evidence prevents resurrection across all paths. |
| Accepted spammer posts reactions, invitations, reports and receipts rapidly. | Expanded-work budgets bind; protective block/leave remains available; no amplified alerts. |

Use at least two independently implemented hosts for interop claims, not two configurations of the same adapter. Runtime changes later require `npm test` under AGENTS.md; status/resend/catch-up behavior additionally needs DOM/browser verification. Simulated DNS, provider errors and local durable-adapter tests are useful but must be labeled separately from production network/provider verification.

## Provisional decisions requiring later review

| Decision | Recommendation / unresolved issue | Sign-off |
| --- | --- | --- |
| D1: consistency and extraction | Specify independent owner replicas/directed consent in the messaging app; replace conflicting central-authority guarantees explicitly. | Protocol/architecture reviewer ___ / date ___ / outcome ___ |
| D2: delivery and limits | Small bounded groups, durable complete sender obligations, recipient custody receipts and finite retry. Numeric profile requires measurements and product review. | Operations/product reviewer ___ / date ___ / outcome ___ |
| D3: multicast | Optional host optimization with per-recipient authority/accounting/status; decide host staging receipt, recovery and discovery wire semantics. | Security/interop reviewer ___ / date ___ / outcome ___ |
| D4: security/privacy lifecycle | Separate signing/possession/encryption keys, local revocation and transport proof renewal; decide replay/retention horizons and metadata disclosure. | Security/privacy reviewer ___ / date ___ / outcome ___ |

## Prioritized checklist for the messaging app

### P0 — settle before freezing the interop design

- [ ] Reconcile the old central-authority draft with independent replicas and directed consent; specify the app/core boundary and versioned upgrade path.
- [ ] Define immutable event/audience identity, causal bounds, live admission incarnations and exactly what a recipient custody receipt covers, including attachments.
- [ ] Specify atomic local acceptance plus complete durable fan-out, queue admission/reservations and honest per-recipient terminal/unknown states.
- [ ] Define retry classification, minimum spacing/jitter, deadlines, budgets, host breakers and recovery probes; keep manual resend on the same bounded obligation.
- [ ] Specify block/reaccept, key continuity, secret-rotation disagreement and late-event rules without promising global expulsion or immediate revocation knowledge.
- [ ] Publish group, event, dependency, attachment, expanded-work and pending-state bounds, including a reserve for protective controls.
- [ ] Set replay/receipt/tombstone retention and restore rules together so erase, migration or compaction cannot resurrect messages.
- [ ] Document plaintext/key custody and delivery metadata; establish scoped status access, safe logging and off-by-default social disclosures.
- [ ] Define identity-preserving SMTP provenance, pre-acceptance refusal and suppressed/bounded replies; no backscatter or implicit conversion of email into signed authorship.

### P1 — prove before enabling cross-host messaging

- [ ] Implement/test durable queue recovery and fair scheduling on real Node/Worker adapters, including account DO contention and exhausted alarm retries.
- [ ] Verify partial delivery counts, retry-missing controls and SSE reset/catch-up in a browser with lost acknowledgements and reconnects.
- [ ] Run the failure scenarios above across independent hosts; document measured latency/cost and actual transport/identity/attachment verification limits.
- [ ] Verify spam, quarantine, moderation/reporting and notification budgets, including malicious admitted participants and a dead destination host.
- [ ] Resolve D1–D4 through named, dated reviewer outcomes in the later authorized ledger update; retain existing production release gates until their evidence is satisfied.

### P2 — optimize after correctness and measurements

- [ ] Add optional host multicast only if host concentration makes the benefit material; preserve individual receipts and fallback deduplication.
- [ ] Tune group limits, retry schedules, cold segmentation and hot-owner sharding from workload/failure measurements rather than competitor limits.
- [ ] Evaluate optional relays and MLS/E2EE as separate profiles with explicit trust, membership agreement, recovery and privacy analysis; keep direct delivery viable.
