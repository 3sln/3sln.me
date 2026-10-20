# BindleBox design wargame review

Date: 2026-10-20.

Reviewed:

- [BindleBox architecture](../architecture/messaging-app.md);
- [BindleBox interop v1](../spec/bindlebox.md);
- [messaging extraction plan](../architecture/messaging-extraction.md).

Method: two independent reviewer subagents, a security/abuse red team and a product/interop wargame, each reading the full drafts and their context. Neither reviewer edited any file. The lead designer then revised all three documents and checked them against [extensions](../spec/extensions.md), [integrations](../spec/integrations.md) and [extensibility design](../architecture/extensibility-design.md) revision 2 as finalized, and against the [scaling spike](messaging-scaling-spike.md) checklist.

This is agent review, not human sign-off. Human sign-off: reviewer ___ / date ___ / outcome ___. Every decision stays provisional until the slots in the architecture header are signed. Nothing is implemented.

Finding counts:

| Review | Blocker | High | Medium | Low |
| --- | --- | --- | --- | --- |
| Security | 0 | 6 | 9 | 5 |
| Product/interop | 3 | 8 | 6 | 1 |

Every finding has a disposition below. "Fixed" means the documents now say what the cited section says. No finding is open, except where marked **Open (user)**.

## Security and abuse review

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| S-1 | high | Credentials are checked inside each mailbox, so one forged request (or one 32-context batch) wakes up to 32 mailboxes. | **Fixed.** An instance-wide edge credential index (spec §7.4) refuses bad credentials without waking any mailbox. A batch is charged as N requests before any context is dispatched, and `accepted-host` is returned only after the credential verifies (spec §7.3; arch §10, §11). |
| S-2 | high | `peer-proposal.ingress` for a third party lets a malicious member capture bodies and the secret. | **Fixed.** Proposals carry no ingress. A third party can convey only the proposed peer's **own** signed introduction, verified against that peer's certificate `client.ingress` (spec §6.3; arch §7.2). |
| S-3 | high | A stolen delegate key can retract, edit, rotate or redirect for up to 24 h. Rotation and breaches are not revoked, and status leaks the suspension time. | **Fixed.** Status checks are required for every lasting-effect record and every receipt. Unapplied records signed after revocation are quarantined. A new `jkt` revokes the previous one, and revocation by `client_id` exists. Status returns only a coarse hour. Consent names the verified origin (spec §3.2, §3.4; arch §4.3). |
| S-4 | high | Ingress changes trust only the origin, which allows path hijack on shared instances. | **Fixed.** The certificate binds a provider-recorded `client.ingress`, and every ingress change must equal it (spec §3.2, §6.2, §6.3). |
| S-5 | high | The marketing auto-reply is an occupancy and existence oracle, can be false on timeout, and can be used to drain the reply budget. | **Fixed.** SMTP behaviour and the reply never vary with occupancy or disposition (extensions §9.8). There is one invariant text that claims neither storage nor non-delivery. Unknown, disabled and ineligible handles get the identical refusal and no reply. The reply has a lowest-priority dedicated budget, per-domain and per-handle caps, and an owner opt-out (arch §13). Whether to send it at all is **Open (user)**: arch §19 question 3. |
| S-6 | medium | The bridge handoff has no binding checks at the occupant. | **Fixed.** Normative checks: provenance key, recipient, `normalizedDigest`, `jti` and `tx` deduplication, `receivedAt` bound, and assertions displayed as assertions (spec §9). |
| S-7 | high | `any-error` classifier failover discloses the same content to up to four origins, conversations are classified without the senders' consent, and capabilities leak into model input. | **Fixed.** BindleBox advances only on pre-dispatch failures, which the slot permits. The input schema is normative and capabilities are redacted. Conversations are excluded by default, and per-occupant disclosure wording is specified (arch §12). |
| S-8 | medium | Principal-resolution route, per-user ingress URLs, 503-versus-404 and timing allow enumeration. | **Fixed.** The principal-resolution route is removed. Ingress URLs are instance-wide. `recipient_unavailable` is always a 503. Edge decisions use equal timing (spec §2.3, §7.3). |
| S-9 | medium | Replay protection is lost on app switch or restore. | **Fixed.** A `replay` segment is exported. Control state is imported first. Pre-checkpoint envelopes are admitted only from the imported set (spec §8.2, §10). |
| S-10 | medium | Gap exceptions grow without bound, and huge counter jumps are possible. | **Fixed.** At most 256 gap exceptions per stream, expiring with the window. `counter_gap` beyond a jump of 1,024 (spec §6.3, §11). |
| S-11 | medium | Invitation responses: crypto runs before the nonce check, the nonce is reusable, `resource` is unbound, and the invitee lacks the creator's binding. | **Fixed.** The nonce and membership are checked before any crypto. The nonce is single-use (`invitation_used`). `resource` must be on the creator's certified origin. `creatorBinding` is added (spec §6.1, §6.2). |
| S-12 | medium | Receipt checks are incomplete, and any app holding the receipt purpose could forge receipts. | **Fixed.** Normative sender checks, including `client.ingress` and status. Purposes are certified only to the current occupant (spec §3.2, §8.1). |
| S-13 | medium | The shared secret is a group-wide bearer that can be replayed to other members. | **Fixed.** Per-pair HMAC token bound to author, recipient and incarnation, with digests in the edge index (spec §6.4). |
| S-14 | medium | The previous app saw every link capability, and presenting the long-lived meta at ingress is a mild regression. | **Fixed (mitigated).** On replacement the owner is shown links from the previous occupant, with bulk revoke and reissue. Links record an `occupantGeneration` (spec §4.2). The regression is accepted: the occupant already holds the parent records. |
| S-15 | high | The archive is unsigned and the sensitive class is stored in plaintext. | **Fixed.** Manifest signed under an archive purpose with a writer lease. Secrets and metas are excluded until encryption, then recovered through `rejoin` and `links.list` (spec §6.6, §10). |
| S-16 | low | Webhook trust was assumed. | **Fixed.** Integration SETs are verified per integrations §6.1. Identity keys come from the directory, not events (spec §2.4). |
| S-17 | low | The genesis roster is disclosed and unverified. | **Fixed (UI).** Shown as "proposed by the creator, unverified" (spec §6.1). Disclosure to an invitee who declines is inherent and accepted. |
| S-18 | low | `multicast` origin is unconstrained; the context prefix is unused. | **Fixed.** Same origin as ingress. Prefix removed (spec §2.3, §5.2). |
| S-19 | low | The reset drops blocks; erase enumeration is switched globally. | **Fixed (recorded).** Per-account switch keyed on the reset marker. Dropping blocks is accepted only because no production users exist (extraction §4). |
| S-20 | low | Reused link decisions outlive blocks. | **Fixed.** Blocks and policy changes invalidate reused decisions (spec §4.2). |

## Product and interop review

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| P-1 | blocker | Bootstrap works in one direction only: the invitee has no creator ingress or incarnation. | **Fixed.** Recipient-specific `creatorBinding` (spec §6.1; arch §7.1). |
| P-2 | blocker | Groups never form: there is no path for B's binding to reach C, and every pair needs manual approval. | **Fixed.** `acceptListed` opt-in, creator-relayed self-signed introductions, and a direct `peer-hello` gated by a `hello` pair token, auto-accepted for listed participants (spec §6.2–§6.4; arch §7.2). |
| P-3 | blocker | An app switch, lagging checkpoint or second app causes equivocation and mutes the user. | **Fixed.** Streams are keyed by `(author, conversation, jkt)` and a new key links to the previous head. One signing installation per principal. The stream head is persisted before signing and exported (spec §3.2, §6.3, §10). |
| P-4 | high | The old app keeps receiving, signing receipts and writing the archive after a switch, and queued sends are orphaned. | **Fixed.** Occupant removal revokes delegation and receipts require active status and `client.ingress`. Writer lease and fencing. `outbox` segment exported. `ingress` and `rejoin` sent on import (spec §3.2, §8.1, §10; arch §16). |
| P-5 | high | `recipient_unavailable` as 404 becomes a terminal rejection during re-review or reinstall. | **Fixed.** Always 503 and retryable until the deadline (spec §2.3, §8.3; arch §9.3). |
| P-6 | high | Secret rotation causes silent drops (403 is terminal); `deferred` was not a state. | **Fixed.** 7-day epoch overlap. A 403 after a known rotation becomes `retry_scheduled(epoch)`. Reasons are attached to `retry_scheduled` (spec §6.5; arch §9.3, §9.4). |
| P-7 | high | Offline peers beyond 72 h: Retry missing is per message with an undefined budget; nothing beyond 7 days; placeholder overflow undefined. | **Fixed.** Per-peer automatic catch-up. Retry missing gets a fresh budget of 10 and a manual deadline of window minus 1 h. Placeholders collapse into a gap marker past 64. After the window, "history unavailable" is shown and nothing is re-sent automatically (arch §9.6, §7.4; spec §6.3). |
| P-8 | high | A retract that overtakes its target is refused terminally; retraction audiences are wrong. | **Fixed.** Bounded pending mutations, author-checked on arrival. Edit and retract audience is the target audience intersected with authorized peers (spec §6.3; arch §7.3). |
| P-9 | high | The collapse key does not save activity budget, and orphaned items cannot be retracted after reinstall. | **Fixed.** One activity item per conversation updated with `Replace`, rolling at 32 revisions. Orphaning stated (arch §14). |
| P-10 | high | Missing core prerequisites, no `list` on the links contract, integrations events now differ, stale references. | **Fixed.** C1 and C3 expanded. Extensions prerequisites and X12 added. `list` and `changes` added. §2.4 rewritten to integrations §6. Routes added to extraction §2.5. This record now exists. The "extensions revision 1" observation was incorrect: the file states revision 2. A DEVLOG entry is needed, and is left to the coordinator because this task may not edit DEVLOG. |
| P-11 | medium | Conversation peers have no descriptor (limits, multicast, profiles). | **Fixed.** Bindings in invitation, hello, ingress and rejoin carry `{profiles, limits, multicast}` (spec §6.1–§6.3). |
| P-12 | medium | Group limits cannot be enforced after genesis; 401 versus 403 inconsistency. | **Fixed.** The limit is defined per owner's accepted-peer set, with a compose pre-check and a UI indicator. 403 used for conversation credentials (spec §6.5; arch §7.7, §11). |
| P-13 | medium | Behaviour per missing provider capability is unstated, and there was no window-expired code. | **Fixed.** Rows for `key-delegation.v1` and the directory. Descriptor `verifies`. `envelope_expired` added (arch §5, §16; spec §2.3, §8.3). |
| P-14 | medium | Aggregate buckets were ambiguous; a cancelled obligation counted as failed forever; `not_sent` label was wrong. | **Fixed.** `{delivered, pending, failed, cancelled}`. `unknown` counts as pending. "delivered before cancel". "joined after this message" (arch §9.4, §9.5). |
| P-15 | medium | Archive trust; same storage resource not ensured; quotas reset; long import expires one-offs. | **Fixed.** Signed manifest, storage pre-selected in the switch flow, `quota` segment, control state imported first with traffic admitted early (spec §10; arch §16). |
| P-16 | medium | The bridge could claim false non-delivery on timeout. | **Fixed** by the invariant reply (see S-5). |
| P-17 | medium | Application consumers of messaging-ingress could call mailbox methods; public-intake was undefined. | **Fixed.** messaging-ingress has `consumers: ["provider"]`. public-intake slot and contract defined, matching extensibility design §7.1 (spec §2.1, §9). |
| P-18 | low | Slice ownership gaps, dependency order, X1/X2 window, "zero exposure" overstated, renewal of rotated keys. | **Fixed.** C1 owns issuance in `contact-endpoints.mjs`, C2 owns `dispatcher.mjs`, and the activity slice owns the core halves. B6 depends on B3/B4, B9 on B4–B6. X1 is now one change. Exposure is bounded by the status cache. Rotation rule (arch §4.3 item 6): routine rotation waits until no unresolved obligation is signed by the old key. On compromise, unresolved obligations are re-signed by the new key as new events carrying `resendOf`, and recipients that already hold the original show the copy once, marked "resent". |

## Addendum: public request auto-rejection (user addition, 2026-10-20)

Arch §12.1 and spec §6.7 add public-request filtering with two tiers. This addendum was not re-run through the independent reviewers. These are the lead designer's own abuse cases and mitigations, and they need review.

| ID | Abuse case | Mitigation |
| --- | --- | --- |
| A-1 | **Oracle probing.** A spammer varies content to learn which messages pass the classifier. | Rejection is unobservable (spec §6.7): the same receipt, the same timing class, invitations that simply lapse, and the invariant email reply. |
| A-2 | **Framing a legitimate sender** by quoting their content in spam, so that their real messages are later auto-rejected. | Rejection applies only to requests, never to accepted peers. The allowlist overrides it. The Rejected view supports rescue. Content similarity is never fed back into rules automatically. |
| A-3 | **Model swap or drift silently raises the reject rate.** | Thresholds are pinned to model, version and schema. Any change enters calibration mode, with no auto-reject until a threshold is pinned for the new version. |
| A-4 | **Flood to evict rescuable items** from the 500-item Rejected view, or to exhaust classifier spend. | Per-sender, per-domain and per-owner request limits run before classification. A separate reserve covers Rejected-view writes. An exhausted classifier allowance falls back to heuristics, which never auto-reject. Residual risk: a sustained, sufficiently distributed flood can still push out older rejected items within 7 days. |
| A-5 | **Header forgery** (fake `List-Unsubscribe` or `Auto-Submitted`) to get a victim's mail auto-rejected. | Heuristics can at most produce "could be spam" (deprioritized) and are never auto-reject by default. |
| A-6 | **Allowlist spoofing** by forging an allowlisted email address. | For email, address allowlists only prevent rejection. They never grant participation. A forged allowlisted address lands as an ordinary unverified request, which is the intended trade-off. Principal allowlists are identity-verified. |
| A-7 | **Content disclosure to the classifier** for requests. | §12 input minimization and redaction, pre-dispatch-only failover, and per-occupant disclosure in consent. |
| A-8 | **Notification leakage.** A push or summary reveals rejected senders. | Rejected items produce no push. The optional daily summary carries counts only. |

## Reconciliation items for other owners

| ID | Owner | Item |
| --- | --- | --- |
| R-1 | Activity ([activity center](../architecture/activity-center.md)) | **Resolved 2026-10-20** at the coordinator's direction: activity-center now keeps both files in core and resets peer records pending user confirmation. Original issue: its extraction table moved `apps/worker/email.mjs` (core system-mail transport) and `packages/messaging/dispatcher.mjs` (lifecycle notices) to the messaging app. Both stay core. Its cutover proposes an owner-reviewed transfer of peer records. This plan proposes a reset instead (extraction §4), pending the user's answer to arch §19 question 7. |
| R-2 | Extensions/integrations | Integrations §6.2 defines no identity-key-rotation or link-change event. BindleBox works without them (directory lookups and `links.changes` polling) and requests them as an optimization. |
| R-3 | Extensions | The open question "public per-entity slot resolution" is answered **no** for messaging (arch §5, spec §2.3). The X12 email-bridge consumer is shared and follows spec §9 and arch §13. |
| R-4 | Core protocol (coordinator) | Two proposed core amendments: `key-delegation.v1` (spec §3.2–§3.4), and the links contract with its link-type → slot registration (spec §4.2). Also new rows for the [links §7.2](../spec/links.md) signature-domain table. |
| R-5 | Coordinator | DEVLOG entry recording these decisions as provisional and linking this record. |

## Residual risks accepted

- **Plaintext custody.** Providers, apps and storage providers see content until a separate encryption profile exists.
- **Plain-message exposure after revocation.** For a delegate key, plain messages and one-offs remain forgeable for up to the certificate lifetime (24 h) after revocation.
- **Cross-host verification** waits for the directory profile. Until then only same-provider principals verify.
- **Two independent implementations** are required before any interop claim. Local tests do not establish one.
